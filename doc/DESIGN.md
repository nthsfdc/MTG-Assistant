# MTG Assistant — Design Document

**Version**: 1.2.0
**Stack**: Electron 31 + React 18 + TypeScript 5.5 + Tailwind CSS 3
**Platform**: Windows (primary), macOS

---

## Changelog

| Version | Date | Changes |
|---------|------|---------|
| 1.0.0 | 2026-02 | Initial design: realtime recording, STT, translation, post-meeting pipeline |
| 1.1.0 | 2026-03 | **Import mode**: audio/video file import, MediaService (ffmpeg), pipeline checkpoint, crash recovery |
| 1.2.0 | 2026-03 | **Production Hardening**: chunk-based Whisper for long audio, hierarchical summarization, secure keytar storage + encrypted fallback, concurrency guard, structured logging with rotation, cost governance guardrails |

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
| Data stored | audio.pcm | audio.wav + source/{original} |
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
│  │  PostMeeting     Export            MediaService ← NEW  │  │
│  └────────────────────────────────────────────────────────┘  │
│  ┌─────────────────────────────────────────────────────┐     │
│  │ Stores                                              │     │
│  │  session.store (app.json)                           │     │
│  │  file.store    (sessions/{id}/...)       ← updated  │     │
│  │  secret.store  (vault.json)                         │     │
│  └─────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
              │
              ▼ External APIs
   Deepgram · OpenAI (Whisper + GPT-4o) · DeepL
```

### Process Separation

| Concern | Process |
|---------|---------|
| UI rendering, audio capture | Renderer (sandboxed) |
| STT WebSocket, file I/O, API calls | Main |
| ffmpeg child process management | Main only |
| API key exposure, raw PCM/WAV | Main only — never in renderer |

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
| `session:resumePipeline` | `{ sessionId }` | `void` ← **NEW v1.2** |
| `media:probe` | `{ filePath }` | `MediaProbeResult` |
| `settings:get` | — | `AppSettings` |
| `settings:save` | `Partial<AppSettings>` | `void` |
| `apikey:set` | `{ service, key }` | `void` |
| `apikey:get` | `{ service }` | `string \| null` |
| `apikey:exists` | `{ service }` | `boolean` |
| `export:markdown` | `{ sessionId }` | `{ filePath }` |

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
| `session:status` | `{ sessionId, status, step?, progress? }` ← extended |
| `session:done` | `{ sessionId, exportPath }` |
| `error` | `{ code, message, sessionId? }` |

**`session:status`** is reused for both realtime post-processing and import pipeline progress. Extended in v1.2.0:

| Field | Type | Notes |
|-------|------|-------|
| `sessionId` | string | — |
| `status` | `SessionStatus` | — |
| `step` | `PipelineStep?` | current step |
| `progress` | number? | 0–100, per-step % |
| `lastCompletedStep` | `PipelineStep?` | ← **NEW v1.2** — for resume banner |
| `error` | string? | ← **NEW v1.2** — error message if status=error |

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
                  Whisper API → TranscriptSegment[]
                  fallback: realtime transcript.jsonl (realtime only)
                  [checkpoint]  { step: 'lang_detect', status: 'pending' }

2. lang_detect  → Unicode heuristic per segment → detectedLang
                  [checkpoint]  { step: 'normalizing', status: 'pending' }

3. normalizing  → Phase 1: rule-based filler removal
                  Phase 2: GPT-4o-mini rewrite (optional, batched 20/call)
                  → normalized.json
                  [checkpoint]  { step: 'summarizing', status: 'pending' }

4. summarizing  → GPT-4o structured output
                  → minutes.json { purpose, decisions, todos, concerns, next_actions }
                  [checkpoint]  { step: 'exporting', status: 'pending' }

5. exporting    → exportService.toMarkdown()
                  → export.md
                  [checkpoint]  { step: 'done', status: 'done' }

6. save         → sessionStore.update(status: 'done')
                  → session:done event
```

### 4.3 Import Flow (new)

```
Renderer: ImportScreen
    user picks file via dialog
    → media:probe (invoke) → { durationMs, hasAudio, format }
    user inputs title, lang, targetLang
    → session:import (invoke) → { sessionId }
    → navigate to /session/:id  (PostMeeting, shows live progress)

Main: import.ipc.ts  handles session:import
    1. sessionStore.create({ title, lang, targetLang, inputType:'import', status:'processing' })
    2. fileStore.copySource(sessionId, sourcePath)      → sessions/{id}/source/{filename}
       [checkpoint]  { step: 'prepare_audio', status: 'pending' }

    3. MediaService
       if sourceType === 'video':
         mediaService.extractAudio(sourcePath, tmpWavPath)
       else:
         mediaService.convertTo16kMonoWav(sourcePath, tmpWavPath)
       → sessions/{id}/audio.wav (written by streaming ffmpeg pipe, never in RAM)
       [checkpoint]  { step: 'batch_stt', status: 'pending' }

    4. postMeetingService.run(sessionId, { audioPath: 'audio.wav' })
       (same pipeline as §4.2 — all 5 steps)
```

**Key constraint**: ffmpeg is spawned as a child process. Output is written directly to `audio.wav` on disk via ffmpeg's `-y` flag and output path argument — the Node process never buffers the full audio in RAM.

---

## 5. Services

### SttService (unchanged)
- Deepgram nova-3 WebSocket (`wss://api.deepgram.com/v1/listen`)
- Params: `model=nova-3&diarize=true&smart_format=true&language=multi`
- Reconnect: once after 2s on disconnect, then degrade silently

### BatchSttService (updated — v1.2.0: chunk-based for long audio)

Whisper-1 has a hard **25 MB file size limit** and degrades above ~30 minutes of audio. BatchSttService handles long files transparently using chunk-based transcription.

**Decision threshold**: audio duration > 30 minutes OR file size > 24 MB → chunk mode.

**Chunking strategy**:

```
1. Probe duration via MediaService.probe()
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
5. Merge all segment arrays → single TranscriptSegment[]
6. Delete chunks/ directory after merge
```

**Memory usage**: each chunk is read as a stream for upload; the merged segment array is the only in-memory structure. Peak RAM ≈ single chunk size (~15 MB WAV slice) + segment JSON.

**Overlap handling**: last 5 seconds of each chunk are included in the next chunk's start window to avoid cutting mid-word. Duplicate segments from overlap are deduplicated by `startMs` comparison after merge.

**Single-chunk path** (≤ 30 min, ≤ 24 MB): behaves as before — no chunking, direct upload.

**Input**:
- `.pcm` (realtime): adds RIFF WAV header in-memory before upload
- `.wav` (import): reads directly

**Language hint**: `ja` / `en` / `vi` (multi → omit hint, auto-detect)

### MediaService (new)

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

### SummarizationService (updated — v1.2.0: hierarchical for long transcripts)

A full 2-hour meeting transcript can exceed 100k tokens — unsafe and costly to send to GPT-4o directly. SummarizationService uses a two-pass hierarchical strategy.

**Token estimation**: 1 Japanese/Chinese character ≈ 1.5 tokens; 1 English word ≈ 1.3 tokens. Estimated at normalization step to route correctly.

**Routing decision**:

| Transcript tokens | Strategy |
|-------------------|----------|
| ≤ 12,000 | **Direct** — single GPT-4o call (existing behaviour) |
| > 12,000 | **Hierarchical** — two-pass (see below) |

**Hierarchical two-pass flow**:

```
Pass 1 — Chunk summarization (GPT-4o-mini, parallel-safe but run sequentially)
  Split normalized transcript into blocks of ~8,000 tokens
  For each block:
    Prompt: "Summarize this meeting segment. Extract: key points, decisions, action items."
    Model: gpt-4o-mini, temperature: 0, max_tokens: 512
    → ChunkSummary string
  Result: N × ChunkSummary (total tokens << original transcript)

Pass 2 — Final structured minutes (GPT-4o)
  Input: concatenated ChunkSummaries (typically 1,000–3,000 tokens total)
  Prompt: "Based on these meeting summaries, produce the final structured minutes."
  Model: gpt-4o, temperature: 0, max_tokens: 1024
  Response format: json_schema (strict mode — same schema as before)
  → MeetingMinutes JSON
```

**Token budget per request**:

| Call | Model | Input budget | Output budget |
|------|-------|-------------|---------------|
| Pass 1 chunk | gpt-4o-mini | 8,000 tokens | 512 tokens |
| Pass 2 final | gpt-4o | ~3,000 tokens | 1,024 tokens |

**Cost control**:
- Pass 1 uses gpt-4o-mini (10× cheaper than gpt-4o)
- Only Pass 2 uses gpt-4o, with a small, bounded input
- If Pass 2 input > 12,000 tokens (edge case: very many chunks): run one more gpt-4o-mini reduction pass before GPT-4o

**Failure fallback**:
- If any Pass 1 chunk fails: include raw (un-summarized) segment text for that block, continue
- If Pass 2 fails: return empty MeetingMinutes with `purpose` = error message (same as before)
- Partial results are still saved to `minutes.json`; UI indicates degraded quality

**JSON schema** (unchanged): `purpose`, `decisions[]`, `todos[]`, `concerns[]`, `next_actions[]`

**Model**: gpt-4o for Pass 2, `temperature: 0`, response format: `json_schema` strict

### PostMeetingService (updated)

Accepts an optional `audioPath` override for import sessions:

```
postMeetingService.run(sessionId, opts?: { audioPath?: string })
  audioPath defaults to fileStore.getAudioForWhisper(sessionId)
  All 5 pipeline steps unchanged
  Each step prefixed by checkpoint write, suffixed by checkpoint update
  Emits session:status per step
```

### ExportService (unchanged)
Deterministic Markdown render (no LLM).

---

## 6. Data Storage

All data stored at `%APPDATA%/mtg-assistant/` (Windows) or `~/Library/Application Support/mtg-assistant/` (macOS).

```
mtg-assistant/
├── settings.json             # AppSettings (device IDs, UI lang, whisper hint)
├── vault.enc                 # ← v1.2: encrypted fallback key store (AES-256-GCM)
├── app.json                  # Session index (SessionMeta[])
├── logs/                     # ← NEW v1.2
│   └── app.log               # Structured log, rotated at 5 MB
└── sessions/
    └── {uuid}/
        ├── source/           # Import only
        │   └── {originalFilename}   # copied verbatim from user's path
        ├── chunks/           # ← NEW v1.2 — transient, deleted after merge
        │   ├── chunk_000.wav
        │   └── chunk_001.wav ...
        ├── audio.pcm         # Realtime: Raw PCM16 16kHz mono
        ├── audio.wav         # Import: 16kHz mono WAV from ffmpeg
        ├── pipeline.json     # Pipeline checkpoint (atomic write)
        ├── transcript.jsonl  # TranscriptSegment[] (one JSON per line)
        ├── normalized.json   # NormalizedSegment[]
        ├── minutes.json      # MeetingMinutes (structured)
        └── export.md         # Markdown export
```

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
type SessionStatus = 'recording' | 'processing' | 'done' | 'error';

// ── Updated SessionMeta ─────────────────────────────────────────────
interface SessionMeta {
  id: string; title: string; lang: LangCode; targetLang: LangCode;
  createdAt: number; status: SessionStatus; durationMs?: number;

  // NEW fields (v1.1.0)
  inputType:      'realtime' | 'import';
  sourceFileName?: string;          // original filename for import sessions
  durationMs?:    number;           // total audio duration in ms
  audioFormat?:   'pcm' | 'wav';    // which audio file is present
}

// ── New: Import payload ─────────────────────────────────────────────
interface ImportPayload {
  title:       string;
  sourcePath:  string;              // absolute path on user's filesystem
  sourceType:  'audio' | 'video';
  lang?:       LangCode;            // if omitted → auto-detect
  targetLang?: LangCode;            // if omitted → no translation
}

// ── New: MediaProbeResult ───────────────────────────────────────────
interface MediaProbeResult {
  durationMs:  number;
  hasAudio:    boolean;
  hasVideo:    boolean;
  format:      string;              // e.g. 'mov,mp4,m4a,3gp,3g2,mj2'
  audioCodec?: string;              // e.g. 'aac', 'mp3', 'pcm_s16le'
  sampleRate?: number;
  channels?:   number;
}

// ── New: Pipeline checkpoint ────────────────────────────────────────
type PipelineStep =
  | 'prepare_audio'   // import only
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

// ── Existing (unchanged) ────────────────────────────────────────────
interface TranscriptSegment { /* ... */ }
interface NormalizedSegment { /* ... */ }
interface MeetingMinutes    { /* ... */ }
interface AppSettings       { /* ... */ }
```

---

## 8. UI / Routing

### Routes

```
/                     → Dashboard      (session list + Import button)   ← updated
/session/setup        → SessionSetup   (new realtime meeting form)
/session/import       → ImportScreen   (new: file picker + metadata)    ← NEW
/session/:id/live     → LiveSession    (recording view)
/session/:id          → PostMeeting    (results + progress + retry)     ← updated
/settings             → Settings       (API keys + prefs)
```

### Dashboard (updated)

Add an **Import** button next to the existing "New Meeting" button:

```
┌─────────────────────────────────────────────┐
│ 会議履歴 / Meeting History                   │
│                            [+ 新規録音] [インポート] │
│ ─────────────────────────────────────────── │
│  Session card 1  ...                         │
│  Session card 2  ...                         │
└─────────────────────────────────────────────┘
```

Clicking "インポート / Import / Nhập" navigates to `/session/import`.

### ImportScreen (new — `/session/import`)

Single-page form, no modal. Layout:

```
┌──────────────────────────────────────────────────────┐
│  ← Back   インポート / Import Audio or Video         │
│ ─────────────────────────────────────────────────── │
│  ファイル選択                                         │
│  [_____ path/to/file.mp4 ______________________] [選択]│
│  Duration: 32:14  |  Format: mp4  |  Audio: ✓        │
│                                                      │
│  タイトル  [_________________________]               │
│                                                      │
│  言語       [自動検出 ▼]                              │
│  翻訳先     [なし ▼]                                 │
│                                                      │
│              [キャンセル]  [インポート開始]            │
└──────────────────────────────────────────────────────┘
```

Behaviour:
- File selection via `dialog.showOpenDialog` (IPC invoke or Electron dialog) filtered to `['*.wav','*.mp3','*.m4a','*.mp4','*.mov']`
- After file chosen: calls `media:probe` IPC to show duration and validate audio presence
- If `hasAudio === false`: shows inline error, disables Import button
- "Import" button → `session:import` invoke → navigate to `/session/:id` (PostMeeting)

### PostMeeting (updated)

Existing tabs (Overview / Transcript / Minutes / Todos) remain unchanged.

**Progress panel** — shown when `status === 'processing'`:

```
┌─────────────────────────────────────────────────────┐
│  処理中 / Processing...                              │
│  ─────────────────────────────────────────────────  │
│  ✓  prepare_audio   完了                             │
│  ✓  batch_stt       完了                             │
│  ⟳  normalizing     実行中  ████████░░░░  65%        │
│  ○  summarizing     待機中                           │
│  ○  exporting       待機中                           │
│                                                      │
│  [処理を中断]                                        │
└─────────────────────────────────────────────────────┘
```

**Error state** — shown when `status === 'error'`:

```
┌─────────────────────────────────────────────────────┐
│  ⚠ エラー / Error                                   │
│  normalizing ステップで失敗しました                   │
│  Error: OpenAI rate limit exceeded                   │
│  ─────────────────────────────────────────────────  │
│  ✓  prepare_audio   完了                             │
│  ✓  batch_stt       完了                             │
│  ✗  normalizing     失敗  ←─ retry from here         │
│  ○  summarizing     待機中                           │
│  ○  exporting       待機中                           │
│                                                      │
│          [normalizing から再試行]                     │
└─────────────────────────────────────────────────────┘
```

Retry button calls `session:retryStep` IPC with `{ sessionId, step: 'normalizing' }`.

---

## 9. Error Handling & UX

| Scenario | Behaviour |
|----------|-----------|
| ffmpeg binary not found | Error code `FFMPEG_MISSING` → toast: "ffmpeg が見つかりません。アプリを再インストールしてください。" + link to docs |
| Video file has no audio stream | Error code `NO_AUDIO_STREAM` → shown in ImportScreen inline (probe response `hasAudio: false`) before import starts |
| Unsupported file format | File dialog filter prevents selection; if bypassed, ffprobe returns error → shown on probe |
| Whisper API failure | Pipeline pauses at `batch_stt`, writes error to `pipeline.json`, emits `session:status` with `status:'error'` → retry button in PostMeeting |
| GPT rate limit / timeout | Same pattern for `normalizing` and `summarizing` steps |
| Import of 2h file (large Whisper payload) | Whisper's 25MB limit: `BatchSttService` checks file size after WAV conversion; if > 24MB, splits into 10-min chunks using ffmpeg segment muxer, transcribes each, merges `TranscriptSegment[]` with time offsets |
| App crash mid-ffmpeg | ffmpeg child process dies with app; `pipeline.json` will still show `prepare_audio: pending` → recoverable on restart |
| Disk full during conversion | ffmpeg exits non-zero; caught → `FfmpegError` → error state in PostMeeting |

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

**Step idempotency**: before running a step, check if its output file already exists and is non-empty. If so, skip and mark as completed. This prevents redundant API calls on resume.

| Step | Output file checked |
|------|-------------------|
| `batch_stt` | `transcript.jsonl` |
| `lang_detect` | `transcript.jsonl` (with `detectedLang` populated) |
| `normalizing` | `normalized.json` |
| `summarizing` | `minutes.json` |
| `exporting` | `export.md` |

---

## 11. Services — File Reference (updated)

```
electron/services/
├── stt.service.ts              Deepgram realtime WebSocket (unchanged)
├── batch-stt.service.ts        Whisper batch — accepts wavPath  ← updated
├── lang-detect.service.ts      Unicode heuristic (unchanged)
├── translation.service.ts      DeepL + GPT router (unchanged)
├── normalization.service.ts    Rule + LLM normalization (unchanged)
├── summarization.service.ts    GPT-4o minutes (unchanged)
├── post-meeting.service.ts     Pipeline orchestrator  ← updated (checkpoint)
├── export.service.ts           Markdown renderer (unchanged)
└── media.service.ts            ffmpeg wrapper  ← NEW
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

### Build Output (updated)

```
out/
├── main/index.js         # Electron main (CJS)
├── preload/index.js      # Context bridge
├── renderer/             # Vite built React app
└── resources/
    └── ffmpeg(.exe)      # Unpacked from asar
    └── ffprobe(.exe)
```

---

## 13. File Reference (updated)

```
electron/
├── main.ts                        App entry, BrowserWindow, startup recovery scan
├── preload.ts                     window.api context bridge
├── ipc/
│   ├── session.ipc.ts             Session lifecycle handlers (unchanged)
│   ├── session.import.ipc.ts      Import session handler  ← NEW
│   ├── audio.ipc.ts               PCM chunk receiver (unchanged)
│   ├── settings.ipc.ts            Settings + API key CRUD (unchanged)
│   └── export.ipc.ts              Markdown export trigger (unchanged)
├── services/
│   ├── stt.service.ts             Deepgram realtime WebSocket
│   ├── batch-stt.service.ts       Whisper batch transcription  ← updated
│   ├── lang-detect.service.ts     Unicode heuristic lang detection
│   ├── translation.service.ts     DeepL + GPT translation router
│   ├── normalization.service.ts   Rule + LLM text normalization
│   ├── summarization.service.ts   GPT-4o minutes generation
│   ├── post-meeting.service.ts    Pipeline orchestrator  ← updated
│   ├── export.service.ts          Markdown renderer
│   └── media.service.ts           ffmpeg/ffprobe wrapper  ← NEW
├── store/
│   ├── session.store.ts           Session index (app.json)  ← updated types
│   ├── file.store.ts              Per-session file ops  ← updated
│   └── secret.store.ts            API key vault (unchanged)
└── utils/paths.ts                 userData path helpers

renderer/src/
├── App.tsx                        React Router setup
├── main.tsx                       Entry point
├── screens/
│   ├── Dashboard.tsx              ← updated (Import button)
│   ├── SessionSetup.tsx           (unchanged)
│   ├── ImportScreen.tsx           File picker + metadata form  ← NEW
│   ├── LiveSession.tsx            (unchanged)
│   ├── PostMeeting.tsx            ← updated (progress panel + retry)
│   └── Settings.tsx               (unchanged)
├── components/
│   ├── Layout.tsx                 Sidebar + nav (unchanged)
│   ├── SessionCard.tsx            Session list item (unchanged)
│   ├── StatusBadge.tsx            ← may need 'error_recoverable' style
│   └── PipelineProgress.tsx       Step-by-step progress UI  ← NEW
├── hooks/
│   ├── useIpc.ts                  IPC event subscriptions
│   └── useAudioCapture.ts         AudioWorklet + AGC (unchanged)
├── store/
│   ├── sessionStore.ts            (unchanged)
│   └── captionStore.ts            (unchanged)
└── i18n/
    ├── index.tsx                  I18nProvider + useT()
    └── locales.ts                 ← updated (new import-mode strings)

shared/
└── types.ts                       ← updated (ImportPayload, PipelineState, MediaProbeResult)
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

Step-by-step plan to implement Import mode without breaking realtime.

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
  2. fileStore.copySource(sessionId, sourcePath)
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
| F4 | Import audio file > 24MB (2h MP3) | Chunked by BatchSttService, all segments merged, timestamps correct |
| F5 | Whisper API failure (network off) | Status = error at `batch_stt`, retry button shown, retry succeeds when network restored |
| F6 | App crash during `normalizing` | Relaunch: session shows `error_recoverable`, resume from `normalizing`, skips `batch_stt`/`lang_detect` |
| F7 | App crash during `prepare_audio` (ffmpeg running) | Relaunch: `audio.wav` absent or partial (tmp not renamed), session marked `error_recoverable` with message "re-import required" |
| F8 | Realtime recording (full flow) | Unchanged behavior — no regression |
| F9 | Realtime session + navigate away + return | REC badge persists, audio uninterrupted |
| F10 | Unsupported file extension bypassed | ffprobe returns codec error → error toast in ImportScreen |

---

### Estimated Risk Areas

| # | Risk | Likelihood | Impact | Mitigation |
|---|------|-----------|--------|------------|
| R1 | **ffmpeg binary not found in packaged app** | Medium | High | Thorough `asarUnpack` config; `FfmpegNotFoundError` with clear user message; CI smoke-test on packaged build |
| R2 | **Whisper 25MB file size limit** for long recordings | High (2h ≈ ~110MB WAV) | High | Implement chunking in `BatchSttService` before v1.1.0 ships; test with 1h file |
| R3 | **Pipeline checkpoint corruption** (crash during write) | Low | Medium | Atomic write (`.tmp` → rename); if `.tmp` exists on startup, discard it |
| R4 | **Race condition**: user navigates to PostMeeting before `session:import` responds | Low | Low | `session:import` returns `sessionId` before async processing starts; navigator uses that ID; PostMeeting subscribes to `session:status` |
| R5 | **macOS audio permission for `getDisplayMedia`** (existing concern, not new) | Medium | Medium | Already handled in realtime; import mode bypasses this entirely (file-based) |

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

#### Chunk storage lifecycle

```
sessions/{id}/chunks/    ← created before chunking starts
    chunk_000.wav        ← 15-min slice
    chunk_001.wav
    ...
```

Chunks are **transient**: deleted immediately after the segment merge is complete and `transcript.jsonl` is written. On startup recovery scan: if `chunks/` exists but `transcript.jsonl` is absent → step `batch_stt` must be retried from scratch (chunks are regenerated).

#### Time offset merging

```
chunkDurationMs = 15 * 60 * 1000   // 900_000 ms

for each chunk at index i:
  offset = i * chunkDurationMs
  for each segment in chunkResult:
    segment.startMs += offset
    segment.endMs   += offset
```

Overlap window (last 5 seconds duplicated at chunk boundary):

```
chunk_000: 0s → 905s  (5s overlap at end)
chunk_001: 900s → 1805s  (5s overlap start/end)
dedup: remove segments where startMs is within [chunkStart, chunkStart + 5000]
       and an identical segment exists in previous chunk's tail
```

#### Memory ceiling

| Stage | Peak RAM |
|-------|----------|
| ffmpeg chunking | ~10 MB (stream, no buffer) |
| Single chunk upload | ~15 MB (WAV slice in memory for multipart) |
| Merged TranscriptSegment[] for 2h session | ~5–15 MB JSON |
| Total peak | < 30 MB above baseline |

---

### 16.3 Hierarchical Summarization

See the updated SummarizationService in §5 for full design. This section documents cost governance specifics.

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

#### Cost estimate per 1-hour meeting

| Step | Model | Estimated tokens | Cost (approx) |
|------|-------|-----------------|---------------|
| Normalization (Phase 2, if triggered) | gpt-4o-mini | ~10k in + 10k out | ~$0.01 |
| Summarization Pass 1 (4 chunks × 8k) | gpt-4o-mini | ~32k in + 2k out | ~$0.02 |
| Summarization Pass 2 | gpt-4o | ~2k in + 1k out | ~$0.04 |
| **Total per 1h meeting** | | | **~$0.07** |

Costs are indicative at March 2026 pricing. 2-hour meeting roughly doubles Pass 1 cost.

#### Guardrails

| Guard | Threshold | Action |
|-------|-----------|--------|
| Max transcript length | 200,000 characters | Truncate to first 200k, log warning, note in minutes |
| Max GPT tokens per request | 8,000 input / 1,024 output | Enforced by chunk size; overflow → reduce chunk size |
| Cost warning | > 5 chunks in Pass 1 | Log cost estimate to `app.log`, emit `session:status` with warning field |
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

The renderer **never receives raw API keys**. All API calls are made in the main process. The `apikey:get` IPC (added in v1.0) is used only for the masked display in Settings UI — the plaintext key is fetched only when the user explicitly clicks 表示, and is held in renderer memory only for the duration of the display.

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

### 16.5 Concurrency Guard

Only one active pipeline is allowed at a time. Enforced in-memory (fast path) and via persisted flag in `app.json` (recovery path).

#### Rules

| Action attempted | Condition | Result |
|-----------------|-----------|--------|
| Start realtime recording | Another session `status='processing'` | Blocked — toast error |
| Start realtime recording | Another session `status='recording'` | Blocked — impossible by design (only one session at a time) |
| Start import | Session `status='recording'` active | Blocked — toast error |
| Start import | Another session `status='processing'` | Blocked — toast error |
| Resume pipeline | Another pipeline running in memory | Queued until running pipeline completes |

#### In-memory lock

```
// electron/services/pipeline-lock.ts
class PipelineLock {
  private activeSessionId: string | null = null;

  acquire(sessionId: string): boolean
    if activeSessionId !== null: return false
    activeSessionId = sessionId; return true

  release(sessionId: string): void
    if activeSessionId === sessionId: activeSessionId = null

  isLocked(): boolean
    return activeSessionId !== null

  getActiveId(): string | null
    return activeSessionId
}
export const pipelineLock = new PipelineLock();  // singleton
```

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
{ "ts": 1709500005678, "level": "error", "ctx": "api", "msg": "whisper error", "sessionId": "uuid", "code": 429, "retryAfter": 30 }
{ "ts": 1709500000100, "level": "info", "ctx": "ffmpeg", "msg": "process exited", "exitCode": 0, "durationMs": 4200 }
```

#### What is logged

| Category | What | What NOT |
|----------|------|----------|
| Pipeline | Step start/end, duration, session ID | Transcript text content |
| AI API calls | Model, token counts, latency, error codes | API keys, request/response body |
| ffmpeg | Exit code, duration, stderr snippet on error | Audio content |
| App lifecycle | Startup, crash recovery actions, migration | — |
| Errors | All caught errors with stack (truncated to 500 chars) | — |

**Privacy**: transcript text, speaker IDs, meeting titles, and API keys are **never** logged. Log files are safe to share for debugging.

#### Logger interface

```
// electron/utils/logger.ts
logger.info(ctx, msg, meta?)
logger.warn(ctx, msg, meta?)
logger.error(ctx, msg, meta?)

// Usage in services:
logger.info('pipeline', 'step started', { sessionId, step: 'batch_stt' })
logger.error('api', 'openai error', { sessionId, statusCode: 429 })
```

---

### 16.7 Cost Governance

#### Estimated cost per meeting

| Meeting length | Whisper (STT) | GPT-4o-mini (norm+pass1) | GPT-4o (pass2) | Total |
|---------------|---------------|--------------------------|-----------------|-------|
| 30 min | ~$0.09 | ~$0.01 | ~$0.04 | **~$0.14** |
| 1 hour | ~$0.18 | ~$0.02 | ~$0.04 | **~$0.24** |
| 2 hours | ~$0.36 | ~$0.04 | ~$0.04 | **~$0.44** |

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
session:status push → { sessionId, warning: 'HIGH_COST_EXPECTED', estimatedUSD: 0.40 }
```

UI shows a dismissible banner: "この会議の処理には推定 $0.40 のAPI費用が発生します。続けますか？"
User can cancel or proceed. If cancelled: session marked `error` with message "User cancelled due to cost estimate".

#### Future option — Cost dashboard

Not implemented in v1.2.0, but `app.log` contains all token counts and API call metadata needed to build a per-session cost report in a future version. The log schema is designed to support this aggregation.
