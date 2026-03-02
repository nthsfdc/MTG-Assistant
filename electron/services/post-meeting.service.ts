import { BrowserWindow } from 'electron';
import { sessionStore } from '../store/session.store';
import { fileStore }    from '../store/file.store';
import type { LangCode, TranscriptSegment } from '../../shared/types';

class PostMeetingService {
  async run(sessionId: string, lang: LangCode, win: BrowserWindow): Promise<void> {
    const notify = (detail: string) => {
      if (!win.isDestroyed()) win.webContents.send('session:status', { sessionId, status: 'processing', detail });
    };

    try {
      const { batchSttService }      = await import('./batch-stt.service');
      const { langDetectService }    = await import('./lang-detect.service');
      const { normalizationService } = await import('./normalization.service');
      const { summarizationService } = await import('./summarization.service');
      const { exportService }        = await import('./export.service');

      // ── Step 1: Get recording ────────────────────────────────────────────────
      const audioPath = fileStore.getAudioPath(sessionId);

      // ── Step 2: Batch STT (high-quality) ────────────────────────────────────
      notify('batch_stt');
      let segments: TranscriptSegment[];
      try {
        segments = await batchSttService.transcribe(audioPath, lang, sessionId);
        fileStore.writeJsonl(sessionId, 'transcript.jsonl', segments);
      } catch (err) {
        console.warn('[PostMeeting] batch STT failed, using realtime log:', err);
        segments = fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl');
      }

      // ── Step 3: LangDetect per segment ──────────────────────────────────────
      notify('lang_detect');
      const segmentsWithLang = langDetectService.detectAll(segments);
      // Persist detectedLang back so PostMeeting UI can use it
      fileStore.writeJsonl(sessionId, 'transcript.jsonl', segmentsWithLang);

      // ── Step 4: Spoken → Written normalization (language-aware) ─────────────
      notify('normalizing');
      const normalized = await normalizationService.normalize(segmentsWithLang);
      fileStore.writeJson(sessionId, 'normalized.json', normalized);

      // ── Step 5: Summarize → JSON structured ─────────────────────────────────
      notify('summarizing');
      const session = sessionStore.get(sessionId);
      const minutes = await summarizationService.summarize(normalized, sessionId, (session?.lang as LangCode) ?? lang);
      fileStore.writeJson(sessionId, 'minutes.json', minutes);

      // ── Step 6: Render Markdown from JSON (code, not LLM) ───────────────────
      notify('exporting');
      const content = exportService.toMarkdown({
        title: session?.title ?? 'Meeting', startedAt: session?.startedAt ?? Date.now(),
        durationMs: session?.durationMs ?? null, minutes, segments: segmentsWithLang,
      });
      const exportPath = fileStore.writeMd(sessionId, 'export.md', content);

      // ── Step 7: Save output ─────────────────────────────────────────────────
      sessionStore.update(sessionId, { status: 'done' });
      if (!win.isDestroyed()) win.webContents.send('session:done', { sessionId, exportPath });

    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[PostMeeting] error:', msg);
      sessionStore.update(sessionId, { status: 'error', errorMsg: msg });
      if (!win.isDestroyed()) win.webContents.send('error', { code: 'POST_MEETING_FAILED', message: msg, sessionId });
    }
  }
}

export const postMeetingService = new PostMeetingService();
