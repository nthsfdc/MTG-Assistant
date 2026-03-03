# MTG Assistant — Design Document

**Version**: 1.3.0
**Stack**: Electron 31 + React 18 + TypeScript 5.5 + Tailwind CSS 3
**Platform**: Windows (primary), macOS

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02 | Initial design: realtime recording, STT, translation, post-meeting pipeline |
| 1.1.0 | 2026-03 | **Import mode**: audio/video file import, MediaService (ffmpeg), pipeline checkpoint, crash recovery |
| 1.2.0 | 2026-03 | **Production Hardening**: chunk-based Whisper for long audio, hierarchical summarization, secure keytar storage + encrypted fallback, concurrency guard, structured logging with rotation, cost governance guardrails |
| 1.2.1 | 2026-03 | **Audit corrections**: chunk trigger is WAV file-size only (post-conversion); dedup uses text-similarity not startMs window; hierarchical reduction pass explicitly defined; idempotency skip validates file content not just existence |
| 1.2.2 | 2026-03 | **CTO review fixes**: architecture diagram corrected (keytar + vault.enc fallback, not vault.json); `apikey:get` removed (plaintext leak), replaced with `apikey:getMasked`; chunk overlap removed (Approach A — no overlap, dedup is optional guard only); Whisper cost corrected ($0.006/min: 30 min=$0.18, 1 h=$0.36, 2 h=$0.72) |
| 1.3.0 | 2026-03 | **Enterprise Hardening & Storage Flexibility**: configurable storageRootPath (external drive support); optional source file archiving vs. path-reference mode; auto-cleanup service; exponential backoff for API resilience (Whisper + GPT); PipelineLock deadlock prevention (2 h timeout, 30 s heartbeat, 10 min watchdog); Reduction Pass redesigned to prose-based pipeline (no forced bullet structure); ffmpeg code-signing requirements for CI/CD; disk usage monitoring with low-space warning |

---

## 1. Overview

MTG Assistant is a **local-first** desktop application that records (or imports) meeting audio, transcribes speech, detects languages, normalizes spoken text, and generates structured meeting minutes using AI. All data stays on the user's machine; only API calls leave the device.

### Key Capabilities

| Capability | Provider | Mode |
|------------|----------|------|
| Real-time transcription + diarization | Deepgram nova-3 (WebSocket) | Realtime |
| High-accuracy batch transcription | OpenAI Whisper | Both |
| Audio/video file import | ffmpeg (local) | Import |
| Audio extraction & format conversion | ffmpeg (local) | Import |
| Translation (realtime) | DeepL → GPT-4o-mini fallback | Realtime |
| Text normalization | Rule engine + GPT-4o-mini | Both |
| Meeting minutes generation | GPT-4o (structured JSON) | Both |
| UI languages | Japanese / English / Vietnamese | Both |

### Input Mode Comparison

| Aspect | Realtime | Import |
|--------|----------|--------|
| Source | Microphone + optional system audio | File (wav/mp3/m4a/mp4/mov) |
| STT | Deepgram WebSocket (streaming) | OpenAI Whisper (batch) |
| Translation | Yes (real-time, not saved) | No (post-meeting only via summary) |
| Post-processing pipeline | Same 5-step pipeline | Same 5-step pipeline |
| Data stored | audio.pcm | audio.wav + optional source/{original} |
| Recovery | N/A (live) | Yes — pipeline.json checkpoint |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer Process (React)                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ RecordingProvider (never unmounts)                    │  │
│  │  useAudioCapture · IPC caption subs · timer           │  │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────┐ ┌────────┐  │  │
│  │  │Dashboard │ │LiveSession│ │PostMeeting│ │Import  │  │  │
│  │  └──────────┘ └───────────┘ └──────────┘ └────────┘  │  │
│  └───────────────────────────────────────────────────────┘  │
│  Zustand: sessionStore · captionStore · recordingStore      │
└────────────────────────┬────────────────────────────────────┘
                         │  contextBridge (window.api)
                         │  IPC channels (invoke / send)
┌────────────────────────▼────────────────────────────────────┐
│  Main Process (Node.js / Electron)                          │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌─────────────┐  │
│  │session.ipc│ │audio.ipc  │ │settings  │ │import.ipc   │  │
│  └─────┬─────┘ └─────┬─────┘ └──────────┘ └──────┬──────┘  │
│        │             │                             │         │
│  ┌─────▼─────────────▼─────────────────────────────▼─────┐  │
│  │ Services                                               │  │
│  │  SttService      BatchSttService   TranslationService  │  │
│  │  LangDetect      Normalization     Summarization       │  │
│  │  PostMeeting     Export            MediaService        │  │
│  │  AutoCleanup ← NEW v1.3                                │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Stores                                              │     │
│  │  session.store (userData/app.json)                  │     │
│  │  file.store    ({storageRoot}/sessions/{id}/...)    │     │
│  │  secret.store  (keytar + vault.enc fallback)        │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
              │
              ▼ External APIs
   Deepgram · OpenAI (Whisper + GPT-4o) · DeepL
```

**`storageRoot`** defaults to `app.getPath('userData')` and is user-configurable (see §17.1). Small metadata files (`app.json`, `settings.json`, `vault.enc`, `logs/`) always remain in `userData` regardless of `storageRoot`.

### Process Separation

| Concern | Process |
|---------|---------|
| UI rendering, audio capture | Renderer (sandboxed) |
| STT WebSocket, file I/O, API calls | Main |
| ffmpeg child process management | Main only |
| API key exposure, raw PCM/WAV | Main only — never in renderer |
| Auto-cleanup, disk monitoring | Main only |

Security: `contextIsolation: true`, `nodeIntegration: false`. Preload exposes typed `window.api` only.

---

## 3. IPC Interface

### Renderer → Main (invoke)

| Channel | Payload | Response |
|---------|---------|----------|
| `session:start` | `{ title, lang, targetLang, inputDeviceId }` | `{ sessionId }` |
| `session:stop` | `{ sessionId }` | `void` |
| `session:list` | — | `SessionMeta[]` |
| `session:get` | `{ sessionId }` | `SessionDetail` |
| `session:delete` | `{ sessionId }` | `void` |
| `session:import` | `ImportPayload` | `{ sessionId }` |
| `session:retryStep` | `{ sessionId, step }` | `void` |
| `session:resumePipeline` | `{ sessionId }` | `void` |
| `media:probe` | `{ filePath }` | `MediaProbeResult` |
| `settings:get` | — | `AppSettings` |
| `settings:save` | `Partial<AppSettings>` | `void` |
| `apikey:set` | `{ service, key }` | `void` |
| `apikey:getMasked` | `{ service }` | `string \| null` — returns `"****abcd"` (last 4 chars) or `null` |
| `apikey:exists` | `{ service }` | `boolean` |
| `export:markdown` | `{ sessionId }` | `{ filePath }` |
| `storage:getStats` | — | `StorageStats` ← **NEW v1.3** |
| `storage:setRoot` | `{ path }` | `{ ok, error? }` ← **NEW v1.3** |
| `storage:runCleanup` | `{ dryRun? }` | `CleanupReport` ← **NEW v1.3** |

### Renderer → Main (send, high-frequency)

| Channel | Payload |
|---------|---------|
| `audio:chunk` | `{ seq: number, pcm: ArrayBuffer }` — 100ms PCM16 |

### Main → Renderer (push)

| Channel | Payload |
|---------|---------|
| `stt:partial` | `{ sessionId, speakerId, text }` |
| `stt:final` | `{ sessionId, speakerId, text, lang, startMs, endMs }` |
| `translation` | `{ sessionId, sourceText, translatedText, speakerId }` |
| `session:status` | `{ sessionId, status, step?, progress?, warning? }` ← extended |
| `session:done` | `{ sessionId, exportPath }` |
| `error` | `{ code, message, sessionId? }` |
| `storage:warning` | `{ freeBytes, threshold }` ← **NEW v1.3** — low disk space alert |

**`session:status`** is reused for both realtime post-processing and import pipeline progress:

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | string | — |
| `status` | `SessionStatus` | — |
| `step` | `PipelineStep?` | current step |
| `progress` | number? | 0–100, per-step % |
| `lastCompletedStep` | `PipelineStep?` | for resume banner |
| `error` | string? | error message if status=error |
| `warning` | `'HIGH_COST_EXPECTED'?` | ← **NEW v1.3** — cost warning field |
| `retryAttempt` | number? | ← **NEW v1.3** — 1–3 during backoff retries |

---

## 4. Data Flow

### 4.1 Realtime Recording (unchanged)

Audio capture is managed by `RecordingProvider` at App level — survives route changes.

```
RecordingProvider.startRecording(sessionId, deviceId)
    → useAudioCapture.start()
        getUserMedia / getDisplayMedia
        → AudioWorklet (pcm-processor.ts)
            AGC: TARGET_RMS=0.08, EMA α=0.05, MAX_GAIN=4.0
            Accumulate 1600 samples (100ms @ 16kHz)
            Float32 → Int16
        → ipcRenderer.send('audio:chunk', { seq, pcm })
        → audio.ipc (main)
            ├→ fileStore.appendAudio()        [audio.pcm]
            └→ sttService.sendAudio()
                → Deepgram WebSocket
                    is_final=false → stt:partial ──→ RecordingProvider IPC listener
                    is_final=true  → file.store         → captionStore (always active)
                                   → stt:final ─────→ captionStore
                    speech_final   → translationService (fire-and-forget)
                                   → translation ───→ captionStore

RecordingProvider also:
    → sets recordingStore.sessionId, hasSysAudio
    → runs timer: recordingStore.tick() every 1s
```

**User navigates away during recording**: audio continues uninterrupted. Sidebar shows
a pulsing REC badge with elapsed timer. Clicking it returns to LiveSession.

**LiveSession re-mount guard**: checks `recordingStore.sessionId === sessionId` before
calling `startRecording()` — prevents double audio capture on back-navigation.

### 4.2 Post-Meeting Pipeline (shared, realtime + import)

Triggered by `session:stop` (realtime) or at end of audio preparation (import). Runs sequentially, emits `session:status` at each step. Checkpoint written to `pipeline.json` before and after each step.

```
0. [checkpoint]  write pipeline.json { step: 'batch_stt', status: 'pending' }

1. batch_stt    → getAudioForWhisper(sessionId)   ← file.store helper (pcm or wav)
                  Whisper API → TranscriptSegment[]  [with exponential backoff, §17.2]
                  fallback: realtime transcript.jsonl (realtime only)
                  [checkpoint]  { step: 'lang_detect', status: 'pending' }

2. lang_detect  → Unicode heuristic per segment → detectedLang
                  [checkpoint]  { step: 'normalizing', status: 'pending' }

3. normalizing  → Phase 1: rule-based filler removal
                  Phase 2: GPT-4o-mini rewrite (optional, batched 20/call)
                  → normalized.json
                  [checkpoint]  { step: 'summarizing', status: 'pending' }

4. summarizing  → GPT-4o structured output (prose pipeline, §17.4)
                  → minutes.json { purpose, decisions, todos, concerns, next_actions }
                  [checkpoint]  { step: 'exporting', status: 'pending' }

5. exporting    → exportService.toMarkdown()
                  → export.md
                  [checkpoint]  { step: 'done', status: 'done' }

6. save         → sessionStore.update(status: 'done')
                  → session:done event
```

### 4.3 Import Flow (updated v1.3.0 — source file handling)

```
Renderer: ImportScreen
    user picks file via dialog
    → media:probe (invoke) → { durationMs, hasAudio, format }
    user inputs title, lang, targetLang
    → session:import (invoke) → { sessionId }
    → navigate to /session/:id  (PostMeeting, shows live progress)

Main: import.ipc.ts  handles session:import
    1. sessionStore.create({ title, lang, targetLang, inputType:'import', status:'processing' })
    2. Source file handling (based on StorageSettings.copySourceFile):
       if copySourceFile = true:
         fileStore.copySource(sessionId, sourcePath) → sessions/{id}/source/{filename}
         SessionMeta.sourceArchivedPath = sessions/{id}/source/{filename}
       else:
         SessionMeta.sourceAbsolutePath = sourcePath   (reference only, no copy)
       [checkpoint]  { step: 'prepare_audio', status: 'pending' }

    3. MediaService
       resolves audio path from sourceArchivedPath or sourceAbsolutePath
       if sourceType === 'video':
         mediaService.extractAudio(resolvedPath, tmpWavPath)
       else:
         mediaService.convertTo16kMonoWav(resolvedPath, tmpWavPath)
       → {storageRoot}/sessions/{id}/audio.wav (streaming ffmpeg pipe, never in RAM)
       [checkpoint]  { step: 'batch_stt', status: 'pending' }

    4. postMeetingService.run(sessionId, { audioPath: 'audio.wav' })
       (same pipeline as §4.2 — all 5 steps)
```

**Source file tradeoffs** (see §17.1 for full design):
- `copySourceFile = false` (default): no disk duplication; import fails if original file is moved.
- `copySourceFile = true`: file archived locally; `prepare_audio` can be retried even if original is deleted.

**Key constraint**: ffmpeg is spawned as a child process. Output is written directly to `audio.wav` on disk via ffmpeg's `-y` flag and output path argument — the Node process never buffers the full audio in RAM.

---

## 5. Services

### SttService (unchanged)
- Deepgram nova-3 WebSocket (`wss://api.deepgram.com/v1/listen`)
- Params: `model=nova-3&diarize=true&smart_format=true&language=multi`
- Reconnect: once after 2s on disconnect, then degrade silently
- **WebSocket inactivity timeout (v1.3.0)**: if no message received for 60s, force reconnect. See §17.3.

### BatchSttService (updated — v1.2.0: chunk-based; v1.3.0: retry policy)

Whisper-1 has a hard **25 MB file size limit** and degrades above ~30 minutes of audio. BatchSttService handles long files transparently using chunk-based transcription.

**Decision threshold — file-size based (v1.2.1)**: After MediaService converts or extracts audio to `audio.wav`, compute `fs.statSync(wavPath).size`. If `wavFileSizeBytes > 24_000_000` (24 MB safety margin below Whisper's 25 MB hard limit) → chunk mode. Otherwise single upload. Duration is used only for UX display and cost estimation, **not** as a chunk trigger.

**Chunking strategy**:

```
1. stat(audio.wav) → wavFileSizeBytes
   if wavFileSizeBytes <= 24_000_000: single-upload path (see below)

2. Divide into N × 15-minute segments using ffmpeg:
     ffmpeg -i audio.wav -f segment -segment_time 900
            -c copy sessions/{id}/chunks/chunk_%03d.wav
   (stream-copy, no re-encode — fast, no quality loss)

3. Transcribe each chunk sequentially:
     chunk_000.wav → TranscriptSegment[]  (offset = 0ms)
     chunk_001.wav → TranscriptSegment[]  (offset = 900_000ms)
     chunk_002.wav → TranscriptSegment[]  (offset = 1_800_000ms)

4. Apply offset to every segment:
     segment.startMs += chunkIndex * CHUNK_DURATION_MS
     segment.endMs   += chunkIndex * CHUNK_DURATION_MS

5. Deduplicate overlap segments (optional guard — see below)

6. Merge all segment arrays → single TranscriptSegment[]

7. Delete chunks/ directory after merge
```

**Memory usage**: each chunk is read as a stream for upload; the merged segment array is the only in-memory structure. Peak RAM ≈ single chunk size (~15 MB WAV slice) + segment JSON.

**API retry policy (v1.3.0)**:

Each Whisper API call is wrapped in an exponential backoff retry loop. See §17.2 for full design.

```
Trigger conditions:
  HTTP 429 (rate limit)
  HTTP 500–599 (server error)
  Network timeout (>30s no response)

Retry schedule:
  Attempt 1 → immediate
  Attempt 2 → wait 2s
  Attempt 3 → wait 4s
  Attempt 4 → wait 8s   (4th = final)
  After 4 attempts → throw; pipeline step marked 'error'

Heartbeat: emits session:status { retryAttempt: N } so UI can display "Retrying…"
Non-retryable errors: HTTP 400, 401, 413 (bad request, auth, file too large) → fail immediately
```

**Deduplication (v1.2.2 — optional guard)**:

Chunks are created with **no audio overlap** (ffmpeg segment muxer, stream-copy). Because cuts happen at exact 15-minute boundaries, boundary-crossing words may be split between two chunks, but genuine duplicate segments do not occur in normal operation. Deduplication is therefore an **optional defensive guard** against unusual Whisper output, not a required pipeline step:

```
After merging all offset-adjusted segments into a flat array,
sort by startMs ascending.

For each pair of consecutive segments (A, B):
  if abs(B.startMs - A.startMs) <= 3000ms:
    normalizedA = normalize(A.text)   // lowercase, strip punctuation
    normalizedB = normalize(B.text)
    similarity = levenshteinSimilarity(normalizedA, normalizedB)
    if similarity >= 0.95:            // near-exact or exact text match
      keep A (earlier), drop B
```

`levenshteinSimilarity(a, b) = 1 - (editDistance(a,b) / max(len(a), len(b)))`

This guard is triggered only when Whisper produces near-identical text within a 3-second window at a chunk boundary — a rare edge case, not the common path.

**Single-chunk path** (WAV ≤ 24 MB): no chunking, direct upload. No dedup needed.

**Input**:
- `.pcm` (realtime): adds RIFF WAV header in-memory before upload
- `.wav` (import): reads directly

**Language hint**: `ja` / `en` / `vi` (multi → omit hint, auto-detect)

### MediaService (updated v1.3.0 — watchdog)

Wraps `ffmpeg` child process for audio extraction and conversion. Binary resolved at runtime from `ffmpeg-static` package path (see §12).

```
probe(filePath): Promise<MediaProbeResult>
  Runs: ffprobe -v quiet -print_format json -show_format -show_streams <file>
  Returns: { durationMs, hasAudio, hasVideo, format, audioCodec, sampleRate, channels }
  Used by: renderer (media:probe IPC) before import to validate + show duration

extractAudio(videoPath, outWavPath): Promise<void>
  Runs: ffmpeg -i <videoPath> -vn -acodec pcm_s16le -ar 16000 -ac 1 -y <outWavPath>
  Streams output directly to disk, no RAM buffer
  Emits progress via ipcMain.send('session:status', { step:'prepare_audio', progress:N })

convertTo16kMonoWav(audioPath, outWavPath): Promise<void>
  Runs: ffmpeg -i <audioPath> -acodec pcm_s16le -ar 16000 -ac 1 -y <outWavPath>
  Handles: mp3, m4a, aac, ogg, flac, wav (re-samples if needed)
  Same progress emission as extractAudio

Errors:
  ffmpeg not found     → throw FfmpegNotFoundError (maps to error code 'FFMPEG_MISSING')
  no audio stream      → throw NoAudioStreamError  (maps to error code 'NO_AUDIO_STREAM')
  ffmpeg exit non-zero → throw FfmpegError with stderr snippet
```

Progress is parsed from ffmpeg `time=HH:MM:SS.xx` stderr output and expressed as `(currentMs / totalMs) * 100`.

**Child process watchdog (v1.3.0)**: See §17.3. If ffmpeg produces no stderr progress for 10 minutes, the watchdog kills the process and marks the step as error.

### LangDetectService (unchanged)
```
detectLang(text):
  CJK codepoints > 10% of chars → 'ja'
  Vietnamese diacritics count > 2 OR > 4% → 'vi'
  else → 'en'

detectAll(segments[]):
  applied only when segment.lang is 'multi' or 'none'
  inherits previous segment lang if isolated ambiguous text
```

### TranslationService (unchanged for import)
- Realtime only: DeepL → GPT-4o-mini fallback (not applied during import post-processing)
- LRU cache: 300 entries

### NormalizationService (unchanged)

**Phase 1 — Rule Engine (always runs)**

| Class | Examples | Remove condition |
|-------|----------|-----------------|
| `always` | um, uh, うん, ừm | Unconditional |
| `sentence_initial` | えっと, so, thì | First token only |
| `isolated` | はい, right, ừ | Entire segment = filler |

**Phase 2 — LLM Rewrite (optional)**
- Trigger: word count > 8 AND filler density > 15%
- Batches up to 20 segments per GPT-4o-mini call, grouped by `detectedLang`

### SummarizationService (updated — v1.3.0: prose-based pipeline)

A full 2-hour meeting transcript can exceed 100k tokens — unsafe and costly to send to GPT-4o directly. SummarizationService uses a two-pass hierarchical strategy.

**Token estimation**: 1 Japanese/Chinese character ≈ 1.5 tokens; 1 English word ≈ 1.3 tokens. Estimated at normalization step to route correctly.

**Routing decision**:

| Transcript tokens | Strategy |
|-------------------|----------|
| ≤ 12,000 | **Direct** — single GPT-4o call (existing behaviour) |
| > 12,000 | **Hierarchical** — prose-based two-pass (see below) |

**Hierarchical prose pipeline (updated v1.3.0)**:

```
Pass 1 — Chunk summarization (GPT-4o-mini, sequential)
  Split normalized transcript into blocks of ~8,000 tokens
  For each block:
    Prompt: "Summarize this meeting segment as concise prose.
             Capture: key points, decisions made, action items, and any risks.
             Preserve nuance — do not omit minority opinions or unresolved items."
    Model: gpt-4o-mini, temperature: 0, max_tokens: 600
    → ChunkSummary (free-form prose paragraph)
  Result: N × ChunkSummary (total tokens << original transcript)

[Reduction Pass — triggered only if concat(ChunkSummaries) > 12,000 tokens]
  Prompt: "Compress the following meeting segment summaries into shorter prose.
           Preserve all decisions, action items, and risks.
           Do not impose structure — output as flowing paragraphs only."
  Model: gpt-4o-mini, temperature: 0, max_tokens: 1200
  → ReducedSummary (prose, ≤ 4,000 tokens)

Pass 2 — Structured minutes (GPT-4o)
  Input: ChunkSummaries or ReducedSummary (prose)
  Prompt: "Based on these meeting summaries, extract the structured minutes.
           Output strictly as JSON matching the provided schema."
  Model: gpt-4o, temperature: 0, max_tokens: 1024
  Response format: json_schema (strict mode — same schema as before)
  → MeetingMinutes JSON
```

**Rationale for prose-based pipeline (v1.3.0)**:
- Forcing bullet structure in the Reduction Pass caused GPT-4o to hallucinate omissions — items that did not fit the four-section format were silently dropped.
- Prose summaries preserve meeting nuance and minority positions that bullets tend to flatten.
- Structured extraction (decisions, todos, risks, next actions) happens only once, at the final GPT-4o pass, where the model has full schema context and output constraints.

**API retry policy (v1.3.0)**: All GPT API calls in Pass 1, Reduction Pass, and Pass 2 use exponential backoff identical to BatchSttService. See §17.2.

**Token budget per request**:

| Call | Model | Input budget | Output budget |
|------|-------|-------------|---------------|
| Pass 1 chunk | gpt-4o-mini | 8,000 tokens | 600 tokens |
| Reduction Pass | gpt-4o-mini | up to 12,000 tokens | 1,200 tokens |
| Pass 2 final | gpt-4o | ~4,000 tokens | 1,024 tokens |

**Cost control**:
- Pass 1 uses gpt-4o-mini (10× cheaper than gpt-4o)
- Reduction Pass uses gpt-4o-mini only when needed (> 12k combined summaries)
- Only Pass 2 uses gpt-4o, with a small, bounded input

**Failure fallback**:
- If any Pass 1 chunk fails after max retries: include raw (un-summarized) segment text for that block, continue
- If Pass 2 fails: return empty MeetingMinutes with `purpose` = error message (same as before)
- Partial results are still saved to `minutes.json`; UI indicates degraded quality

**JSON schema** (unchanged): `purpose`, `decisions[]`, `todos[]`, `concerns[]`, `next_actions[]`

**Model**: gpt-4o for Pass 2, `temperature: 0`, response format: `json_schema` strict

**Pass summary chain**:

```
Long transcript:   Chunks → [Pass 1: prose summaries]
                                          ↓ (if > 12k tokens)
                                    [Reduction Pass: prose compression]
                                          ↓
                              [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes

Short transcript:  Direct → [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes
```

### PostMeetingService (updated)

Accepts an optional `audioPath` override for import sessions:

```
postMeetingService.run(sessionId, opts?: { audioPath?: string })
  audioPath defaults to fileStore.getAudioForWhisper(sessionId)
  All 5 pipeline steps unchanged
  Each step prefixed by checkpoint write, suffixed by checkpoint update
  Emits session:status per step
  Each API-calling step wrapped in exponential backoff retry (§17.2)
```

### AutoCleanupService (new — v1.3.0)

Runs on app startup. Scans all sessions older than `StorageSettings.autoCleanupDays`.

```
autoCleanupService.run(dryRun?: boolean): CleanupReport
  for each session where:
    session.status === 'done'
    AND (now - session.createdAt) > autoCleanupDays * 86_400_000ms

  Delete derived files:
    audio.wav          (large — typically 50–200 MB for 1–2h import)
    chunks/            (transient, should already be gone after pipeline)
    transcript.jsonl   (recoverable from audio if needed)
    normalized.json    (recoverable from transcript)

  Keep:
    minutes.json       (primary user value — kept always)
    export.md          (primary user value — kept always)
    source/            (archived source file — only if copySourceFile was true)
    audio.pcm          (realtime raw capture — optional, see StorageSettings.fullPurge)

CleanupReport: { scannedCount, cleanedCount, freedBytes, errors[] }
```

If `autoCleanupDays = 0`, auto-cleanup is disabled. The user can also trigger cleanup manually via Settings. See §17.1 for full design.

### ExportService (unchanged)
Deterministic Markdown render (no LLM).

---

## 6. Data Storage

All **metadata** stored at `%APPDATA%/mtg-assistant/` (Windows) or `~/Library/Application Support/mtg-assistant/` (macOS). **Session data** stored under `{storageRoot}/sessions/` which defaults to the same path but is user-configurable.

```
userData/                             ← always at %APPDATA%/mtg-assistant/
├── settings.json                     # AppSettings (device IDs, UI lang, storageRoot, etc.)
├── vault.enc                         # Encrypted fallback key store (AES-256-GCM)
├── app.json                          # Session index (SessionMeta[])
└── logs/
    └── app.log                       # Structured log, rotated at 5 MB

{storageRoot}/sessions/               ← configurable (default = userData)
└── {uuid}/
    ├── source/                       # Import only — present if copySourceFile=true
    │   └── {originalFilename}        # Archived copy of source file
    ├── chunks/                       # Transient — deleted after merge
    │   ├── chunk_000.wav
    │   └── chunk_001.wav ...
    ├── audio.pcm                     # Realtime: Raw PCM16 16kHz mono
    ├── audio.wav                     # Import: 16kHz mono WAV from ffmpeg
    ├── pipeline.json                 # Pipeline checkpoint (atomic write)
    ├── transcript.jsonl              # TranscriptSegment[] (one JSON per line)
    ├── normalized.json               # NormalizedSegment[]
    ├── minutes.json                  # MeetingMinutes (structured) ← kept by cleanup
    └── export.md                     # Markdown export              ← kept by cleanup
```

**Storage location rationale**: Metadata files (`app.json`, `settings.json`, `vault.enc`, `logs/`) are small (< 10 MB total) and always remain in `userData` for reliable access. Session audio and transcript files are large (tens to hundreds of MB per session) and live under `storageRoot` which the user can redirect to an external drive or NAS. See §17.1.

**`vault.json` → `vault.enc` migration** (v1.2.0): Primary key storage moves to OS keychain via `keytar`. `vault.enc` is the encrypted fallback for environments where keytar is unavailable (rare). See §16.4 for full security design.

If `vault.json` from a previous version is detected on startup, it is automatically migrated to keytar + deleted. See §16.4.

`audio.pcm` and `audio.wav` are mutually exclusive per session. `fileStore.getAudioForWhisper(sessionId)` resolves whichever exists.

### `pipeline.json` schema

Written atomically (write to `.tmp`, then `fs.rename`) to prevent corruption on crash.

```json
{
  "sessionId": "uuid",
  "step": "normalizing",
  "status": "pending",
  "completedSteps": ["batch_stt", "lang_detect"],
  "error": null,
  "updatedAt": 1709500000000
}
```

Steps (ordered): `prepare_audio` → `batch_stt` → `lang_detect` → `normalizing` → `summarizing` → `exporting` → `done`

`prepare_audio` only exists for import sessions. Realtime sessions start from `batch_stt`.

---

## 7. TypeScript Interface Updates

Changes to `shared/types.ts` (diff-friendly — only additions shown):

```typescript
// ── Existing (unchanged) ────────────────────────────────────────────
type LangCode = 'ja' | 'vi' | 'en' | 'multi' | 'none';
type SessionStatus = 'recording' | 'processing' | 'done' | 'error' | 'error_recoverable';

// ── Updated SessionMeta (v1.3.0 additions) ──────────────────────────
interface SessionMeta {
  id: string; title: string; lang: LangCode; targetLang: LangCode;
  createdAt: number; status: SessionStatus;

  // v1.1.0 fields
  inputType:            'realtime' | 'import';
  sourceFileName?:      string;             // original filename (display only)
  durationMs?:          number;             // total audio duration in ms
  audioFormat?:         'pcm' | 'wav';      // which audio file is present

  // v1.3.0 fields ← NEW
  sourceAbsolutePath?:  string;             // original file path on user's filesystem
  sourceArchivedPath?:  string;             // path inside sessions/{id}/source/ if copied
  diskUsageBytes?:      number;             // estimated size of all session files (cached)
}

// ── New: Import payload ─────────────────────────────────────────────
interface ImportPayload {
  title:       string;
  sourcePath:  string;              // absolute path on user's filesystem
  sourceType:  'audio' | 'video';
  lang?:       LangCode;
  targetLang?: LangCode;
}

// ── New: MediaProbeResult ───────────────────────────────────────────
interface MediaProbeResult {
  durationMs:  number;
  hasAudio:    boolean;
  hasVideo:    boolean;
  format:      string;
  audioCodec?: string;
  sampleRate?: number;
  channels?:   number;
}

// ── New: Pipeline checkpoint ────────────────────────────────────────
type PipelineStep =
  | 'prepare_audio'
  | 'batch_stt'
  | 'lang_detect'
  | 'normalizing'
  | 'summarizing'
  | 'exporting'
  | 'done';

interface PipelineState {
  sessionId:       string;
  step:            PipelineStep;
  status:          'pending' | 'running' | 'done' | 'error';
  completedSteps:  PipelineStep[];
  error?:          string | null;
  updatedAt:       number;
}

// ── New: Storage settings (v1.3.0) ──────────────────────────────────
interface StorageSettings {
  storageRootPath:      string;    // default = app.getPath('userData')
  allowExternalStorage: boolean;   // if false, warn on non-userData paths
  autoCleanupDays:      number;    // 0 = disabled; default 30
  copySourceFile:       boolean;   // archive source file locally; default false
}

// ── New: Storage stats (v1.3.0) ─────────────────────────────────────
interface StorageStats {
  storageRootPath:    string;
  totalSessions:      number;
  totalDiskBytes:     number;     // sum of all session file sizes
  freeBytesOnVolume:  number;     // free space on the volume containing storageRoot
  perSession:         Array<{ sessionId: string; bytes: number; title: string }>;
}

// ── New: Cleanup report (v1.3.0) ─────────────────────────────────────
interface CleanupReport {
  scannedCount: number;
  cleanedCount: number;
  freedBytes:   number;
  errors:       Array<{ sessionId: string; message: string }>;
  dryRun:       boolean;
}

// ── Updated AppSettings ──────────────────────────────────────────────
interface AppSettings {
  // existing fields...
  inputDeviceId?:   string;
  uiLang:           'ja' | 'en' | 'vi';
  whisperLangHint?: LangCode;
  // v1.3.0 additions:
  storage:          StorageSettings;
}

// ── Existing (unchanged) ────────────────────────────────────────────
interface TranscriptSegment { /* ... */ }
interface NormalizedSegment { /* ... */ }
interface MeetingMinutes    { /* ... */ }
```

---

## 8. UI / Routing

### Routes

```
/                     → Dashboard      (session list + Import button)
/session/setup        → SessionSetup   (new realtime meeting form)
/session/import       → ImportScreen   (file picker + metadata)
/session/:id/live     → LiveSession    (recording view)
/session/:id          → PostMeeting    (results + progress + retry)
/settings             → Settings       (API keys + prefs + storage)  ← updated v1.3
```

### Dashboard (updated v1.3.0 — disk warning banner)

When `storage:warning` IPC push is received (free space < 5 GB on `storageRoot` volume):

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠ ストレージの空き容量が少なくなっています (残 3.2 GB)             │
│   設定でストレージ先を変更するか、古いセッションを削除してください。 │
│                                              [設定を開く] [閉じる]│
└─────────────────────────────────────────────────────────────────┘
```

### ImportScreen (unchanged from v1.1.0)

### PostMeeting (updated — retry banner extended for backoff)

**Processing with retry** — shown when `session:status` includes `retryAttempt`:

```
┌─────────────────────────────────────────────────────┐
│  処理中 / Processing...                              │
│  ─────────────────────────────────────────────────  │
│  ✓  prepare_audio   完了                             │
│  ⟳  batch_stt       再試行中 (2/4) … 4秒後に再開    │
│  ○  normalizing     待機中                           │
│  ○  summarizing     待機中                           │
│  ○  exporting       待機中                           │
└─────────────────────────────────────────────────────┘
```

**Error state**, **Resume banner**: unchanged from v1.2.0.

### Settings (updated v1.3.0 — Storage section)

New **Storage** section added below API Keys:

```
┌──────────────────────────────────────────────────────────────┐
│  ストレージ設定 / Storage Settings                            │
│  ─────────────────────────────────────────────────────────── │
│  保存先フォルダ                                               │
│  [C:\Users\...\AppData\Roaming\mtg-assistant _______] [変更] │
│  空き容量: 42.3 GB                                           │
│                                                              │
│  ☐ ソースファイルをローカルにアーカイブする                     │
│     (有効にすると元ファイルを削除しても再処理できます)           │
│                                                              │
│  古いファイルの自動削除: [30] 日後  (0 = 無効)                │
│     削除対象: audio.wav, chunks/, transcript, normalized      │
│     保持: minutes.json, export.md                            │
│                                                              │
│  使用容量: 2.4 GB (12 sessions)         [今すぐクリーンアップ] │
│  ─────────────────────────────────────────────────────────── │
│  [セッション別の使用容量を表示]                                 │
└──────────────────────────────────────────────────────────────┘
```

**Storage per-session breakdown** (expandable panel):

```
┌─────────────────────────────────────────────────────────────┐
│  セッション別ストレージ                                        │
│  ─────────────────────────────────────────────────────────  │
│  プロダクトレビュー (2026-03-01)       1.2 GB  [削除]        │
│  チームスタンドアップ (2026-02-28)       82 MB  [削除]        │
│  …                                                           │
└─────────────────────────────────────────────────────────────┘
```

---

## 9. Error Handling & UX

| Scenario | Behaviour |
|----------|-----------|
| ffmpeg binary not found | Error code `FFMPEG_MISSING` → toast: "ffmpeg が見つかりません。アプリを再インストールしてください。" + link to docs |
| Video file has no audio stream | Error code `NO_AUDIO_STREAM` → shown in ImportScreen inline (probe response `hasAudio: false`) before import starts |
| Unsupported file format | File dialog filter prevents selection; if bypassed, ffprobe returns error → shown on probe |
| Whisper API failure (persistent) | After 4 retry attempts with backoff: pipeline pauses at `batch_stt`, writes error to `pipeline.json`, emits `session:status` with `status:'error'` → retry button in PostMeeting |
| GPT rate limit / timeout | Same retry + backoff pattern for `normalizing` and `summarizing` steps |
| Import of long audio (WAV > 24 MB after conversion) | `BatchSttService` checks `wavFileSizeBytes` post-conversion; chunk mode triggered; all segments merged with correct offsets; dedup guard runs (no-op in normal case); timestamps correct |
| App crash mid-ffmpeg | ffmpeg child process dies with app; `pipeline.json` will still show `prepare_audio: pending` → recoverable on restart |
| Disk full during conversion | ffmpeg exits non-zero; caught → `FfmpegError` → error state in PostMeeting |
| Source file moved (no-copy mode) | `prepare_audio` fails: `sourceAbsolutePath` not found → error shown with path + option to re-import from new location |
| storageRoot volume < 5 GB free | `storage:warning` push → dismissible banner in Dashboard + Dashboard metric; import blocked if < 500 MB free |
| PipelineLock timeout (ffmpeg hang) | Watchdog kills child process after 10 min no progress → lock released → step marked 'error' |

---

## 10. Crash Recovery

### On App Startup

`electron/main.ts` runs a recovery scan before rendering:

```
1. sessionStore.getAll()
2. for each session where status === 'processing':
     read pipeline.json
     if pipeline.json missing or step === 'prepare_audio':
       mark status = 'error_recoverable'
       error = 'App closed during audio preparation — re-import required'
     else:
       mark status = 'error_recoverable'
       error = 'App closed during pipeline step: {step}'
3. sessionStore.save()
4. autoCleanupService.run()    ← NEW v1.3 — runs after recovery scan
5. diskMonitor.start()         ← NEW v1.3 — periodic free-space check
```

### SessionStatus update

```typescript
type SessionStatus = 'recording' | 'processing' | 'done' | 'error' | 'error_recoverable';
```

### In PostMeeting

When `status === 'error_recoverable'`, show a **Resume** banner:

```
┌──────────────────────────────────────────────────────┐
│  ⚡ 前回の処理を再開できます                          │
│  最後の完了ステップ: batch_stt                        │
│                [lang_detect から再開]                 │
└──────────────────────────────────────────────────────┘
```

Resume calls `session:retryStep` with the next incomplete step. The pipeline resumes from the checkpoint — already-completed steps (with their output files present) are skipped.

**Step idempotency (v1.2.1 — content validation)**: before running a step, check if its output file exists **and passes content validation**. File existence alone is not sufficient — a crash mid-write can leave a partial or corrupt file. If validation fails, treat the step as incomplete and re-run it.

| Step | Output file | Validation rule |
|------|-------------|-----------------|
| `batch_stt` | `transcript.jsonl` | Every line must `JSON.parse` without error; file must have ≥ 1 line |
| `lang_detect` | `transcript.jsonl` | Same as above, plus every parsed object must have a `detectedLang` field |
| `normalizing` | `normalized.json` | `JSON.parse` succeeds; result is a non-empty array |
| `summarizing` | `minutes.json` | `JSON.parse` succeeds; result has all required top-level keys: `sessionId`, `generatedAt`, `language`, `data`; `data` has keys `purpose`, `decisions`, `todos`, `concerns`, `next_actions` |
| `exporting` | `export.md` | File size ≥ 100 bytes |

Validation failures are logged at `warn` level with the session ID and step name. The step is re-queued from scratch — no partial output is used.

---

## 11. Services — File Reference (updated)

```
electron/services/
├── stt.service.ts              Deepgram realtime WebSocket (unchanged)
├── batch-stt.service.ts        Whisper batch + retry policy  ← updated v1.3
├── lang-detect.service.ts      Unicode heuristic (unchanged)
├── translation.service.ts      DeepL + GPT router (unchanged)
├── normalization.service.ts    Rule + LLM normalization (unchanged)
├── summarization.service.ts    GPT-4o minutes — prose pipeline  ← updated v1.3
├── post-meeting.service.ts     Pipeline orchestrator  ← updated (checkpoint + retry)
├── export.service.ts           Markdown renderer (unchanged)
├── media.service.ts            ffmpeg/ffprobe wrapper + watchdog  ← updated v1.3
└── auto-cleanup.service.ts     Derived file cleanup  ← NEW v1.3
```

---

## 12. Build & Run

```bash
# Development
node scripts/dev.js

# Production build
electron-vite build && electron-builder

# Kill dev instance (Windows)
powershell.exe -Command "Get-Process -Name 'electron' | Stop-Process -Force"
```

### ffmpeg Packaging

**Recommended approach: `ffmpeg-static` npm package**

`ffmpeg-static` ships pre-compiled static ffmpeg binaries for Windows (x64), macOS (x64/arm64), and Linux (x64). The binary path is resolved at runtime:

```
const ffmpegPath = require('ffmpeg-static');
// → e.g. node_modules/ffmpeg-static/bin/win32/x64/ffmpeg.exe
```

For production builds, `electron-builder` must be configured to include the binary via `extraResources` or `asarUnpack`:

```json
// electron-builder config
"asarUnpack": ["node_modules/ffmpeg-static/**/*"],
"extraResources": []
```

At runtime in the packaged app, the path is resolved relative to `process.resourcesPath`.

**`ffprobe`** (needed for `media:probe`) is **not** included in `ffmpeg-static`. Use `ffprobe-static` package separately, same packaging approach.

**Licensing note**: The `ffmpeg-static` binary is built with LGPL configuration by default (no GPL codecs). This is sufficient for the input formats supported (wav, mp3, m4a, mp4, mov). If additional codec support is required in future (e.g., WMV), a GPL build would be needed and must be disclosed to end users. See [ffmpeg.org/legal.html](https://ffmpeg.org/legal.html).

**Code-signing requirement (v1.3.0)**: Both the Electron app executable and the ffmpeg/ffprobe binaries must be code-signed in production builds. See §17.5 for the full CI/CD code-signing design.

### Build Output (updated)

```
out/
├── main/index.js         # Electron main (CJS)
├── preload/index.js      # Context bridge
├── renderer/             # Vite built React app
└── resources/
    └── ffmpeg(.exe)      # Unpacked from asar — must be code-signed
    └── ffprobe(.exe)     # Unpacked from asar — must be code-signed
```

---

## 13. File Reference (updated)

```
electron/
├── main.ts                        App entry, BrowserWindow, startup recovery + cleanup
├── preload.ts                     window.api context bridge
├── ipc/
│   ├── session.ipc.ts             Session lifecycle handlers (unchanged)
│   ├── session.import.ipc.ts      Import session handler
│   ├── audio.ipc.ts               PCM chunk receiver (unchanged)
│   ├── settings.ipc.ts            Settings + API key CRUD (unchanged)
│   ├── storage.ipc.ts             Storage stats, set root, cleanup  ← NEW v1.3
│   └── export.ipc.ts              Markdown export trigger (unchanged)
├── services/
│   ├── stt.service.ts             Deepgram realtime WebSocket
│   ├── batch-stt.service.ts       Whisper batch + retry policy  ← updated v1.3
│   ├── lang-detect.service.ts     Unicode heuristic lang detection
│   ├── translation.service.ts     DeepL + GPT translation router
│   ├── normalization.service.ts   Rule + LLM text normalization
│   ├── summarization.service.ts   GPT-4o minutes — prose pipeline  ← updated v1.3
│   ├── post-meeting.service.ts    Pipeline orchestrator  ← updated
│   ├── export.service.ts          Markdown renderer
│   ├── media.service.ts           ffmpeg/ffprobe wrapper + watchdog  ← updated v1.3
│   └── auto-cleanup.service.ts    Derived file cleanup  ← NEW v1.3
├── store/
│   ├── session.store.ts           Session index (app.json)  ← updated types
│   ├── file.store.ts              Per-session file ops  ← updated (storageRoot)
│   └── secret.store.ts            API key vault (unchanged)
└── utils/
    ├── paths.ts                   userData + storageRoot path helpers  ← updated
    ├── logger.ts                  Structured NDJSON logger (unchanged)
    ├── disk-monitor.ts            Free-space poller  ← NEW v1.3
    └── retry.ts                   Exponential backoff helper  ← NEW v1.3

renderer/src/
├── App.tsx                        React Router setup
├── main.tsx                       Entry point
├── screens/
│   ├── Dashboard.tsx              ← updated (disk warning banner)
│   ├── SessionSetup.tsx           (unchanged)
│   ├── ImportScreen.tsx           File picker + metadata form
│   ├── LiveSession.tsx            (unchanged)
│   ├── PostMeeting.tsx            ← updated (retry progress display)
│   └── Settings.tsx               ← updated (storage section)
├── components/
│   ├── Layout.tsx                 Sidebar + nav (unchanged)
│   ├── SessionCard.tsx            ← updated (diskUsageBytes display)
│   ├── StatusBadge.tsx            (unchanged)
│   ├── PipelineProgress.tsx       ← updated (retryAttempt display)
│   └── StorageStats.tsx           Per-session disk usage panel  ← NEW v1.3
├── hooks/
│   ├── useIpc.ts                  IPC event subscriptions
│   └── useAudioCapture.ts         AudioWorklet + AGC (unchanged)
├── store/
│   ├── sessionStore.ts            (unchanged)
│   └── captionStore.ts            (unchanged)
└── i18n/
    ├── index.tsx                  I18nProvider + useT()
    └── locales.ts                 ← updated (storage + retry strings)

shared/
└── types.ts                       ← updated (StorageSettings, StorageStats, CleanupReport)
```

---

## 14. Theme (unchanged)

Dark theme defined in `tailwind.config.js`:

| Token | Value | Usage |
|-------|-------|-------|
| `bg` | `#0f1117` | App background |
| `surface` | `#161b2e` | Sidebar, cards |
| `surface-2` | `#1d2540` | Inputs, secondary areas |
| `border` | `#252d47` | Dividers |
| `text-primary` | `#e2e8f0` | Main text |
| `text-muted` | `#64748b` | Secondary text |
| `text-dim` | `#94a3b8` | Labels |
| `accent` | `#6366f1` | Primary buttons, active nav |
| `accent-hover` | `#4f46e5` | Button hover |

---

## 15. Implementation Checklist (File-level Plan)

Step-by-step plan to implement Import mode without breaking realtime. (v1.1.0 plan — unchanged. See §17 for v1.3.0 additions.)

---

### A — UI

#### A1. Dashboard — Import button

**Goal**: Surface import entry point alongside existing New Meeting button.

**Files to modify**:
- `renderer/src/screens/Dashboard.tsx`

**Changes**:
- Add secondary button "インポート / Import / Nhập" next to existing new-session CTA
- `onClick` → `navigate('/session/import')`
- Add import-related strings to `renderer/src/i18n/locales.ts`:
  - `nav.import`, `dashboard.importBtn`

**IPC channels touched**: none

**Acceptance criteria**:
- Button visible on Dashboard in all 3 UI languages
- Clicking navigates to `/session/import`
- Existing New Meeting button unaffected

---

#### A2. ImportScreen — `/session/import`

**Goal**: Allow user to select a file, validate it, fill metadata, and kick off import.

**Files to create**:
- `renderer/src/screens/ImportScreen.tsx`

**Files to modify**:
- `renderer/src/App.tsx` — add route `<Route path="/session/import" element={<ImportScreen />} />`
- `renderer/src/i18n/locales.ts` — add `import.*` string keys
- `renderer/src/components/Layout.tsx` — no change needed (route handled by router)

**Key logic**:
- File open dialog via `window.api.dialog.openFile(['wav','mp3','m4a','mp4','mov'])` (requires new preload binding or reuse Electron's dialog API)
- On file chosen: call `window.api.media.probe(filePath)` → display duration, show error if `!hasAudio`
- Form fields: title (required), lang (optional, default blank = auto), targetLang (optional)
- Submit: `window.api.session.import({ title, sourcePath, sourceType, lang, targetLang })` → navigate to `/session/:id`

**IPC channels touched**: `media:probe`, `session:import`

**Acceptance criteria**:
- File picker filters to supported extensions
- Duration and format shown after probe
- "No audio stream" error blocks submission
- Valid import navigates to PostMeeting with status = processing

---

#### A3. PostMeeting — Progress panel + Retry/Resume

**Goal**: Show live pipeline progress for processing sessions; allow retry of failed steps.

**Files to modify**:
- `renderer/src/screens/PostMeeting.tsx`

**Files to create**:
- `renderer/src/components/PipelineProgress.tsx`

**Key logic**:
- Subscribe to `session:status` IPC events (extend `useLiveIpc` or add dedicated hook)
- Render `PipelineProgress` when `session.status === 'processing' || 'error' || 'error_recoverable'`
- Each step shown as: waiting / running (with progress %) / done / error
- Retry button: `window.api.session.retryStep({ sessionId, step })`
- Resume banner for `error_recoverable`: "Resume from {nextStep}"
- Hide progress panel when `status === 'done'`; show tabs normally

**IPC channels touched**: `session:status`, `session:retryStep`

**Acceptance criteria**:
- Steps light up in order during processing
- Error state shows which step failed and error message
- Retry button re-runs only from the failed step onward
- Resume works after app restart (recoverable session shows banner)

---

### B — Main Process

#### B1. `session.import.ipc.ts` — Import handler

**Goal**: New IPC handler for `session:import` and `session:retryStep` channels.

**Files to create**:
- `electron/ipc/session.import.ipc.ts`

**Files to modify**:
- `electron/main.ts` — register new IPC module

**Key functions**:
```
handleImport(payload: ImportPayload): Promise<{ sessionId }>
  1. sessionStore.create({ ...meta, inputType:'import', status:'processing' })
  2. fileStore.copySource(sessionId, sourcePath)  [if copySourceFile=true]
  3. Run media conversion (MediaService)
  4. Kick off postMeetingService.run(sessionId) — async, do NOT await in handler
  5. Return { sessionId } immediately so renderer can navigate

handleRetryStep({ sessionId, step }): Promise<void>
  Read pipeline.json, validate step is retryable, call postMeetingService.runFrom(sessionId, step)

handleMediaProbe({ filePath }): Promise<MediaProbeResult>
  Delegates to mediaService.probe(filePath)
```

**IPC channels touched**: `session:import`, `session:retryStep`, `media:probe`

**Acceptance criteria**:
- `session:import` returns `sessionId` within ~200ms (async processing runs in background)
- `session:retryStep` resumes from correct step, skips completed steps
- Errors return typed error codes, not raw exceptions

---

#### B2. `media.service.ts` — ffmpeg wrapper

**Goal**: Encapsulate all ffmpeg/ffprobe interactions. No other service touches the binary.

**Files to create**:
- `electron/services/media.service.ts`
- `electron/utils/ffmpeg-path.ts` — resolve binary path for dev vs packaged

**Key functions**:
```
probe(filePath): Promise<MediaProbeResult>
extractAudio(videoPath, outWavPath, onProgress?): Promise<void>
convertTo16kMonoWav(audioPath, outWavPath, onProgress?): Promise<void>
```

**Implementation notes**:
- Use Node `child_process.spawn`, not `exec` — avoids shell injection
- Parse ffprobe JSON output with `JSON.parse`
- Parse ffmpeg stderr `time=HH:MM:SS.xx` for progress
- Write output to `.tmp` file first, rename on success — prevents partial files
- Kill child process cleanly on `SIGTERM` (app quit mid-conversion)

**IPC channels touched**: emits `session:status` progress events

**Acceptance criteria**:
- `probe` correctly returns `hasAudio: false` for video-only files
- `extractAudio` produces 16kHz mono WAV from MP4 without loading file into RAM
- `convertTo16kMonoWav` produces correct WAV from MP3/M4A input
- App quit mid-conversion leaves no partial `audio.wav` (tmp rename strategy)
- Error when ffmpeg missing: throws `FfmpegNotFoundError`

---

#### B3. `post-meeting.service.ts` — Checkpoint support

**Goal**: Write/read `pipeline.json` at each step boundary; support `runFrom(sessionId, step)`.

**Files to modify**:
- `electron/services/post-meeting.service.ts`

**Key functions**:
```
run(sessionId, opts?): Promise<void>          // full pipeline
runFrom(sessionId, startStep): Promise<void>  // partial pipeline (retry/resume)
writeCheckpoint(sessionId, state): Promise<void>
readCheckpoint(sessionId): Promise<PipelineState | null>
```

**Step skip logic** (idempotency):
- Before running `batch_stt`: check `transcript.jsonl` exists and size > 0
- Before `normalizing`: check `normalized.json` exists
- Before `summarizing`: check `minutes.json` exists
- Before `exporting`: check `export.md` exists

**IPC channels touched**: emits `session:status` per step

**Acceptance criteria**:
- `pipeline.json` written before each step starts
- On resume, completed steps are skipped (no duplicate Whisper calls)
- Atomic write (tmp → rename) prevents corrupt checkpoint

---

#### B4. `batch-stt.service.ts` — Accept WAV path

**Goal**: Decouple BatchSttService from PCM-only assumption.

**Files to modify**:
- `electron/services/batch-stt.service.ts`

**Key change**:
```
// Before (realtime only):
transcribe(sessionId, lang): Promise<TranscriptSegment[]>
  reads audio.pcm, adds RIFF header in-memory

// After:
transcribe(audioPath, lang, sessionId): Promise<TranscriptSegment[]>
  if audioPath.endsWith('.pcm'): add RIFF header in-memory
  if audioPath.endsWith('.wav'): read as-is
  if file > 24MB: chunk via ffmpeg, transcribe each, merge
```

**Files to modify** (caller):
- `electron/services/post-meeting.service.ts` — call `fileStore.getAudioForWhisper(sessionId)` to resolve path, pass to `transcribe()`

**Acceptance criteria**:
- Realtime sessions (`audio.pcm`) transcribed identically as before
- Import sessions (`audio.wav`) transcribed without PCM header insertion
- Files > 24MB are chunked and merged correctly

---

### C — Storage

#### C1. `file.store.ts` — Import file ops

**Goal**: Add methods for import-specific file operations.

**Files to modify**:
- `electron/store/file.store.ts`

**Key functions to add**:
```
copySource(sessionId, sourcePath): Promise<string>
  copies file to sessions/{id}/source/{basename}
  returns destination path

getAudioForWhisper(sessionId): string
  returns sessions/{id}/audio.wav  if exists
  returns sessions/{id}/audio.pcm  if exists
  throws if neither exists

writeWav(sessionId, wavPath): Promise<void>
  moves tmp wav into sessions/{id}/audio.wav

writePipeline(sessionId, state): Promise<void>
  atomic write to pipeline.json (.tmp → rename)

readPipeline(sessionId): Promise<PipelineState | null>
  returns null if file missing (new session)
```

**Acceptance criteria**:
- Source file preserved verbatim in `source/` subdirectory
- `getAudioForWhisper` works for both realtime and import sessions
- Atomic pipeline write survives app kill during write

---

### D — Types

#### D1. `shared/types.ts` — New interfaces

**Goal**: Add all v1.1.0 type definitions; maintain backward compat with realtime types.

**Files to modify**:
- `shared/types.ts`

**Additions** (as specified in §7):
- `SessionMeta.inputType`, `sourceFileName`, `audioFormat`
- `SessionStatus` — add `'error_recoverable'`
- `ImportPayload`
- `MediaProbeResult`
- `PipelineStep` union type
- `PipelineState`

**Files to verify after**:
- `electron/store/session.store.ts` — ensure it handles new optional fields gracefully
- `renderer/src/store/sessionStore.ts` — no breaking changes expected

**Acceptance criteria**:
- TypeScript compiler reports zero new errors in existing files
- `inputType` defaults to `'realtime'` for sessions created before v1.1.0 (via `?? 'realtime'` in store read)

---

### E — Packaging

#### E1. ffmpeg / ffprobe binaries

**Goal**: Ship ffmpeg and ffprobe binaries for all target platforms without build complexity.

**Approach**: Use `ffmpeg-static` and `ffprobe-static` npm packages.

**Files to modify**:
- `package.json` — add `ffmpeg-static`, `ffprobe-static` as `dependencies` (not devDependencies)
- `electron-builder` config — add `asarUnpack` rule
- `electron/utils/ffmpeg-path.ts` — runtime binary path resolver

**`ffmpeg-path.ts` logic**:
```
if (app.isPackaged):
  base = path.join(process.resourcesPath, 'app.asar.unpacked')
else:
  base = project root

ffmpegPath  = path.join(base, 'node_modules/ffmpeg-static/...')
ffprobePath = path.join(base, 'node_modules/ffprobe-static/...')
```

**Licensing**:
- `ffmpeg-static` uses LGPL build — compliant for WAV/MP3/AAC/H264 without source disclosure
- Add attribution to app's About screen: "This software uses FFmpeg (LGPL v2.1+)"
- If GPL build needed in future, update About screen and review distribution requirements

**Acceptance criteria**:
- Dev: `ffmpeg`/`ffprobe` resolve from `node_modules`
- Packaged: binaries unpacked from asar, path resolves correctly on Windows and macOS
- `MediaService` throws `FfmpegNotFoundError` if binary not found (not an unhandled crash)

---

### F — QA Scenarios

| # | Scenario | Expected result |
|---|----------|-----------------|
| F1 | Import MP3 ~10 min | Converts to WAV, Whisper transcribes, full pipeline runs, PostMeeting shows minutes |
| F2 | Import MP4 ~30 min with audio | Audio extracted, same pipeline, correct duration in SessionMeta |
| F3 | Import MP4 with no audio stream | `probe` returns `hasAudio: false`, Import button disabled, no session created |
| F4 | Import audio file where converted WAV > 24 MB (e.g., 2h MP3 → ~110 MB WAV) | `BatchSttService` checks `wavFileSizeBytes` post-conversion; chunk mode triggered; all segments merged with correct offsets; dedup guard runs (no-op in normal case); timestamps correct |
| F5 | Whisper API failure (network off) | Retry with backoff (4 attempts); after max attempts: status = error at `batch_stt`, retry button shown |
| F6 | App crash during `normalizing` | Relaunch: session shows `error_recoverable`, resume from `normalizing`, skips `batch_stt`/`lang_detect` |
| F7 | App crash during `prepare_audio` (ffmpeg running) | Relaunch: `audio.wav` absent or partial (tmp not renamed), session marked `error_recoverable` with message "re-import required" |
| F8 | Realtime recording (full flow) | Unchanged behavior — no regression |
| F9 | Realtime session + navigate away + return | REC badge persists, audio uninterrupted |
| F10 | Unsupported file extension bypassed | ffprobe returns codec error → error toast in ImportScreen |
| F11 | Import with `copySourceFile = false`, then original file moved | `prepare_audio` fails with path-not-found error; session shows re-import message |
| F12 | storageRoot volume drops below 5 GB | Dashboard warning banner appears; import blocked below 500 MB |
| F13 | Whisper returns 429, then succeeds on retry | `retryAttempt: 2` shown in progress panel; step completes; no pipeline error |
| F14 | ffmpeg hangs (no stderr for 10 min) | Watchdog kills process; PipelineLock released; step marked error; session recoverable |
| F15 | Auto-cleanup on startup (30-day-old done sessions) | `audio.wav` and derived files deleted; `minutes.json` and `export.md` preserved |

---

### Estimated Risk Areas

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **ffmpeg binary not found in packaged app** | Medium | High | Thorough `asarUnpack` config; `FfmpegNotFoundError` with clear user message; CI smoke-test on packaged build |
| R2 | **Whisper 25MB file size limit** for long recordings | High (2h ≈ ~110MB WAV) | High | Implement chunking in `BatchSttService` before v1.1.0 ships; test with 1h file |
| R3 | **Pipeline checkpoint corruption** (crash during write) | Low | Medium | Atomic write (`.tmp` → rename); if `.tmp` exists on startup, discard it |
| R4 | **Race condition**: user navigates to PostMeeting before `session:import` responds | Low | Low | `session:import` returns `sessionId` before async processing starts; navigator uses that ID; PostMeeting subscribes to `session:status` |
| R5 | **macOS audio permission for `getDisplayMedia`** (existing concern, not new) | Medium | Medium | Already handled in realtime; import mode bypasses this entirely (file-based) |
| R6 | **External storageRoot unavailable** (network drive disconnected) | Medium | High | Validate path on startup; show error if `storageRoot` inaccessible; fall back to userData with warning |
| R7 | **Source file deleted before retry** (no-copy mode) | Medium | Medium | Clear error message on `prepare_audio` failure; offer re-import from new path |
| R8 | **PipelineLock deadlock** (ffmpeg or Deepgram hang) | Low | High | 2h lock timeout + 10min watchdog; see §17.3 |

---

## 16. Production Hardening Layer (v1.2.0)

This section documents stability, security, and cost-control measures added in v1.2.0. Core features from §1–§15 are unchanged; this layer wraps them.

---

### 16.1 Pipeline Checkpoint & Resume

Extends the pipeline.json design introduced in v1.1.0 with a stricter state machine and unified resume path for both realtime and import sessions.

#### Checkpoint schema (updated)

```json
{
  "sessionId": "uuid",
  "step": "normalizing",
  "status": "running",
  "lastCompletedStep": "lang_detect",
  "completedSteps": ["batch_stt", "lang_detect"],
  "error": null,
  "updatedAt": 1709500000000
}
```

| Field | Type | Description |
|-------|------|-------------|
| `step` | `PipelineStep` | Step currently executing or about to execute |
| `status` | `'pending'\|'running'\|'done'\|'error'` | State of current step |
| `lastCompletedStep` | `PipelineStep?` | Last successfully finished step — used by UI resume banner |
| `completedSteps` | `PipelineStep[]` | All finished steps — used for idempotency skip |
| `error` | `string?` | Error message if status=error |
| `updatedAt` | `number` | Unix ms — used to detect stale states on startup |

#### Write protocol (atomic)

```
1. Write checkpoint to  pipeline.json.tmp
2. fs.rename(.tmp → pipeline.json)   ← atomic on POSIX; near-atomic on Windows NTFS
3. If rename fails: leave .tmp, log warning, continue
```

On startup: if `pipeline.json.tmp` exists alongside `pipeline.json`, discard the `.tmp` (incomplete write from previous crash).

#### Startup recovery scan

Runs in `electron/main.ts` before the BrowserWindow is shown:

```
for each session in sessionStore.getAll():
  if session.status === 'processing':
    state = readPipeline(session.id)
    if state is null OR state.step === 'prepare_audio':
      mark status = 'error_recoverable'
      message = 'Audio preparation incomplete — re-import required'
    elif (now - state.updatedAt) > 30_000ms AND state.status === 'running':
      // process was killed mid-step
      mark status = 'error_recoverable'
      message = 'Processing interrupted at step: {state.step}'
    else:
      mark status = 'error_recoverable'
      message = 'Processing interrupted at step: {state.step}'
  sessionStore.save()
```

The 30-second staleness check prevents false positives on slow machines where a step takes time.

#### Resume flow

`session:resumePipeline { sessionId }` IPC:
1. Read `pipeline.json` → determine `lastCompletedStep`
2. Set `nextStep` = step after `lastCompletedStep` in ordered step list
3. Call `postMeetingService.runFrom(sessionId, nextStep)`
4. Each step checks for existing output file (idempotency) before executing

#### UI — Resume banner in PostMeeting

```
┌───────────────────────────────────────────────────────┐
│  ⚡ 前回の処理を再開できます                            │
│  最後の完了ステップ: lang_detect                        │
│                    [normalizing から再開]               │
└───────────────────────────────────────────────────────┘
```

Shown when `session.status === 'error_recoverable'`. Button calls `session:resumePipeline`.

---

### 16.2 Chunk-Based Whisper for Long Audio

See the updated BatchSttService in §5 for full design. This section documents the operational constraints.

#### Chunk trigger

Chunking is triggered by **WAV file size after conversion**, not duration:

```
stat(audio.wav) → wavFileSizeBytes
if wavFileSizeBytes > 24_000_000: chunk mode
else:                              single upload
```

Duration (from `MediaService.probe()`) is stored in `SessionMeta.durationMs` for UX display and cost estimation only — it does not influence the chunk decision.

#### Chunk storage lifecycle

```
{storageRoot}/sessions/{id}/chunks/    ← created before chunking starts
    chunk_000.wav                      ← 15-min slice
    chunk_001.wav
    ...
```

Chunks are **transient**: deleted immediately after the segment merge and deduplication are complete and `transcript.jsonl` is written. On startup recovery scan: if `chunks/` exists but `transcript.jsonl` is absent (or fails validation) → step `batch_stt` must be retried from scratch; chunks are regenerated.

#### Time offset merging

```
chunkDurationMs = 15 * 60 * 1000   // 900_000 ms

for each chunk at index i:
  offset = i * chunkDurationMs
  for each segment in chunkResult:
    segment.startMs += offset
    segment.endMs   += offset
```

#### Deduplication guard (v1.2.2 — no overlap, optional guard)

Chunks are created with **no audio overlap** — the ffmpeg segment muxer performs a stream-copy cut at exact 15-minute boundaries. Genuine duplicate segments do not occur in normal operation.

A **text-similarity dedup guard** runs as a defensive check after offset adjustment. It catches the rare case where Whisper produces near-identical output for a word that straddles a chunk boundary:

```
Sort merged segments by startMs ascending.

For each consecutive pair (A, B):
  if abs(B.startMs - A.startMs) <= 3000:
    normA = lowercase(stripPunctuation(A.text))
    normB = lowercase(stripPunctuation(B.text))
    sim   = 1 - editDistance(normA, normB) / max(len(normA), len(normB))
    if sim >= 0.95:
      keep A, discard B
```

Only near-exact text matches within a 3-second window are removed. This path is expected to trigger rarely or never in production.

#### Memory ceiling

| Stage | Peak RAM |
|-------|----------|
| ffmpeg chunking | ~10 MB (stream, no buffer) |
| Single chunk upload | ~15 MB (WAV slice in memory for multipart) |
| Merged TranscriptSegment[] for 2h session | ~5–15 MB JSON |
| Total peak | < 30 MB above baseline |

---

### 16.3 Hierarchical Summarization (updated v1.3.0 — prose pipeline)

See the updated SummarizationService in §5 for full design. This section documents cost governance specifics and the updated Reduction Pass.

#### Reduction Pass design (updated v1.3.0 — prose compression)

Triggered when concatenated Pass 1 chunk summaries exceed 12,000 tokens:

```
Trigger check:
  estimateTokens(allChunkSummaries.join('\n\n')) > 12_000

Reduction Pass — GPT-4o-mini prose compression
  Input:  all N × ChunkSummary strings concatenated (> 12,000 tokens)
  Prompt: "Compress the following meeting segment summaries into shorter prose.
           Preserve all decisions, action items, and risks.
           Output as flowing paragraphs — do not use bullet lists or impose structure."
  Model:  gpt-4o-mini, temperature: 0, max_tokens: 1200
  → ReducedSummary (prose, ≤ 4,000 tokens)

Pass 2 receives ReducedSummary instead of raw chunk summaries.
```

**Rationale for prose-only Reduction Pass (v1.3.0)**:

The v1.2.1 design forced a four-section bullet output (`## Key Points / ## Decisions / ## Action Items / ## Risks`). In practice this caused GPT-4o-mini to silently drop items that did not fit neatly into one section, resulting in information loss before Pass 2 (GPT-4o) could see them. By keeping Reduction Pass output as flowing prose, nuance and minority positions are preserved. Pass 2 (GPT-4o with strict JSON schema) is the single point of structured extraction.

**Pass summary chain**:

```
Long transcript:   Chunks → [Pass 1: prose summaries per chunk]
                                          ↓ (if > 12k tokens)
                                    [Reduction Pass: prose compression]
                                          ↓
                              [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes

Short transcript:  Direct → [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes
```

#### Token estimation (pre-summarization)

Before calling any GPT API, the pipeline estimates token count of `normalized.json`:

```
estimateTokens(segments: NormalizedSegment[]): number
  total = 0
  for each segment:
    for each char in normalizedText:
      if CJK codepoint: total += 1.5
      else: total += 0.33   // ~3 chars per token for Latin
  return Math.ceil(total)
```

If `estimateTokens(segments) > 12_000` → hierarchical path.

#### Cost estimate per meeting

| Meeting length | Whisper (STT) | GPT-4o-mini (norm+pass1) | GPT-4o (pass2) | Total |
|---------------|---------------|--------------------------|-----------------|-------|
| 30 min | ~$0.18 | ~$0.01 | ~$0.04 | **~$0.23** |
| 1 hour | ~$0.36 | ~$0.02 | ~$0.04 | **~$0.42** |
| 2 hours | ~$0.72 | ~$0.04 | ~$0.04 | **~$0.80** |

Assumptions: Whisper at $0.006/min; gpt-4o-mini at $0.15/1M in + $0.60/1M out; gpt-4o at $5/1M in + $15/1M out. Prices indicative at March 2026.

Note: DeepL cost (realtime translation, if enabled) is separate and not included above.

#### Guardrails

| Guard | Threshold | Action |
|-------|-----------|--------|
| Max transcript length | 200,000 characters | Truncate to first 200k, log warning, note in minutes |
| Max GPT tokens per request | 8,000 input / 1,024 output | Enforced by chunk size; overflow → reduce chunk size |
| Cost warning | > 5 chunks in Pass 1 | Log cost estimate to `app.log`, emit `session:status` with `warning: 'HIGH_COST_EXPECTED'` |
| Normalization Phase 2 gate | Only if filler density > 15% | Prevents unnecessary LLM calls for clean audio |

---

### 16.4 Secure API Key Storage

Replaces `vault.json` (plaintext) with a two-tier system.

#### Tier 1 — OS keychain via `keytar` (primary)

```
keytar.setPassword('mtg-assistant', service, key)
keytar.getPassword('mtg-assistant', service)   // → string | null
keytar.deletePassword('mtg-assistant', service)
```

`service` values: `'deepgram'`, `'openai'`, `'deepl'`

Keys stored in:
- Windows: Windows Credential Manager
- macOS: macOS Keychain
- Linux: libsecret / GNOME Keyring

#### Tier 2 — Encrypted fallback `vault.enc`

Used when `keytar` is unavailable (e.g., headless CI, minimal Linux installs without libsecret).

```
Encryption: AES-256-GCM
Key derivation: PBKDF2(machineId + appName, salt, 100_000 iterations, SHA-256)
machineId: os.hostname() + app.getPath('userData')  (stable per install)
Format: { iv: hex, salt: hex, tag: hex, data: hex }  per service
```

The machine-derived key means `vault.enc` is non-portable — cannot be decrypted on a different machine. This is intentional.

#### Access path

```
secret.store.ts
  get(service): Promise<string | null>
    1. try keytar.getPassword(service)
    2. if null: try vault.enc decrypt
    3. return value or null

set(service, key): Promise<void>
    1. keytar.setPassword(service, key)
    2. also write to vault.enc (keep both in sync)

delete(service): Promise<void>
    1. keytar.deletePassword(service)
    2. remove from vault.enc
```

#### Renderer isolation

The renderer **never receives raw API keys**. All API calls are made in the main process. The Settings UI calls `apikey:getMasked` to display a masked value (`"****abcd"`) — the plaintext key is never sent to the renderer under any circumstances. There is no reveal/表示 feature; the masked value is sufficient for the user to confirm a key is set.

#### Migration from `vault.json`

On first launch of v1.2.0:

```
if vault.json exists:
  for each service in vault.json:
    secretStore.set(service, vault.json[service])
  rename vault.json → vault.json.bak   // keep backup for 1 session
  delete vault.json.bak on next launch
  log 'Migrated API keys from vault.json to secure storage'
```

---

### 16.5 Concurrency Guard (updated v1.3.0 — deadlock prevention)

Only one active pipeline is allowed at a time. Enforced in-memory (fast path) and via persisted flag in `app.json` (recovery path). v1.3.0 adds lock timeout and heartbeat watchdog to prevent deadlock from hung child processes.

#### Rules

| Action attempted | Condition | Result |
|-----------------|-----------|--------|
| Start realtime recording | Another session `status='processing'` | Blocked — toast error |
| Start realtime recording | Another session `status='recording'` | Blocked — impossible by design (only one session at a time) |
| Start import | Session `status='recording'` active | Blocked — toast error |
| Start import | Another session `status='processing'` | Blocked — toast error |
| Resume pipeline | Another pipeline running in memory | Queued until running pipeline completes |

#### In-memory lock (updated v1.3.0)

```
// electron/services/pipeline-lock.ts
class PipelineLock {
  private activeSessionId: string | null = null;
  private acquiredAt:      number | null = null;
  private lastHeartbeat:   number | null = null;
  private readonly LOCK_TIMEOUT_MS      = 2 * 60 * 60 * 1000;  // 2 hours
  private readonly HEARTBEAT_TIMEOUT_MS = 10 * 60 * 1000;       // 10 minutes

  acquire(sessionId: string): boolean
    if activeSessionId !== null AND !this.isExpired(): return false
    if activeSessionId !== null AND this.isExpired():
      log.warn('lock', 'Lock expired — force releasing', { activeSessionId })
      this.forceRelease()
    activeSessionId = sessionId
    acquiredAt = Date.now()
    lastHeartbeat = Date.now()
    return true

  heartbeat(sessionId: string): void
    if activeSessionId === sessionId: lastHeartbeat = Date.now()

  release(sessionId: string): void
    if activeSessionId === sessionId:
      activeSessionId = null; acquiredAt = null; lastHeartbeat = null

  isExpired(): boolean
    if acquiredAt is null: return false
    return (Date.now() - acquiredAt) > LOCK_TIMEOUT_MS

  isHeartbeatStale(): boolean
    if lastHeartbeat is null: return false
    return (Date.now() - lastHeartbeat) > HEARTBEAT_TIMEOUT_MS

  forceRelease(): void
    log.warn('lock', 'Force-releasing stale lock', { activeSessionId })
    activeSessionId = null; acquiredAt = null; lastHeartbeat = null
}
export const pipelineLock = new PipelineLock();  // singleton
```

#### Heartbeat protocol

Each pipeline step emits a heartbeat every **30 seconds** while running:

```
// In PostMeetingService, wrapping each step:
const heartbeatInterval = setInterval(() => {
  pipelineLock.heartbeat(sessionId)
  logger.debug('pipeline', 'heartbeat', { sessionId, step })
}, 30_000)

try {
  await runStep(sessionId, step)
} finally {
  clearInterval(heartbeatInterval)
}
```

#### Watchdog

A watchdog timer runs in the main process. If `pipelineLock.isHeartbeatStale()` returns true:

```
watchdog checks every 60s:
  if pipelineLock.isHeartbeatStale():
    log.error('watchdog', 'Heartbeat stale — killing child processes', { activeSessionId })
    mediaService.killActiveProcess()     // kills ffmpeg if running
    pipelineLock.forceRelease()
    sessionStore.markError(activeSessionId, 'Processing watchdog triggered — retry required')
    ipcMain.send('session:status', { sessionId: activeSessionId, status: 'error' })
```

#### Deepgram WebSocket inactivity

SttService: if no message (partial or final) is received for **60 seconds**, force-close and reconnect the WebSocket. This prevents silent hangs when Deepgram stops sending frames without closing the connection.

#### Persisted flag

`app.json` SessionMeta has `status: 'processing'` while a pipeline runs. On startup recovery scan (§16.1), any session with `status='processing'` is moved to `error_recoverable` — this ensures the lock is implicitly released on restart even if `pipelineLock.release()` was never called.

#### UI enforcement

Import button and New Meeting button are **disabled** (not hidden) when `pipelineLock.isLocked()`. A tooltip explains why: "別の会議が処理中です / Another session is being processed".

---

### 16.6 Logging & Observability

Structured logging in the main process only. The renderer never writes logs directly.

#### Log file

```
%APPDATA%/mtg-assistant/logs/app.log
~/Library/Application Support/mtg-assistant/logs/app.log
```

**Rotation**: when `app.log` exceeds 5 MB, rename to `app.log.1` and start a new `app.log`. Keep maximum 3 rotated files (`app.log.1`, `app.log.2`, `app.log.3`). Total log storage cap: ~20 MB.

#### Log format

Each line is a JSON object (newline-delimited):

```json
{ "ts": 1709500000000, "level": "info", "ctx": "pipeline", "msg": "step started", "sessionId": "uuid", "step": "batch_stt" }
{ "ts": 1709500001234, "level": "info", "ctx": "api", "msg": "whisper call", "sessionId": "uuid", "chunkIndex": 0, "fileSizeBytes": 14200000 }
{ "ts": 1709500005678, "level": "warn", "ctx": "api", "msg": "whisper retry", "sessionId": "uuid", "attempt": 2, "waitMs": 4000 }
{ "ts": 1709500005678, "level": "error", "ctx": "api", "msg": "whisper error", "sessionId": "uuid", "code": 429, "retryAfter": 30 }
{ "ts": 1709500000100, "level": "info", "ctx": "ffmpeg", "msg": "process exited", "exitCode": 0, "durationMs": 4200 }
{ "ts": 1709500000200, "level": "warn", "ctx": "watchdog", "msg": "heartbeat stale", "sessionId": "uuid" }
{ "ts": 1709500000300, "level": "info", "ctx": "cleanup", "msg": "derived files deleted", "sessionId": "uuid", "freedBytes": 145000000 }
```

#### What is logged

| Category | What | What NOT |
|----------|------|----------|
| Pipeline | Step start/end, duration, session ID | Transcript text content |
| AI API calls | Model, token counts, latency, error codes, retry attempts | API keys, request/response body |
| ffmpeg | Exit code, duration, stderr snippet on error | Audio content |
| App lifecycle | Startup, crash recovery actions, migration, cleanup | — |
| Watchdog | Stale heartbeat events, force-release actions | — |
| Errors | All caught errors with stack (truncated to 500 chars) | — |

**Privacy**: transcript text, speaker IDs, meeting titles, and API keys are **never** logged. Log files are safe to share for debugging.

#### Logger interface

```
// electron/utils/logger.ts
logger.info(ctx, msg, meta?)
logger.warn(ctx, msg, meta?)
logger.error(ctx, msg, meta?)
logger.debug(ctx, msg, meta?)   // ← NEW v1.3 — heartbeat, watchdog

// Usage in services:
logger.info('pipeline', 'step started', { sessionId, step: 'batch_stt' })
logger.warn('api', 'whisper retry', { sessionId, attempt: 2, waitMs: 4000 })
logger.error('api', 'openai error', { sessionId, statusCode: 429 })
```

---

### 16.7 Cost Governance

#### Estimated cost per meeting

| Meeting length | Whisper (STT) | GPT-4o-mini (norm+pass1) | GPT-4o (pass2) | Total |
|---------------|---------------|--------------------------|-----------------|-------|
| 30 min | ~$0.18 | ~$0.01 | ~$0.04 | **~$0.23** |
| 1 hour | ~$0.36 | ~$0.02 | ~$0.04 | **~$0.42** |
| 2 hours | ~$0.72 | ~$0.04 | ~$0.04 | **~$0.80** |

Assumptions: Whisper at $0.006/min; gpt-4o-mini at $0.15/1M in + $0.60/1M out; gpt-4o at $5/1M in + $15/1M out. Prices indicative at March 2026.

Note: DeepL cost (realtime translation, if enabled) is separate and not included above.

#### Guardrails implemented

| Guardrail | Where enforced | Value |
|-----------|---------------|-------|
| Max transcript chars before summarization | `PostMeetingService` | 200,000 chars |
| Max Whisper chunk size | `BatchSttService` | 24 MB (below 25 MB API limit) |
| Max GPT tokens per normalization batch | `NormalizationService` | 20 segments / call |
| Max GPT tokens per summarization chunk | `SummarizationService` | 8,000 tokens input |
| Max GPT tokens for final summary input | `SummarizationService` | 12,000 tokens (else extra reduction pass) |
| Translation LRU cache | `TranslationService` | 300 entries (deduplication) |

#### Cost warning flow

If Pass 1 in hierarchical summarization would require > 5 chunk calls (meeting > ~1.5 hours of dense speech):

```
session:status push → { sessionId, warning: 'HIGH_COST_EXPECTED', estimatedUSD: 0.62 }
```

UI shows a dismissible banner: "この会議の処理には推定 $0.62 のAPI費用が発生します。続けますか？"
User can cancel or proceed. If cancelled: session marked `error` with message "User cancelled due to cost estimate".

#### Future option — Cost dashboard

Not implemented in v1.2.0, but `app.log` contains all token counts and API call metadata needed to build a per-session cost report in a future version. The log schema is designed to support this aggregation.

---

## 17. Enterprise Hardening Layer (v1.3.0)

This section documents the six enterprise-hardening features added in v1.3.0. Core features from §1–§16 are unchanged; these features extend and protect them in enterprise-scale deployments.

---

### 17.1 Storage Location Customization

#### Problem

Sessions are stored by default in Electron's `userData` directory (`%APPDATA%/mtg-assistant/` on Windows), which resides on the system drive (typically C:). Importing large audio or video files — after conversion to 16kHz WAV — can consume hundreds of megabytes per session. Organizations with multiple users, or users processing multi-hour recordings daily, can fill the system drive within weeks.

#### Design

A new `StorageSettings` block is added to `AppSettings` (see §7). The key field is `storageRootPath`:

```
storageRootPath:      string    // where session data lives; default = userData
allowExternalStorage: boolean   // if false: warn when user picks a non-userData path
autoCleanupDays:      number    // 0 = disabled, default = 30
copySourceFile:       boolean   // archive source file locally; default = false
```

**What moves with `storageRootPath`**:

| Path | Movable | Notes |
|------|---------|-------|
| `sessions/{id}/` | Yes | All session files move with storageRoot |
| `settings.json` | No | Always in userData — fast access on startup |
| `app.json` | No | Session index — always in userData |
| `vault.enc` | No | Encryption fallback — always in userData |
| `logs/` | No | Always in userData |

**Validation on storageRoot change**:

```
storage:setRoot { path }:
  1. fs.accessSync(path, fs.constants.W_OK)   // writable?
  2. diskMonitor.getFreeBytes(path) > 1_073_741_824  // > 1 GB free?
  3. if existing sessions exist: offer to migrate (move all sessions/{id}/ dirs)
  4. update settings.json.storage.storageRootPath
  5. reload fileStore paths
  Return: { ok: true } or { ok: false, error: 'INSUFFICIENT_SPACE' | 'NOT_WRITABLE' | 'MIGRATION_FAILED' }
```

**Migration**: session directories are moved with `fs.rename`. If source and target are on different volumes (rename fails), fall back to copy + delete with progress events.

#### Source file handling

| `copySourceFile` | Behavior | Tradeoff |
|-----------------|----------|----------|
| `false` (default) | `SessionMeta.sourceAbsolutePath` stores original path; no copy made | No extra disk; `prepare_audio` fails if original moved or deleted |
| `true` | File copied to `sessions/{id}/source/`; `SessionMeta.sourceArchivedPath` set | Extra disk usage equal to source file size; retry always works |

When `copySourceFile = false` and the original file is missing at retry time, the pipeline emits `error` with message: `"Source file not found: {path}. Re-import from new location."` The UI shows the original path and an option to pick a replacement file.

#### Auto-cleanup service

Runs on startup (after recovery scan) and on user demand via Settings → "今すぐクリーンアップ".

```
AutoCleanupService.run(dryRun = false): CleanupReport
  threshold = now - (autoCleanupDays * 86_400_000)

  for each session where:
    session.status === 'done'
    session.createdAt < threshold

  Derived files to delete:
    audio.wav              (typically largest — 50–300 MB per import session)
    audio.pcm              (realtime raw — delete if session.status === 'done')
    chunks/                (should already be gone; safety sweep)
    transcript.jsonl       (recoverable from audio if ever needed)
    normalized.json        (recoverable from transcript)

  Always keep:
    minutes.json           (primary user value)
    export.md              (primary user value)
    source/                (archived source, if present — user explicitly chose to archive)
    pipeline.json          (checkpoint metadata — negligible size)
```

If `dryRun = true`, the report shows what would be deleted without deleting. This is used by the Settings UI "preview" button before the user confirms.

**Disk tradeoffs** (documented in UI tooltip):

| Mode | Notes |
|------|-------|
| `copySourceFile = false` (default) | Minimum disk. Source stays on original drive. Retry fails if file moves. |
| `copySourceFile = true` | Double disk for source duration. Retry always works. |
| `autoCleanupDays = 30` (default) | Derived files cleared after 30 days. Minutes + export permanently kept. |
| `autoCleanupDays = 0` | No auto-cleanup. User manages storage manually. |

---

### 17.2 API Resilience — Exponential Backoff

#### Problem

Whisper and GPT API calls can fail transiently: HTTP 429 (rate limits), HTTP 5xx (server errors), or network timeouts. The current pipeline treats any failure as a permanent error requiring manual retry. Under enterprise-scale usage — multiple users sharing API keys, or large batch imports — transient failures are common and should be handled automatically.

#### Retry policy

A shared `retry.ts` utility wraps any async API call:

```typescript
// electron/utils/retry.ts
interface RetryOptions {
  maxAttempts:      number;       // default: 4 (1 initial + 3 retries)
  baseDelayMs:      number;       // default: 2000
  retryableStatus:  number[];     // default: [429, 500, 502, 503, 504]
  onRetry?:         (attempt: number, waitMs: number) => void;
}

async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions): Promise<T>
  for attempt = 1 to opts.maxAttempts:
    try:
      return await fn()
    catch error:
      if attempt === opts.maxAttempts: throw error
      if error is non-retryable (400, 401, 403, 413): throw immediately
      waitMs = opts.baseDelayMs * 2^(attempt - 1)   // 2s, 4s, 8s
      opts.onRetry?.(attempt, waitMs)
      logger.warn('api', 'retry scheduled', { attempt, waitMs, statusCode })
      await sleep(waitMs)
  throw lastError
```

**Retry schedule**:

| Attempt | Wait before | Total elapsed |
|---------|-------------|---------------|
| 1 | — (immediate) | 0s |
| 2 | 2s | 2s |
| 3 | 4s | 6s |
| 4 | 8s | 14s |
| (fail) | — | ~14s |

**Non-retryable errors** (fail immediately, no wait):

| HTTP Status | Reason |
|-------------|--------|
| 400 | Bad request — will not succeed on retry |
| 401 | Invalid API key — must fix in Settings |
| 403 | Forbidden — check API plan |
| 413 | File too large — chunking logic error |

**Applied to**:
- `BatchSttService`: each individual chunk upload (and single upload)
- `SummarizationService`: each GPT-4o-mini chunk call, Reduction Pass call, GPT-4o Pass 2 call
- `NormalizationService` Phase 2: each GPT-4o-mini batch call

**UI feedback**:

Each retry emits `session:status { step, retryAttempt: N, retryWaitMs: M }`. The `PipelineProgress` component shows:
```
⟳  batch_stt   再試行中 (2/4) … 4秒後に再開
```

**Logging**:

```json
{ "level": "warn", "ctx": "api", "msg": "retry", "attempt": 2, "waitMs": 4000, "statusCode": 429 }
{ "level": "info", "ctx": "api", "msg": "retry success", "attempt": 3, "totalWaitMs": 6000 }
```

**Idempotency note**: Retry applies only to idempotent calls — Whisper transcription (deterministic for the same audio) and GPT summarization (non-deterministic but safe to retry since output replaces previous). Realtime Deepgram streaming is reconnect-based, not retry-based.

---

### 17.3 Process Watchdog & Lock Safety

#### Problem

If a child process (ffmpeg, or a spawned ffprobe) hangs — for example due to a corrupt input file that causes ffmpeg to loop indefinitely — the `PipelineLock` is never released. No new sessions can be started until the app is restarted. Similarly, if the Deepgram WebSocket stops sending frames without closing the connection, the pipeline may stall silently during realtime recording.

#### PipelineLock deadlock prevention

Full lock design is documented in §16.5. Summary of v1.3.0 additions:

| Mechanism | Value | Purpose |
|-----------|-------|---------|
| Lock timeout | 2 hours | Hard ceiling — no pipeline should take longer |
| Heartbeat interval | Every 30s | Step emits keep-alive while running |
| Watchdog check interval | Every 60s | Main process checks heartbeat staleness |
| Heartbeat stale threshold | 10 minutes | Time without heartbeat → assume hang |

**Lock state recovery on restart**: On app startup, if `session.status === 'processing'` in `app.json`, the lock is implicitly released by the recovery scan which sets status to `error_recoverable`. The in-memory `PipelineLock` is reset to null on process startup — it holds no state across restarts.

#### MediaService child process watchdog

```
// In MediaService.extractAudio / convertTo16kMonoWav:
let lastProgressAt = Date.now()

child.stderr.on('data', (chunk) => {
  if (chunk.includes('time=')):
    lastProgressAt = Date.now()
    pipelineLock.heartbeat(sessionId)
})

const watchdogInterval = setInterval(() => {
  if (Date.now() - lastProgressAt > 10 * 60 * 1000):
    logger.error('watchdog', 'ffmpeg no progress for 10 min — killing', { sessionId })
    child.kill('SIGKILL')
    clearInterval(watchdogInterval)
}, 60_000)

child.on('exit', () => clearInterval(watchdogInterval))
```

#### Deepgram WebSocket inactivity timeout

```
// In SttService:
let lastMessageAt = Date.now()

ws.on('message', () => { lastMessageAt = Date.now() })

setInterval(() => {
  if (Date.now() - lastMessageAt > 60_000 AND ws.readyState === OPEN):
    logger.warn('stt', 'WebSocket inactive for 60s — reconnecting')
    ws.close()   // triggers reconnect logic
}, 15_000)
```

The 60-second inactivity threshold is intentionally conservative — a meeting with a long silence pause should not trigger reconnect. The 15-second polling interval minimizes reconnect delay.

---

### 17.4 Reduction Pass Refinement

This section captures the design rationale for the v1.3.0 Reduction Pass change (prose-based vs. forced bullet structure). The implementation details are in §5 SummarizationService and §16.3.

#### Problem with v1.2.1 approach

The forced four-section bullet output (`## Key Points / ## Decisions / ## Action Items / ## Risks`) in the Reduction Pass introduced hallucination of omission. When GPT-4o-mini compressed long summaries into four labeled sections:

1. Items that spanned multiple categories (e.g., a decision that also created a risk) were placed in one section and lost from others.
2. Minority opinions or "parking lot" items without a clear category were silently dropped.
3. Pass 2 (GPT-4o) received a pre-classified input, biasing its extraction and reducing its ability to identify implicit decisions or risks in the original text.

#### v1.3.0 design

| Stage | v1.2.1 | v1.3.0 |
|-------|--------|--------|
| Pass 1 (per-chunk) | Bullet-hinted prose | Free-form prose (no structure prompt) |
| Reduction Pass | Four forced sections (`##` headers) | Prose compression (paragraphs only) |
| Pass 2 (final) | JSON extraction from mixed input | JSON extraction from clean prose |
| Structured output | Split across passes | Single extraction point at Pass 2 |

#### Prompt engineering constraints

- Pass 1 prompt must not mention "decisions", "action items", etc. by name — this primes the model to over-classify and under-extract.
- Reduction Pass prompt explicitly forbids bullet lists and headers to prevent re-classification.
- Pass 2 (GPT-4o strict JSON schema) is the only place where classification and extraction happens, ensuring consistency and reducing hallucination risk.

#### Tradeoff

Prose summaries in Pass 1 and Reduction Pass are slightly longer than bullet-compressed equivalents (~10–20% more tokens). This increases cost marginally but is dominated by the reduction in re-runs caused by missing information in v1.2.1 minutes.

---

### 17.5 FFmpeg Enterprise Code-Signing

#### Problem

Without code-signing, both the Electron app executable and the bundled ffmpeg/ffprobe binaries may be flagged by antivirus software, Microsoft Defender SmartScreen (Windows), or macOS Gatekeeper as unverified publishers. In enterprise environments with strict endpoint protection, unsigned binaries are often blocked or quarantined automatically — including ffmpeg, which is unpacked from the asar archive at runtime.

#### Requirements

| Component | Platform | Signing requirement |
|-----------|----------|-------------------|
| Electron app (`.exe` / `.app`) | Windows, macOS | Must be code-signed with valid EV certificate |
| `ffmpeg.exe` / `ffmpeg` binary | Windows, macOS | Must be code-signed separately — it is an unpacked external binary |
| `ffprobe.exe` / `ffprobe` binary | Windows, macOS | Same as ffmpeg |
| Installer (`.msi` / `.dmg`) | Windows, macOS | Must be signed by the same certificate |

#### CI/CD pipeline requirement

Code-signing must occur in the CI/CD build pipeline, not on developer machines:

```
Build pipeline (GitHub Actions / Azure DevOps):

Windows build:
  1. electron-vite build
  2. signtool sign /fd sha256 /tr http://timestamp.url /td sha256
        out/resources/ffmpeg.exe
        out/resources/ffprobe.exe
  3. electron-builder (builds .exe / .msi installer)
  4. signtool sign ... dist/MTGAssistant-Setup.exe

macOS build:
  1. electron-vite build
  2. codesign --deep --force --verify --verbose
        --sign "Developer ID Application: Org Name (TEAMID)"
        --entitlements entitlements.plist
        out/resources/ffmpeg
        out/resources/ffprobe
  3. electron-builder (builds .dmg / .pkg)
  4. codesign + notarize dist/MTGAssistant.dmg
```

#### Certificate management

- Windows: EV (Extended Validation) Code Signing Certificate from a CA (DigiCert, Sectigo). Stored as `PFX` secret in CI/CD vault.
- macOS: Apple Developer ID Application certificate. Stored in CI/CD keychain. Requires Apple notarization (`xcrun notarytool`) for distribution outside Mac App Store.
- Certificates **must not** be stored in source control or on developer workstations — CI/CD secrets vault only.

#### Build verification step

After signing, CI must verify:

```
# Windows
signtool verify /pa out/resources/ffmpeg.exe
signtool verify /pa dist/MTGAssistant-Setup.exe

# macOS
codesign --verify --verbose out/resources/ffmpeg
spctl --assess --verbose dist/MTGAssistant.dmg
```

Builds that fail signature verification are rejected — artifact is not published.

#### Developer workflow

Developers run unsigned builds in development mode (`node scripts/dev.js`). Signing only occurs in CI. The `ffmpeg-path.ts` resolver differentiates `app.isPackaged` (signed CI build) from development (unsigned `node_modules`).

---

### 17.6 Disk Usage Monitoring

#### Problem

`storageRoot` can fill up silently. Without monitoring, the user discovers disk-full errors mid-pipeline — at the worst possible time (while transcribing a long import).

#### Design

A `DiskMonitor` singleton runs in the main process. It polls free space on the `storageRoot` volume every **5 minutes** while the app is open.

```typescript
// electron/utils/disk-monitor.ts
class DiskMonitor {
  private readonly POLL_INTERVAL_MS = 5 * 60 * 1000
  private readonly WARN_THRESHOLD_BYTES  = 5  * 1024 * 1024 * 1024  // 5 GB
  private readonly BLOCK_THRESHOLD_BYTES = 500 * 1024 * 1024         // 500 MB

  start(): void
    setInterval(() => this.check(), POLL_INTERVAL_MS)
    this.check()   // immediate check on startup

  async check(): Promise<void>
    freeBytes = await this.getFreeBytes(storageRootPath)
    if freeBytes < WARN_THRESHOLD_BYTES:
      ipcMain.send('storage:warning', { freeBytes, threshold: WARN_THRESHOLD_BYTES })
      logger.warn('disk', 'low free space', { freeBytes, path: storageRootPath })

  getFreeBytes(dirPath: string): Promise<number>
    // Windows: uses statvfs-equivalent via Node fs/promises or native module
    // macOS/Linux: uses fs.statfs (Node 22+) or child_process df
```

**Blocking behavior**: If `freeBytes < BLOCK_THRESHOLD_BYTES` (500 MB), new imports are blocked immediately with an error: `"空き容量が不足しています。ストレージを解放してから再試行してください。"`.

#### UI surface

**Dashboard warning banner** (shown when `storage:warning` push received):

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠ ストレージの空き容量が少なくなっています (残 3.2 GB)             │
│   設定でストレージ先を変更するか、古いセッションを削除してください。 │
│                                              [設定を開く] [閉じる]│
└─────────────────────────────────────────────────────────────────┘
```

Banner is **dismissible per session** (dismissed state not persisted — re-appears on next poll below threshold).

**Settings page — Storage section** shows:

| Element | Content |
|---------|---------|
| Storage location | Path + free space display (`空き容量: 42.3 GB`) |
| Total used | Sum of all session file sizes (`使用容量: 2.4 GB`) |
| Per-session breakdown | Expandable table: session title, date, size, delete button |
| Cleanup button | "今すぐクリーンアップ" — triggers `storage:runCleanup` with preview (`dryRun: true`) first |

**Session card** (Dashboard list item): optionally shows session disk usage if `SessionMeta.diskUsageBytes` is set. Displayed as a small muted label: `"1.2 GB"`. Computed lazily after session completes and cached in `SessionMeta`.

#### `storage:getStats` implementation

```
storage:getStats (IPC invoke):
  1. Read all sessions from sessionStore
  2. For each session: sum file sizes under {storageRoot}/sessions/{id}/
  3. Get free bytes on storageRoot volume
  4. Return StorageStats
```

Stat computation is done in a background task (non-blocking) to avoid slowing the IPC response. First call returns a cached value (or empty) immediately; updated result is pushed via a follow-up `session:status`-style event if needed.

---

*End of DESIGN.md v1.3.0*
