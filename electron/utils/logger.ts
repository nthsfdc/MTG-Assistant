import fs from 'fs';
import path from 'path';
import { paths, ensureDir } from './paths';

const MAX_SIZE = 5 * 1024 * 1024; // 5 MB
const KEEP_BACKUPS = 3;

class Logger {
  private logPath(): string {
    ensureDir(paths.logDir);
    return path.join(paths.logDir, 'app.log');
  }

  private write(level: string, msg: string, data?: Record<string, unknown>): void {
    try {
      const p = this.logPath();
      if (fs.existsSync(p) && fs.statSync(p).size > MAX_SIZE) this.rotate(p);
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...data }) + '\n';
      fs.appendFileSync(p, line, 'utf-8');
    } catch { /* ignore logging errors to avoid infinite loops */ }
  }

  private rotate(p: string): void {
    for (let i = KEEP_BACKUPS; i > 0; i--) {
      const src = i === 1 ? p : `${p}.${i - 1}`;
      const dst = `${p}.${i}`;
      if (fs.existsSync(src)) {
        if (fs.existsSync(dst)) fs.unlinkSync(dst);
        fs.renameSync(src, dst);
      }
    }
  }

  info(msg: string, data?: Record<string, unknown>)  { this.write('INFO',  msg, data); }
  warn(msg: string, data?: Record<string, unknown>)  { this.write('WARN',  msg, data); }
  error(msg: string, data?: Record<string, unknown>) { this.write('ERROR', msg, data); }
}

export const logger = new Logger();
