import fs                         from 'fs';
import { ipcMain, BrowserWindow } from 'electron';
import { v4 as uuidv4 }          from 'uuid';
import path                       from 'path';
import { sessionStore }           from '../store/session.store';
import { fileStore }              from '../store/file.store';
import { diskMonitor }            from '../utils/disk-monitor';
import { setActiveSession }       from './audio.ipc';
import { getSettings }            from './settings.ipc';
import { logger }                 from '../utils/logger';
import type {
  StartSessionPayload, StartSessionResult, ImportPayload,
  LangCode, InputType, PipelineStep,
  TranscriptSegment, NormalizedSegment,
} from '../../shared/types';

export function registerSessionIpc(win: BrowserWindow): void {

  // ── Recording session start ──────────────────────────────────────────────
  ipcMain.handle('session:start', async (_, p: StartSessionPayload): Promise<StartSessionResult> => {
    const id = uuidv4();
    sessionStore.create({ id, title: p.title, startedAt: Date.now(), lang: p.lang, inputType: 'recording' });
    fileStore.initSession(id);
    setActiveSession(id);
    win.webContents.send('session:status', { sessionId: id, status: 'recording' });
    logger.info('[Session] recording started', { sessionId: id });
    return { sessionId: id };
  });

  // ── Recording session stop → trigger pipeline ────────────────────────────
  ipcMain.handle('session:stop', async (_, { sessionId }: { sessionId: string }) => {
    const s = sessionStore.get(sessionId);
    if (!s) return;
    setActiveSession(null);
    const now = Date.now();
    sessionStore.update(sessionId, { status: 'processing', endedAt: now, durationMs: now - s.startedAt });
    logger.info('[Session] recording stopped, starting pipeline', { sessionId });
    import('../services/post-meeting.service').then(({ postMeetingService }) => {
      postMeetingService.run(sessionId, s.lang as LangCode, 'recording', win);
    });
  });

  // ── Import session: probe → create → pipeline ────────────────────────────
  ipcMain.handle('session:import', async (_, payload: ImportPayload): Promise<StartSessionResult> => {
    if (!(await diskMonitor.canImport())) {
      throw new Error('Insufficient disk space (<500 MB). Free up space before importing.');
    }

    const id       = uuidv4();
    const fileName = path.basename(payload.filePath);
    sessionStore.create({
      id, title: payload.title, startedAt: Date.now(), lang: payload.lang,
      inputType: 'import', sourceFileName: fileName, sourceFilePath: payload.filePath,
    });
    fileStore.initSession(id);

    const settings = getSettings();
    if (settings.archiveSource) {
      const ext = path.extname(payload.filePath);
      fs.copyFileSync(payload.filePath, fileStore.sessionFile(id, `source${ext}`));
    }

    sessionStore.update(id, { status: 'processing' });
    logger.info('[Session] import started', { sessionId: id, file: fileName });

    import('../services/post-meeting.service').then(({ postMeetingService }) => {
      postMeetingService.run(id, payload.lang as LangCode, 'import', win, undefined, payload.filePath);
    });

    return { sessionId: id };
  });

  // ── Retry a specific pipeline step ──────────────────────────────────────
  ipcMain.handle('session:retryStep', async (_, { sessionId, step }: { sessionId: string; step: PipelineStep }) => {
    const s = sessionStore.get(sessionId);
    if (!s) throw new Error('Session not found');
    sessionStore.update(sessionId, { status: 'processing', errorMsg: null });
    logger.info('[Session] retrying step', { sessionId, step });
    import('../services/post-meeting.service').then(({ postMeetingService }) => {
      postMeetingService.run(sessionId, s.lang as LangCode, s.inputType as InputType, win, step, s.sourceFilePath);
    });
  });

  // ── Resume pipeline from checkpoint ─────────────────────────────────────
  ipcMain.handle('session:resumePipeline', async (_, { sessionId }: { sessionId: string }) => {
    const s = sessionStore.get(sessionId);
    if (!s) throw new Error('Session not found');
    sessionStore.update(sessionId, { status: 'processing', errorMsg: null });
    logger.info('[Session] resuming pipeline from checkpoint', { sessionId });
    import('../services/post-meeting.service').then(({ postMeetingService }) => {
      postMeetingService.run(sessionId, s.lang as LangCode, s.inputType as InputType, win, undefined, s.sourceFilePath);
    });
  });

  // ── Read-only handlers ───────────────────────────────────────────────────
  ipcMain.handle('session:list', () => sessionStore.list());

  ipcMain.handle('session:get', (_, { sessionId }: { sessionId: string }) => {
    const s = sessionStore.get(sessionId);
    if (!s) return null;
    return {
      id: s.id, title: s.title, status: s.status, inputType: s.inputType,
      startedAt: s.startedAt, endedAt: s.endedAt, lang: s.lang,
      durationMs: s.durationMs, sourceFileName: s.sourceFileName,
      errorMsg: s.errorMsg,
      segments:   fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl'),
      normalized: fileStore.readJson<NormalizedSegment[]>(sessionId, 'normalized.json'),
      minutes:    fileStore.readJson(sessionId, 'minutes.json'),
      pipeline:   fileStore.readPipeline(sessionId),
    };
  });

  ipcMain.handle('session:delete', (_, { sessionId }: { sessionId: string }) => {
    sessionStore.delete(sessionId);
    fileStore.deleteSession(sessionId);
    logger.info('[Session] deleted', { sessionId });
  });
}
