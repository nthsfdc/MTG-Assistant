import fs from 'fs';
import path from 'path';
import { paths, ensureDir } from '../utils/paths';

export const fileStore = {
  initSession(id: string): void {
    ensureDir(paths.sessionDir(id));
  },

  appendAudio(id: string, pcm: Buffer): void {
    fs.appendFileSync(path.join(paths.sessionDir(id), 'audio.pcm'), pcm);
  },

  getAudioPath(id: string): string {
    return path.join(paths.sessionDir(id), 'audio.pcm');
  },

  writeJson(id: string, file: string, data: unknown): void {
    fs.writeFileSync(path.join(paths.sessionDir(id), file), JSON.stringify(data, null, 2), 'utf-8');
  },

  readJson<T>(id: string, file: string): T | null {
    const p = path.join(paths.sessionDir(id), file);
    if (!fs.existsSync(p)) return null;
    return JSON.parse(fs.readFileSync(p, 'utf-8')) as T;
  },

  writeMd(id: string, file: string, content: string): string {
    const p = path.join(paths.sessionDir(id), file);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  },

  writeJsonl(id: string, file: string, records: unknown[]): void {
    const p = path.join(paths.sessionDir(id), file);
    fs.writeFileSync(p, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
  },

  appendJsonl(id: string, file: string, record: unknown): void {
    fs.appendFileSync(
      path.join(paths.sessionDir(id), file),
      JSON.stringify(record) + '\n',
      'utf-8',
    );
  },

  readJsonl<T>(id: string, file: string): T[] {
    const p = path.join(paths.sessionDir(id), file);
    if (!fs.existsSync(p)) return [];
    return fs.readFileSync(p, 'utf-8')
      .split('\n').filter(Boolean)
      .map(l => JSON.parse(l) as T);
  },

  deleteSession(id: string): void {
    fs.rmSync(paths.sessionDir(id), { recursive: true, force: true });
  },
};
