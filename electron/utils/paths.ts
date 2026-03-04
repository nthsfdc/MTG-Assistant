import { app } from 'electron';
import path from 'path';
import fs from 'fs';

let _storageRoot = '';

export function getStorageRoot(): string {
  return _storageRoot || path.join(app.getPath('userData'), 'sessions');
}

export function setStorageRoot(p: string): void {
  if (!p) { _storageRoot = ''; return; }
  _storageRoot = p;
  ensureDir(_storageRoot);
}

export function ensureDir(p: string): void {
  fs.mkdirSync(p, { recursive: true });
}

export const paths = {
  get userData()  { return app.getPath('userData'); },
  get settings()  { return path.join(app.getPath('userData'), 'settings.json'); },
  get vault()     { return path.join(app.getPath('userData'), 'vault.enc'); },
  get appJson()   { return path.join(app.getPath('userData'), 'app.json'); },
  get logDir()    { return path.join(app.getPath('userData'), 'logs'); },
  sessionDir(id: string)               { return path.join(getStorageRoot(), id); },
  sessionFile(id: string, name: string){ return path.join(getStorageRoot(), id, name); },
};
