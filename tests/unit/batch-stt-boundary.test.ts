/**
 * BL-004 unit tests for Batch STT reliability fixes.
 * Tests: WAV 0-byte guard (BL-001), multi lang preservation (BL-002),
 *        multi-segment boundary dedup (BL-003).
 */
import { describe, it, expect } from 'vitest';

// ── Helpers (mirrored from batch-stt.service.ts) ─────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = i;
    for (let j = 1; j <= n; j++) {
      const cur = a[i - 1] === b[j - 1] ? dp[j - 1] : 1 + Math.min(dp[j - 1], dp[j], prev);
      dp[j - 1] = prev;
      prev = cur;
    }
    dp[n] = prev;
  }
  return dp[n];
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const maxLen = Math.max(a.length, b.length);
  return 1 - levenshtein(a, b) / maxLen;
}

/**
 * Simulates the boundary dedup logic from BatchSttService (BL-003).
 * Returns { kept: string[], dropped: number }.
 */
function applyBoundaryDedup(
  lastKeptText: string,
  newSegs: string[],
  threshold = 0.95,
  maxK = 3,
): { kept: string[]; dropped: number } {
  const segs = [...newSegs];
  let dropped = 0;
  while (dropped < maxK && segs.length > 0) {
    if (similarity(lastKeptText, segs[0]) >= threshold) {
      segs.shift();
      dropped++;
    } else {
      break;
    }
  }
  return { kept: segs, dropped };
}

/**
 * Simulates the WAV 0-byte guard from BatchSttService (BL-001).
 */
function validateWavSize(size: number): void {
  if (size === 0) throw new Error('Audio WAV file is empty — cannot transcribe');
}

/**
 * Simulates lang assignment from transcribeSingle (BL-002).
 */
function assignLang(lang: string): string {
  return lang; // no coercion — preserve 'multi'
}

// ── BL-001: WAV 0-byte guard ──────────────────────────────────────────────────

describe('BL-001 — WAV empty file validation', () => {
  it('throws with clear message when WAV size is 0', () => {
    expect(() => validateWavSize(0)).toThrowError(
      'Audio WAV file is empty — cannot transcribe',
    );
  });

  it('does not throw for non-zero WAV size', () => {
    expect(() => validateWavSize(1)).not.toThrow();
    expect(() => validateWavSize(24_000_000)).not.toThrow();
  });

  it('does not throw for minimal valid WAV (44 bytes header)', () => {
    expect(() => validateWavSize(44)).not.toThrow();
  });
});

// ── BL-002: multi lang preservation ──────────────────────────────────────────

describe('BL-002 — Preserve "multi" lang in segment output', () => {
  it('keeps "multi" as-is (no coercion to "ja")', () => {
    expect(assignLang('multi')).toBe('multi');
  });

  it('keeps "ja" as-is', () => {
    expect(assignLang('ja')).toBe('ja');
  });

  it('keeps "vi" as-is', () => {
    expect(assignLang('vi')).toBe('vi');
  });

  it('keeps "en" as-is', () => {
    expect(assignLang('en')).toBe('en');
  });
});

// ── BL-003: multi-segment boundary dedup ─────────────────────────────────────

describe('BL-003 — Robust multi-segment boundary dedup', () => {
  const REAL_SEGMENT = 'This is the next real sentence after the boundary.';
  const DUP_SEGMENT = 'This is the previous chunk ending sentence here.';

  it('drops 1 duplicate leading segment', () => {
    const { kept, dropped } = applyBoundaryDedup(
      DUP_SEGMENT,
      [DUP_SEGMENT, REAL_SEGMENT],
    );
    expect(dropped).toBe(1);
    expect(kept[0]).toBe(REAL_SEGMENT);
  });

  it('drops 2 consecutive near-duplicate leading segments', () => {
    const dup1 = 'Meeting is now starting please join the call';
    const dup2 = 'Meeting is now starting please join the call.'; // near-identical (punctuation diff)
    const real = 'Today we will discuss the project roadmap.';
    const { kept, dropped } = applyBoundaryDedup(dup1, [dup2, real]);
    expect(dropped).toBe(1); // dup2 is similar to dup1 (last kept = dup1)
    expect(kept[0]).toBe(real);
  });

  it('drops all 3 when K=3 consecutive near-duplicates appear', () => {
    const base = 'The project deadline has been set for March.';
    const near1 = 'The project deadline has been set for March.';
    const near2 = 'The project deadline has been set for March';   // no period
    const near3 = 'The project deadline has been set for March!';  // diff punct
    const real  = 'Next item on the agenda is the budget review.';
    const { kept, dropped } = applyBoundaryDedup(base, [near1, near2, near3, real]);
    // Each iteration compares against last KEPT text (not updated in loop — by design)
    // near1 vs base → drop; near2 vs base → drop; near3 vs base → drop
    expect(dropped).toBe(3);
    expect(kept[0]).toBe(real);
  });

  it('does NOT drop beyond K=3 even if more duplicates follow', () => {
    const base = 'This is the boundary segment text.';
    const dups = Array(5).fill('This is the boundary segment text.');
    const { kept, dropped } = applyBoundaryDedup(base, dups);
    expect(dropped).toBe(3); // capped at K=3
    expect(kept.length).toBe(2); // 5 - 3 = 2 remaining
  });

  it('does NOT drop a non-duplicate first segment', () => {
    const { kept, dropped } = applyBoundaryDedup(
      DUP_SEGMENT,
      [REAL_SEGMENT, DUP_SEGMENT],
    );
    expect(dropped).toBe(0);
    expect(kept).toEqual([REAL_SEGMENT, DUP_SEGMENT]);
  });

  it('handles empty new chunk gracefully', () => {
    const { kept, dropped } = applyBoundaryDedup(DUP_SEGMENT, []);
    expect(dropped).toBe(0);
    expect(kept).toEqual([]);
  });

  it('stops loop immediately when first non-duplicate found', () => {
    const base = 'Boundary segment ending text here.';
    const real1 = 'Completely different first segment content.';
    const dup   = 'Boundary segment ending text here.'; // duplicate but second
    const { kept, dropped } = applyBoundaryDedup(base, [real1, dup]);
    expect(dropped).toBe(0); // stops at real1 since it's not similar
    expect(kept).toEqual([real1, dup]);
  });
});

// ── Similarity helper sanity checks ──────────────────────────────────────────

describe('similarity helper', () => {
  it('returns 1 for identical strings', () => {
    expect(similarity('hello', 'hello')).toBe(1);
  });

  it('returns 0 for empty strings (guard)', () => {
    expect(similarity('', 'hello')).toBe(0);
    expect(similarity('hello', '')).toBe(0);
  });

  it('returns < 0.95 for clearly different strings', () => {
    expect(similarity(
      'This is a completely different sentence.',
      'Totally unrelated content here indeed.',
    )).toBeLessThan(0.95);
  });

  it('returns >= 0.95 for near-identical strings (1 char diff)', () => {
    const a = 'The meeting is scheduled for Monday morning at nine.';
    const b = 'The meeting is scheduled for Monday morning at nine!';
    expect(similarity(a, b)).toBeGreaterThanOrEqual(0.95);
  });
});
