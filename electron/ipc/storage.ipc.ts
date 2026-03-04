import fs from 'fs';
import { ipcMain } from 'electron';
import { getStorageRoot, setStorageRoot, paths } from '../utils/paths';
import { fileStore } from '../store/file.store';
import { sessionStore } from '../store/session.store';
import { autoCleanupService } from '../services/auto-cleanup.service';
import { getSettings } from './settings.ipc';
import type { StorageStats } from '../../shared/types';

function getFreeBytes(): Promise<number> {
  return new Promise((resolve) => {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (fs as any).statfs(getStorageRoot(), (err: Error | null, stats: { bfree: number; bsize: number }) => {
        if (err) resolve(Infinity); else resolve(stats.bfree * stats.bsize);
      });
    } catch { resolve(Infinity); }
  });
}

export function registerStorageIpc(): void {
  ipcMain.handle('storage:getStats', async (): Promise<StorageStats> => {
    const sessions   = sessionStore.list();
    const totalBytes = sessions.reduce((sum, s) => sum + fileStore.sessionBytes(s.id), 0);
    const freeBytes  = await getFreeBytes();
    return { sessionCount: sessions.length, totalBytes, freeBytes, storageRoot: getStorageRoot() };
  });

  ipcMain.handle('storage:setRoot', (_evt, { rootPath }: { rootPath: string }) => {
    setStorageRoot(rootPath);
    const cur     = getSettings();
    const updated = { ...cur, storageRootPath: rootPath };
    fs.writeFileSync(paths.settings, JSON.stringify(updated, null, 2), 'utf-8');
  });

  ipcMain.handle('storage:runCleanup', () => {
    const settings = getSettings();
    autoCleanupService.run(settings.autoCleanupDays);
  });
}
