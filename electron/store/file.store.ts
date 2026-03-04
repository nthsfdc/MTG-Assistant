import fs from 'fs';
import path from 'path';
import { paths, ensureDir } from '../utils/paths';
import type { PipelineState } from '../../shared/types';

export const fileStore = {
  initSession(id: string): void {
    ensureDir(paths.sessionDir(id));
  },

  appendAudio(id: string, pcm: Buffer): void {
    fs.appendFileSync(paths.sessionFile(id, 'audio.pcm'), pcm);
  },

  getAudioPath(id: string): string {
    return paths.sessionFile(id, 'audio.pcm');
  },

  getWavPath(id: string): string {
    return paths.sessionFile(id, 'audio.wav');
  },

  sessionFile(id: string, name: string): string {
    return paths.sessionFile(id, name);
  },

  exists(id: string, file: string): boolean {
    const p = paths.sessionFile(id, file);
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  },

  writeJson(id: string, file: string, data: unknown): void {
    const p = paths.sessionFile(id, file);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  },

  readJson<T>(id: string, file: string): T | null {
    const p = paths.sessionFile(id, file);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
  },

  writeMd(id: string, file: string, content: string): string {
    const p = paths.sessionFile(id, file);
    fs.writeFileSync(p, content, 'utf-8');
    return p;
  },

  writeJsonl(id: string, file: string, records: unknown[]): void {
    const p   = paths.sessionFile(id, file);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
    fs.renameSync(tmp, p);
  },

  appendJsonl(id: string, file: string, record: unknown): void {
    fs.appendFileSync(paths.sessionFile(id, file), JSON.stringify(record) + '\n', 'utf-8');
  },

  readJsonl<T>(id: string, file: string): T[] {
    const p = paths.sessionFile(id, file);
    if (!fs.existsSync(p)) return [];
    try {
      return fs.readFileSync(p, 'utf-8')
        .split('\n').filter(Boolean)
        .map(l => JSON.parse(l) as T);
    } catch { return []; }
  },

  /** Atomic write of pipeline.json checkpoint (.tmp → rename). */
  writePipeline(id: string, state: PipelineState): void {
    const p   = paths.sessionFile(id, 'pipeline.json');
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  },

  readPipeline(id: string): PipelineState | null {
    return this.readJson<PipelineState>(id, 'pipeline.json');
  },

  /**
   * Checks if a step's output file is valid (exists + non-empty).
   * Used for idempotency before re-running a step.
   */
  isStepOutputValid(id: string, step: string): boolean {
    const checks: Record<string, () => boolean> = {
      prepare_audio: () => this.exists(id, 'audio.wav'),
      batch_stt:     () => { const s = this.readJsonl(id, 'transcript.jsonl'); return s.length > 0; },
      lang_detect:   () => {
        const s = this.readJsonl<{ detectedLang?: unknown }>(id, 'transcript.jsonl');
        return s.length > 0 && s.every(x => x.detectedLang != null);
      },
      normalizing:   () => { const n = this.readJson<unknown[]>(id, 'normalized.json'); return Array.isArray(n) && n.length > 0; },
      summarizing:   () => { const m = this.readJson<{ data?: unknown }>(id, 'minutes.json'); return m?.data != null; },
      exporting:     () => this.exists(id, 'export.md'),
    };
    return checks[step]?.() ?? false;
  },

  /** Returns total bytes used by a session directory. */
  sessionBytes(id: string): number {
    const dir = paths.sessionDir(id);
    if (!fs.existsSync(dir)) return 0;
    let total = 0;
    for (const f of fs.readdirSync(dir)) {
      try { total += fs.statSync(path.join(dir, f)).size; } catch { /* skip */ }
    }
    return total;
  },

  deleteSession(id: string): void {
    fs.rmSync(paths.sessionDir(id), { recursive: true, force: true });
  },

  /** Delete derived files after cleanup, keeping minutes.json + export.md + pipeline.json. */
  deleteArtifacts(id: string): void {
    for (const f of ['audio.pcm', 'audio.wav', 'transcript.jsonl', 'normalized.json']) {
      try { fs.unlinkSync(paths.sessionFile(id, f)); } catch { /* already gone */ }
    }
  },
};
