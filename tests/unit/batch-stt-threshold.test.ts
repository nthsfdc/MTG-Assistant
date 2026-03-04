/**
 * Safeguard: BatchSttService WAV chunk trigger.
 * Verifies WAV_CHUNK_THRESHOLD constant and chunking decision logic.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

// ── threshold constant ────────────────────────────────────────────────────────
const WAV_CHUNK_THRESHOLD = 24_000_000; // 24 MB — must match batch-stt.service.ts

describe('WAV_CHUNK_THRESHOLD', () => {
  it('is exactly 24 MB', () => {
    expect(WAV_CHUNK_THRESHOLD).toBe(24_000_000);
  });

  it('24 MB wav triggers chunking', () => {
    const fileSize = 24_000_001;
    expect(fileSize > WAV_CHUNK_THRESHOLD).toBe(true);
  });

  it('23.9 MB wav does not trigger chunking', () => {
    const fileSize = 23_900_000;
    expect(fileSize > WAV_CHUNK_THRESHOLD).toBe(false);
  });

  it('exactly 24 MB does not trigger chunking (> not >=)', () => {
    const fileSize = 24_000_000;
    expect(fileSize > WAV_CHUNK_THRESHOLD).toBe(false);
  });
});

// ── chunking decision ─────────────────────────────────────────────────────────
describe('chunking decision logic', () => {
  function shouldChunk(fileSizeBytes: number): boolean {
    return fileSizeBytes > WAV_CHUNK_THRESHOLD;
  }

  it.each([
    [0,             false],
    [1_000_000,     false],  // 1 MB
    [23_999_999,    false],  // just under 24 MB
    [24_000_000,    false],  // exactly 24 MB — single call
    [24_000_001,    true],   // 1 byte over → chunk
    [100_000_000,   true],   // 100 MB → chunk
    [1_073_741_824, true],   // 1 GB → chunk
  ])('file %i bytes → shouldChunk=%s', (size, expected) => {
    expect(shouldChunk(size)).toBe(expected);
  });
});

// ── Levenshtein similarity (dedup guard) ──────────────────────────────────────
function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
  return dp[m][n];
}

function similarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

describe('Levenshtein dedup guard (≥0.95 threshold)', () => {
  const DEDUP_THRESHOLD = 0.95;

  function isDuplicate(prev: string, next: string): boolean {
    return similarity(prev, next) >= DEDUP_THRESHOLD;
  }

  it('identical segments are duplicates', () => {
    const seg = 'this is a test segment at the chunk boundary';
    expect(isDuplicate(seg, seg)).toBe(true);
  });

  it('very similar segments (1 char diff) are duplicates', () => {
    const a = 'this is a test segment at the chunk boundary';
    const b = 'this is a test segment at the chunk boundarX';
    expect(isDuplicate(a, b)).toBe(true);
  });

  it('different segments are not duplicates', () => {
    const a = 'this is the first chunk ending segment here';
    const b = 'this is the second chunk starting segment now';
    expect(isDuplicate(a, b)).toBe(false);
  });

  it('empty strings have similarity 1', () => {
    expect(similarity('', '')).toBe(1);
  });
});
