/**
 * Simple JSON file store — replaces better-sqlite3 (no native compilation needed).
 */
import fs from 'fs';
import { paths, ensureDir } from '../utils/paths';
import type { Session, SessionMeta } from '../../shared/types';

function dbPath() { return paths.db.replace('.sqlite', '.json'); }

function readAll(): Session[] {
  try {
    ensureDir(require('path').dirname(dbPath()));
    if (!fs.existsSync(dbPath())) return [];
    return JSON.parse(fs.readFileSync(dbPath(), 'utf-8')) as Session[];
  } catch { return []; }
}

function writeAll(sessions: Session[]): void {
  fs.writeFileSync(dbPath(), JSON.stringify(sessions, null, 2), 'utf-8');
}

export const sessionStore = {
  create(s: Pick<Session, 'id' | 'title' | 'startedAt' | 'lang' | 'targetLang'>): void {
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
    return readAll().map(({ id, title, status, startedAt, endedAt, lang, durationMs }) =>
      ({ id, title, status, startedAt, endedAt, lang, durationMs }));
  },

  get(id: string): Session | undefined {
    return readAll().find(s => s.id === id);
  },

  delete(id: string): void {
    writeAll(readAll().filter(s => s.id !== id));
  },
};
