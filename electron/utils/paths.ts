import { app } from 'electron';
import path from 'path';
import fs from 'fs';

export const paths = {
  get db()       { return path.join(app.getPath('userData'), 'app.sqlite'); },
  get sessions() { return path.join(app.getPath('userData'), 'sessions'); },
  get settings() { return path.join(app.getPath('userData'), 'settings.json'); },
  sessionDir(id: string) {
    return path.join(app.getPath('userData'), 'sessions', id);
  },
};

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}
