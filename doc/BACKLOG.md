# MTG Assistant Backlog

Project: MTG Assistant
Architecture: Electron + React + TypeScript
Design: v1.4.0-lite (Batch Processing Only)

Purpose:
Track all product improvements without losing discussion context.

---

# UI/UX Polish v1.2

Scoped to renderer UI components only. No pipeline logic changes.

---

## UI-001 — Hide pipeline progress for completed sessions

Priority: P0
Status: Done ✅
Files: `renderer/src/screens/PostMeeting.tsx`

Description
When user opens a session where `status === 'done'`, the pipeline progress panel is hidden by default. A toggle "処理ログ ▼" lets the user expand it on demand. Auto-collapses on status change to `done`.

Done Criteria
- Pipeline panel hidden by default when status=done.
- "処理ログ" toggle button visible, expands/collapses panel.
- Pipeline visible immediately when status=processing or error.

---

## UI-002 — Thin overall progress bar in header

Priority: P0
Status: Done ✅
Files: `renderer/src/screens/PostMeeting.tsx`

Description
A 2px accent-colored bar runs across the full width below the page header, visible only while `status === 'processing'`. Shows overall pipeline percent.

Done Criteria
- Thin progress bar visible only during processing.
- Animates smoothly with `transition-all`.
- Disappears when done/error.

---

## UI-003 — Compact horizontal stepper in PipelineProgress

Priority: P0
Status: Done ✅
Files: `renderer/src/components/PipelineProgress.tsx`

Description
Replace the verbose vertical step list with a compact inline stepper. Steps shown left-to-right separated by `→`. Icons: ✔ done / ▶ running / ○ pending / ✖ error. Short labels: audio → STT → lang → norm → AI → export.

Done Criteria
- Steps rendered horizontally in one row.
- Icons match: ✔/▶/○/✖.
- Retry button inline with error step.
- Resume button below stepper when error_recoverable.
- No redundant progress bar inside PipelineProgress (moved to header).

---

## UI-004 — Tabs layout

Priority: P0
Status: Done
Files: `renderer/src/screens/PostMeeting.tsx`, `renderer/src/i18n/locales.ts`

Description
Tabs are: 要約 / 文字起こし / Todo. Spacing and readability improved.

---

## UI-005 — Transcript layout

Priority: P0
Status: Done
Files: `renderer/src/screens/PostMeeting.tsx`

Description
Paragraph grouping, [mm:ss] timestamps, max-w-3xl container. Implemented in previous iteration.

---

## UI-006 — Tailwind layout polish

Priority: P1
Status: Done ✅
Files: `renderer/src/screens/PostMeeting.tsx`

Description
Overview tab uses max-w-2xl. Todos tab uses max-w-3xl. Rounded cards for section blocks in overview.
文字起こし tab uses w-full (fullwidth) to maximise reading area.

Done Criteria
- Content areas have consistent max-width.
- Overview sections have rounded card styling.
- 文字起こし tab fills full available width.

---

## UI-009 — Fix false 。 insertion before conjunctive particles (ますが/ますので/でしたり etc.)

Priority: P1
Status: Done ✅
Date: 2026-03-04 (updated 2026-03-05)
Files: `renderer/src/screens/PostMeeting.tsx`

Problem
`JA_PREDICATES` regex inserts `。\n` after predicate endings (ます/です/etc.) even when followed by particles that continue the sentence:
- `ますが` → was becoming `ます。\nが...`
- `ますので` → was becoming `ます。\nので...`
- `ですが` / `ですので` / `ですけど` / `ですから` etc.
- `でしたり` → was becoming `でした。\nり...` (〜たり conjunction form)

Fix
Extend negative lookahead of `JA_PREDICATES` to exclude conjunctive particles:
```
(?![。\n、]|が|ので|のに|けど|けれど|から|し[、。\s]|り)
```
- `が` — 逆接 (but/however)
- `ので` / `のに` — 理由・逆説 (because / although)
- `けど` / `けれど` — 逆接 (but)
- `から` — 理由 (because/from)
- `し[、。\s]` — 列挙 (listing, e.g. ますし、)
- `り` — 〜たり conjunction (e.g. でしたり、しましたり)

Done Criteria
- `ますが`、`ますので`、`ですが`、`ですので`、`ですけど`、`ますから`、`ますし` do NOT get `。` inserted.
- `でしたり`、`しましたり` do NOT get `。` inserted.
- Standalone predicate endings (not followed by conjunctives) still get `。` inserted correctly.

---

## UI-010 — JA sentence boundary: cross-segment fix + compound predicate patterns

Priority: P1
Status: Done ✅
Date: 2026-03-05
Files: `renderer/src/screens/PostMeeting.tsx`

Problem 1 — Cross-segment false break
`normalizeJapanesePunctuation` was called per-segment BEFORE joining. When segment N ended with a predicate (e.g. `できます`), the regex immediately added `。\n` and flushed the paragraph. Segment N+1 starting with `ので` / `と` / etc. appeared as a separate timestamp block.

Example:
```
[01:30] ブラウザからアクセスできます。    ← false break
[01:30] ので電子メールと…                ← should be same sentence
```

Fix 1
Restructure `buildTranscriptParagraphs`:
- Join raw segment text FIRST, then call `normalizeJapanesePunctuation` on the combined text.
- Introduce `JA_PREDICATES_MID` (with `(?=[\s\S])`) — skips predicates at end-of-string so the decision is deferred until the next segment joins.
- Introduce `JA_PREDICATES_FINAL` (no end-of-string guard) — used at final flush to terminate trailing predicates.
- `pendingRaw` carries the raw incomplete fragment across segment boundaries.

Problem 2 — Wrong 。 placement inside compounds
Simple predicate `ます`/`です` matched before the full compound, splitting mid-expression:
- `ますね` → `ます。\nね` (should be `ますね。\n`)
- `ますか` → `ます。\nか` (should be `ますか。\n`)
- `でしょうか` — not detected at all

Fix 2
Redesign `_JA_PRED_ALT` as an ordered array (longest compound first):
- Compound / keigo endings: `ませんでした`, `ていました`, `ております`, `かもしれません`, `必要があります`, `問題ありません`, `いかがでしょうか`, `でしょうか`, `ということです`, `と思います`, `お願いします`, `ございます`, `いたします`, `いただきます`, `てください`, `しましょう` など
- predicate+ね/よ/か as units: `ますよね`, `ましたね`, `ますね`, `ますよ`, `ますか`, `ですね`, `ですよ`, `ですか`, `でしょうか` etc. — must precede bare `ます`/`です`
- Simple endings last: `ました`, `でした`, `ません`, `します`, `できます`, `です`, `ます`, `ください`

Key insight: suffix-based matching means `ますね` catches ALL verb stems automatically
(`ありますね`, `できますね`, `なりますね` etc.) without enumerating each verb.

Done Criteria
- `できますので電子メールと…` renders as ONE sentence (not split across two timestamp blocks).
- `ですね`/`ますね`/`ますよ`/`ますか`/`でしょうか` each get `。\n` after the FULL expression.
- `ますと`/`まして`/`ますても`/`ますたら`/`ますながら` do NOT get `。` inserted.
- Final segment ending with bare predicate still gets `。` at flush time.

---

## UI-008 — Fix 文字起こし timestamps: cross-segment sentence joining

Priority: P0
Status: Done ✅
Date: 2026-03-04
Files: `renderer/src/screens/PostMeeting.tsx`

Problem
Timestamp `[mm:ss]` chỉ hiển thị ở đoạn đầu tiên vì `mergeConsecutive` gộp toàn bộ segment `speaker_0` thành 1 block duy nhất. Các đoạn sau (do `groupParagraphs` tạo ra) không có timestamp.

Thêm vào đó, câu bị cắt ngang giữa 2 segment (Whisper cut mid-sentence) khiến transcript hiển thị không tự nhiên.

Fix (`buildTranscriptParagraphs`)
- Xử lý từng `NormalizedSegment`, normalize text.
- Nếu đoạn cuối của segment chưa kết thúc bằng dấu câu terminal (`。！？!?`), tích lũy vào `pendingText` và join với segment tiếp theo.
- Timestamp của đoạn join = `startMs` của segment **đầu tiên** đóng góp vào câu đó.
- Các câu hoàn chỉnh được flush với timestamp chính xác; phần dư mang sang segment kế.

Done Criteria
- Mỗi đoạn văn hiển thị timestamp `[mm:ss]` đúng với vị trí audio.
- Câu bị Whisper cắt ngang được nối tự nhiên (không xuống dòng giữa câu).
- Timestamp = startMs của segment mà câu bắt đầu từ đó.
- EN/VI segments không bị ảnh hưởng.

---

## UI-007 — 文字起こし tab fullwidth layout

Priority: P1
Status: Done ✅
Date: 2026-03-04
Files: `renderer/src/screens/PostMeeting.tsx`

Description
Remove `max-w-3xl` width cap on the 文字起こし (transcript) tab so the text fills the full panel width.
Useful when the app window is large or when the transcript contains long lines.

Done Criteria
- 文字起こし container uses `w-full` instead of `max-w-3xl`.
- No other layout changes.

---

# Batch STT Reliability (BL series)

Scoped to `batch-stt.service.ts` and the Whisper upload pipeline.
See `doc/DISCUSSION.md` for design decisions behind these items.

---

## BL-001 — Validate WAV file size = 0 before calling Whisper

Priority: P0
Status: Done
Files: `electron/services/batch-stt.service.ts`

Problem
Calling Whisper with an empty WAV file results in an opaque API error.

Done Criteria
- If `fs.statSync(wavPath).size === 0`, throw a typed error with human-readable message before any Whisper request.
- Pipeline surfaces the error at `batch_stt` step as recoverable.
- Logs must NOT include audio content or API key.

---

## BL-002 — Do NOT coerce segment.lang from 'multi' to 'ja'

Priority: P0
Status: Done
Files: `electron/services/batch-stt.service.ts`

Problem
`transcribeSingle()` forced `segment.lang = 'ja'` when user hint is `'multi'`, preventing the downstream `LangDetect` step from running correctly.

Done Criteria
- `TranscriptSegment.lang` is set to the user-hint lang directly (no 'multi'→'ja' coercion).
- When lang is `'multi'`, segment.lang is `'multi'`, not `'ja'`.
- `LangDetect` step still runs and overwrites `detectedLang` per segment.

---

## BL-003 — Robust boundary dedup: handle multiple short duplicate segments

Priority: P0
Status: Done
Files: `electron/services/batch-stt.service.ts`

Problem
Old dedup only called `segs.shift()` once. If Whisper emitted 2–3 near-duplicate segments at a chunk boundary, only the first was dropped.

Done Criteria
- Loop drops ALL leading duplicate segments in new chunk (up to K=3).
- Each iteration compares last kept segment text vs candidate text (normalized).
- Loop breaks immediately when similarity < threshold or K exceeded.
- Logs dropped count per boundary.
- Does NOT drop real content beyond K guard.

---

## BL-004 — Unit tests: wav 0 bytes, multi lang, multi-segment dedup

Priority: P1
Status: Done
Files: `tests/unit/batch-stt-boundary.test.ts`

Done Criteria
- Test: WAV 0 bytes → clear error message thrown (no API call).
- Test: `lang='multi'` → segment.lang stays `'multi'` (no 'ja' coercion).
- Test: 3 consecutive near-duplicate leading segments → all 3 dropped, real 4th kept.
- Test: non-duplicate first segment → nothing dropped.

---

## BL-010 — Remove 議事録 tab; keep 要約 / 文字起こし / Todo

Priority: P0
Status: Done
Files: `renderer/src/screens/PostMeeting.tsx`, `renderer/src/i18n/locales.ts`

Done Criteria
- 議事録 tab is not shown in the UI.
- Tabs are exactly: 要約 / 文字起こし / Todo (and their i18n equivalents for en/vi).
- `minutes` key removed from Locale.tabs interface.

---

## BL-011 — Implement 文字起こし as normalized written text with timestamps

Priority: P0
Status: Done
Files: `renderer/src/screens/PostMeeting.tsx`

Description
- 文字起こし displays normalized text (話し言葉→書き言葉), not raw Whisper output.
- Timestamps derived from `TranscriptSegment.startMs` via `sourceId` join.
- Format: `[mm:ss]` for total < 1h; `[hh:mm:ss]` when >= 1h.
- Granularity: paragraph (consecutive same-speaker segments grouped, timestamp at paragraph start).

Done Criteria
- 文字起こし is readable written-style text with `[mm:ss]` timestamp prefix per paragraph.
- Raw transcript is NOT rendered anywhere in the UI.

---

## BL-013 — Fix incorrect「。」punctuation in Japanese transcript

Priority: P1 (High)
Status: Done ✅
Date: 2026-03-04
Files: `renderer/src/screens/PostMeeting.tsx`
Estimate: ~0.5 day

Problem
Whisper STT output for Japanese speech often produces incorrect「。」mid-sentence:
- Duplicate periods: "。。" or "。 。"
- Wrong period before connectors: "。こちら", "。そして", "。また", "。そのため", "。続いて", "。さらに"
- Missing sentence breaks after predicate endings not followed by 。

Fix
Added `normalizeJapanesePunctuation(text)` applied after `normalizePunctuation()`, only for `detectedLang === 'ja'` blocks in the transcript paragraph builder:
- Rule a) Collapse repeated 。: `"。。+" → "。"`
- Rule b) Remove incorrect 。 before connectors: `"。こちら" → " こちら"`
- Rule c) Insert sentence break after predicate endings (です/ます/ました/でした/ください/します/できます/となります/になります/可能です) not already followed by 。 or newline

Acceptance Criteria
- No "、。" or "。。" in displayed transcript.
- Fewer mid-sentence 。 before connectors (こちら/そして/また/そのため/続いて/さらに).
- Sentence breaks added after predicate endings.
- No change to Whisper/STT chunking or pipeline behavior.
- EN/VI segments unaffected.

---

## UI-011 — Fix JA transcript: merge paragraphs starting with continuation pattern かと

Priority: P1
Status: Done ✅
Date: 2026-03-05
Files: `renderer/src/screens/PostMeeting.tsx`

Problem
Whisper sometimes inserts `。` mid-utterance causing a segment like `かと思います` to appear as a separate paragraph even though it continues the previous sentence (e.g. `…できると思います`).

Fix
After `buildTranscriptParagraphs`, retroactively merge any paragraph whose first sentence starts with `かと` into the preceding paragraph — strip the trailing `。` from the previous last sentence and concatenate.

Done Criteria
- `かと思います` / `かと考えています` etc. do not start a new timestamp block.
- No change to EN/VI paragraphs.

---

## BL-012 — Improve normalization rules and GPT rewrite prompt (optional)

Priority: P1
Status: Todo
Files: `electron/services/normalization.service.ts`

Done Criteria
- Phase 1 filler rules reviewed and expanded per feedback from real meetings.
- GPT-4o-mini prompt refined to better handle mixed Japanese/English sentences.

---

## BL-005 — Stable error codes + safe error messages for Batch STT failures

Priority: P1
Status: Todo
Files: `electron/services/batch-stt.service.ts`, `electron/ipc/session.ipc.ts`

Done Criteria
- Define typed error codes: `STT_EMPTY_WAV`, `STT_CHUNK_MISSING`, `STT_API_413`, `STT_API_401`, etc.
- Error messages shown to user are human-readable and contain no secrets or file contents.
- Log includes error code and sessionId only (no transcript text, no API key).

---

## BL-006 — Optional: p-limit concurrency guard for Whisper chunk uploads

Priority: P2
Status: Todo
Files: `electron/services/batch-stt.service.ts`

Done Criteria
- Chunks currently uploaded sequentially; this is safe but slow for 5+ chunks.
- If concurrency is added, use `p-limit(2)` to avoid HTTP 429.
- Must still respect chunk ordering for offset calculation.
- Only implement if chunk count is a real UX pain point (>3 chunks).

---

## BL-007 — SpeakerId fallback naming consistency

Priority: P2
Status: Todo
Files: `electron/services/batch-stt.service.ts`

Done Criteria
- All segments use `speakerId: 'speaker_0'` as placeholder (no diarization).
- Add code comment: `// Whisper-1 does not provide diarization; speakerId is a placeholder`.
- Future: when diarization is added, this is the single touch point.

---

# P0 – Must Have (Before Beta Release)

These features must be implemented before testing with real users.

---

## 1. Actionable Todo UX

Status: Done ✅
Date: 2026-03-05
Files: `renderer/src/screens/PostMeeting.tsx`, `electron/ipc/export.ipc.ts`

- Checklist items with checkboxes, priority badges, assignee/deadline columns
- Copy button (plain text format) + Export Markdown button
- `source_time` shown below each task (`└ 01:12`)

---

## 2. Meeting Search

Status: Done ✅
Date: 2026-03-05
Files: `renderer/src/screens/Dashboard.tsx`, `electron/services/search-index.service.ts`, `electron/ipc/search.ipc.ts`

- Search input on Dashboard filters sessions by title + full-text index
- `search_index.json` built after pipeline completes (title + purpose + decisions + todos + transcript)
- Falls back to title-only for sessions without index (legacy)

---

## 3. Summary Evidence (Timestamp Source)

Status: Done ✅
Date: 2026-03-05
Files: `electron/services/post-meeting.service.ts`, `renderer/src/screens/PostMeeting.tsx`

- `matchTimestamp()` attaches `source_time` to each decision and todo (word-overlap ≥30% against transcript segments)
- Displayed as `└ 00:42` in 要約 tab (decisions) and Todo tab

---

## 4. Processing Progress Indicator

Status: Done ✅
Files: `renderer/src/screens/PostMeeting.tsx`, `renderer/src/components/PipelineProgress.tsx`

- UI-001: Collapsible pipeline log panel (auto-collapse when done)
- UI-002: Thin 2px accent progress bar in header (visible during processing)
- UI-003: Compact horizontal stepper with icons ✔/▶/○/✖

---

## 5. Fix Whisper 413 — Size-Aware Chunking ✅

Problem
`chunkWav()` used a fixed 900 s chunk window. For PCM16 16 kHz mono (32,000 B/s), a 900 s chunk is 28.8 MiB — exceeding Whisper's 25 MiB hard limit, causing HTTP 413.

Root Cause
`BatchSttService` did not pass a computed `chunkSec` to `mediaService.chunkWav()`, relying on the default of 900 s.

Fix Applied
- `SAFE_UPLOAD_BYTES = 23 MiB`; `chunkSec = clamp(floor(23*1024*1024 / 32_000), 60, 900) = 753 s`
- Each chunk ≤ 22.98 MiB (safely under Whisper limit)
- Pre-upload validation: WAV size = 0 → throw; each chunk must exist and size > 0
- Fallback: if any chunk still > 25 MiB → re-chunk at 300 s
- Logging: `wavSizeBytes`, `chunkSec`, `numberOfChunks`, `perChunkEstimateBytes`

Status: **Implemented**

---

# P1 – Should Have (After Beta)

These features improve usability but are not required for first release.

---

## 5. Meeting Insights

Provide analytics about meetings.

Examples

Top discussed topics

AWS  
RDS  
Salesforce

Frequent action owners

佐藤  
田中

Implementation

Use simple word frequency.

Data source

summary  
todo  
transcript

Store analytics

userData/insights.json

---

## 6. Transcript Readability

Status: Done ✅
Date: 2026-03-05

- Timestamps `[mm:ss]` per paragraph (UI-008)
- Cross-segment sentence joining (UI-010)
- Full-width layout (UI-007)
- Japanese punctuation normalization (BL-013, UI-009, UI-011)

---

# P2 – Future Features

These are possible product expansion features.

---

## Speaker Detection

Example

佐藤  
AWSの件ですが

田中  
RDS連携確認します

---

## Translation Mode

Future phase feature.

Languages

JP → VN  
VN → JP

Use cases

Japanese company meetings  
Vietnam development team communication

---

# Development Rules

- Keep architecture aligned with DESIGN.md
- Avoid adding extra AI calls unless necessary
- Maintain local-first processing
- Protect API keys (main process only)

---

# How to Work With Claude Code

Example prompt

Implement P0 tasks in BACKLOG.md.

Requirements

- small commits
- do not break pipeline
- run TypeScript typecheck
- keep UI consistent with current design.