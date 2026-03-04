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
    const p   = paths.sessionFile(id, file);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, p);
  },

  readJson<T>(id: string, file: string): T | null {
    const p = paths.sessionFile(id, file);
    if (!fs.existsSync(p)) return null;
    try { return JSON.parse(fs.readFileSync(p, 'utf-8')) as T; } catch { return null; }
  },

  /** Atomic write: write to .tmp then rename to final path. */
  writeMd(id: string, file: string, content: string): string {
    const p   = paths.sessionFile(id, file);
    const tmp = p + '.tmp';
    fs.writeFileSync(tmp, content, 'utf-8');
    fs.renameSync(tmp, p);
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
   * Strict validation of transcript.jsonl.
   * Every line must parse as JSON and contain text:string, startMs:number, endMs:number.
   * Returns false if file is missing, empty, or any line is malformed.
   */
  validateTranscriptJsonl(id: string): boolean {
    const p = paths.sessionFile(id, 'transcript.jsonl');
    if (!fs.existsSync(p)) return false;
    try {
      const lines = fs.readFileSync(p, 'utf-8').split('\n').filter(Boolean);
      if (lines.length === 0) return false;
      for (const line of lines) {
        const obj = JSON.parse(line) as Record<string, unknown>;
        if (typeof obj.text    !== 'string') return false;
        if (typeof obj.startMs !== 'number') return false;
        if (typeof obj.endMs   !== 'number') return false;
      }
      return true;
    } catch { return false; }
  },

  /**
   * Checks if a step's output is fully valid.
   * Used for idempotency skip AND resume source-of-truth check.
   */
  isStepOutputValid(id: string, step: string): boolean {
    const checks: Record<string, () => boolean> = {
      prepare_audio: () => this.exists(id, 'audio.wav'),

      // Strict: validate every JSONL line has required fields
      batch_stt: () => this.validateTranscriptJsonl(id),

      // On top of strict transcript validation, every segment must have detectedLang
      lang_detect: () => {
        if (!this.validateTranscriptJsonl(id)) return false;
        const segs = this.readJsonl<{ detectedLang?: unknown }>(id, 'transcript.jsonl');
        return segs.length > 0 && segs.every(x => x.detectedLang != null);
      },

      normalizing: () => {
        const n = this.readJson<unknown[]>(id, 'normalized.json');
        return Array.isArray(n) && n.length > 0;
      },

      summarizing: () => {
        const m = this.readJson<{ data?: unknown }>(id, 'minutes.json');
        return m?.data != null;
      },

      exporting: () => this.exists(id, 'export.md'),
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
