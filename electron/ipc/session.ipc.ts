import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuidv4 }          from 'uuid';
import { sessionStore }          from '../store/session.store';
import { fileStore }             from '../store/file.store';
import { setActiveSession, setSttSendAudio } from './audio.ipc';
import { detectLang }            from '../services/lang-detect.service';
import type { StartSessionPayload, StartSessionResult, LangCode, TranscriptSegment, NormalizedSegment, SttFinalEvent } from '../../shared/types';

const sessionMeta     = new Map<string, { lang: LangCode; targetLang: LangCode }>();
// In-memory segments per session — flushed to disk at stop (includes translations)
const sessionSegments = new Map<string, TranscriptSegment[]>();

export function registerSessionIpc(win: BrowserWindow): void {

  ipcMain.handle('session:start', async (_, p: StartSessionPayload): Promise<StartSessionResult> => {
    const id = uuidv4();
    sessionStore.create({ id, title: p.title, startedAt: Date.now(), lang: p.lang, targetLang: p.targetLang });
    fileStore.initSession(id);
    setActiveSession(id);
    sessionMeta.set(id, { lang: p.lang, targetLang: p.targetLang });
    sessionSegments.set(id, []);

    try {
      const { SttService }         = await import('../services/stt.service');
      const { translationService } = await import('../services/translation.service');
      const stt = new SttService(win);

      await stt.start(
        id, p.lang,
        undefined, // onSpeechFinal not used — translation driven per-segment below
        (evt: SttFinalEvent) => {
          // ── Step 3: LangDetect ────────────────────────────────────────
          const detectedLang: LangCode =
            evt.lang !== 'multi' && evt.lang !== 'none'
              ? evt.lang
              : detectLang(evt.text, 'ja');

          const seg: TranscriptSegment = {
            id: uuidv4(), sessionId: id, speakerId: evt.speakerId,
            text: evt.text, lang: evt.lang, detectedLang,
            startMs: evt.startMs, endMs: evt.endMs,
          };

          // Store in memory + append to file (translation added later)
          const segs = sessionSegments.get(id) ?? [];
          segs.push(seg);
          sessionSegments.set(id, segs);
          fileStore.appendJsonl(id, 'transcript.jsonl', seg);

          // ── Step 4: TranslationRouter ─────────────────────────────────
          if (p.targetLang === 'none' || detectedLang === p.targetLang) return;

          translationService.translate(
            seg.text, detectedLang, p.targetLang,
            id, seg.speakerId, win,
            (translatedText) => { seg.translation = translatedText; }, // update in-memory
          );
        },
      );

      setSttSendAudio(pcm => stt.sendAudio(pcm));
      (win as unknown as Record<string, unknown>)._stopStt = () => stt.stop();
    } catch (err) {
      console.error('[session:start] STT init failed:', err);
    }

    win.webContents.send('session:status', { sessionId: id, status: 'recording' });
    return { sessionId: id };
  });

  ipcMain.handle('session:stop', async (_, { sessionId }: { sessionId: string }) => {
    const s = sessionStore.get(sessionId);
    if (!s) return;

    setActiveSession(null);
    setSttSendAudio(null);
    const stopFn = (win as unknown as Record<string, unknown>)._stopStt as (() => void) | undefined;
    stopFn?.();

    // Flush segments with translations collected so far
    const segs = sessionSegments.get(sessionId);
    if (segs && segs.length > 0) fileStore.writeJsonl(sessionId, 'transcript.jsonl', segs);
    sessionSegments.delete(sessionId);

    const now = Date.now();
    sessionStore.update(sessionId, { status: 'processing', endedAt: now, durationMs: now - s.startedAt });

    const meta = sessionMeta.get(sessionId);
    import('../services/post-meeting.service').then(({ postMeetingService }) => {
      postMeetingService.run(sessionId, meta?.lang ?? (s.lang as LangCode), win)
        .finally(() => sessionMeta.delete(sessionId));
    });
  });

  ipcMain.handle('session:list',   ()                                      => sessionStore.list());
  ipcMain.handle('session:get',    (_, { sessionId }: { sessionId: string }) => {
    const s = sessionStore.get(sessionId);
    if (!s) return null;
    return {
      ...s,
      segments:   fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl'),
      normalized: fileStore.readJson<NormalizedSegment[]>(sessionId, 'normalized.json'),
      minutes:    fileStore.readJson(sessionId, 'minutes.json'),
    };
  });
  ipcMain.handle('session:delete', (_, { sessionId }: { sessionId: string }) => {
    sessionStore.delete(sessionId);
    fileStore.deleteSession(sessionId);
    sessionSegments.delete(sessionId);
  });
}
