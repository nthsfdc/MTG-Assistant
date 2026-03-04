import fs from 'fs';
import path from 'path';
import { paths, ensureDir } from '../utils/paths';
import type { Session, SessionMeta, SessionStatus } from '../../shared/types';

function dbPath() { return path.join(paths.userData, 'app.json'); }

function readAll(): Session[] {
  try {
    ensureDir(path.dirname(dbPath()));
    if (!fs.existsSync(dbPath())) return [];
    return JSON.parse(fs.readFileSync(dbPath(), 'utf-8')) as Session[];
  } catch { return []; }
}

function writeAll(sessions: Session[]): void {
  fs.writeFileSync(dbPath(), JSON.stringify(sessions, null, 2), 'utf-8');
}

export const sessionStore = {
  create(s: Pick<Session, 'id' | 'title' | 'startedAt' | 'lang' | 'inputType' | 'sourceFileName' | 'sourceFilePath'>): void {
    const all = readAll();
    all.unshift({ ...s, status: 'recording', endedAt: null, durationMs: null, errorMsg: null });
    writeAll(all);
  },

  update(id: string, patch: Partial<Pick<Session, 'status' | 'endedAt' | 'durationMs' | 'errorMsg'>>): void {
    const all = readAll();
    const idx = all.findIndex(s => s.id === id);
    if (idx >= 0) { all[idx] = { ...all[idx], ...patch }; writeAll(all); }
  },

  list(): SessionMeta[] {
    return readAll().map(({ id, title, status, inputType, startedAt, endedAt, lang, durationMs, sourceFileName }) =>
      ({ id, title, status, inputType, startedAt, endedAt, lang, durationMs, sourceFileName }));
  },

  get(id: string): Session | undefined {
    return readAll().find(s => s.id === id);
  },

  /** Returns all sessions with status='processing' — used for crash recovery on startup. */
  getProcessing(): Session[] {
    return readAll().filter(s => s.status === 'processing');
  },

  delete(id: string): void {
    writeAll(readAll().filter(s => s.id !== id));
  },

  markError(id: string, msg: string, recoverable = false): void {
    const status: SessionStatus = recoverable ? 'error_recoverable' : 'error';
    this.update(id, { status, errorMsg: msg });
  },
};
