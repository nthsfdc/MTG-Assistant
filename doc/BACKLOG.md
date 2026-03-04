# MTG Assistant Backlog

Project: MTG Assistant  
Architecture: Electron + React + TypeScript  
Design: v1.4.0-lite (Batch Processing Only)

Purpose:
Track all product improvements without losing discussion context.

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