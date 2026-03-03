# MTG Assistant — Design Document

**Version**: 1.0.0
**Stack**: Electron 31 + React 18 + TypeScript 5.5 + Tailwind CSS 3
**Platform**: Windows (primary), macOS

---

## 1. Overview

MTG Assistant is a **local-first** desktop application that records meetings, transcribes speech in real-time, detects languages, normalizes spoken text, and generates structured meeting minutes using AI. All data stays on the user's machine; only API calls leave the device.

### Key Capabilities

| Capability | Provider |
|------------|----------|
| Real-time transcription + diarization | Deepgram nova-3 (WebSocket) |
| High-accuracy batch transcription | OpenAI Whisper |
| Translation (realtime) | DeepL → GPT-4o-mini fallback |
| Text normalization | Rule engine + GPT-4o-mini |
| Meeting minutes generation | GPT-4o (structured JSON) |
| UI languages | Japanese / English / Vietnamese |

---

## 2. Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Renderer Process (React)                               │
│  ┌─────────────────────────────────────────────────┐   │
│  │ RecordingProvider (never unmounts)              │   │
│  │  useAudioCapture · IPC caption subs · timer     │   │
│  │  ┌──────────┐ ┌───────────┐ ┌──────────┐       │   │
│  │  │Dashboard │ │LiveSession│ │PostMeeting│ ...   │   │
│  │  └──────────┘ └───────────┘ └──────────┘       │   │
│  └─────────────────────────────────────────────────┘   │
│  Zustand: sessionStore · captionStore · recordingStore  │
└──────────────────────┬──────────────────────────────────┘
                       │  contextBridge (window.api)
                       │  IPC channels (invoke / send)
┌──────────────────────▼──────────────────────────────────┐
│  Main Process (Node.js / Electron)                      │
│  ┌───────────┐ ┌───────────┐ ┌──────────┐ ┌─────────┐ │
│  │session.ipc│ │audio.ipc  │ │settings  │ │export   │ │
│  └─────┬─────┘ └─────┬─────┘ └──────────┘ └─────────┘ │
│        │             │                                   │
│  ┌─────▼─────────────▼──────────────────────────────┐  │
│  │ Services                                          │  │
│  │  SttService   BatchSttService  TranslationService │  │
│  │  LangDetect   Normalization    Summarization      │  │
│  │  PostMeeting  Export                              │  │
│  └───────────────────────────────────────────────────┘  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Stores                                           │   │
│  │  session.store (app.json)                        │   │
│  │  file.store   (sessions/{id}/*.pcm/.jsonl/.json) │   │
│  │  secret.store (vault.json)                       │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
              │
              ▼ External APIs
   Deepgram · OpenAI · DeepL
```

### Process Separation

| Concern | Process |
|---------|---------|
| UI rendering, audio capture | Renderer (sandboxed) |
| STT WebSocket, file I/O, API calls | Main |
| API key exposure, raw PCM | Main only — never in renderer |

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
| `session:status` | `{ sessionId, status, step? }` |
| `session:done` | `{ sessionId, exportPath }` |
| `error` | `{ code, message, sessionId? }` |

---

## 4. Data Flow

### 4.1 Live Recording

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

### 4.2 Post-Meeting Pipeline

Triggered by `session:stop`. Runs sequentially, emits `session:status` at each step.

```
1. batch_stt    → Whisper API → TranscriptSegment[]
                  (fallback: realtime transcript.jsonl)
2. lang_detect  → Unicode heuristic per segment → detectedLang
3. normalizing  → Phase 1: rule-based filler removal
                  Phase 2: GPT-4o-mini rewrite (optional, batched 20/call)
                  → normalized.json
4. summarizing  → GPT-4o structured output
                  → minutes.json { purpose, decisions, todos, concerns, next_actions }
5. exporting    → exportService.toMarkdown()
                  → export.md
6. save         → sessionStore.update(status: 'done')
                  → session:done event
```

---

## 5. Services

### SttService
- Deepgram nova-3 WebSocket (`wss://api.deepgram.com/v1/listen`)
- Params: `model=nova-3&diarize=true&smart_format=true&language=multi`
- Reconnect: once after 2s on disconnect, then degrade silently

### BatchSttService
- OpenAI Whisper-1 (`audio/transcriptions`)
- Converts raw PCM → WAV (adds RIFF header) in-memory before upload
- Returns `TranscriptSegment[]` with `startMs`/`endMs`
- Language hint: `ja` / `en` / `vi` (multi → omit hint, auto-detect)

### LangDetectService
```
detectLang(text):
  CJK codepoints > 10% of chars → 'ja'
  Vietnamese diacritics count > 2 OR > 4% → 'vi'
  else → 'en'

detectAll(segments[]):
  applied only when segment.lang is 'multi' or 'none'
  inherits previous segment lang if isolated ambiguous text
```

### TranslationService
- Provider priority: DeepL (if key set) → GPT-4o-mini
- LRU cache: 300 entries (key = `srcLang:tgtLang:text`)
- DeepL language mapping: `ja→JA`, `en→EN-US`, `vi→VI`
- GPT fallback prompt: simple translation instruction, max 256 tokens
- Non-blocking: fire-and-forget, UI shows translation when ready

### NormalizationService

**Phase 1 — Rule Engine (always runs)**

| Class | Examples | Remove condition |
|-------|----------|-----------------|
| `always` | um, uh, うん, ừm | Unconditional |
| `sentence_initial` | えっと, so, thì | First token only |
| `isolated` | はい, right, ừ | Entire segment = filler |

Language-specific punctuation: adds `。` / `.` if terminal missing.

**Phase 2 — LLM Rewrite (optional)**
- Trigger: word count > 8 AND filler density > 15%
- Batches up to 20 segments per GPT-4o-mini call, grouped by `detectedLang`
- System prompt: `"Convert spoken {lang} to written {lang}. Preserve meaning."`
- Fallback: return Phase 1 result on any error

### SummarizationService
- Model: GPT-4o, `temperature: 0`, `max_tokens: 1024`
- Response format: `json_schema` (strict mode)
- Schema fields: `purpose`, `decisions[]`, `todos[]`, `concerns[]`, `next_actions[]`
- Todo item: `{ task, assignee: string|null, deadline: string|null, priority: high|medium|low }`
- Language-aware prompt: summary requested in meeting's detected language
- Fallback: empty structure with error message in `purpose` field

### ExportService
Deterministic Markdown render (no LLM):
```markdown
# {title}
日時: {date}  所要時間: {duration}

## 目的 / Purpose / Mục đích
{purpose}

## 決定事項
- {decision}

## ToDo
| # | タスク | 担当者 | 期限 | 優先度 |
|---|--------|--------|------|--------|

## 議事録 (全文)
[{hh:mm}] Speaker N: {normalizedText}
```

---

## 6. Data Storage

All data stored at `%APPDATA%/mtg-assistant/` (Windows) or `~/Library/Application Support/mtg-assistant/` (macOS).

```
mtg-assistant/
├── settings.json          # AppSettings (device IDs, UI lang, whisper hint)
├── vault.json             # API keys (plaintext — local only)
├── app.json               # Session index (SessionMeta[])
└── sessions/
    └── {uuid}/
        ├── audio.pcm      # Raw PCM16 16kHz mono
        ├── transcript.jsonl  # TranscriptSegment[] (one JSON per line)
        ├── normalized.json   # NormalizedSegment[]
        ├── minutes.json      # MeetingMinutes (structured)
        └── export.md         # Markdown export
```

### Key Types

```typescript
type LangCode = 'ja' | 'vi' | 'en' | 'multi' | 'none';
type SessionStatus = 'recording' | 'processing' | 'done' | 'error';

interface TranscriptSegment {
  id: string; sessionId: string; speakerId: string;
  text: string; lang: LangCode; detectedLang?: LangCode;
  startMs: number; endMs: number; translation?: string;
}

interface NormalizedSegment {
  sourceId: string; speakerId: string; detectedLang: LangCode;
  originalText: string; normalizedText: string;
  method: 'rule' | 'llm';
}

interface MeetingMinutes {
  sessionId: string; generatedAt: number; language: LangCode;
  data: {
    purpose: string;
    decisions: string[];
    todos: { task: string; assignee: string|null; deadline: string|null; priority: 'high'|'medium'|'low' }[];
    concerns: string[];
    next_actions: string[];
  };
}

interface AppSettings {
  inputDeviceId: string; outputDeviceId: string;
  transcriptionLanguage: string; uiLang: 'ja' | 'en' | 'vi';
}
```

---

## 7. Renderer Architecture

### Routing

```
/                     → Dashboard      (session list)
/session/setup        → SessionSetup   (new meeting form)
/session/:id/live     → LiveSession    (recording view)
/session/:id          → PostMeeting    (results + minutes)
/settings             → Settings       (API keys + prefs)
```

### State Management (Zustand)

**sessionStore**
```typescript
{ sessions: SessionMeta[], loadSessions(), deleteSession(id) }
```

**captionStore**
```typescript
{
  lines: CaptionLine[],
  onPartial(e): update interim caption for speaker,
  onFinal(e):   replace interim → final, append,
  onTranslation(e): inject into matching final line,
  clear(): reset for new session
}
```

**recordingStore** *(new)*
```typescript
{
  sessionId:   string | null,   // active recording session
  elapsed:     number,          // seconds since start
  hasSysAudio: boolean,         // whether system audio is captured
  setActive(id, sys): void,
  tick(): void,                 // called every 1s by RecordingProvider
  clear(): void,
}
```

### RecordingProvider (`context/RecordingContext.tsx`)

Mounted once at App level, wraps all routes. Owns:
- Single `useAudioCapture()` instance — refs survive route changes
- IPC subscriptions for `stt:partial` / `stt:final` / `translation` — always active
- Elapsed timer via `recordingStore.tick()`

Exposes via React context:
```typescript
{ startRecording(sessionId, deviceId?): Promise<void>, stopRecording(): void }
```

`useLiveIpc` now only subscribes to session lifecycle events (`session:done`, `session:status`, `error`).
Caption events are handled exclusively by RecordingProvider.

### Audio Capture (`useAudioCapture`)

```
getUserMedia({ audio: { echoCancellation: true } })   → Mic
getDisplayMedia({ audio: true, video: false })         → System audio (optional)
    ↓
AudioContext → AudioWorkletNode ('pcm-processor')
    Accumulate 1600 samples (100ms @ 16kHz)
    AGC per 128-sample frame
    Float32Array → Int16Array
    postMessage → main thread
    → ipcRenderer.send('audio:chunk', { seq, pcm })
```

### i18n

```typescript
// Provider wraps entire app
<I18nProvider>
  // Loads uiLang from settings on mount
  // Sets document.documentElement.lang dynamically
  // Provides: { t: Locale, uiLang, setUiLang }
</I18nProvider>

// Usage
const { t } = useT();
t.nav.dashboard   // '会議履歴' | 'Meeting History' | 'Lịch sử Meeting'
t.appName         // '会議アシスタント' | 'Meeting Assistant' | 'Meeting Assistant'
```

### UI Screens

**Dashboard** — Session list with status badges, duration, delete action
**SessionSetup** — Title, input language, translation target, mic selector
**LiveSession** — Real-time captions, speaker colors (5-color palette), elapsed timer
**PostMeeting** — 4 tabs: Overview / Transcript / Minutes / Todos
**Settings** — API key rows (masked + 表示 toggle), UI language, Whisper hint

---

## 8. Theme

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

## 9. Build & Run

```bash
# Development
node scripts/dev.js

# Production build
electron-vite build && electron-builder

# Kill dev instance (Windows)
powershell.exe -Command "Get-Process -Name 'electron' | Stop-Process -Force"
```

### Build Output
```
out/
├── main/index.js       # Electron main (CJS)
├── preload/index.js    # Context bridge
└── renderer/           # Vite built React app
```

---

## 10. File Reference

```
electron/
├── main.ts                        App entry, BrowserWindow
├── preload.ts                     window.api context bridge
├── ipc/
│   ├── session.ipc.ts             Session lifecycle handlers
│   ├── audio.ipc.ts               PCM chunk receiver
│   ├── settings.ipc.ts            Settings + API key CRUD
│   └── export.ipc.ts              Markdown export trigger
├── services/
│   ├── stt.service.ts             Deepgram realtime WebSocket
│   ├── batch-stt.service.ts       Whisper batch transcription
│   ├── lang-detect.service.ts     Unicode heuristic lang detection
│   ├── translation.service.ts     DeepL + GPT translation router
│   ├── normalization.service.ts   Rule + LLM text normalization
│   ├── summarization.service.ts   GPT-4o minutes generation
│   ├── post-meeting.service.ts    Pipeline orchestrator
│   └── export.service.ts          Markdown renderer
├── store/
│   ├── session.store.ts           Session index (app.json)
│   ├── file.store.ts              Per-session file operations
│   └── secret.store.ts            API key vault (vault.json)
└── utils/paths.ts                 userData path helpers

renderer/src/
├── App.tsx                        React Router setup
├── main.tsx                       Entry point
├── screens/
│   ├── Dashboard.tsx
│   ├── SessionSetup.tsx
│   ├── LiveSession.tsx
│   ├── PostMeeting.tsx
│   └── Settings.tsx
├── components/
│   ├── Layout.tsx                 Sidebar + nav
│   ├── SessionCard.tsx            Session list item
│   └── StatusBadge.tsx            Status indicator
├── hooks/
│   ├── useIpc.ts                  IPC event subscriptions
│   └── useAudioCapture.ts         AudioWorklet + AGC
├── store/
│   ├── sessionStore.ts
│   └── captionStore.ts
└── i18n/
    ├── index.tsx                  I18nProvider + useT()
    └── locales.ts                 ja / en / vi string packs

shared/
└── types.ts                       Shared TypeScript interfaces
```
