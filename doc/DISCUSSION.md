# MTG Assistant – Design Decisions & Discussion

Project: MTG Assistant
Architecture: Electron + React + TypeScript
Design: v1.4.0-lite (Batch Processing Only)

---

## Decisions

### Batch-Only Architecture
- Realtime STT (Deepgram WebSocket) was removed in v1.4.0-lite pivot.
- All transcription goes through Whisper-1 after recording/import finishes.
- No streaming IPC channels (`stt:partial`, `stt:final`, `translation`) remain.
- This simplifies the pipeline and removes the Deepgram dependency.

### No Realtime Translation
- TranslationService (DeepL + GPT-4o-mini fallback) was removed with realtime STT.
- Translation is not part of the current product scope. Future: P2 if added back.

### Multi-Language Handling in Batch STT
- When the user selects `lang = 'multi'`, Whisper is called without a `language` hint.
- `TranscriptSegment.lang` is set to `'multi'` (not coerced to `'ja'`).
- The downstream `LangDetect` step (`lang-detect.service.ts`) runs on every segment and writes `detectedLang` per segment using CJK heuristics, Vietnamese diacritic detection, and fallback to `'en'`.
- Forcing `'ja'` at the Batch STT layer would bypass LangDetect and produce incorrect normalization grouping.

### Chunk Boundary Dedup — Guard, Not Assumption
- Whisper chunks are created with NO audio overlap (ffmpeg stream-copy, exact cut).
- Genuine duplicate segments at boundaries do not occur in normal Whisper output.
- The dedup guard exists as a defensive check against unusual Whisper behavior at silence/boundary artifacts.
- Guard parameters: similarity threshold ≥ 0.95 (Levenshtein-based), max K = 3 leading segments inspected per chunk.
- Guard MUST NOT drop real content — the K=3 cap prevents over-deletion.

### Chunk Size Strategy (Whisper 25 MiB limit)
- Whisper hard limit: 25 MiB per upload.
- PCM16 16 kHz mono: 32,000 bytes/s.
- Safe chunk duration: `clamp(floor(23MiB / 32000), 60, 900) = 753 s` → max chunk ≈ 22.98 MiB.
- Fallback: if any chunk exceeds 25 MiB (unusual audio format), re-chunk at 300 s (≈ 9.15 MiB).

### SpeakerId Placeholder
- Whisper-1 does not provide speaker diarization.
- All segments use `speakerId: 'speaker_0'` as a static placeholder.
- Future diarization integration would replace this single field.

### Pipeline Checkpoint & Recovery
- `pipeline.json` is written atomically (`.tmp` → rename) after each step completes.
- On app restart, interrupted sessions are detected and resumed from the last completed step.
- `batch_stt` failures are marked as `error_recoverable` → user can retry via UI.

---

### UI Tabs Redesign (2026-03-04)
- Tab order: 要約 / 文字起こし / Todo (3 tabs only)
- 「議事録」 tab removed — it was a duplicate of 文字起こし with no unique value
- 「文字起こし」 shows normalized written text (話し言葉→書き言葉), NOT raw Whisper output
- Timestamps included in 文字起こし: `[mm:ss]` per paragraph (group by consecutive same-speaker segments); `[hh:mm:ss]` when total duration >= 1h
- Raw transcript (`transcript.jsonl` / `detail.segments`) stays internal — used for summarization and timestamp lookup only, not rendered in UI

---

## Open Questions

*(none currently — add here when a decision is deferred or contested)*

---

## Next Actions

- BL-001: WAV empty file validation — **Done** (throw before Whisper call if size = 0)
- BL-002: Preserve 'multi' lang in segment output — **Done** (no 'multi'→'ja' coercion)
- BL-003: Robust multi-segment boundary dedup — **Done** (loop K=3, break on non-duplicate)
- BL-004: Unit tests for above three — **Done** (`tests/unit/batch-stt-boundary.test.ts`)
- BL-005: Stable error codes for Batch STT — Todo (P1)
- BL-006: p-limit concurrency guard — Todo (P2, defer)
- BL-007: SpeakerId comment consistency — Todo (P2, defer)
