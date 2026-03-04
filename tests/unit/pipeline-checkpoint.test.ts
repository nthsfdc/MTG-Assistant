/**
 * Safeguard: Pipeline checkpoint write/read + idempotency checks.
 * Uses a temp directory — no Electron dependency.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { PipelineState } from '../../shared/types';

// ── isolate from Electron paths ──────────────────────────────────────────────
let tmpRoot: string;

function makePaths(root: string) {
  return {
    sessionDir: (id: string) => path.join(root, id),
    sessionFile: (id: string, name: string) => path.join(root, id, name),
  };
}

// Inline the fileStore logic under test so we don't pull in Electron modules.
function makeStore(root: string) {
  const p = makePaths(root);

  return {
    initSession(id: string) { fs.mkdirSync(p.sessionDir(id), { recursive: true }); },

    exists(id: string, file: string) {
      const fp = p.sessionFile(id, file);
      return fs.existsSync(fp) && fs.statSync(fp).size > 0;
    },

    writeJson(id: string, file: string, data: unknown) {
      const fp  = p.sessionFile(id, file);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
      fs.renameSync(tmp, fp);
    },

    readJson<T>(id: string, file: string): T | null {
      const fp = p.sessionFile(id, file);
      if (!fs.existsSync(fp)) return null;
      try { return JSON.parse(fs.readFileSync(fp, 'utf-8')) as T; } catch { return null; }
    },

    writeJsonl(id: string, file: string, records: unknown[]) {
      const fp  = p.sessionFile(id, file);
      const tmp = fp + '.tmp';
      fs.writeFileSync(tmp, records.map(r => JSON.stringify(r)).join('\n') + '\n', 'utf-8');
      fs.renameSync(tmp, fp);
    },

    readJsonl<T>(id: string, file: string): T[] {
      const fp = p.sessionFile(id, file);
      if (!fs.existsSync(fp)) return [];
      try {
        return fs.readFileSync(fp, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l) as T);
      } catch { return []; }
    },

    writePipeline(id: string, state: PipelineState) {
      this.writeJson(id, 'pipeline.json', state);
    },

    readPipeline(id: string): PipelineState | null {
      return this.readJson<PipelineState>(id, 'pipeline.json');
    },

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
  };
}

// ── tests ────────────────────────────────────────────────────────────────────
describe('pipeline checkpoint', () => {
  let store: ReturnType<typeof makeStore>;
  const SID = 'sess-001';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-test-'));
    store = makeStore(tmpRoot);
    store.initSession(SID);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('writes and reads pipeline.json atomically', () => {
    const state: PipelineState = {
      sessionId: SID,
      currentStep: 'batch_stt',
      steps: [
        { name: 'batch_stt', status: 'running' },
        { name: 'lang_detect', status: 'pending' },
      ],
    };
    store.writePipeline(SID, state);
    const read = store.readPipeline(SID);
    expect(read).toEqual(state);
  });

  it('returns null for missing pipeline.json', () => {
    expect(store.readPipeline('missing-id')).toBeNull();
  });

  it('tmp file is cleaned up after atomic write', () => {
    const state: PipelineState = {
      sessionId: SID, currentStep: 'exporting',
      steps: [{ name: 'exporting', status: 'done', completedAt: Date.now() }],
    };
    store.writePipeline(SID, state);
    const tmpFile = path.join(tmpRoot, SID, 'pipeline.json.tmp');
    expect(fs.existsSync(tmpFile)).toBe(false);
  });

  it('checkpoint can be updated and re-read (resume simulation)', () => {
    const initial: PipelineState = {
      sessionId: SID, currentStep: 'normalizing',
      steps: [
        { name: 'batch_stt', status: 'done', completedAt: Date.now() },
        { name: 'normalizing', status: 'running' },
      ],
    };
    store.writePipeline(SID, initial);

    // Simulate resuming: update step to done
    const resumed: PipelineState = {
      ...initial,
      currentStep: 'summarizing',
      steps: [
        { name: 'batch_stt', status: 'done', completedAt: Date.now() },
        { name: 'normalizing', status: 'done', completedAt: Date.now() },
        { name: 'summarizing', status: 'running' },
      ],
    };
    store.writePipeline(SID, resumed);

    const read = store.readPipeline(SID);
    expect(read?.currentStep).toBe('summarizing');
    expect(read?.steps.find(s => s.name === 'normalizing')?.status).toBe('done');
  });
});

describe('isStepOutputValid (idempotency)', () => {
  let store: ReturnType<typeof makeStore>;
  const SID = 'sess-002';

  beforeEach(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mtg-test-'));
    store = makeStore(tmpRoot);
    store.initSession(SID);
  });

  afterEach(() => {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  });

  it('prepare_audio: false when audio.wav missing', () => {
    expect(store.isStepOutputValid(SID, 'prepare_audio')).toBe(false);
  });

  it('prepare_audio: true when audio.wav exists with content', () => {
    fs.writeFileSync(path.join(tmpRoot, SID, 'audio.wav'), Buffer.from([1, 2, 3]));
    expect(store.isStepOutputValid(SID, 'prepare_audio')).toBe(true);
  });

  it('batch_stt: false when transcript.jsonl is empty', () => {
    expect(store.isStepOutputValid(SID, 'batch_stt')).toBe(false);
  });

  it('batch_stt: true when transcript.jsonl has records', () => {
    store.writeJsonl(SID, 'transcript.jsonl', [{ id: '1', text: 'hello', speakerId: 'spk_0', startMs: 0, endMs: 500, lang: 'en' }]);
    expect(store.isStepOutputValid(SID, 'batch_stt')).toBe(true);
  });

  it('lang_detect: false when transcripts lack detectedLang', () => {
    store.writeJsonl(SID, 'transcript.jsonl', [{ id: '1', text: 'hello', speakerId: 'spk_0', startMs: 0, endMs: 500, lang: 'en' }]);
    expect(store.isStepOutputValid(SID, 'lang_detect')).toBe(false);
  });

  it('lang_detect: true when all segments have detectedLang', () => {
    store.writeJsonl(SID, 'transcript.jsonl', [{ id: '1', text: 'hello', detectedLang: 'en', speakerId: 'spk_0', startMs: 0, endMs: 500, lang: 'en' }]);
    expect(store.isStepOutputValid(SID, 'lang_detect')).toBe(true);
  });

  it('normalizing: false when normalized.json missing', () => {
    expect(store.isStepOutputValid(SID, 'normalizing')).toBe(false);
  });

  it('normalizing: true when normalized.json has items', () => {
    store.writeJson(SID, 'normalized.json', [{ sourceId: '1', normalizedText: 'hello', speakerId: 'spk_0', originalText: 'hello', detectedLang: 'en', method: 'rule' }]);
    expect(store.isStepOutputValid(SID, 'normalizing')).toBe(true);
  });

  it('summarizing: false when minutes.json missing', () => {
    expect(store.isStepOutputValid(SID, 'summarizing')).toBe(false);
  });

  it('summarizing: true when minutes.json has data', () => {
    store.writeJson(SID, 'minutes.json', { sessionId: SID, generatedAt: Date.now(), language: 'en', data: { purpose: 'Test', decisions: [], todos: [], concerns: [], next_actions: [] } });
    expect(store.isStepOutputValid(SID, 'summarizing')).toBe(true);
  });

  it('exporting: false when export.md missing', () => {
    expect(store.isStepOutputValid(SID, 'exporting')).toBe(false);
  });

  it('exporting: true when export.md exists with content', () => {
    fs.writeFileSync(path.join(tmpRoot, SID, 'export.md'), '# Minutes\n\nContent here.');
    expect(store.isStepOutputValid(SID, 'exporting')).toBe(true);
  });

  it('unknown step: returns false', () => {
    expect(store.isStepOutputValid(SID, 'unknown_step')).toBe(false);
  });
});
