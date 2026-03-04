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

  ipcMain.handle('export:todoMarkdown', async (_, { sessionId }: { sessionId: string }) => {
    const minutes  = fileStore.readJson<MeetingMinutes>(sessionId, 'minutes.json');
    const todos    = minutes?.data?.todos ?? [];
    const lines    = ['# ToDo', ''];
    todos.forEach(t => {
      const owner    = t.assignee ? `担当: ${t.assignee}` : '担当: 未定';
      const deadline = t.deadline ? `　期限: ${t.deadline}` : '';
      lines.push(`- [ ] ${t.task}（${owner}${deadline}）`);
    });
    const filePath = fileStore.writeMd(sessionId, 'todo.md', lines.join('\n'));
    await shell.openPath(filePath);
    return { filePath };
  });
}
