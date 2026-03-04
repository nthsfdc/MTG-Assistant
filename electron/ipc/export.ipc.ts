import { ipcMain, shell } from 'electron';
import { fileStore }    from '../store/file.store';
import { sessionStore } from '../store/session.store';
import type { MeetingMinutes, TranscriptSegment } from '../../shared/types';

export function registerExportIpc(): void {
  ipcMain.handle('export:markdown', async (_, { sessionId }: { sessionId: string }) => {
    const { exportService } = await import('../services/export.service');
    const session  = sessionStore.get(sessionId);
    const minutes  = fileStore.readJson<MeetingMinutes>(sessionId, 'minutes.json');
    const segments = fileStore.readJsonl<TranscriptSegment>(sessionId, 'transcript.jsonl');
    const content  = exportService.toMarkdown({
      title:      session?.title     ?? 'Meeting',
      startedAt:  session?.startedAt ?? Date.now(),
      durationMs: session?.durationMs ?? null,
      minutes,
      segments,
    });
    const filePath = fileStore.writeMd(sessionId, 'export.md', content);
    await shell.openPath(filePath);
    return { filePath };
  });

  ipcMain.handle('media:probe', async (_, { filePath }: { filePath: string }) => {
    const { mediaService } = await import('../services/media.service');
    return mediaService.probe(filePath);
  });
}
