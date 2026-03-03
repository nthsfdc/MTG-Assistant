# MTG Assistant — Design Document v1.1 (Import Mode)

**Version**: 1.1
**Scope**: Import-only Meeting Minutes Generator — no recording, no realtime STT, no translation
**Stack**: Electron 31 + React 18 + TypeScript 5.5 + Tailwind CSS 3
**Platform**: Windows (primary), macOS

---

## 0. What Is Deleted From the Full Design

This document covers v1.1 scope only. The following features from DESIGN.md v1.4.0-lite are **intentionally excluded**:

| Deleted Feature | Reason |
|----------------|--------|
| Audio recording (microphone, AudioWorklet, RecordingProvider) | No recording in v1.1 |
| `stt.service.ts` (Deepgram, WebSocket) | No realtime STT |
| `translation.service.ts` (DeepL / GPT fallback) | No translation |
| `captionStore`, `recordingStore` | No recording |
| `RecordingScreen`, `SessionSetup` | No recording |
| `stt:partial`, `stt:final`, `translation` IPC channels | No realtime STT |
| `audio:chunk` IPC send | No recording |
| `audio.pcm` file | No recording |
| `session:start`, `session:stop` IPC channels | No recording |
| `LangDetectService` (Unicode heuristic) | Simplified — lang comes from user input |
| Hierarchical summarization (Pass 1 / Reduction Pass / Pass 2) | Single GPT call only |
| Exponential backoff / `retry.ts` | Simple try/catch, user retries manually |
| `PipelineLock` / `pipeline-lock.ts` watchdog | No concurrency concern in v1.1 |
| `keytar` / `vault.enc` secure key storage | OpenAI key stored plaintext in `settings.json` |
| `storageRootPath` customization | Sessions always in `userData` |
| `AutoCleanupService` / `auto-cleanup.service.ts` | No cleanup in v1.1 |
| `DiskMonitor` / `disk-monitor.ts` | No disk monitoring |
| `storage:getStats`, `storage:setRoot`, `storage:runCleanup` IPC | No storage management |
| `storage:warning` push channel | No disk monitoring |
| `StorageSettings`, `StorageStats`, `CleanupReport` types | No storage management |
| Normalization Phase 1 rule engine (filler sets) | Simple GPT rewrite only |
| Cost governance (`HIGH_COST_EXPECTED` warning, guardrails) | No cost tracking |
| FFmpeg code-signing CI/CD requirements | Out of scope for v1.1 |
| Chunk deduplication / Levenshtein guard | Not needed without overlap |
| BatchSttService multi-language hint complex routing | Simple lang hint pass-through |

**Kept from full design**:
- MediaService (ffprobe probe + ffmpeg extract/convert)
- BatchSttService (Whisper-1, with basic file-size chunking)
- NormalizationService (single GPT-4o-mini spoken→written call)
- SummarizationService (single GPT-4o call)
- ExportService (deterministic Markdown)
- PostMeetingService (4-step pipeline orchestrator)
- `pipeline.json` checkpoint + crash recovery
- ImportScreen, PostMeeting, Dashboard, Settings

---

## 1. Overview

MTG Assistant v1.1 imports an audio or video file, converts it to 16 kHz WAV, transcribes with Whisper, normalizes spoken text, generates structured minutes with GPT-4o, and exports a Markdown file. No recording. No live captions. No translation.

### Pipeline

```
User picks file (wav/mp3/m4a/mp4/mov)
        ↓
  media:probe        → validate hasAudio, get duration
        ↓
  prepare_audio      → audio.wav (ffmpeg extract or convert)
        ↓
  batch_stt          → transcript.jsonl  (Whisper-1)
        ↓
  normalizing        → normalized.json   (GPT-4o-mini spoken→written)
        ↓
  summarizing        → minutes.json      (GPT-4o structured JSON)
        ↓
  exporting          → export.md         (deterministic render)
```

### Storage path

```
%APPDATA%/mtg-assistant/          (Windows)
~/Library/Application Support/mtg-assistant/   (macOS)
├── settings.json                 # { openaiKey, uiLang }
├── app.json                      # SessionMeta[]
└── sessions/
    └── {uuid}/
        ├── audio.wav             # 16kHz mono WAV (transient; large)
        ├── chunks/               # Transient — deleted after merge
        │   ├── chunk_000.wav
        │   └── ...
        ├── pipeline.json         # Checkpoint (atomic write)
        ├── transcript.jsonl      # One TranscriptSegment JSON per line
        ├── normalized.json       # NormalizedSegment[]
        ├── minutes.json          # MeetingMinutes
        └── export.md
```

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────────┐
│  Renderer Process (React)                                   │
│  ┌───────────────────────────────────────────────────────┐  │
│  │  ┌───────────┐  ┌─────────────┐  ┌────────────────┐  │  │
│  │  │ Dashboard │  │ ImportScreen│  │  PostMeeting   │  │  │
│  │  └───────────┘  └─────────────┘  └────────────────┘  │  │
│  │                      ┌──────────┐                      │  │
│  │                      │ Settings │                      │  │
│  │                      └──────────┘                      │  │
│  └───────────────────────────────────────────────────────┘  │
│  Zustand: sessionStore                                      │
└────────────────────────┬────────────────────────────────────┘
                         │  contextBridge (window.api)
┌────────────────────────▼────────────────────────────────────┐
│  Main Process (Node.js / Electron)                          │
│  ┌─────────────────────┐  ┌────────────┐  ┌─────────────┐  │
│  │ session.import.ipc  │  │settings.ipc│  │ export.ipc  │  │
│  └──────────┬──────────┘  └────────────┘  └─────────────┘  │
│             │                                                │
│  ┌──────────▼─────────────────────────────────────────┐     │
│  │ Services                                           │     │
│  │  MediaService     BatchSttService   Normalization  │     │
│  │  Summarization    ExportService     PostMeeting    │     │
│  └────────────────────────────────────────────────────┘     │
│  ┌────────────────────────────────────────────────────┐     │
│  │ Stores                                             │     │
│  │  session.store (userData/app.json)                 │     │
│  │  file.store    (userData/sessions/{id}/...)        │     │
│  └────────────────────────────────────────────────────┘     │
└─────────────────────────────────────────────────────────────┘
              │
              ▼ External APIs
   OpenAI (Whisper-1 + GPT-4o-mini + GPT-4o)
```

---

## 3. IPC Interface

### Renderer → Main (invoke)

| Channel | Payload | Response |
|---------|---------|----------|
| `session:import` | `{ title, sourcePath, sourceType, lang? }` | `{ sessionId }` |
| `session:list` | — | `SessionMeta[]` |
| `session:get` | `{ sessionId }` | `SessionDetail` |
| `session:retryStep` | `{ sessionId, step }` | `void` |
| `session:resumePipeline` | `{ sessionId }` | `void` |
| `media:probe` | `{ filePath }` | `MediaProbeResult` |
| `dialog:openFile` | `{ extensions: string[] }` | `string \| null` — selected path |
| `settings:get` | — | `AppSettings` |
| `settings:save` | `Partial<AppSettings>` | `void` |
| `export:markdown` | `{ sessionId }` | `{ filePath }` |

### Main → Renderer (push)

| Channel | Payload |
|---------|---------|
| `session:status` | `{ sessionId, status, step?, progress?, error? }` |
| `session:done` | `{ sessionId, exportPath }` |
| `error` | `{ code, message, sessionId? }` |

---

## 4. TypeScript Types

### `shared/types.ts`

```typescript
export type LangCode = 'ja' | 'vi' | 'en' | 'multi';

export type SessionStatus =
  | 'processing'
  | 'done'
  | 'error'
  | 'error_recoverable';

export type PipelineStep =
  | 'prepare_audio'
  | 'batch_stt'
  | 'normalizing'
  | 'summarizing'
  | 'exporting'
  | 'done';

export type PipelineStepStatus = 'pending' | 'running' | 'done' | 'error';

// ── Session ──────────────────────────────────────────────────────────
export interface SessionMeta {
  id:               string;
  title:            string;
  lang?:            LangCode;
  createdAt:        number;
  status:           SessionStatus;
  sourceFileName?:  string;    // original filename (display only)
  durationMs?:      number;    // total audio duration in ms
}

export interface SessionDetail extends SessionMeta {
  pipeline?: PipelineState | null;
  minutes?:  MeetingMinutes | null;
}

// ── Import ───────────────────────────────────────────────────────────
export interface ImportPayload {
  title:       string;
  sourcePath:  string;              // absolute path on user's filesystem
  sourceType:  'audio' | 'video';
  lang?:       LangCode;
}

export interface MediaProbeResult {
  durationMs:  number;
  hasAudio:    boolean;
  hasVideo:    boolean;
  format:      string;
  audioCodec?: string;
  sampleRate?: number;
  channels?:   number;
}

// ── Pipeline ─────────────────────────────────────────────────────────
export interface PipelineState {
  sessionId:          string;
  step:               PipelineStep;
  status:             PipelineStepStatus;
  lastCompletedStep?: PipelineStep;
  completedSteps:     PipelineStep[];
  error?:             string | null;
  updatedAt:          number;
}

// ── Transcript / Minutes ─────────────────────────────────────────────
export interface TranscriptSegment {
  speakerId: string;
  text:      string;
  startMs:   number;
  endMs:     number;
  lang?:     LangCode;
}

export interface NormalizedSegment {
  speakerId:      string;
  originalText:   string;
  normalizedText: string;
}

export interface MeetingMinutes {
  sessionId:    string;
  generatedAt:  number;
  language?:    string;
  data: {
    purpose:      string;
    decisions:    string[];
    todos:        string[];
    concerns:     string[];
    next_actions: string[];
  };
}

// ── Settings ─────────────────────────────────────────────────────────
export interface AppSettings {
  openaiKey?: string;   // stored plaintext in settings.json
  uiLang:     'ja' | 'en' | 'vi';
}
```

---

## 5. Data Flow

```
1. User opens ImportScreen, picks file via dialog:openFile.

2. Renderer calls media:probe(filePath)
   → Main: ffprobe → MediaProbeResult { durationMs, hasAudio, format }
   → ImportScreen shows duration; blocks submit if !hasAudio.

3. User fills title + lang hint, clicks Import.

4. Renderer calls session:import({ title, sourcePath, sourceType, lang })
   → Main:
     a. sessionStore.create({ title, lang, status:'processing', sourceFileName })
     b. Returns { sessionId } immediately (renderer navigates to /session/:id)
     c. Async: runImportPipeline(sessionId, payload)

5. runImportPipeline:
   a. writePipeline { step:'prepare_audio', status:'running' }
   b. MediaService.extractAudio / convertTo16kMonoWav → audio.wav
      → emits session:status { step:'prepare_audio', progress:N }
   c. writePipeline { step:'batch_stt', status:'pending' }
   d. postMeetingService.run(sessionId, audioPath, lang)

6. postMeetingService.run executes 4 steps in order:
   batch_stt → normalizing → summarizing → exporting
   Each step:
     - writePipeline { step: X, status:'running' }
     - do work, emit session:status { step:X, progress? }
     - writePipeline { step: nextStep, status:'pending', lastCompletedStep:X }
   On complete:
     - sessionStore.update({ status:'done' })
     - emit session:done { sessionId, exportPath }

7. PostMeeting subscribes to session:status and session:done.
   When done: shows 議事録 / 要約 / ToDo result tabs.
```

### Crash Recovery Flow

```
On app startup (before BrowserWindow shown):
  for each session where status === 'processing':
    read pipeline.json
    mark status = 'error_recoverable'
  sessionStore.save()

User opens the session in PostMeeting:
  sees Resume banner: "Resume from {nextStep}"
  clicks Resume → session:resumePipeline { sessionId }
  Main reads pipeline.json → lastCompletedStep → runs from nextStep
```

### Step Idempotency

Before running a step, check if its output file exists **and passes content validation**:

| Step | Output | Validation |
|------|--------|------------|
| `batch_stt` | `transcript.jsonl` | Every line parses as JSON; ≥ 1 line |
| `normalizing` | `normalized.json` | `JSON.parse` succeeds; non-empty array |
| `summarizing` | `minutes.json` | `JSON.parse` succeeds; has `data.purpose` |
| `exporting` | `export.md` | File size ≥ 100 bytes |

If validation passes → skip step (already done). If fails → re-run from scratch.

---

## 6. Services

### MediaService

```
probe(filePath): MediaProbeResult
  ffprobe -v quiet -print_format json -show_format -show_streams <file>

extractAudio(videoPath, outWavPath, onProgress?): void
  ffmpeg -i <videoPath> -vn -acodec pcm_s16le -ar 16000 -ac 1 -y <outWavPath>

convertTo16kMonoWav(audioPath, outWavPath, onProgress?): void
  ffmpeg -i <audioPath> -acodec pcm_s16le -ar 16000 -ac 1 -y <outWavPath>

Errors:
  FfmpegNotFoundError  → code: 'FFMPEG_MISSING'
  NoAudioStreamError   → code: 'NO_AUDIO_STREAM'
  FfmpegError          → stderr snippet
```

### BatchSttService

Simple Whisper-1 call. Chunks large files.

```
transcribe(wavPath, lang?, sessionId): TranscriptSegment[]
  1. stat(wavPath) → fileSizeBytes
  2. if fileSizeBytes <= 24_000_000: single upload
  3. else: chunk mode
     - ffmpeg split into 15-min segments → chunks/chunk_N.wav
     - transcribe each sequentially, apply time offset
     - merge → single TranscriptSegment[]
     - delete chunks/ directory
  4. return segments
```

No deduplication. No retry. Language hint passed to Whisper if provided.

### NormalizationService

Single GPT-4o-mini call. Groups segments into batches of ≤ 20.

```
normalize(segments, lang?): NormalizedSegment[]
  For each batch of 20 segments:
    prompt = "Rewrite the following {lang} spoken-language transcript segments
              into clean written text. Remove filler words (um, uh, えーと, etc.),
              fix grammar, but preserve meaning. Do not translate.
              Return a JSON array of objects: { originalText, normalizedText }"
    call gpt-4o-mini, temperature: 0
    merge results → NormalizedSegment[]
```

If GPT fails: return segments as-is (originalText = normalizedText = original).

### SummarizationService

Single GPT-4o call with the full normalized transcript.

```
summarize(segments, lang?): MeetingMinutes
  transcript = segments.map(s => `[${s.speakerId}]: ${s.normalizedText}`).join('\n')
  if transcript.length > 120_000: transcript = transcript.slice(0, 120_000) + '\n[truncated]'

  prompt = "You are a meeting minutes assistant.
            Based on the following transcript, extract structured meeting minutes in {lang}.
            Return JSON matching the schema exactly."

  schema = { purpose: string, decisions: string[], todos: string[],
             concerns: string[], next_actions: string[] }

  call gpt-4o, temperature: 0, response_format: json_schema (strict)
  return MeetingMinutes
```

If GPT fails: return empty MeetingMinutes with `purpose = "Summarization failed"`.

### ExportService

Deterministic Markdown render from `MeetingMinutes`. No LLM.

```
toMarkdown(minutes, sessionMeta): string
  Returns a Markdown document with:
  - Title + date
  - ## 概要 / Purpose
  - ## 決定事項 / Decisions  (bulleted list)
  - ## ToDo              (bulleted list with speaker if available)
  - ## 懸念事項 / Concerns  (bulleted list)
  - ## 次のアクション / Next Actions (bulleted list)
```

---

## 7. Implementation Plan

### Files to Create

```
electron/
├── main.ts                          Entry, BrowserWindow, startup recovery
├── preload.ts                       contextBridge — window.api
├── ipc/
│   ├── session.import.ipc.ts        All session + media IPC handlers
│   ├── settings.ipc.ts              settings:get / settings:save
│   └── export.ipc.ts                export:markdown
├── services/
│   ├── media.service.ts             ffmpeg/ffprobe wrapper
│   ├── batch-stt.service.ts         Whisper-1 transcription
│   ├── normalization.service.ts     GPT-4o-mini spoken→written
│   ├── summarization.service.ts     GPT-4o minutes generation
│   ├── export.service.ts            Markdown renderer
│   └── post-meeting.service.ts      Pipeline orchestrator
├── store/
│   ├── session.store.ts             SessionMeta[] persisted to app.json
│   └── file.store.ts                Per-session file ops + pipeline.json
└── utils/
    ├── paths.ts                     userData path helpers
    └── logger.ts                    Simple structured console logger

renderer/src/
├── App.tsx                          React Router setup
├── main.tsx                         Entry point
├── screens/
│   ├── Dashboard.tsx                Session list + Import button
│   ├── ImportScreen.tsx             File picker + metadata form
│   ├── PostMeeting.tsx              Progress + result tabs
│   └── Settings.tsx                 OpenAI API key input
├── components/
│   ├── PipelineProgress.tsx         Step list with retry/resume
│   └── SessionCard.tsx              Session list item
├── hooks/
│   └── useIpc.ts                    IPC push event subscriptions
└── store/
    └── sessionStore.ts              Zustand — session list + current detail

shared/
└── types.ts                         (see §4)
```

### Files to Modify

| File | Change |
|------|--------|
| `package.json` | Add `ffmpeg-static`, `ffprobe-static`, `openai` dependencies; remove `keytar` if present |
| `electron-builder config` | Add `asarUnpack` for ffmpeg/ffprobe binaries |
| `vite.config.ts` / `electron-vite.config.ts` | Standard setup — no changes if already configured |

---

## 8. Code Skeletons

---

### `electron/main.ts`

```typescript
import { app, BrowserWindow, ipcMain, dialog } from 'electron';
import path from 'path';
import { sessionStore } from './store/session.store';
import { registerSessionImportIpc } from './ipc/session.import.ipc';
import { registerSettingsIpc } from './ipc/settings.ipc';
import { registerExportIpc } from './ipc/export.ipc';

let win: BrowserWindow | null = null;

export function getMainWindow(): BrowserWindow | null {
  return win;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (process.env.NODE_ENV === 'development') {
    win.loadURL('http://localhost:5173');
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
}

async function recoverInterruptedSessions(): Promise<void> {
  const sessions = sessionStore.getAll();
  let changed = false;
  for (const s of sessions) {
    if (s.status === 'processing') {
      sessionStore.update(s.id, { status: 'error_recoverable' });
      changed = true;
    }
  }
  if (changed) sessionStore.save();
}

// dialog:openFile handler (registered in main to access Electron dialog API)
ipcMain.handle('dialog:openFile', async (_, { extensions }: { extensions: string[] }) => {
  const result = await dialog.showOpenDialog({
    properties: ['openFile'],
    filters: [{ name: 'Audio/Video', extensions }],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

app.whenReady().then(async () => {
  await recoverInterruptedSessions();

  registerSessionImportIpc();
  registerSettingsIpc();
  registerExportIpc();

  await createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
```

---

### `electron/preload.ts`

```typescript
import { contextBridge, ipcRenderer } from 'electron';

type IpcCallback = (data: unknown) => void;

contextBridge.exposeInMainWorld('api', {
  session: {
    import:          (payload: unknown) => ipcRenderer.invoke('session:import', payload),
    list:            ()                 => ipcRenderer.invoke('session:list'),
    get:             (sessionId: string) => ipcRenderer.invoke('session:get', { sessionId }),
    retryStep:       (sessionId: string, step: string) =>
                       ipcRenderer.invoke('session:retryStep', { sessionId, step }),
    resumePipeline:  (sessionId: string) =>
                       ipcRenderer.invoke('session:resumePipeline', { sessionId }),
  },
  media: {
    probe: (filePath: string) => ipcRenderer.invoke('media:probe', { filePath }),
  },
  dialog: {
    openFile: (extensions: string[]) => ipcRenderer.invoke('dialog:openFile', { extensions }),
  },
  settings: {
    get:  ()      => ipcRenderer.invoke('settings:get'),
    save: (s: unknown) => ipcRenderer.invoke('settings:save', s),
  },
  export: {
    markdown: (sessionId: string) => ipcRenderer.invoke('export:markdown', { sessionId }),
  },
  // IPC push subscriptions — returns unsubscribe function
  on: (channel: string, cb: IpcCallback) => {
    const listener = (_: Electron.IpcRendererEvent, data: unknown) => cb(data);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },
});

// TypeScript global declaration (place in renderer/src/env.d.ts)
// declare global { interface Window { api: typeof api } }
```

---

### `electron/ipc/session.import.ipc.ts`

```typescript
import { ipcMain, BrowserWindow } from 'electron';
import path from 'path';
import { sessionStore } from '../store/session.store';
import { fileStore } from '../store/file.store';
import { mediaService } from '../services/media.service';
import { postMeetingService } from '../services/post-meeting.service';
import type { ImportPayload, PipelineStep } from '../../shared/types';

// ── Helpers ──────────────────────────────────────────────────────────

function pushStatus(data: object) {
  BrowserWindow.getAllWindows()[0]?.webContents.send('session:status', data);
}

function pushDone(sessionId: string, exportPath: string) {
  BrowserWindow.getAllWindows()[0]?.webContents.send('session:done', { sessionId, exportPath });
}

const STEP_ORDER: PipelineStep[] = [
  'prepare_audio', 'batch_stt', 'normalizing', 'summarizing', 'exporting', 'done',
];

function nextStep(current: PipelineStep): PipelineStep {
  const idx = STEP_ORDER.indexOf(current);
  return STEP_ORDER[Math.min(idx + 1, STEP_ORDER.length - 1)];
}

// ── Main pipeline ────────────────────────────────────────────────────

async function runImportPipeline(sessionId: string, payload: ImportPayload): Promise<void> {
  const wavPath = fileStore.getWavPath(sessionId);

  try {
    // ── prepare_audio ────────────────────────────────────────────────
    await fileStore.writePipeline(sessionId, {
      sessionId,
      step: 'prepare_audio',
      status: 'running',
      completedSteps: [],
      updatedAt: Date.now(),
    });

    pushStatus({ sessionId, status: 'processing', step: 'prepare_audio', progress: 0 });

    const onProgress = (progress: number) =>
      pushStatus({ sessionId, status: 'processing', step: 'prepare_audio', progress });

    if (payload.sourceType === 'video') {
      await mediaService.extractAudio(payload.sourcePath, wavPath, onProgress);
    } else {
      await mediaService.convertTo16kMonoWav(payload.sourcePath, wavPath, onProgress);
    }

    // Update duration from converted wav
    const probe = await mediaService.probe(wavPath);
    sessionStore.update(sessionId, { durationMs: probe.durationMs });

    await fileStore.writePipeline(sessionId, {
      sessionId,
      step: 'batch_stt',
      status: 'pending',
      lastCompletedStep: 'prepare_audio',
      completedSteps: ['prepare_audio'],
      updatedAt: Date.now(),
    });

    // ── batch_stt → normalizing → summarizing → exporting ────────────
    const exportPath = await postMeetingService.run(sessionId, wavPath, payload.lang);
    pushDone(sessionId, exportPath);

  } catch (err: any) {
    sessionStore.update(sessionId, { status: 'error' });
    pushStatus({ sessionId, status: 'error', error: err.message });
  }
}

// ── IPC Handlers ─────────────────────────────────────────────────────

export function registerSessionImportIpc(): void {

  ipcMain.handle('session:import', async (_, payload: ImportPayload) => {
    const meta = sessionStore.create({
      title:          payload.title,
      lang:           payload.lang,
      sourceFileName: path.basename(payload.sourcePath),
      status:         'processing',
      createdAt:      Date.now(),
    });

    // Fire-and-forget — renderer navigates using returned sessionId
    runImportPipeline(meta.id, payload).catch(console.error);

    return { sessionId: meta.id };
  });

  ipcMain.handle('session:list', () => sessionStore.getAll());

  ipcMain.handle('session:get', async (_, { sessionId }: { sessionId: string }) => {
    const meta     = sessionStore.get(sessionId);
    const pipeline = await fileStore.readPipeline(sessionId);
    const minutes  = await fileStore.readMinutes(sessionId);
    return { ...meta, pipeline, minutes };
  });

  ipcMain.handle('session:retryStep', async (_, { sessionId, step }: { sessionId: string; step: PipelineStep }) => {
    const wavPath = fileStore.getWavPath(sessionId);
    const state   = await fileStore.readPipeline(sessionId);
    const lang    = sessionStore.get(sessionId)?.lang;
    await postMeetingService.runFrom(sessionId, step, wavPath, lang);
  });

  ipcMain.handle('session:resumePipeline', async (_, { sessionId }: { sessionId: string }) => {
    const state = await fileStore.readPipeline(sessionId);
    if (!state) throw new Error('No pipeline checkpoint found');
    const resumeFrom = state.lastCompletedStep
      ? nextStep(state.lastCompletedStep)
      : 'batch_stt';
    const wavPath = fileStore.getWavPath(sessionId);
    const lang    = sessionStore.get(sessionId)?.lang;
    await postMeetingService.runFrom(sessionId, resumeFrom, wavPath, lang);
  });

  ipcMain.handle('media:probe', async (_, { filePath }: { filePath: string }) => {
    return mediaService.probe(filePath);
  });
}
```

---

### `electron/ipc/settings.ipc.ts`

```typescript
import { ipcMain } from 'electron';
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { AppSettings } from '../../shared/types';

const SETTINGS_PATH = path.join(app.getPath('userData'), 'settings.json');

function readSettings(): AppSettings {
  try {
    return JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  } catch {
    return { uiLang: 'ja' };
  }
}

function writeSettings(s: AppSettings): void {
  fs.writeFileSync(SETTINGS_PATH, JSON.stringify(s, null, 2), 'utf-8');
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => readSettings());

  ipcMain.handle('settings:save', (_, partial: Partial<AppSettings>) => {
    const current = readSettings();
    writeSettings({ ...current, ...partial });
  });
}
```

---

### `electron/ipc/export.ipc.ts`

```typescript
import { ipcMain, dialog } from 'electron';
import fs from 'fs';
import { fileStore } from '../store/file.store';
import { exportService } from '../services/export.service';
import { sessionStore } from '../store/session.store';

export function registerExportIpc(): void {
  ipcMain.handle('export:markdown', async (_, { sessionId }: { sessionId: string }) => {
    const minutes = await fileStore.readMinutes(sessionId);
    const meta    = sessionStore.get(sessionId);
    if (!minutes) throw new Error('minutes.json not found');

    const md = exportService.toMarkdown(minutes, meta);

    const result = await dialog.showSaveDialog({
      defaultPath: `${meta?.title ?? 'minutes'}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });

    if (result.canceled || !result.filePath) return { filePath: null };
    fs.writeFileSync(result.filePath, md, 'utf-8');
    return { filePath: result.filePath };
  });
}
```

---

### `electron/store/session.store.ts`

```typescript
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import { v4 as uuidv4 } from 'uuid';
import type { SessionMeta, SessionStatus } from '../../shared/types';

const APP_JSON_PATH = path.join(app.getPath('userData'), 'app.json');

class SessionStore {
  private sessions: SessionMeta[] = [];

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(APP_JSON_PATH, 'utf-8');
      this.sessions = JSON.parse(raw);
    } catch {
      this.sessions = [];
    }
  }

  save(): void {
    fs.writeFileSync(APP_JSON_PATH, JSON.stringify(this.sessions, null, 2), 'utf-8');
  }

  getAll(): SessionMeta[] {
    return [...this.sessions].sort((a, b) => b.createdAt - a.createdAt);
  }

  get(id: string): SessionMeta | undefined {
    return this.sessions.find(s => s.id === id);
  }

  create(data: Omit<SessionMeta, 'id'>): SessionMeta {
    const meta: SessionMeta = { id: uuidv4(), ...data };
    this.sessions.unshift(meta);
    this.save();
    return meta;
  }

  update(id: string, patch: Partial<SessionMeta>): void {
    const idx = this.sessions.findIndex(s => s.id === id);
    if (idx !== -1) {
      this.sessions[idx] = { ...this.sessions[idx], ...patch };
      this.save();
    }
  }

  delete(id: string): void {
    this.sessions = this.sessions.filter(s => s.id !== id);
    this.save();
  }
}

export const sessionStore = new SessionStore();
```

---

### `electron/store/file.store.ts`

```typescript
import fs from 'fs';
import path from 'path';
import { app } from 'electron';
import type { PipelineState, MeetingMinutes, NormalizedSegment, TranscriptSegment } from '../../shared/types';

function sessionDir(sessionId: string): string {
  const dir = path.join(app.getPath('userData'), 'sessions', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

class FileStore {
  // ── Path helpers ─────────────────────────────────────────────────────

  getWavPath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'audio.wav');
  }

  getTranscriptPath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'transcript.jsonl');
  }

  getNormalizedPath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'normalized.json');
  }

  getMinutesPath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'minutes.json');
  }

  getExportPath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'export.md');
  }

  getPipelinePath(sessionId: string): string {
    return path.join(sessionDir(sessionId), 'pipeline.json');
  }

  // ── Pipeline checkpoint (atomic write) ───────────────────────────────

  async writePipeline(sessionId: string, state: PipelineState): Promise<void> {
    const p    = this.getPipelinePath(sessionId);
    const tmp  = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  }

  async readPipeline(sessionId: string): Promise<PipelineState | null> {
    try {
      return JSON.parse(fs.readFileSync(this.getPipelinePath(sessionId), 'utf-8'));
    } catch {
      return null;
    }
  }

  // ── Transcript ────────────────────────────────────────────────────────

  writeTranscript(sessionId: string, segments: TranscriptSegment[]): void {
    const lines = segments.map(s => JSON.stringify(s)).join('\n');
    fs.writeFileSync(this.getTranscriptPath(sessionId), lines, 'utf-8');
  }

  readTranscript(sessionId: string): TranscriptSegment[] | null {
    try {
      const raw = fs.readFileSync(this.getTranscriptPath(sessionId), 'utf-8');
      return raw.trim().split('\n').map(line => JSON.parse(line));
    } catch {
      return null;
    }
  }

  // ── Normalized ────────────────────────────────────────────────────────

  writeNormalized(sessionId: string, segments: NormalizedSegment[]): void {
    fs.writeFileSync(this.getNormalizedPath(sessionId), JSON.stringify(segments, null, 2), 'utf-8');
  }

  readNormalized(sessionId: string): NormalizedSegment[] | null {
    try {
      const data = JSON.parse(fs.readFileSync(this.getNormalizedPath(sessionId), 'utf-8'));
      return Array.isArray(data) && data.length > 0 ? data : null;
    } catch {
      return null;
    }
  }

  // ── Minutes ───────────────────────────────────────────────────────────

  writeMinutes(sessionId: string, minutes: MeetingMinutes): void {
    fs.writeFileSync(this.getMinutesPath(sessionId), JSON.stringify(minutes, null, 2), 'utf-8');
  }

  async readMinutes(sessionId: string): Promise<MeetingMinutes | null> {
    try {
      const data = JSON.parse(fs.readFileSync(this.getMinutesPath(sessionId), 'utf-8'));
      return data?.data?.purpose !== undefined ? data : null;
    } catch {
      return null;
    }
  }

  // ── Export ────────────────────────────────────────────────────────────

  writeExport(sessionId: string, markdown: string): void {
    fs.writeFileSync(this.getExportPath(sessionId), markdown, 'utf-8');
  }

  // ── Validation (idempotency check) ───────────────────────────────────

  isStepOutputValid(sessionId: string, step: string): boolean {
    try {
      switch (step) {
        case 'batch_stt': {
          const raw = fs.readFileSync(this.getTranscriptPath(sessionId), 'utf-8');
          const lines = raw.trim().split('\n');
          return lines.length >= 1 && lines.every(l => { JSON.parse(l); return true; });
        }
        case 'normalizing': {
          const data = JSON.parse(fs.readFileSync(this.getNormalizedPath(sessionId), 'utf-8'));
          return Array.isArray(data) && data.length > 0;
        }
        case 'summarizing': {
          const data = JSON.parse(fs.readFileSync(this.getMinutesPath(sessionId), 'utf-8'));
          return typeof data?.data?.purpose === 'string';
        }
        case 'exporting': {
          return fs.statSync(this.getExportPath(sessionId)).size >= 100;
        }
        default:
          return false;
      }
    } catch {
      return false;
    }
  }
}

export const fileStore = new FileStore();
```

---

### `electron/services/media.service.ts`

```typescript
import { spawn } from 'child_process';
import path from 'path';
import type { MediaProbeResult } from '../../shared/types';

// Resolve ffmpeg/ffprobe at runtime from ffmpeg-static / ffprobe-static
function resolveBin(name: 'ffmpeg' | 'ffprobe'): string {
  // In dev: node_modules/ffmpeg-static (or ffprobe-static)
  // In prod: process.resourcesPath/app.asar.unpacked/node_modules/...
  try {
    if (name === 'ffmpeg') return require('ffmpeg-static') as string;
    return require('ffprobe-static').path as string;
  } catch {
    return name; // fallback: assume in PATH
  }
}

export class MediaService {
  async probe(filePath: string): Promise<MediaProbeResult> {
    return new Promise((resolve, reject) => {
      const proc = spawn(resolveBin('ffprobe'), [
        '-v', 'quiet', '-print_format', 'json',
        '-show_format', '-show_streams', filePath,
      ]);

      let stdout = '';
      let stderr = '';
      proc.stdout.on('data', (d: Buffer) => (stdout += d.toString()));
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));

      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffprobe failed: ${stderr.slice(0, 200)}`));
        try {
          const json  = JSON.parse(stdout);
          const audio = json.streams?.find((s: any) => s.codec_type === 'audio');
          const dur   = parseFloat(json.format?.duration ?? '0') * 1000;
          resolve({
            durationMs:  Math.round(dur),
            hasAudio:    !!audio,
            hasVideo:    json.streams?.some((s: any) => s.codec_type === 'video') ?? false,
            format:      json.format?.format_name ?? 'unknown',
            audioCodec:  audio?.codec_name,
            sampleRate:  audio?.sample_rate ? parseInt(audio.sample_rate) : undefined,
            channels:    audio?.channels,
          });
        } catch (e) {
          reject(new Error(`ffprobe parse error: ${e}`));
        }
      });
    });
  }

  async extractAudio(
    videoPath: string,
    outWavPath: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return this._ffmpegConvert(
      ['-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outWavPath],
      videoPath,
      onProgress,
    );
  }

  async convertTo16kMonoWav(
    audioPath: string,
    outWavPath: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    return this._ffmpegConvert(
      ['-i', audioPath, '-acodec', 'pcm_s16le', '-ar', '16000', '-ac', '1', '-y', outWavPath],
      audioPath,
      onProgress,
    );
  }

  private async _ffmpegConvert(
    args: string[],
    inputPath: string,
    onProgress?: (pct: number) => void,
  ): Promise<void> {
    // Get duration first for progress calculation
    let totalMs = 0;
    try { totalMs = (await this.probe(inputPath)).durationMs; } catch {}

    return new Promise((resolve, reject) => {
      const proc  = spawn(resolveBin('ffmpeg'), args);
      let stderr  = '';

      proc.stderr.on('data', (d: Buffer) => {
        const chunk = d.toString();
        stderr += chunk;

        // Parse time= from ffmpeg progress output
        const m = chunk.match(/time=(\d+):(\d+):(\d+\.\d+)/);
        if (m && totalMs > 0 && onProgress) {
          const ms = (parseInt(m[1]) * 3600 + parseInt(m[2]) * 60 + parseFloat(m[3])) * 1000;
          onProgress(Math.min(100, Math.round((ms / totalMs) * 100)));
        }
      });

      proc.on('close', (code) => {
        if (code === 0) { onProgress?.(100); resolve(); }
        else reject(new Error(`ffmpeg failed (exit ${code}): ${stderr.slice(-300)}`));
      });
    });
  }

  // Split audio.wav into 15-minute segments for chunked Whisper upload
  async splitIntoChunks(wavPath: string, chunksDir: string): Promise<string[]> {
    return new Promise((resolve, reject) => {
      const pattern = path.join(chunksDir, 'chunk_%03d.wav');
      const proc = spawn(resolveBin('ffmpeg'), [
        '-i', wavPath, '-f', 'segment', '-segment_time', '900',
        '-c', 'copy', pattern, '-y',
      ]);
      let stderr = '';
      proc.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
      proc.on('close', (code) => {
        if (code !== 0) return reject(new Error(`ffmpeg chunk split failed: ${stderr.slice(-300)}`));
        const fs = require('fs') as typeof import('fs');
        const chunks = fs.readdirSync(chunksDir)
          .filter(f => f.startsWith('chunk_') && f.endsWith('.wav'))
          .sort()
          .map(f => path.join(chunksDir, f));
        resolve(chunks);
      });
    });
  }
}

export const mediaService = new MediaService();
```

---

### `electron/services/batch-stt.service.ts`

```typescript
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { app } from 'electron';
import { mediaService } from './media.service';
import type { TranscriptSegment, LangCode } from '../../shared/types';

const CHUNK_SIZE_LIMIT = 24_000_000; // 24 MB
const CHUNK_DURATION_MS = 15 * 60 * 1000; // 15 minutes

function getOpenAI(): OpenAI {
  const settings = JSON.parse(
    fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8')
  );
  return new OpenAI({ apiKey: settings.openaiKey });
}

export class BatchSttService {
  async transcribe(
    wavPath: string,
    lang: LangCode | undefined,
    sessionId: string,
  ): Promise<TranscriptSegment[]> {
    const stat = fs.statSync(wavPath);

    if (stat.size <= CHUNK_SIZE_LIMIT) {
      return this._transcribeFile(wavPath, lang, 0);
    }

    // Chunk mode
    const chunksDir = path.join(path.dirname(wavPath), 'chunks');
    fs.mkdirSync(chunksDir, { recursive: true });

    try {
      const chunkPaths = await mediaService.splitIntoChunks(wavPath, chunksDir);
      const allSegments: TranscriptSegment[] = [];

      for (let i = 0; i < chunkPaths.length; i++) {
        const offset   = i * CHUNK_DURATION_MS;
        const segments = await this._transcribeFile(chunkPaths[i], lang, offset);
        allSegments.push(...segments);
      }

      return allSegments;
    } finally {
      // Clean up chunks
      try { fs.rmSync(chunksDir, { recursive: true, force: true }); } catch {}
    }
  }

  private async _transcribeFile(
    filePath: string,
    lang: LangCode | undefined,
    offsetMs: number,
  ): Promise<TranscriptSegment[]> {
    const openai = getOpenAI();

    const params: OpenAI.Audio.TranscriptionCreateParams = {
      file:             fs.createReadStream(filePath),
      model:            'whisper-1',
      response_format:  'verbose_json',
      timestamp_granularities: ['segment'],
    };

    if (lang && lang !== 'multi') {
      params.language = lang;
    }

    const result = await openai.audio.transcriptions.create(params);

    // verbose_json includes segments with start/end timestamps
    const raw = result as any;
    if (!raw.segments) {
      // Fallback: single segment from full text
      return [{
        speakerId: 'SPEAKER_0',
        text:      result.text,
        startMs:   offsetMs,
        endMs:     offsetMs + 60_000,
        lang,
      }];
    }

    return (raw.segments as any[]).map((seg: any) => ({
      speakerId: 'SPEAKER_0',   // Whisper-1 does not diarize; all same speaker
      text:      seg.text.trim(),
      startMs:   Math.round(seg.start * 1000) + offsetMs,
      endMs:     Math.round(seg.end   * 1000) + offsetMs,
      lang,
    }));
  }
}

export const batchSttService = new BatchSttService();
```

---

### `electron/services/normalization.service.ts`

```typescript
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { app } from 'electron';
import type { TranscriptSegment, NormalizedSegment, LangCode } from '../../shared/types';

const BATCH_SIZE = 20;

function getOpenAI(): OpenAI {
  const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'));
  return new OpenAI({ apiKey: s.openaiKey });
}

function langName(lang?: LangCode): string {
  return lang === 'ja' ? 'Japanese'
       : lang === 'vi' ? 'Vietnamese'
       : lang === 'en' ? 'English'
       : 'the original language';
}

export class NormalizationService {
  async normalize(
    segments: TranscriptSegment[],
    lang?: LangCode,
  ): Promise<NormalizedSegment[]> {
    const results: NormalizedSegment[] = [];

    for (let i = 0; i < segments.length; i += BATCH_SIZE) {
      const batch = segments.slice(i, i + BATCH_SIZE);

      try {
        const normalized = await this._normalizeBatch(batch, lang);
        results.push(...normalized);
      } catch {
        // Fallback: return batch as-is
        for (const seg of batch) {
          results.push({
            speakerId:      seg.speakerId,
            originalText:   seg.text,
            normalizedText: seg.text,
          });
        }
      }
    }

    return results;
  }

  private async _normalizeBatch(
    segments: TranscriptSegment[],
    lang?: LangCode,
  ): Promise<NormalizedSegment[]> {
    const openai = getOpenAI();

    const inputList = segments.map((s, i) => `${i}: ${s.text}`).join('\n');

    const prompt = `You are a transcript editor.
Rewrite the following ${langName(lang)} spoken-language transcript lines into clean written text.
- Remove filler words (um, uh, えーと, あの, ừm, ờ, etc.)
- Fix grammar and sentence structure
- Preserve the original meaning and language — do not translate
- Return ONLY a JSON array of exactly ${segments.length} objects: [{"originalText":"...","normalizedText":"..."}]
- Index order must match the input exactly

Input:
${inputList}`;

    const res = await openai.chat.completions.create({
      model:       'gpt-4o-mini',
      temperature: 0,
      messages:    [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
    });

    const content = res.choices[0]?.message?.content ?? '[]';
    // The model may return { items: [...] } or just [...]
    let arr: any[];
    try {
      const parsed = JSON.parse(content);
      arr = Array.isArray(parsed) ? parsed : (parsed.items ?? parsed.result ?? []);
    } catch {
      arr = [];
    }

    return segments.map((seg, i) => ({
      speakerId:      seg.speakerId,
      originalText:   seg.text,
      normalizedText: (arr[i]?.normalizedText as string) ?? seg.text,
    }));
  }
}

export const normalizationService = new NormalizationService();
```

---

### `electron/services/summarization.service.ts`

```typescript
import fs from 'fs';
import path from 'path';
import OpenAI from 'openai';
import { app } from 'electron';
import type { NormalizedSegment, MeetingMinutes, LangCode } from '../../shared/types';

const MAX_TRANSCRIPT_CHARS = 120_000;

function getOpenAI(): OpenAI {
  const s = JSON.parse(fs.readFileSync(path.join(app.getPath('userData'), 'settings.json'), 'utf-8'));
  return new OpenAI({ apiKey: s.openaiKey });
}

const MINUTES_SCHEMA = {
  name:   'meeting_minutes',
  strict: true,
  schema: {
    type: 'object',
    properties: {
      purpose:      { type: 'string' },
      decisions:    { type: 'array', items: { type: 'string' } },
      todos:        { type: 'array', items: { type: 'string' } },
      concerns:     { type: 'array', items: { type: 'string' } },
      next_actions: { type: 'array', items: { type: 'string' } },
    },
    required: ['purpose', 'decisions', 'todos', 'concerns', 'next_actions'],
    additionalProperties: false,
  },
} as const;

export class SummarizationService {
  async summarize(
    segments: NormalizedSegment[],
    sessionId: string,
    lang?: LangCode,
  ): Promise<MeetingMinutes> {
    let transcript = segments
      .map(s => `[${s.speakerId}]: ${s.normalizedText}`)
      .join('\n');

    if (transcript.length > MAX_TRANSCRIPT_CHARS) {
      transcript = transcript.slice(0, MAX_TRANSCRIPT_CHARS) + '\n[transcript truncated]';
    }

    const langInstruction = lang && lang !== 'multi'
      ? `Write all values in ${lang === 'ja' ? 'Japanese' : lang === 'vi' ? 'Vietnamese' : 'English'}.`
      : 'Write all values in the language of the meeting.';

    const prompt = `You are a meeting minutes assistant.
Based on the following meeting transcript, extract structured minutes.
${langInstruction}
Be concise. Use bullet-point style sentences.
Return ONLY the JSON object — no explanation, no markdown.

Transcript:
${transcript}`;

    try {
      const openai = getOpenAI();
      const res = await openai.chat.completions.create({
        model:           'gpt-4o',
        temperature:     0,
        messages:        [{ role: 'user', content: prompt }],
        response_format: { type: 'json_schema', json_schema: MINUTES_SCHEMA },
      });

      const data = JSON.parse(res.choices[0]?.message?.content ?? '{}');
      return {
        sessionId,
        generatedAt: Date.now(),
        language:    lang,
        data: {
          purpose:      data.purpose      ?? '',
          decisions:    data.decisions    ?? [],
          todos:        data.todos        ?? [],
          concerns:     data.concerns     ?? [],
          next_actions: data.next_actions ?? [],
        },
      };
    } catch (err: any) {
      return {
        sessionId,
        generatedAt: Date.now(),
        language:    lang,
        data: {
          purpose:      `Summarization failed: ${err.message}`,
          decisions:    [],
          todos:        [],
          concerns:     [],
          next_actions: [],
        },
      };
    }
  }
}

export const summarizationService = new SummarizationService();
```

---

### `electron/services/export.service.ts`

```typescript
import type { MeetingMinutes, SessionMeta } from '../../shared/types';

function formatDate(ts: number): string {
  return new Date(ts).toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
}

function bulletList(items: string[]): string {
  if (!items.length) return '_なし / None_\n';
  return items.map(item => `- ${item}`).join('\n') + '\n';
}

export class ExportService {
  toMarkdown(minutes: MeetingMinutes, meta: SessionMeta | undefined): string {
    const title    = meta?.title ?? 'Meeting Minutes';
    const date     = formatDate(minutes.generatedAt);
    const duration = meta?.durationMs
      ? `${Math.round(meta.durationMs / 60000)} 分`
      : '不明';

    return `# ${title}

**日時**: ${date}
**所要時間**: ${duration}

---

## 概要 / Purpose

${minutes.data.purpose}

---

## 決定事項 / Decisions

${bulletList(minutes.data.decisions)}
---

## ToDo

${bulletList(minutes.data.todos)}
---

## 懸念事項 / Concerns

${bulletList(minutes.data.concerns)}
---

## 次のアクション / Next Actions

${bulletList(minutes.data.next_actions)}
---

_Generated by MTG Assistant v1.1_
`;
  }
}

export const exportService = new ExportService();
```

---

### `electron/services/post-meeting.service.ts`

```typescript
import { BrowserWindow } from 'electron';
import { sessionStore } from '../store/session.store';
import { fileStore } from '../store/file.store';
import { batchSttService } from './batch-stt.service';
import { normalizationService } from './normalization.service';
import { summarizationService } from './summarization.service';
import { exportService } from './export.service';
import type { LangCode, PipelineStep } from '../../shared/types';

const STEP_ORDER: PipelineStep[] = [
  'batch_stt', 'normalizing', 'summarizing', 'exporting',
];

function push(sessionId: string, data: object) {
  BrowserWindow.getAllWindows()[0]?.webContents.send('session:status', { sessionId, ...data });
}

export class PostMeetingService {
  async run(sessionId: string, wavPath: string, lang?: LangCode): Promise<string> {
    return this.runFrom(sessionId, 'batch_stt', wavPath, lang);
  }

  async runFrom(
    sessionId: string,
    startStep: PipelineStep,
    wavPath: string,
    lang?: LangCode,
  ): Promise<string> {
    const state = await fileStore.readPipeline(sessionId) ?? {
      sessionId,
      step: startStep,
      status: 'pending' as const,
      completedSteps: [] as PipelineStep[],
      updatedAt: Date.now(),
    };

    sessionStore.update(sessionId, { status: 'processing' });

    const startIdx = STEP_ORDER.indexOf(startStep);
    if (startIdx === -1) throw new Error(`Unknown step: ${startStep}`);

    for (let i = startIdx; i < STEP_ORDER.length; i++) {
      const step = STEP_ORDER[i];

      // Idempotency: skip if already done and output is valid
      if (fileStore.isStepOutputValid(sessionId, step)) {
        state.completedSteps = [...new Set([...state.completedSteps, step])];
        state.lastCompletedStep = step;
        continue;
      }

      // Mark step running
      await fileStore.writePipeline(sessionId, {
        ...state,
        step,
        status: 'running',
        updatedAt: Date.now(),
      });
      push(sessionId, { status: 'processing', step, progress: 0 });

      try {
        await this._runStep(sessionId, step, wavPath, lang);
      } catch (err: any) {
        await fileStore.writePipeline(sessionId, {
          ...state,
          step,
          status: 'error',
          error: err.message,
          updatedAt: Date.now(),
        });
        sessionStore.update(sessionId, { status: 'error' });
        push(sessionId, { status: 'error', step, error: err.message });
        throw err;
      }

      // Mark step done, advance checkpoint
      state.completedSteps = [...new Set([...state.completedSteps, step])];
      state.lastCompletedStep = step;
      const nextStep = STEP_ORDER[i + 1] ?? 'done';

      await fileStore.writePipeline(sessionId, {
        ...state,
        step:   nextStep,
        status: 'pending',
        updatedAt: Date.now(),
      });

      push(sessionId, { status: 'processing', step, progress: 100 });
    }

    // All steps done
    const exportPath = fileStore.getExportPath(sessionId);
    sessionStore.update(sessionId, { status: 'done' });
    await fileStore.writePipeline(sessionId, {
      ...state,
      step: 'done',
      status: 'done',
      updatedAt: Date.now(),
    });

    BrowserWindow.getAllWindows()[0]?.webContents.send('session:done', { sessionId, exportPath });
    return exportPath;
  }

  private async _runStep(
    sessionId: string,
    step: PipelineStep,
    wavPath: string,
    lang?: LangCode,
  ): Promise<void> {
    switch (step) {
      case 'batch_stt': {
        const segments = await batchSttService.transcribe(wavPath, lang, sessionId);
        fileStore.writeTranscript(sessionId, segments);
        break;
      }

      case 'normalizing': {
        const transcript = fileStore.readTranscript(sessionId);
        if (!transcript) throw new Error('transcript.jsonl missing');
        const normalized = await normalizationService.normalize(transcript, lang);
        fileStore.writeNormalized(sessionId, normalized);
        break;
      }

      case 'summarizing': {
        const normalized = fileStore.readNormalized(sessionId);
        if (!normalized) throw new Error('normalized.json missing');
        const minutes = await summarizationService.summarize(normalized, sessionId, lang);
        fileStore.writeMinutes(sessionId, minutes);
        break;
      }

      case 'exporting': {
        const minutes = await fileStore.readMinutes(sessionId);
        if (!minutes) throw new Error('minutes.json missing');
        const meta = sessionStore.get(sessionId);
        const md   = exportService.toMarkdown(minutes, meta);
        fileStore.writeExport(sessionId, md);
        break;
      }
    }
  }
}

export const postMeetingService = new PostMeetingService();
```

---

### `renderer/src/store/sessionStore.ts`

```typescript
import { create } from 'zustand';
import type { SessionMeta, SessionDetail } from '../../../shared/types';

interface SessionStore {
  list:       SessionMeta[];
  current:    SessionDetail | null;
  loadList:   () => Promise<void>;
  loadDetail: (sessionId: string) => Promise<void>;
  refresh:    (sessionId: string) => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set) => ({
  list:    [],
  current: null,

  loadList: async () => {
    const list = await window.api.session.list() as SessionMeta[];
    set({ list });
  },

  loadDetail: async (sessionId: string) => {
    const current = await window.api.session.get(sessionId) as SessionDetail;
    set({ current });
  },

  refresh: async (sessionId: string) => {
    const [list, current] = await Promise.all([
      window.api.session.list() as Promise<SessionMeta[]>,
      window.api.session.get(sessionId)  as Promise<SessionDetail>,
    ]);
    set({ list, current });
  },
}));
```

---

### `renderer/src/hooks/useIpc.ts`

```typescript
import { useEffect } from 'react';

export function useIpcOn(channel: string, handler: (data: any) => void) {
  useEffect(() => {
    const unsub = window.api.on(channel, handler);
    return unsub;
  }, [channel, handler]);
}
```

---

### `renderer/src/screens/Dashboard.tsx`

```tsx
import { useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../store/sessionStore';
import { SessionCard } from '../components/SessionCard';

export function Dashboard() {
  const navigate = useNavigate();
  const { list, loadList } = useSessionStore();

  useEffect(() => { loadList(); }, []);

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-4">
        <h1 className="text-xl font-semibold text-text-primary">MTG Assistant</h1>
        <button
          className="px-3 py-1.5 bg-accent hover:bg-accent-hover text-white rounded text-sm font-normal"
          onClick={() => navigate('/import')}
        >
          インポート / Import
        </button>
      </div>

      {list.length === 0 ? (
        <p className="text-text-muted text-sm">
          セッションがありません。ファイルをインポートしてください。
        </p>
      ) : (
        <div className="space-y-2">
          {list.map(s => (
            <SessionCard
              key={s.id}
              session={s}
              onClick={() => navigate(`/session/${s.id}`)}
            />
          ))}
        </div>
      )}
    </div>
  );
}
```

---

### `renderer/src/screens/ImportScreen.tsx`

```tsx
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LangCode, MediaProbeResult } from '../../../shared/types';

const LANG_OPTIONS: { value: LangCode | ''; label: string }[] = [
  { value: '',      label: '自動検出 / Auto-detect' },
  { value: 'ja',    label: '日本語 (Japanese)' },
  { value: 'en',    label: 'English' },
  { value: 'vi',    label: 'Tiếng Việt (Vietnamese)' },
];

export function ImportScreen() {
  const navigate = useNavigate();
  const [filePath, setFilePath]   = useState<string | null>(null);
  const [probe, setProbe]         = useState<MediaProbeResult | null>(null);
  const [probeError, setProbeError] = useState<string | null>(null);
  const [title, setTitle]         = useState('');
  const [lang, setLang]           = useState<LangCode | ''>('');
  const [loading, setLoading]     = useState(false);

  const EXTENSIONS = ['wav', 'mp3', 'm4a', 'mp4', 'mov', 'mkv', 'webm'];

  async function pickFile() {
    const path = await window.api.dialog.openFile(EXTENSIONS) as string | null;
    if (!path) return;
    setFilePath(path);
    setProbeError(null);
    setProbe(null);

    try {
      const result = await window.api.media.probe(path) as MediaProbeResult;
      if (!result.hasAudio) {
        setProbeError('この動画には音声トラックがありません。');
        return;
      }
      setProbe(result);
      // Pre-fill title from filename
      if (!title) {
        const name = path.split(/[\\/]/).pop() ?? '';
        setTitle(name.replace(/\.[^.]+$/, ''));
      }
    } catch (e: any) {
      setProbeError(e.message);
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!filePath || !probe || !title.trim()) return;
    setLoading(true);

    try {
      const sourceType = probe.hasVideo ? 'video' : 'audio';
      const { sessionId } = await window.api.session.import({
        title:      title.trim(),
        sourcePath: filePath,
        sourceType,
        lang:       lang || undefined,
      }) as { sessionId: string };
      navigate(`/session/${sessionId}`);
    } catch (e: any) {
      setProbeError(e.message);
      setLoading(false);
    }
  }

  const durationStr = probe
    ? `${Math.round(probe.durationMs / 60000)} 分 (${probe.format})`
    : null;

  return (
    <div className="p-4 max-w-lg mx-auto">
      <h2 className="text-lg font-semibold text-text-primary mb-4">
        ファイルインポート / Import File
      </h2>

      <form onSubmit={handleSubmit} className="space-y-3">
        {/* File picker */}
        <div>
          <button
            type="button"
            onClick={pickFile}
            className="w-full py-2 border border-border rounded text-sm text-text-dim
                       hover:border-accent hover:text-text-primary transition"
          >
            {filePath
              ? filePath.split(/[\\/]/).pop()
              : 'ファイルを選択… (wav / mp3 / m4a / mp4 / mov)'}
          </button>
          {durationStr && (
            <p className="text-xs text-text-muted mt-1">再生時間: {durationStr}</p>
          )}
          {probeError && (
            <p className="text-xs text-red-400 mt-1">{probeError}</p>
          )}
        </div>

        {/* Title */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            タイトル / Title *
          </label>
          <input
            type="text"
            value={title}
            onChange={e => setTitle(e.target.value)}
            placeholder="例：週次ミーティング"
            className="w-full px-3 py-1.5 bg-surface-2 border border-border rounded text-sm
                       text-text-primary placeholder:text-text-muted focus:outline-none
                       focus:border-accent"
            required
          />
        </div>

        {/* Language */}
        <div>
          <label className="block text-xs text-text-muted mb-1">
            言語 / Language
          </label>
          <select
            value={lang}
            onChange={e => setLang(e.target.value as LangCode | '')}
            className="w-full px-3 py-1.5 bg-surface-2 border border-border rounded text-sm
                       text-text-primary focus:outline-none focus:border-accent"
          >
            {LANG_OPTIONS.map(o => (
              <option key={o.value} value={o.value}>{o.label}</option>
            ))}
          </select>
        </div>

        <button
          type="submit"
          disabled={!probe || !title.trim() || loading}
          className="w-full py-2 bg-accent hover:bg-accent-hover disabled:opacity-40
                     text-white rounded text-sm font-normal transition"
        >
          {loading ? '処理中…' : 'インポート開始'}
        </button>
      </form>
    </div>
  );
}
```

---

### `renderer/src/screens/PostMeeting.tsx`

```tsx
import { useEffect, useState, useCallback } from 'react';
import { useParams } from 'react-router-dom';
import { useSessionStore } from '../store/sessionStore';
import { useIpcOn } from '../hooks/useIpc';
import { PipelineProgress } from '../components/PipelineProgress';
import type { SessionDetail, PipelineStep } from '../../../shared/types';

type StatusPush = {
  sessionId: string; status: string; step?: PipelineStep;
  progress?: number; error?: string;
};

export function PostMeeting() {
  const { id: sessionId } = useParams<{ id: string }>();
  const { current, loadDetail } = useSessionStore();
  const [activeTab, setActiveTab] = useState<'minutes' | 'todos' | 'concerns'>('minutes');
  const [statusOverride, setStatusOverride] = useState<StatusPush | null>(null);

  useEffect(() => {
    if (sessionId) loadDetail(sessionId);
  }, [sessionId]);

  // Live pipeline status updates
  const handleStatus = useCallback((data: StatusPush) => {
    if (data.sessionId !== sessionId) return;
    setStatusOverride(data);
    if (data.status === 'done' || data.status === 'error') {
      loadDetail(sessionId!);
    }
  }, [sessionId]);

  useIpcOn('session:status', handleStatus);
  useIpcOn('session:done',   handleStatus);

  if (!current) return <div className="p-4 text-text-muted text-sm">読み込み中…</div>;

  const session = current as SessionDetail;
  const effectiveStatus = statusOverride?.status ?? session.status;
  const isProcessing = effectiveStatus === 'processing';
  const isError      = effectiveStatus === 'error';
  const isRecoverable = session.status === 'error_recoverable' && !statusOverride;
  const isDone       = effectiveStatus === 'done' || session.status === 'done';

  const minutes = session.minutes;

  async function handleRetry(step: PipelineStep) {
    setStatusOverride(null);
    await window.api.session.retryStep(sessionId!, step);
  }

  async function handleResume() {
    setStatusOverride(null);
    await window.api.session.resumePipeline(sessionId!);
  }

  async function handleExport() {
    await window.api.export.markdown(sessionId!);
  }

  return (
    <div className="p-4 max-w-2xl mx-auto">
      <h2 className="text-lg font-semibold text-text-primary mb-1">{session.title}</h2>
      {session.durationMs && (
        <p className="text-xs text-text-muted mb-3">
          {Math.round(session.durationMs / 60000)} 分
        </p>
      )}

      {/* Resume banner */}
      {isRecoverable && (
        <div className="mb-3 p-3 border border-yellow-600 rounded bg-yellow-900/20 text-sm">
          <p className="text-yellow-300 mb-2">
            ⚡ 前回の処理を再開できます（最後の完了ステップ:{' '}
            {session.pipeline?.lastCompletedStep ?? 'なし'}）
          </p>
          <button
            onClick={handleResume}
            className="px-3 py-1 bg-yellow-700 hover:bg-yellow-600 text-white rounded text-xs"
          >
            処理を再開
          </button>
        </div>
      )}

      {/* Pipeline progress */}
      {(isProcessing || isError || isRecoverable) && (
        <PipelineProgress
          pipeline={session.pipeline}
          statusOverride={statusOverride}
          onRetry={handleRetry}
        />
      )}

      {/* Results */}
      {isDone && minutes && (
        <>
          <div className="flex gap-2 mb-3 border-b border-border pb-2">
            {(['minutes', 'todos', 'concerns'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-3 py-1 rounded text-xs transition ${
                  activeTab === tab
                    ? 'bg-accent text-white'
                    : 'text-text-muted hover:text-text-primary'
                }`}
              >
                {tab === 'minutes' ? '議事録' : tab === 'todos' ? 'ToDo' : '懸念事項'}
              </button>
            ))}
            <button
              onClick={handleExport}
              className="ml-auto px-3 py-1 border border-border rounded text-xs
                         text-text-muted hover:text-text-primary transition"
            >
              MD エクスポート
            </button>
          </div>

          <div className="text-sm text-text-primary space-y-2">
            {activeTab === 'minutes' && (
              <>
                <p className="text-text-muted text-xs">概要 / Purpose</p>
                <p>{minutes.data.purpose}</p>
                {minutes.data.decisions.length > 0 && (
                  <>
                    <p className="text-text-muted text-xs mt-3">決定事項 / Decisions</p>
                    <ul className="list-disc list-inside space-y-1">
                      {minutes.data.decisions.map((d, i) => <li key={i}>{d}</li>)}
                    </ul>
                  </>
                )}
                {minutes.data.next_actions.length > 0 && (
                  <>
                    <p className="text-text-muted text-xs mt-3">次のアクション / Next Actions</p>
                    <ul className="list-disc list-inside space-y-1">
                      {minutes.data.next_actions.map((a, i) => <li key={i}>{a}</li>)}
                    </ul>
                  </>
                )}
              </>
            )}

            {activeTab === 'todos' && (
              <>
                <p className="text-text-muted text-xs">ToDo</p>
                {minutes.data.todos.length > 0
                  ? <ul className="list-disc list-inside space-y-1">
                      {minutes.data.todos.map((t, i) => <li key={i}>{t}</li>)}
                    </ul>
                  : <p className="text-text-muted">なし</p>
                }
              </>
            )}

            {activeTab === 'concerns' && (
              <>
                <p className="text-text-muted text-xs">懸念事項 / Concerns</p>
                {minutes.data.concerns.length > 0
                  ? <ul className="list-disc list-inside space-y-1">
                      {minutes.data.concerns.map((c, i) => <li key={i}>{c}</li>)}
                    </ul>
                  : <p className="text-text-muted">なし</p>
                }
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}
```

---

### `renderer/src/components/PipelineProgress.tsx`

```tsx
import type { PipelineState, PipelineStep } from '../../../shared/types';

const STEPS: PipelineStep[] = ['batch_stt', 'normalizing', 'summarizing', 'exporting'];

const STEP_LABEL: Record<PipelineStep, string> = {
  prepare_audio: '音声変換',
  batch_stt:     '音声認識',
  normalizing:   'テキスト整形',
  summarizing:   '議事録生成',
  exporting:     'エクスポート',
  done:          '完了',
};

type Props = {
  pipeline:       PipelineState | null | undefined;
  statusOverride: { step?: PipelineStep; status?: string; progress?: number; error?: string } | null;
  onRetry:        (step: PipelineStep) => void;
};

export function PipelineProgress({ pipeline, statusOverride, onRetry }: Props) {
  const completedSteps = new Set(pipeline?.completedSteps ?? []);
  const activeStep     = statusOverride?.step ?? pipeline?.step;
  const activeStatus   = statusOverride?.status ?? pipeline?.status;

  return (
    <div className="mb-4 p-3 bg-surface border border-border rounded">
      <p className="text-xs text-text-muted mb-2">
        {activeStatus === 'error' ? '⚠ エラーが発生しました' : '処理中 / Processing…'}
      </p>
      <div className="space-y-1.5">
        {STEPS.map(step => {
          const isDone    = completedSteps.has(step);
          const isActive  = step === activeStep;
          const isError   = isActive && activeStatus === 'error';
          const progress  = isActive ? (statusOverride?.progress ?? 0) : 0;

          return (
            <div key={step} className="flex items-center gap-2 text-sm">
              <span className="w-4 text-center">
                {isDone    ? '✓'
               : isError   ? '✕'
               : isActive  ? '⟳'
               :              '○'}
              </span>
              <span className={`flex-1 ${isDone ? 'text-text-muted' : 'text-text-primary'}`}>
                {STEP_LABEL[step]}
              </span>
              {isActive && !isError && progress > 0 && (
                <span className="text-xs text-text-muted">{progress}%</span>
              )}
              {isError && (
                <button
                  onClick={() => onRetry(step)}
                  className="px-2 py-0.5 text-xs border border-red-600 text-red-400
                             rounded hover:bg-red-900/30 transition"
                >
                  再試行
                </button>
              )}
            </div>
          );
        })}
      </div>
      {statusOverride?.error && (
        <p className="mt-2 text-xs text-red-400">{statusOverride.error}</p>
      )}
    </div>
  );
}
```

---

### `renderer/src/screens/Settings.tsx`

```tsx
import { useEffect, useState } from 'react';
import type { AppSettings } from '../../../shared/types';

export function Settings() {
  const [settings, setSettings] = useState<AppSettings>({ uiLang: 'ja' });
  const [keyInput, setKeyInput] = useState('');
  const [saved, setSaved]       = useState(false);

  useEffect(() => {
    window.api.settings.get().then((s: AppSettings) => {
      setSettings(s);
      setKeyInput(s.openaiKey ? '****' + s.openaiKey.slice(-4) : '');
    });
  }, []);

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();
    const newKey = keyInput.startsWith('****') ? settings.openaiKey : keyInput.trim();
    await window.api.settings.save({ openaiKey: newKey, uiLang: settings.uiLang });
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  return (
    <div className="p-4 max-w-md mx-auto">
      <h2 className="text-lg font-semibold text-text-primary mb-4">設定 / Settings</h2>

      <form onSubmit={handleSave} className="space-y-3">
        <div>
          <label className="block text-xs text-text-muted mb-1">
            OpenAI API Key
          </label>
          <input
            type="text"
            value={keyInput}
            onChange={e => setKeyInput(e.target.value)}
            placeholder="sk-..."
            className="w-full px-3 py-1.5 bg-surface-2 border border-border rounded text-sm
                       text-text-primary placeholder:text-text-muted font-mono
                       focus:outline-none focus:border-accent"
          />
          <p className="text-xs text-text-muted mt-1">
            Whisper + GPT-4o に使用されます。
            平文で settings.json に保存されます (v1.1)。
          </p>
        </div>

        <div>
          <label className="block text-xs text-text-muted mb-1">
            UI 言語 / UI Language
          </label>
          <select
            value={settings.uiLang}
            onChange={e => setSettings(s => ({ ...s, uiLang: e.target.value as 'ja' | 'en' | 'vi' }))}
            className="w-full px-3 py-1.5 bg-surface-2 border border-border rounded text-sm
                       text-text-primary focus:outline-none focus:border-accent"
          >
            <option value="ja">日本語</option>
            <option value="en">English</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </div>

        <button
          type="submit"
          className="w-full py-2 bg-accent hover:bg-accent-hover text-white rounded text-sm font-normal"
        >
          {saved ? '保存しました ✓' : '保存 / Save'}
        </button>
      </form>
    </div>
  );
}
```

---

### `renderer/src/App.tsx`

```tsx
import { MemoryRouter, Routes, Route, Navigate } from 'react-router-dom';
import { Dashboard }    from './screens/Dashboard';
import { ImportScreen } from './screens/ImportScreen';
import { PostMeeting }  from './screens/PostMeeting';
import { Settings }     from './screens/Settings';

export function App() {
  return (
    <MemoryRouter>
      <div className="min-h-screen bg-bg text-text-primary flex">
        {/* Minimal sidebar nav */}
        <nav className="w-48 bg-surface border-r border-border flex flex-col p-3 gap-1 shrink-0">
          <a href="#/" onClick={e => { e.preventDefault(); window.history.go(0); }}
             className="text-xs text-text-muted py-1 px-2 rounded hover:bg-surface-2">
            ホーム
          </a>
          {/* Nav handled by React Router — links here are decorative */}
        </nav>

        <main className="flex-1 overflow-auto">
          <Routes>
            <Route path="/"              element={<Dashboard />} />
            <Route path="/import"        element={<ImportScreen />} />
            <Route path="/session/:id"   element={<PostMeeting />} />
            <Route path="/settings"      element={<Settings />} />
            <Route path="*"              element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </MemoryRouter>
  );
}
```

---

## 9. Error Handling

| Scenario | Behaviour |
|----------|-----------|
| ffmpeg binary not found | `FfmpegNotFoundError` → toast: "ffmpeg が見つかりません。" |
| File has no audio stream | `probe` returns `hasAudio: false` → ImportScreen blocks submit |
| Whisper API error (401) | Pipeline marks step 'error'; user opens Settings to fix key |
| Whisper API error (5xx) | Pipeline marks step 'error'; user clicks Retry in PostMeeting |
| GPT API error | Same — step marked 'error', Retry button shown |
| File > 24 MB WAV | Chunked automatically; no user action needed |
| Very long transcript (> 120k chars) | Truncated silently; note added to minutes |
| App crash mid-pipeline | On restart: session marked `error_recoverable`; Resume banner shown |

All unhandled errors in `runImportPipeline` are caught, set session `status: 'error'`, and push `session:status { status: 'error', error: message }`.

---

## 10. QA Scenarios

| # | Scenario | Expected |
|---|----------|---------|
| Q1 | Import 10-min MP3 | Converts → transcribes → normalizes → summarizes → export.md |
| Q2 | Import 2h MP4 video | Audio extracted; WAV > 24MB → chunked STT; all steps complete |
| Q3 | Import MP4 with no audio | Probe returns `hasAudio: false`; Import button disabled |
| Q4 | Wrong API key | `batch_stt` fails (401); Retry button visible; fix key in Settings → Retry works |
| Q5 | App crash during `normalizing` | Restart: resume banner shows; Resume → skips `batch_stt`, runs from `normalizing` |
| Q6 | App crash during `prepare_audio` | Restart: `audio.wav` absent → `error_recoverable` with "re-import required" message |
| Q7 | Two imports at same time | Second import starts own pipeline; both run (no lock in v1.1) |
| Q8 | Re-import same file | New sessionId created; old session unaffected |

---

*End of DESIGN_v1.1_IMPORT.md*
