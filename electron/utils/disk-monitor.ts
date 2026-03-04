import fs from 'fs';
import { BrowserWindow } from 'electron';
import { getStorageRoot } from './paths';
import { logger } from './logger';
import type { StorageWarningEvent } from '../../shared/types';

const WARN_THRESHOLD  = 5  * 1024 * 1024 * 1024; // 5 GB
const BLOCK_THRESHOLD = 500 * 1024 * 1024;         // 500 MB
const POLL_INTERVAL   = 5  * 60  * 1000;            // 5 min

class DiskMonitor {
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _win: BrowserWindow | null = null;

  start(win: BrowserWindow): void {
    this._win = win;
    void this._check();
    this._timer = setInterval(() => void this._check(), POLL_INTERVAL);
  }

  stop(): void {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  async canImport(): Promise<boolean> {
    const free = await this._getFree();
    return free > BLOCK_THRESHOLD;
  }

  private async _check(): Promise<void> {
    try {
      const free = await this._getFree();
      if (free < WARN_THRESHOLD) {
        logger.warn('[DiskMonitor] low disk space', { freeBytes: free });
        const event: StorageWarningEvent = {
          freeBytes: free,
          threshold: free < BLOCK_THRESHOLD ? 'block' : 'warn',
        };
        if (this._win && !this._win.isDestroyed()) {
          this._win.webContents.send('storage:warning', event);
        }
      }
    } catch { /* ignore */ }
  }

  private async _getFree(): Promise<number> {
    try {
      const root = getStorageRoot();
      // Node 19+ has fs.statfs; Electron 31 ships Node 20
      const statfs = await new Promise<{ bfree: number; bsize: number }>((resolve, reject) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (fs as any).statfs(root, (err: Error | null, stats: { bfree: number; bsize: number }) => {
          if (err) reject(err); else resolve(stats);
        });
      });
      return statfs.bfree * statfs.bsize;
    } catch {
      return Infinity; // fail open
    }
  }
}

export const diskMonitor = new DiskMonitor();
