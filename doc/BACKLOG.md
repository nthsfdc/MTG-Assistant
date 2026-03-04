# MTG Assistant Backlog

Project: MTG Assistant
Architecture: Electron + React + TypeScript
Design: v1.4.0-lite (Batch Processing Only)

Purpose:
Track all product improvements without losing discussion context.

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

Problem  
Current Todo output is plain text and difficult to reuse in other tools.

Goal  
Allow users to easily copy or export todos.

Features

- Render todos as checklist items
- Display optional fields:
  - Owner
  - Due date
- Add buttons:
  - Copy Todo
  - Export Todo Markdown

Example UI

☐ HALST SQUAREでデータ連携処理を実行  
担当: 佐藤  
期限: 未定

Buttons

[Copy] [Export]

Copy Output Format

■ ToDo  
・HALST SQUAREでデータ連携処理を実行（担当: 佐藤）

Export File

sessions/{sessionId}/todo.md

---

## 2. Meeting Search

Problem  
Users cannot find past meetings easily when sessions increase.

Goal  
Enable fast search across meeting data.

Search Scope

- meeting title
- summary
- todo
- transcript

Implementation

Create search index file

sessions/{id}/search_index.json

Example

{
  "text": "AWS RDS 連携 デモ Salesforce API ..."
}

Search UI

Search input on dashboard.

Example

Search meeting...

Result

AWS RDS連携デモ  
Salesforce API検討MTG

---

## 3. Summary Evidence (Timestamp Source)

Problem  
Users cannot verify if AI summary is accurate.

Goal  
Attach transcript timestamp to each summary item.

Example

決定事項  
✓ 社員名を半角に変換する  
└ 00:42

Todo  
☐ HALST SQUAREで連携確認  
└ 01:12

Implementation

Use transcript.jsonl

Example segment

{
 "text": "社員名を半角に変換する必要があります",
 "startMs": 42000
}

Convert

42000 → 00:42

Add field in minutes.json

{
  "decisions": [
    {
      "text": "社員名を半角に変換する",
      "source_time": "00:42"
    }
  ]
}

Optional UI

Click timestamp → jump to transcript.

---

## 4. Processing Progress Indicator

Problem  
Users cannot tell if the processing pipeline is progressing.

Goal  
Display clear pipeline progress.

Example UI

Processing meeting...

████████░░░░░░░░░░
60% completed

Step 3 / 5

Pipeline Steps

1 prepare_audio  
2 batch_stt  
3 normalize  
4 summarize  
5 export

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

Improve transcript viewer.

Enhancements

- show timestamps
- monospaced font
- better spacing

Example

[00:02]  
こんにちは

[00:05]  
本日はAWS RDS連携について説明します

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