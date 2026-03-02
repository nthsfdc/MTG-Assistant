import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuidv4 }          from 'uuid';
import { sessionStore }          from '../store/session.store';
import { fileStore }             from '../store/file.store';
import { setActiveSession, setSttSendAudio } from './audio.ipc';
import type { StartSessionPayload, StartSessionResult, LangCode, TranscriptSegment, SttFinalEvent } from '../../shared/types';

const sessionMeta = new Map<string, { lang: LangCode }>();

export function registerSessionIpc(win: BrowserWindow): void {

  ipcMain.handle('session:start', async (_, p: StartSessionPayload): Promise<StartSessionResult> => {
    const id = uuidv4();
    sessionStore.create({ id, title: p.title, startedAt: Date.now(), lang: p.lang, targetLang: p.targetLang });
    fileStore.initSession(id);
    setActiveSession(id);
    sessionMeta.set(id, { lang: p.lang });

    // Lazy-import services to avoid startup cost
    try {
      const { SttService }        = await import('../services/stt.service');
      const { translationService } = await import('../services/translation.service');
      const stt = new SttService(win);
      const onTranslate = p.targetLang !== 'none'
        ? (speakerId: string, text: string) => translationService.translate(text, id, speakerId, win)
        : undefined;
      await stt.start(
        id, p.lang,
        onTranslate,
        (evt: SttFinalEvent) => {
          const seg: TranscriptSegment = { id: uuidv4(), sessionId: id, speakerId: evt.speakerId, text: evt.text, lang: evt.lang, startMs: evt.startMs, endMs: evt.endMs };
          fileStore.appendJsonl(id, 'transcript.jsonl', seg);
        },
      );
      setSttSendAudio(pcm => stt.sendAudio(pcm));
      // Store stop fn so session:stop can call it
      (win as unknown as Record<string, unknown>)._stopStt = () => stt.stop();
    } catch (err) {
      console.error('[session:start] STT init failed (no API key?):', err);
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
    return { ...s, minutes: fileStore.readJson(sessionId, 'minutes.json'), segments: fileStore.readJsonl(sessionId, 'transcript.jsonl') };
  });
  ipcMain.handle('session:delete', (_, { sessionId }: { sessionId: string }) => {
    sessionStore.delete(sessionId);
    fileStore.deleteSession(sessionId);
  });
}
