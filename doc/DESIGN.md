# MTG Assistant — Design Document

**Version**: 1.4.0-lite
**Product Focus**: Batch-only Meeting Minutes Generator
**Stack**: Electron 31 + React 18 + TypeScript 5.5 + Tailwind CSS 3
**Platform**: Windows (primary), macOS
**Design Freeze**: 2026-03-03

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
| 1.4.0-lite | 2026-03 | **Product pivot — Batch-only Meeting Minutes Generator**: removed Deepgram realtime STT, TranslationService, WebSocket IPC channels (`stt:partial`, `stt:final`, `translation`), `captionStore`, and `LiveSession` screen. Recording screen simplified to timer + stop button. All enterprise hardening from v1.3.0 preserved. `inputType` renamed `'realtime'` → `'recording'`. `targetLang` removed from all session types. Only OpenAI API key required. |

---

## 1. Overview

MTG Assistant is a **local-first** desktop application that records (or imports) meeting audio, transcribes speech, detects languages, normalizes spoken text, and generates structured meeting minutes using AI. All data stays on the user's machine; only API calls leave the device.

**Realtime transcription is not supported.** All STT processing is batch-based (OpenAI Whisper) and occurs after recording stops or import completes.

### Key Capabilities

| Capability | Provider | Mode |
|------------|----------|------|
| Meeting audio recording | MediaDevices API + AudioWorklet | Recording |
| High-accuracy batch transcription | OpenAI Whisper | Both |
| Audio/video file import | ffmpeg (local) | Import |
| Audio extraction & format conversion | ffmpeg (local) | Import |
| Text normalization | Rule engine + GPT-4o-mini | Both |
| Meeting minutes generation | GPT-4o (structured JSON) | Both |
| UI languages | Japanese / English / Vietnamese | Both |

### Input Mode Comparison

| Aspect | Recording | Import |
|--------|-----------|--------|
| Source | Microphone | File (wav/mp3/m4a/mp4/mov) |
| STT | Whisper batch (after stop) | Whisper batch |
| Live captions | None | N/A |
| Post-processing pipeline | Same 5-step pipeline | Same 5-step pipeline |
| Data stored | audio.pcm | audio.wav + optional source/{original} |
| Recovery | Yes — pipeline.json checkpoint | Yes — pipeline.json checkpoint |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer Process (React)                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │ RecordingProvider (never unmounts)                    │  │
│  │  useAudioCapture · timer                              │  │
│  │  ┌──────────┐ ┌───────────────┐ ┌──────────┐ ┌─────┐ │  │
│  │  │Dashboard │ │RecordingScreen│ │PostMeeting│ │Imprt│ │  │
│  │  └──────────┘ └───────────────┘ └──────────┘ └─────┘ │  │
│  └───────────────────────────────────────────────────────┘  │
│  Zustand: sessionStore · recordingStore                     │
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
│  │  BatchSttService   LangDetect      Normalization       │  │
│  │  Summarization     PostMeeting     Export              │  │
│  │  MediaService      AutoCleanup                        │  │
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
   OpenAI (Whisper + GPT-4o)
```

**`storageRoot`** defaults to `app.getPath('userData')` and is user-configurable (see §17.1). Small metadata files (`app.json`, `settings.json`, `vault.enc`, `logs/`) always remain in `userData` regardless of `storageRoot`.

### Process Separation

| Concern | Process |
|---------|---------|
| UI rendering, audio capture | Renderer (sandboxed) |
| File I/O, API calls | Main |
| ffmpeg child process management | Main only |
| API key exposure, raw PCM/WAV | Main only — never in renderer |
| Auto-cleanup, disk monitoring | Main only |

Security: `contextIsolation: true`, `nodeIntegration: false`. Preload exposes typed `window.api` only.

---

## 3. IPC Interface

### Renderer → Main (invoke)

| Channel | Payload | Response |
|---------|---------|----------|
| `session:start` | `{ title, lang, inputDeviceId }` | `{ sessionId }` |
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
| `storage:getStats` | — | `StorageStats` |
| `storage:setRoot` | `{ path }` | `{ ok, error? }` |
| `storage:runCleanup` | `{ dryRun? }` | `CleanupReport` |

### Renderer → Main (send, high-frequency)

| Channel | Payload |
|---------|---------|
| `audio:chunk` | `{ seq: number, pcm: ArrayBuffer }` — 100ms PCM16, written to disk only |

### Main → Renderer (push)

| Channel | Payload |
|---------|---------|
| `session:status` | `{ sessionId, status, step?, progress?, warning?, retryAttempt? }` |
| `session:done` | `{ sessionId, exportPath }` |
| `error` | `{ code, message, sessionId? }` |
| `storage:warning` | `{ freeBytes, threshold }` — low disk space alert |

**`session:status`** covers both recording-session post-processing and import pipeline progress:

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | string | — |
| `status` | `SessionStatus` | — |
| `step` | `PipelineStep?` | current step |
| `progress` | number? | 0–100, per-step % |
| `lastCompletedStep` | `PipelineStep?` | for resume banner |
| `error` | string? | error message if status=error |
| `warning` | `'HIGH_COST_EXPECTED'?` | cost warning field |
| `retryAttempt` | number? | 1–3 during backoff retries |

---

## 4. Data Flow

### 4.1 Recording

Audio capture is managed by `RecordingProvider` at App level — survives route changes.

```
RecordingProvider.startRecording(sessionId, deviceId)
    → useAudioCapture.start()
        getUserMedia({ audio: { deviceId } })
        → AudioWorklet (pcm-processor.ts)
            AGC: TARGET_RMS=0.08, EMA α=0.05, MAX_GAIN=4.0
            Accumulate 1600 samples (100ms @ 16kHz)
            Float32 → Int16
        → ipcRenderer.send('audio:chunk', { seq, pcm })
        → audio.ipc (main)
            → fileStore.appendAudio()        [audio.pcm]
            (no STT forwarding — recording is capture-only)

RecordingProvider also:
    → sets recordingStore.sessionId
    → runs timer: recordingStore.tick() every 1s
```

`audio:chunk` is written directly to `audio.pcm` on disk. No realtime STT processing occurs during recording.

**User navigates away during recording**: audio continues uninterrupted. Sidebar shows a pulsing REC badge with elapsed timer. Clicking it returns to RecordingScreen.

**RecordingScreen re-mount guard**: checks `recordingStore.sessionId === sessionId` before calling `startRecording()` — prevents double audio capture on back-navigation.

### 4.2 Post-Meeting Pipeline (shared: recording + import)

Triggered by `session:stop` (recording) or at end of audio preparation (import). Runs sequentially, emits `session:status` at each step. Checkpoint written to `pipeline.json` before and after each step.

```
0. [checkpoint]  write pipeline.json { step: 'batch_stt', status: 'pending' }

1. batch_stt    → getAudioForWhisper(sessionId)   ← file.store helper (pcm or wav)
                  Whisper API → TranscriptSegment[]  [with exponential backoff, §17.2]
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

### 4.3 Import Flow

```
Renderer: ImportScreen
    user picks file via dialog
    → media:probe (invoke) → { durationMs, hasAudio, format }
    user inputs title, lang
    → session:import (invoke) → { sessionId }
    → navigate to /session/:id  (PostMeeting, shows live progress)

Main: import.ipc.ts  handles session:import
    1. sessionStore.create({ title, lang, inputType:'import', status:'processing' })
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

### BatchSttService

Whisper-1 has a hard **25 MB file size limit** and degrades above ~30 minutes of audio. BatchSttService handles long files transparently using chunk-based transcription.

**Decision threshold — file-size based**: After MediaService converts or extracts audio to `audio.wav`, compute `fs.statSync(wavPath).size`. If `wavFileSizeBytes > 24_000_000` (24 MB safety margin below Whisper's 25 MB hard limit) → chunk mode. Otherwise single upload. Duration is used only for UX display and cost estimation, **not** as a chunk trigger.

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

**API retry policy**: Each Whisper API call is wrapped in an exponential backoff retry loop. See §17.2.

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

**Deduplication (optional guard)**:

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

**Single-chunk path** (WAV ≤ 24 MB): no chunking, direct upload. No dedup needed.

**Input**:
- `.pcm` (recording): adds RIFF WAV header in-memory before upload
- `.wav` (import): reads directly

**Language hint**: `ja` / `en` / `vi` (multi → omit hint, auto-detect)

### MediaService

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

**Child process watchdog**: See §17.3. If ffmpeg produces no stderr progress for 10 minutes, the watchdog kills the process and marks the step as error.

### LangDetectService

```
detectLang(text):
  CJK codepoints > 10% of chars → 'ja'
  Vietnamese diacritics count > 2 OR > 4% → 'vi'
  else → 'en'

detectAll(segments[]):
  applied only when segment.lang is 'multi' or absent
  inherits previous segment lang if isolated ambiguous text
```

### NormalizationService

**Phase 1 — Rule Engine (always runs)**

| Class | Examples | Remove condition |
|-------|----------|-----------------|
| `always` | um, uh, うん, ừm | Unconditional |
| `sentence_initial` | えっと, so, thì | First token only |
| `isolated` | はい, right, ừ | Entire segment = filler |

**Phase 2 — LLM Rewrite (optional)**
- Trigger: word count > 8 AND filler density > 15%
- Batches up to 20 segments per GPT-4o-mini call, grouped by `detectedLang`

### SummarizationService (prose-based pipeline)

A full 2-hour meeting transcript can exceed 100k tokens — unsafe and costly to send to GPT-4o directly. SummarizationService uses a two-pass hierarchical strategy.

**Token estimation**: 1 Japanese/Chinese character ≈ 1.5 tokens; 1 English word ≈ 1.3 tokens. Estimated at normalization step to route correctly.

**Routing decision**:

| Transcript tokens | Strategy |
|-------------------|----------|
| ≤ 12,000 | **Direct** — single GPT-4o call |
| > 12,000 | **Hierarchical** — prose-based two-pass (see below) |

**Hierarchical prose pipeline**:

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
  Response format: json_schema (strict mode)
  → MeetingMinutes JSON
```

**Rationale for prose-based pipeline**:
- Forcing bullet structure in the Reduction Pass caused GPT-4o to hallucinate omissions — items that did not fit the four-section format were silently dropped.
- Prose summaries preserve meeting nuance and minority positions that bullets tend to flatten.
- Structured extraction (decisions, todos, risks, next actions) happens only once, at the final GPT-4o pass, where the model has full schema context and output constraints.

**API retry policy**: All GPT API calls in Pass 1, Reduction Pass, and Pass 2 use exponential backoff identical to BatchSttService. See §17.2.

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
- If Pass 2 fails: return empty MeetingMinutes with `purpose` = error message
- Partial results are still saved to `minutes.json`; UI indicates degraded quality

**JSON schema**: `purpose`, `decisions[]`, `todos[]`, `concerns[]`, `next_actions[]`

**Pass summary chain**:

```
Long transcript:   Chunks → [Pass 1: prose summaries]
                                      ↓ (if > 12k tokens)
                                [Reduction Pass: prose compression]
                                      ↓
                          [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes

Short transcript:  Direct → [Pass 2 GPT-4o: JSON extraction] → MeetingMinutes
```

### PostMeetingService

Accepts an optional `audioPath` override for import sessions:

```
postMeetingService.run(sessionId, opts?: { audioPath?: string })
  audioPath defaults to fileStore.getAudioForWhisper(sessionId)
  All 5 pipeline steps unchanged
  Each step prefixed by checkpoint write, suffixed by checkpoint update
  Emits session:status per step
  Each API-calling step wrapped in exponential backoff retry (§17.2)
```

### AutoCleanupService

Runs on app startup. Scans all sessions older than `StorageSettings.autoCleanupDays`.

```
autoCleanupService.run(dryRun?: boolean): CleanupReport
  for each session where:
    session.status === 'done'
    AND (now - session.createdAt) > autoCleanupDays * 86_400_000ms

  Delete derived files:
    audio.wav          (large — typically 50–200 MB for 1–2h import)
    audio.pcm          (recording raw capture — deleted when session done)
    chunks/            (transient, should already be gone after pipeline)
    transcript.jsonl   (recoverable from audio if needed)
    normalized.json    (recoverable from transcript)

  Keep:
    minutes.json       (primary user value — kept always)
    export.md          (primary user value — kept always)
    source/            (archived source file — only if copySourceFile was true)

CleanupReport: { scannedCount, cleanedCount, freedBytes, errors[] }
```

If `autoCleanupDays = 0`, auto-cleanup is disabled. The user can also trigger cleanup manually via Settings. See §17.1 for full design.

### ExportService
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
    ├── audio.pcm                     # Recording: Raw PCM16 16kHz mono
    ├── audio.wav                     # Import: 16kHz mono WAV from ffmpeg
    ├── pipeline.json                 # Pipeline checkpoint (atomic write)
    ├── transcript.jsonl              # TranscriptSegment[] (one JSON per line)
    ├── normalized.json               # NormalizedSegment[]
    ├── minutes.json                  # MeetingMinutes (structured) ← kept by cleanup
    └── export.md                     # Markdown export              ← kept by cleanup
```

**Storage location rationale**: Metadata files (`app.json`, `settings.json`, `vault.enc`, `logs/`) are small (< 10 MB total) and always remain in `userData` for reliable access. Session audio and transcript files are large (tens to hundreds of MB per session) and live under `storageRoot` which the user can redirect to an external drive or NAS. See §17.1.

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

`prepare_audio` only exists for import sessions. Recording sessions start from `batch_stt`.

---

## 7. TypeScript Interfaces

```typescript
// ── Core types ───────────────────────────────────────────────────────
type LangCode = 'ja' | 'vi' | 'en' | 'multi';
type SessionStatus = 'recording' | 'processing' | 'done' | 'error' | 'error_recoverable';

// ── SessionMeta ──────────────────────────────────────────────────────
interface SessionMeta {
  id:          string;
  title:       string;
  lang:        LangCode;
  createdAt:   number;
  status:      SessionStatus;

  // input mode
  inputType:            'recording' | 'import';
  sourceFileName?:      string;             // original filename (display only)
  durationMs?:          number;             // total audio duration in ms
  audioFormat?:         'pcm' | 'wav';      // which audio file is present

  // storage (v1.3.0+)
  sourceAbsolutePath?:  string;             // original file path on user's filesystem
  sourceArchivedPath?:  string;             // path inside sessions/{id}/source/ if copied
  diskUsageBytes?:      number;             // estimated size of all session files (cached)
}

// ── Import payload ───────────────────────────────────────────────────
interface ImportPayload {
  title:       string;
  sourcePath:  string;              // absolute path on user's filesystem
  sourceType:  'audio' | 'video';
  lang?:       LangCode;
}

// ── MediaProbeResult ─────────────────────────────────────────────────
interface MediaProbeResult {
  durationMs:  number;
  hasAudio:    boolean;
  hasVideo:    boolean;
  format:      string;
  audioCodec?: string;
  sampleRate?: number;
  channels?:   number;
}

// ── Pipeline checkpoint ──────────────────────────────────────────────
type PipelineStep =
  | 'prepare_audio'
  | 'batch_stt'
  | 'lang_detect'
  | 'normalizing'
  | 'summarizing'
  | 'exporting'
  | 'done';

interface PipelineState {
  sessionId:          string;
  step:               PipelineStep;
  status:             'pending' | 'running' | 'done' | 'error';
  lastCompletedStep?: PipelineStep;
  completedSteps:     PipelineStep[];
  error?:             string | null;
  updatedAt:          number;
}

// ── Storage settings (v1.3.0+) ───────────────────────────────────────
interface StorageSettings {
  storageRootPath:      string;    // default = app.getPath('userData')
  allowExternalStorage: boolean;   // if false, warn on non-userData paths
  autoCleanupDays:      number;    // 0 = disabled; default 30
  copySourceFile:       boolean;   // archive source file locally; default false
}

// ── Storage stats (v1.3.0+) ──────────────────────────────────────────
interface StorageStats {
  storageRootPath:    string;
  totalSessions:      number;
  totalDiskBytes:     number;
  freeBytesOnVolume:  number;
  perSession:         Array<{ sessionId: string; bytes: number; title: string }>;
}

// ── Cleanup report (v1.3.0+) ─────────────────────────────────────────
interface CleanupReport {
  scannedCount: number;
  cleanedCount: number;
  freedBytes:   number;
  errors:       Array<{ sessionId: string; message: string }>;
  dryRun:       boolean;
}

// ── AppSettings ──────────────────────────────────────────────────────
interface AppSettings {
  inputDeviceId?:   string;
  uiLang:           'ja' | 'en' | 'vi';
  whisperLangHint?: LangCode;
  storage:          StorageSettings;
}

// ── Existing segment types (unchanged) ───────────────────────────────
interface TranscriptSegment { /* speakerId, text, startMs, endMs, lang, detectedLang */ }
interface NormalizedSegment  { /* speakerId, originalText, normalizedText, detectedLang, method */ }
interface MeetingMinutes     { /* purpose, decisions[], todos[], concerns[], next_actions[] */ }
```

---

## 8. UI / Routing

### Routes

```
/                     → Dashboard        (session list + New Recording + Import)
/session/setup        → SessionSetup     (new recording form)
/session/:id/rec      → RecordingScreen  (timer + stop button)
/session/import       → ImportScreen     (file picker + metadata)
/session/:id          → PostMeeting      (results + progress + retry)
/settings             → Settings         (API key + prefs + storage)
```

### Dashboard

Session list showing all past and in-progress sessions. Two action buttons:

```
┌────────────────────────────────────────────────────────┐
│  MTG Assistant                    [新しい録音] [インポート] │
│  ──────────────────────────────────────────────────── │
│  プロダクトレビュー  2026-03-01  ✓ 完了   1.2 GB  [→] │
│  チームスタンドアップ 2026-02-28  ✓ 完了   82 MB   [→] │
│  週次ミーティング    2026-02-27  ⚠ エラー  —      [→] │
└────────────────────────────────────────────────────────┘
```

When `storage:warning` IPC push received (free space < 5 GB on `storageRoot` volume):

```
┌─────────────────────────────────────────────────────────────────┐
│ ⚠ ストレージの空き容量が少なくなっています (残 3.2 GB)             │
│   設定でストレージ先を変更するか、古いセッションを削除してください。 │
│                                              [設定を開く] [閉じる]│
└─────────────────────────────────────────────────────────────────┘
```

### SessionSetup

Form to start a new recording:
- Title (required, free text)
- Language hint (ja / en / vi / auto-detect)
- Microphone device selector
- Submit → `session:start` → navigate to `/session/:id/rec`

### RecordingScreen

Minimal screen shown during active recording:

```
┌──────────────────────────────────────────┐
│  録音中 / Recording                       │
│                                           │
│             01:23:45                      │
│                                           │
│          [■  録音停止]                    │
└──────────────────────────────────────────┘
```

- Timer increments every second via `recordingStore`
- Stop button calls `session:stop` → pipeline starts → navigate to `/session/:id`
- No transcript or caption display

### ImportScreen (unchanged from v1.1.0 design)

File picker + metadata form:
- File open dialog (wav/mp3/m4a/mp4/mov)
- On file chosen: `media:probe` → show duration; error if `!hasAudio`
- Form fields: title (required), lang (optional)
- Submit: `session:import` → navigate to `/session/:id`

### PostMeeting

Shows pipeline progress while processing, then results (議事録 / 要約 / ToDo tabs) when done.

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

**Results tabs** (shown when `status === 'done'`):

```
┌────────────────────────────────────────────────────────────┐
│  [議事録]  [要約]  [ToDo]                                   │
│  ──────────────────────────────────────────────────────── │
│  (tab content — rendered from minutes.json)                │
│                                              [MDエクスポート]│
└────────────────────────────────────────────────────────────┘
```

**Error state** and **Resume banner**: see §16.1 for full UX specification.

### Settings (updated — Storage section, simplified API Keys)

**API Keys section**: OpenAI only.

```
┌──────────────────────────────────────────────────────────────┐
│  APIキー設定                                                  │
│  ─────────────────────────────────────────────────────────── │
│  OpenAI API Key                                              │
│  [****abcd ___________________________________] [変更] [確認] │
└──────────────────────────────────────────────────────────────┘
```

**Storage section** (unchanged from v1.3.0 design — see §17.1).

---

## 9. Error Handling & UX

| Scenario | Behaviour |
|----------|-----------|
| ffmpeg binary not found | Error code `FFMPEG_MISSING` → toast: "ffmpeg が見つかりません。アプリを再インストールしてください。" |
| Video file has no audio stream | Error code `NO_AUDIO_STREAM` → shown in ImportScreen inline before import starts |
| Unsupported file format | File dialog filter prevents selection; if bypassed, ffprobe returns error → shown on probe |
| Whisper API failure (persistent) | After 4 retry attempts with backoff: pipeline pauses at `batch_stt`, error written to `pipeline.json`, retry button in PostMeeting |
| GPT rate limit / timeout | Same retry + backoff pattern for `normalizing` and `summarizing` steps |
| Import of long audio (WAV > 24 MB after conversion) | `BatchSttService` checks `wavFileSizeBytes` post-conversion; chunk mode triggered; all segments merged with correct offsets; dedup guard runs (no-op in normal case) |
| App crash mid-ffmpeg | ffmpeg child process dies with app; `pipeline.json` shows `prepare_audio: pending` → recoverable on restart |
| Disk full during conversion | ffmpeg exits non-zero; caught → `FfmpegError` → error state in PostMeeting |
| Source file moved (no-copy mode) | `prepare_audio` fails: `sourceAbsolutePath` not found → error shown with path + option to re-import from new location |
| storageRoot volume < 5 GB free | `storage:warning` push → dismissible banner in Dashboard; import blocked if < 500 MB free |
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
4. autoCleanupService.run()
5. diskMonitor.start()
```

### SessionStatus

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

Resume calls `session:resumePipeline`. The pipeline resumes from the checkpoint — already-completed steps (with their output files validated) are skipped.

**Step idempotency (content validation)**: before running a step, check if its output file exists **and passes content validation**. File existence alone is not sufficient — a crash mid-write can leave a partial or corrupt file.

| Step | Output file | Validation rule |
|------|-------------|-----------------|
| `batch_stt` | `transcript.jsonl` | Every line must `JSON.parse` without error; file must have ≥ 1 line |
| `lang_detect` | `transcript.jsonl` | Same as above, plus every parsed object must have a `detectedLang` field |
| `normalizing` | `normalized.json` | `JSON.parse` succeeds; result is a non-empty array |
| `summarizing` | `minutes.json` | `JSON.parse` succeeds; result has all required top-level keys; `data` has keys `purpose`, `decisions`, `todos`, `concerns`, `next_actions` |
| `exporting` | `export.md` | File size ≥ 100 bytes |

---

## 11. Services — File Reference

```
electron/services/
├── batch-stt.service.ts        Whisper batch + retry policy
├── lang-detect.service.ts      Unicode heuristic lang detection
├── normalization.service.ts    Rule + LLM text normalization
├── summarization.service.ts    GPT-4o minutes — prose pipeline
├── post-meeting.service.ts     Pipeline orchestrator (checkpoint + retry)
├── export.service.ts           Markdown renderer
├── media.service.ts            ffmpeg/ffprobe wrapper + watchdog
└── auto-cleanup.service.ts     Derived file cleanup
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

For production builds, `electron-builder` must be configured to include the binary via `asarUnpack`:

```json
"asarUnpack": ["node_modules/ffmpeg-static/**/*"]
```

At runtime in the packaged app, the path is resolved relative to `process.resourcesPath`.

**`ffprobe`** (needed for `media:probe`) is **not** included in `ffmpeg-static`. Use `ffprobe-static` package separately, same packaging approach.

**Licensing note**: The `ffmpeg-static` binary is built with LGPL configuration by default (no GPL codecs). This is sufficient for the input formats supported (wav, mp3, m4a, mp4, mov).

**Code-signing requirement**: Both the Electron app executable and the ffmpeg/ffprobe binaries must be code-signed in production builds. See §17.5 for the full CI/CD code-signing design.

### Build Output

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

## 13. File Reference

```
electron/
├── main.ts                        App entry, BrowserWindow, startup recovery + cleanup
├── preload.ts                     window.api context bridge
├── ipc/
│   ├── session.ipc.ts             Session lifecycle handlers
│   ├── session.import.ipc.ts      Import session handler
│   ├── audio.ipc.ts               PCM chunk receiver (disk write only)
│   ├── settings.ipc.ts            Settings + API key CRUD
│   ├── storage.ipc.ts             Storage stats, set root, cleanup
│   └── export.ipc.ts              Markdown export trigger
├── services/
│   ├── batch-stt.service.ts       Whisper batch + retry policy
│   ├── lang-detect.service.ts     Unicode heuristic lang detection
│   ├── normalization.service.ts   Rule + LLM text normalization
│   ├── summarization.service.ts   GPT-4o minutes — prose pipeline
│   ├── post-meeting.service.ts    Pipeline orchestrator
│   ├── export.service.ts          Markdown renderer
│   ├── media.service.ts           ffmpeg/ffprobe wrapper + watchdog
│   └── auto-cleanup.service.ts    Derived file cleanup
├── store/
│   ├── session.store.ts           Session index (app.json)
│   ├── file.store.ts              Per-session file ops (storageRoot)
│   └── secret.store.ts            API key vault (keytar + vault.enc)
└── utils/
    ├── paths.ts                   userData + storageRoot path helpers
    ├── logger.ts                  Structured NDJSON logger
    ├── disk-monitor.ts            Free-space poller
    ├── retry.ts                   Exponential backoff helper
    └── pipeline-lock.ts           PipelineLock singleton

renderer/src/
├── App.tsx                        React Router setup
├── main.tsx                       Entry point
├── screens/
│   ├── Dashboard.tsx              Session list + disk warning banner
│   ├── SessionSetup.tsx           New recording form
│   ├── RecordingScreen.tsx        Timer + stop button
│   ├── ImportScreen.tsx           File picker + metadata form
│   ├── PostMeeting.tsx            Results tabs + pipeline progress
│   └── Settings.tsx               API key + prefs + storage section
├── components/
│   ├── Layout.tsx                 Sidebar + nav
│   ├── SessionCard.tsx            Session list item (with diskUsageBytes)
│   ├── StatusBadge.tsx            Recording / processing / done / error badge
│   ├── PipelineProgress.tsx       Step list with retry attempt display
│   └── StorageStats.tsx           Per-session disk usage panel
├── hooks/
│   ├── useIpc.ts                  IPC event subscriptions
│   └── useAudioCapture.ts         AudioWorklet + AGC
├── store/
│   ├── sessionStore.ts            Zustand session state
│   └── recordingStore.ts          Zustand recording state (sessionId, timer)
└── i18n/
    ├── index.tsx                  I18nProvider + useT()
    └── locales.ts                 ja/en/vi string definitions

shared/
└── types.ts                       All shared TypeScript interfaces
```

---

## 14. Theme

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

Step-by-step plan to implement the batch-only recording + import architecture.

---

### A — UI

#### A1. Dashboard — New Recording + Import buttons

**Goal**: Surface both entry points from the main session list.

**Files to modify**:
- `renderer/src/screens/Dashboard.tsx`

**Changes**:
- Add "新しい録音 / New Recording" primary button → `navigate('/session/setup')`
- Add secondary "インポート / Import" button → `navigate('/session/import')`
- Show disk warning banner on `storage:warning` IPC push (dismissible)
- Add import + storage strings to `locales.ts`

**Acceptance criteria**:
- Both buttons visible in all 3 UI languages
- Disk warning banner appears and is dismissible
- Session list shows status badges and disk usage

---

#### A2. SessionSetup — Recording form

**Goal**: Collect title, language hint, and microphone before starting recording.

**Files to modify / create**:
- `renderer/src/screens/SessionSetup.tsx`

**Key logic**:
- Title input (required)
- Language selector: ja / en / vi / auto-detect
- Microphone device selector (from `navigator.mediaDevices.enumerateDevices`)
- Submit → `window.api.session.start({ title, lang, inputDeviceId })` → navigate to `/session/:id/rec`

**Acceptance criteria**:
- Submit disabled when title empty
- Device list populated correctly
- Navigate to RecordingScreen with correct sessionId

---

#### A3. RecordingScreen — Timer + stop

**Goal**: Minimal recording view with elapsed timer and stop button. No captions.

**Files to create**:
- `renderer/src/screens/RecordingScreen.tsx`

**Files to modify**:
- `renderer/src/App.tsx` — add route `/session/:id/rec`

**Key logic**:
- Subscribe to `recordingStore.elapsedMs` for timer display
- Stop button → `window.api.session.stop({ sessionId })` → navigate to `/session/:id`
- Re-mount guard: if `recordingStore.sessionId !== sessionId`, do not call `startRecording()` again

**Acceptance criteria**:
- Timer increments every second
- Navigating away and back resumes timer without restarting audio
- Sidebar REC badge persists during recording
- Stop navigates to PostMeeting

---

#### A4. ImportScreen — File picker + metadata

**Goal**: Allow user to select a file, validate it, fill metadata, and kick off import.

**Files to create**:
- `renderer/src/screens/ImportScreen.tsx`

**Files to modify**:
- `renderer/src/App.tsx` — add route `/session/import`
- `renderer/src/i18n/locales.ts` — add `import.*` string keys

**Key logic**:
- File open dialog via `window.api.dialog.openFile(['wav','mp3','m4a','mp4','mov'])`
- On file chosen: call `window.api.media.probe(filePath)` → display duration; error if `!hasAudio`
- Form fields: title (required), lang (optional)
- Submit: `window.api.session.import({ title, sourcePath, sourceType, lang })` → navigate to `/session/:id`

**Acceptance criteria**:
- File picker filters to supported extensions
- Duration and format shown after probe
- "No audio stream" error blocks submission
- Valid import navigates to PostMeeting with status = processing

---

#### A5. PostMeeting — Progress + results

**Goal**: Show live pipeline progress during processing; show results tabs when done.

**Files to modify**:
- `renderer/src/screens/PostMeeting.tsx`

**Files to create**:
- `renderer/src/components/PipelineProgress.tsx`

**Key logic**:
- Subscribe to `session:status` IPC events
- Show `PipelineProgress` when `status === 'processing' || 'error' || 'error_recoverable'`
- Each step: waiting / running (with progress %) / done / error
- Retry button: `window.api.session.retryStep({ sessionId, step })`
- Resume banner for `error_recoverable`: button calls `session:resumePipeline`
- When `status === 'done'`: hide progress panel, show 議事録 / 要約 / ToDo tabs with export button

**Acceptance criteria**:
- Steps light up in order during processing
- Error state shows which step failed
- Retry reruns from failed step onward
- Resume works after app restart

---

### B — Main Process

#### B1. `session.ipc.ts` — Recording lifecycle

**Goal**: Handle `session:start` and `session:stop` for recording sessions.

**Key changes**:
- `session:start` payload: `{ title, lang, inputDeviceId }` (no `targetLang`)
- `session:stop` triggers post-meeting pipeline asynchronously, returns immediately
- Navigate signal sent via `session:status { status: 'processing' }`

---

#### B2. `audio.ipc.ts` — Disk write only

**Goal**: Forward `audio:chunk` PCM to `fileStore.appendAudio()` only. No STT forwarding.

**Key change**:
- Remove any `sttService.sendAudio()` call
- `fileStore.appendAudio(sessionId, pcmBuffer)` only

---

#### B3. `session.import.ipc.ts` — Import handler

**Goal**: Handle `session:import`, `session:retryStep`, `session:resumePipeline`, `media:probe`.

**Key functions**:
```
handleImport(payload: ImportPayload): Promise<{ sessionId }>
  1. sessionStore.create({ ...meta, inputType:'import', status:'processing' })
  2. fileStore.copySource(sessionId, sourcePath)  [if copySourceFile=true]
  3. Run media conversion (MediaService)
  4. Kick off postMeetingService.run(sessionId) — async, do NOT await in handler
  5. Return { sessionId } immediately

handleRetryStep({ sessionId, step }): Promise<void>
  Read pipeline.json, validate step is retryable, call postMeetingService.runFrom(sessionId, step)

handleResumePipeline({ sessionId }): Promise<void>
  Read pipeline.json → determine nextStep → postMeetingService.runFrom(sessionId, nextStep)

handleMediaProbe({ filePath }): Promise<MediaProbeResult>
  Delegates to mediaService.probe(filePath)
```

---

#### B4. `post-meeting.service.ts` — Checkpoint support

**Goal**: Write/read `pipeline.json` at each step boundary; support `runFrom(sessionId, step)`.

**Key functions**:
```
run(sessionId, opts?): Promise<void>          // full pipeline
runFrom(sessionId, startStep): Promise<void>  // partial pipeline (retry/resume)
writeCheckpoint(sessionId, state): Promise<void>
readCheckpoint(sessionId): Promise<PipelineState | null>
```

**Step skip logic** (idempotency + content validation as per §10):
- Before `batch_stt`: validate `transcript.jsonl`
- Before `normalizing`: validate `normalized.json`
- Before `summarizing`: validate `minutes.json`
- Before `exporting`: validate `export.md`

---

#### B5. `batch-stt.service.ts` — WAV + PCM input

```
transcribe(audioPath, lang, sessionId): Promise<TranscriptSegment[]>
  if audioPath.endsWith('.pcm'): add RIFF header in-memory
  if audioPath.endsWith('.wav'): read as-is
  if file > 24MB: chunk via ffmpeg, transcribe each, merge
```

---

### C — Storage

#### C1. `file.store.ts` — Import file ops

**Key functions to add**:
```
copySource(sessionId, sourcePath): Promise<string>
getAudioForWhisper(sessionId): string   // resolves audio.wav or audio.pcm
writeWav(sessionId, wavPath): Promise<void>
writePipeline(sessionId, state): Promise<void>   // atomic (.tmp → rename)
readPipeline(sessionId): Promise<PipelineState | null>
```

---

### D — Types

#### D1. `shared/types.ts`

See §7 for complete interface definitions.

Key changes from v1.3.0:
- `LangCode`: remove `'none'` (was translation-target sentinel)
- `SessionMeta.inputType`: `'recording' | 'import'` (was `'realtime' | 'import'`)
- `SessionMeta`: remove `targetLang`
- `ImportPayload`: remove `targetLang`

---

### E — Packaging

#### E1. ffmpeg / ffprobe binaries

**Approach**: `ffmpeg-static` + `ffprobe-static` npm packages.

**Files to modify**:
- `package.json` — add as `dependencies`
- `electron-builder` config — add `asarUnpack` rule
- `electron/utils/ffmpeg-path.ts` — runtime binary path resolver

**Acceptance criteria**:
- Dev: binaries resolve from `node_modules`
- Packaged: binaries unpacked from asar, path resolves on Windows and macOS
- `MediaService` throws `FfmpegNotFoundError` if binary not found

---

### F — QA Scenarios

| # | Scenario | Expected result |
|---|----------|-----------------|
| F1 | Record meeting ~15 min, stop | PostMeeting shows processing → 議事録 / 要約 / ToDo tabs |
| F2 | Import MP3 ~10 min | Converts to WAV, Whisper transcribes, full pipeline, PostMeeting shows results |
| F3 | Import MP4 ~30 min with audio | Audio extracted, same pipeline, correct duration in SessionMeta |
| F4 | Import MP4 with no audio stream | `probe` returns `hasAudio: false`, Import button disabled, no session created |
| F5 | Import audio where converted WAV > 24 MB (e.g., 2h MP3 → ~110 MB WAV) | BatchSttService chunks; all segments merged with correct offsets; dedup guard runs (no-op in normal case) |
| F6 | Whisper API failure (network off) | Retry with backoff (4 attempts); after max: status=error at `batch_stt`, retry button shown |
| F7 | App crash during `normalizing` | Relaunch: session shows `error_recoverable`, resume from `normalizing`, skips `batch_stt`/`lang_detect` |
| F8 | App crash during `prepare_audio` (ffmpeg running) | Relaunch: `audio.wav` absent or partial, session marked `error_recoverable`, "re-import required" |
| F9 | Navigate away during recording | REC badge in sidebar; audio uninterrupted; return to RecordingScreen shows correct timer |
| F10 | Import with `copySourceFile = false`, then original file moved | `prepare_audio` fails with path-not-found error; user shown path + re-import option |
| F11 | storageRoot volume drops below 5 GB | Dashboard warning banner appears; import blocked below 500 MB |
| F12 | Whisper returns 429, then succeeds on retry | `retryAttempt: 2` shown in progress panel; step completes; no pipeline error |
| F13 | ffmpeg hangs (no stderr for 10 min) | Watchdog kills process; PipelineLock released; step marked error; session recoverable |
| F14 | Auto-cleanup on startup (30-day-old done sessions) | `audio.wav` and derived files deleted; `minutes.json` and `export.md` preserved |

---

### Estimated Risk Areas

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **ffmpeg binary not found in packaged app** | Medium | High | Thorough `asarUnpack` config; `FfmpegNotFoundError` with clear user message; CI smoke-test on packaged build |
| R2 | **Whisper 25MB file size limit** for long recordings | High (2h ≈ ~110MB WAV) | High | Chunk mode in BatchSttService; test with 1h file |
| R3 | **Pipeline checkpoint corruption** (crash during write) | Low | Medium | Atomic write (`.tmp` → rename); if `.tmp` exists on startup, discard it |
| R4 | **Race condition**: user navigates to PostMeeting before `session:import` responds | Low | Low | `session:import` returns `sessionId` before async processing starts; PostMeeting subscribes to `session:status` |
| R5 | **macOS audio permission for `getUserMedia`** | Medium | Medium | Prompt for mic permission on first launch; error handling if denied |
| R6 | **External storageRoot unavailable** (network drive disconnected) | Medium | High | Validate path on startup; error if `storageRoot` inaccessible; fall back to userData with warning |
| R7 | **Source file deleted before retry** (no-copy mode) | Medium | Medium | Clear error message on `prepare_audio` failure; offer re-import from new path |
| R8 | **PipelineLock deadlock** (ffmpeg hang) | Low | High | 2h lock timeout + 10min watchdog; see §17.3 |

---

## 16. Production Hardening Layer

This section documents stability, security, and cost-control measures. Core features from §1–§15 are unchanged; this layer wraps them.

---

### 16.1 Pipeline Checkpoint & Resume

Extends the `pipeline.json` design with a strict state machine and unified resume path for both recording and import sessions.

#### Checkpoint schema

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

On startup: if `pipeline.json.tmp` exists alongside `pipeline.json`, discard the `.tmp`.

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
      mark status = 'error_recoverable'
      message = 'Processing interrupted at step: {state.step}'
    else:
      mark status = 'error_recoverable'
      message = 'Processing interrupted at step: {state.step}'
  sessionStore.save()
```

#### Resume flow

`session:resumePipeline { sessionId }` IPC:
1. Read `pipeline.json` → determine `lastCompletedStep`
2. Set `nextStep` = step after `lastCompletedStep` in ordered step list
3. Call `postMeetingService.runFrom(sessionId, nextStep)`
4. Each step checks for existing validated output file (idempotency) before executing

#### UI — Resume banner in PostMeeting

```
┌───────────────────────────────────────────────────────┐
│  ⚡ 前回の処理を再開できます                            │
│  最後の完了ステップ: lang_detect                        │
│                    [normalizing から再開]               │
└───────────────────────────────────────────────────────┘
```

---

### 16.2 Chunk-Based Whisper for Long Audio

#### Chunk trigger

Chunking is triggered by **WAV file size after conversion**, not duration:

```
stat(audio.wav) → wavFileSizeBytes
if wavFileSizeBytes > 24_000_000: chunk mode
else:                              single upload
```

For recording sessions, `audio.pcm` is converted to WAV in-memory (RIFF header prepended) before the size check is applied.

#### Chunk storage lifecycle

```
{storageRoot}/sessions/{id}/chunks/    ← created before chunking starts
    chunk_000.wav                      ← 15-min slice
    chunk_001.wav
    ...
```

Chunks are **transient**: deleted after segment merge and `transcript.jsonl` is written. On startup recovery: if `chunks/` exists but `transcript.jsonl` is absent or fails validation → `batch_stt` must be retried from scratch; chunks are regenerated.

#### Time offset merging

```
chunkDurationMs = 15 * 60 * 1000   // 900_000 ms

for each chunk at index i:
  offset = i * chunkDurationMs
  for each segment in chunkResult:
    segment.startMs += offset
    segment.endMs   += offset
```

#### Deduplication guard (no overlap, optional)

Chunks are created with **no audio overlap** — the ffmpeg segment muxer performs a stream-copy cut at exact 15-minute boundaries. Genuine duplicate segments do not occur in normal operation.

A **text-similarity dedup guard** runs as a defensive check after offset adjustment:

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

#### Memory ceiling

| Stage | Peak RAM |
|-------|----------|
| ffmpeg chunking | ~10 MB (stream, no buffer) |
| Single chunk upload | ~15 MB (WAV slice in memory for multipart) |
| Merged TranscriptSegment[] for 2h session | ~5–15 MB JSON |
| Total peak | < 30 MB above baseline |

---

### 16.3 Hierarchical Summarization (prose pipeline)

See the SummarizationService in §5 for full design. This section documents cost governance specifics.

#### Reduction Pass design (prose compression)

Triggered when concatenated Pass 1 chunk summaries exceed 12,000 tokens:

```
Trigger check:
  estimateTokens(allChunkSummaries.join('\n\n')) > 12_000

Reduction Pass — GPT-4o-mini prose compression
  Input:  all N × ChunkSummary strings concatenated
  Prompt: "Compress the following meeting segment summaries into shorter prose.
           Preserve all decisions, action items, and risks.
           Output as flowing paragraphs — do not use bullet lists or impose structure."
  Model:  gpt-4o-mini, temperature: 0, max_tokens: 1200
  → ReducedSummary (prose, ≤ 4,000 tokens)
```

**Rationale**: forced bullet output (`## Key Points / ## Decisions / ## Action Items / ## Risks`) caused GPT-4o-mini to silently drop items that did not fit neatly into one section. Prose preserves nuance; structured extraction happens only once at Pass 2.

#### Token estimation

```
estimateTokens(segments: NormalizedSegment[]): number
  total = 0
  for each segment:
    for each char in normalizedText:
      if CJK codepoint: total += 1.5
      else: total += 0.33   // ~3 chars per token for Latin
  return Math.ceil(total)
```

#### Cost estimate per meeting

| Meeting length | Whisper (STT) | GPT-4o-mini (norm+pass1) | GPT-4o (pass2) | Total |
|---------------|---------------|--------------------------|-----------------|-------|
| 30 min | ~$0.18 | ~$0.01 | ~$0.04 | **~$0.23** |
| 1 hour | ~$0.36 | ~$0.02 | ~$0.04 | **~$0.42** |
| 2 hours | ~$0.72 | ~$0.04 | ~$0.04 | **~$0.80** |

Assumptions: Whisper at $0.006/min; gpt-4o-mini at $0.15/1M in + $0.60/1M out; gpt-4o at $5/1M in + $15/1M out. Prices indicative at March 2026.

#### Guardrails

| Guard | Threshold | Action |
|-------|-----------|--------|
| Max transcript length | 200,000 characters | Truncate to first 200k, log warning, note in minutes |
| Max GPT tokens per request | 8,000 input / 1,024 output | Enforced by chunk size |
| Cost warning | > 5 chunks in Pass 1 | Emit `session:status` with `warning: 'HIGH_COST_EXPECTED'` |
| Normalization Phase 2 gate | Only if filler density > 15% | Prevents unnecessary LLM calls for clean audio |

---

### 16.4 Secure API Key Storage

Replaces plaintext storage with a two-tier system.

#### Tier 1 — OS keychain via `keytar` (primary)

```
keytar.setPassword('mtg-assistant', service, key)
keytar.getPassword('mtg-assistant', service)   // → string | null
keytar.deletePassword('mtg-assistant', service)
```

`service` values: `'openai'` only (v1.4.0-lite — Whisper + GPT)

Keys stored in:
- Windows: Windows Credential Manager
- macOS: macOS Keychain

#### Tier 2 — Encrypted fallback `vault.enc`

Used when `keytar` is unavailable (e.g., headless CI, minimal Linux installs without libsecret).

```
Encryption: AES-256-GCM
Key derivation: PBKDF2(machineId + appName, salt, 100_000 iterations, SHA-256)
machineId: os.hostname() + app.getPath('userData')  (stable per install)
Format: { iv: hex, salt: hex, tag: hex, data: hex }  per service
```

The machine-derived key means `vault.enc` is non-portable — cannot be decrypted on a different machine.

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

---

### 16.5 Concurrency Guard (PipelineLock)

Only one active pipeline is allowed at a time. Enforced in-memory (fast path) and via persisted flag in `app.json` (recovery path). v1.3.0 adds lock timeout and heartbeat watchdog to prevent deadlock from hung child processes.

#### Rules

| Action attempted | Condition | Result |
|-----------------|-----------|--------|
| Start recording | Another session `status='processing'` | Blocked — toast error |
| Start recording | Another session `status='recording'` | Blocked — impossible by design |
| Start import | Session `status='recording'` active | Blocked — toast error |
| Start import | Another session `status='processing'` | Blocked — toast error |
| Resume pipeline | Another pipeline running in memory | Queued until running pipeline completes |

#### In-memory lock

```typescript
// electron/utils/pipeline-lock.ts
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

```
watchdog checks every 60s:
  if pipelineLock.isHeartbeatStale():
    log.error('watchdog', 'Heartbeat stale — killing child processes', { activeSessionId })
    mediaService.killActiveProcess()     // kills ffmpeg if running
    pipelineLock.forceRelease()
    sessionStore.markError(activeSessionId, 'Processing watchdog triggered — retry required')
    ipcMain.send('session:status', { sessionId: activeSessionId, status: 'error' })
```

#### Persisted flag

`app.json` SessionMeta has `status: 'processing'` while a pipeline runs. On startup recovery scan (§16.1), any session with `status='processing'` is moved to `error_recoverable` — this ensures the lock is implicitly released on restart.

#### UI enforcement

New Recording and Import buttons are **disabled** (not hidden) when `pipelineLock.isLocked()`. Tooltip: "別の会議が処理中です / Another session is being processed".

---

### 16.6 Logging & Observability

Structured logging in the main process only. The renderer never writes logs directly.

#### Log file

```
%APPDATA%/mtg-assistant/logs/app.log
~/Library/Application Support/mtg-assistant/logs/app.log
```

**Rotation**: when `app.log` exceeds 5 MB, rename to `app.log.1`. Keep maximum 3 rotated files. Total log storage cap: ~20 MB.

#### Log format

Each line is a JSON object (newline-delimited):

```json
{ "ts": 1709500000000, "level": "info",  "ctx": "pipeline", "msg": "step started",  "sessionId": "uuid", "step": "batch_stt" }
{ "ts": 1709500001234, "level": "info",  "ctx": "api",      "msg": "whisper call",  "sessionId": "uuid", "chunkIndex": 0, "fileSizeBytes": 14200000 }
{ "ts": 1709500005678, "level": "warn",  "ctx": "api",      "msg": "whisper retry", "sessionId": "uuid", "attempt": 2, "waitMs": 4000 }
{ "ts": 1709500005678, "level": "error", "ctx": "api",      "msg": "whisper error", "sessionId": "uuid", "code": 429 }
{ "ts": 1709500000100, "level": "info",  "ctx": "ffmpeg",   "msg": "process exited","exitCode": 0, "durationMs": 4200 }
{ "ts": 1709500000200, "level": "warn",  "ctx": "watchdog", "msg": "heartbeat stale","sessionId": "uuid" }
{ "ts": 1709500000300, "level": "info",  "ctx": "cleanup",  "msg": "derived files deleted", "sessionId": "uuid", "freedBytes": 145000000 }
```

#### What is logged

| Category | What | What NOT |
|----------|------|----------|
| Pipeline | Step start/end, duration, session ID | Transcript text content |
| AI API calls | Model, token counts, latency, error codes, retry attempts | API keys, request/response body |
| ffmpeg | Exit code, duration, stderr snippet on error | Audio content |
| App lifecycle | Startup, crash recovery actions, cleanup | — |
| Watchdog | Stale heartbeat events, force-release actions | — |
| Errors | All caught errors with stack (truncated to 500 chars) | — |

**Privacy**: transcript text, speaker IDs, meeting titles, and API keys are **never** logged.

#### Logger interface

```
// electron/utils/logger.ts
logger.info(ctx, msg, meta?)
logger.warn(ctx, msg, meta?)
logger.error(ctx, msg, meta?)
logger.debug(ctx, msg, meta?)
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

#### Guardrails implemented

| Guardrail | Where enforced | Value |
|-----------|---------------|-------|
| Max transcript chars before summarization | `PostMeetingService` | 200,000 chars |
| Max Whisper chunk size | `BatchSttService` | 24 MB (below 25 MB API limit) |
| Max GPT tokens per normalization batch | `NormalizationService` | 20 segments / call |
| Max GPT tokens per summarization chunk | `SummarizationService` | 8,000 tokens input |
| Max GPT tokens for final summary input | `SummarizationService` | 12,000 tokens (else extra reduction pass) |

#### Cost warning flow

If Pass 1 in hierarchical summarization would require > 5 chunk calls (meeting > ~1.5 hours of dense speech):

```
session:status push → { sessionId, warning: 'HIGH_COST_EXPECTED', estimatedUSD: 0.62 }
```

UI shows a dismissible banner: "この会議の処理には推定 $0.62 のAPI費用が発生します。続けますか？"
User can cancel or proceed. If cancelled: session marked `error` with message "User cancelled due to cost estimate".

---

## 17. Enterprise Hardening Layer

This section documents the six enterprise-hardening features. Core features from §1–§16 are unchanged; these features extend and protect them in enterprise-scale deployments.

---

### 17.1 Storage Location Customization

#### Problem

Sessions are stored by default in Electron's `userData` directory, which resides on the system drive. Importing large audio or video files — after conversion to 16kHz WAV — can consume hundreds of megabytes per session. Organizations with multiple users, or users processing multi-hour recordings daily, can fill the system drive within weeks.

#### Design

`StorageSettings` block in `AppSettings` (see §7):

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
    audio.pcm              (recording raw — delete when session done)
    chunks/                (should already be gone; safety sweep)
    transcript.jsonl       (recoverable from audio if ever needed)
    normalized.json        (recoverable from transcript)

  Always keep:
    minutes.json           (primary user value)
    export.md              (primary user value)
    source/                (archived source, if present)
    pipeline.json          (checkpoint metadata — negligible size)
```

If `dryRun = true`, the report shows what would be deleted without deleting.

**Disk tradeoffs** (documented in UI tooltip):

| Mode | Notes |
|------|-------|
| `copySourceFile = false` (default) | Minimum disk. Source stays on original drive. Retry fails if file moves. |
| `copySourceFile = true` | Double disk for source duration. Retry always works. |
| `autoCleanupDays = 30` (default) | Derived files cleared after 30 days. Minutes + export permanently kept. |
| `autoCleanupDays = 0` | No auto-cleanup. User manages storage manually. |

#### Settings UI — Storage section

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

---

### 17.2 API Resilience — Exponential Backoff

#### Problem

Whisper and GPT API calls can fail transiently: HTTP 429 (rate limits), HTTP 5xx (server errors), or network timeouts. Under enterprise-scale usage — multiple users sharing API keys, or large batch imports — transient failures are common and should be handled automatically.

#### Retry policy

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

**Non-retryable errors** (fail immediately):

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

---

### 17.3 Process Watchdog & Lock Safety

#### Problem

If a child process (ffmpeg or ffprobe) hangs — for example due to a corrupt input file causing ffmpeg to loop indefinitely — the `PipelineLock` is never released. No new sessions can be started until the app is restarted.

#### PipelineLock deadlock prevention

Full lock design is documented in §16.5. Summary:

| Mechanism | Value | Purpose |
|-----------|-------|---------|
| Lock timeout | 2 hours | Hard ceiling — no pipeline should take longer |
| Heartbeat interval | Every 30s | Step emits keep-alive while running |
| Watchdog check interval | Every 60s | Main process checks heartbeat staleness |
| Heartbeat stale threshold | 10 minutes | Time without heartbeat → assume hang |

**Lock state recovery on restart**: On app startup, if `session.status === 'processing'` in `app.json`, the lock is implicitly released by the recovery scan which sets status to `error_recoverable`. The in-memory `PipelineLock` is reset to null on process startup.

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

---

### 17.4 Reduction Pass Refinement

This section captures the design rationale for the prose-based Reduction Pass. The implementation details are in §5 SummarizationService and §16.3.

#### Problem with forced bullet structure

A four-section bullet output (`## Key Points / ## Decisions / ## Action Items / ## Risks`) in the Reduction Pass introduced hallucination of omission:

1. Items that spanned multiple categories were placed in one section and lost from others.
2. Minority opinions or "parking lot" items without a clear category were silently dropped.
3. Pass 2 (GPT-4o) received a pre-classified input, biasing its extraction and reducing its ability to identify implicit decisions or risks.

#### v1.4.0-lite design

| Stage | Old | Current |
|-------|-----|---------|
| Pass 1 (per-chunk) | Bullet-hinted prose | Free-form prose (no structure prompt) |
| Reduction Pass | Four forced sections (`##` headers) | Prose compression (paragraphs only) |
| Pass 2 (final) | JSON extraction from mixed input | JSON extraction from clean prose |
| Structured output | Split across passes | Single extraction point at Pass 2 |

#### Prompt engineering constraints

- Pass 1 prompt must not mention "decisions", "action items", etc. by name
- Reduction Pass prompt explicitly forbids bullet lists and headers
- Pass 2 (GPT-4o strict JSON schema) is the only place where classification and extraction happens

#### Tradeoff

Prose summaries are slightly longer than bullet-compressed equivalents (~10–20% more tokens). This increases cost marginally but is dominated by the reduction in re-runs caused by missing information.

---

### 17.5 FFmpeg Enterprise Code-Signing

#### Problem

Without code-signing, both the Electron app executable and the bundled ffmpeg/ffprobe binaries may be flagged by antivirus software, Microsoft Defender SmartScreen, or macOS Gatekeeper. In enterprise environments, unsigned binaries are often blocked or quarantined automatically.

#### Requirements

| Component | Platform | Signing requirement |
|-----------|----------|-------------------|
| Electron app (`.exe` / `.app`) | Windows, macOS | Must be code-signed with valid EV certificate |
| `ffmpeg.exe` / `ffmpeg` binary | Windows, macOS | Must be code-signed separately |
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

- Windows: EV (Extended Validation) Code Signing Certificate. Stored as `PFX` secret in CI/CD vault.
- macOS: Apple Developer ID Application certificate. Stored in CI/CD keychain. Requires Apple notarization.
- Certificates **must not** be stored in source control or on developer workstations.

#### Build verification step

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

A `DiskMonitor` singleton runs in the main process, polling free space on the `storageRoot` volume every **5 minutes**.

```typescript
// electron/utils/disk-monitor.ts
class DiskMonitor {
  private readonly POLL_INTERVAL_MS      = 5 * 60 * 1000
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

**Blocking behavior**: If `freeBytes < BLOCK_THRESHOLD_BYTES` (500 MB), new imports are blocked: `"空き容量が不足しています。ストレージを解放してから再試行してください。"`

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
| Cleanup button | "今すぐクリーンアップ" — triggers `storage:runCleanup` with `dryRun: true` first |

**Session card** (Dashboard list item): optionally shows session disk usage if `SessionMeta.diskUsageBytes` is set. Displayed as a small muted label: `"1.2 GB"`. Computed lazily after session completes and cached in `SessionMeta`.

#### `storage:getStats` implementation

```
storage:getStats (IPC invoke):
  1. Read all sessions from sessionStore
  2. For each session: sum file sizes under {storageRoot}/sessions/{id}/
  3. Get free bytes on storageRoot volume
  4. Return StorageStats
```

Stat computation is done in a background task (non-blocking). First call returns a cached value immediately; updated result is pushed via a follow-up event if needed.

---

*End of DESIGN.md v1.4.0-lite*
