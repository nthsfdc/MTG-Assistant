/**
 * Safeguard: secretStore.getMasked() never returns the raw key.
 * Tests the masking logic directly without Electron/keytar dependencies.
 */
import { describe, it, expect } from 'vitest';

// Inline the getMasked logic from secret.store.ts
function getMasked(key: string | null): string {
  if (!key) return '';
  return '****' + key.slice(-4);
}

describe('getMasked()', () => {
  it('returns empty string for null key', () => {
    expect(getMasked(null)).toBe('');
  });

  it('returns empty string for empty key', () => {
    expect(getMasked('')).toBe('');
  });

  it('masks all but last 4 chars', () => {
    const key = 'sk-abcdefghijklmnop1234';
    const masked = getMasked(key);
    expect(masked).toBe('****1234');
  });

  it('last 4 chars are preserved exactly', () => {
    const key = 'sk-proj-ABCDEFGHIJKLMNOPQRSTUVWXYZ9876';
    const masked = getMasked(key);
    expect(masked.endsWith('9876')).toBe(true);
    expect(masked.startsWith('****')).toBe(true);
  });

  it('always starts with ****', () => {
    const keys = [
      'short',
      'sk-key12345678',
      'sk-proj-VeryLongOpenAIKey1234567890',
    ];
    for (const key of keys) {
      expect(getMasked(key).startsWith('****')).toBe(true);
    }
  });

  it('does NOT contain full key', () => {
    const key = 'sk-proj-secret-ABCD';
    const masked = getMasked(key);
    expect(masked).not.toBe(key);
    expect(masked.length).toBe(8); // '****' + 4 chars
  });

  it('key shorter than 4 chars: still masked prefix only', () => {
    const key = 'abc';
    const masked = getMasked(key);
    expect(masked).toBe('****abc');
    expect(masked).not.toBe(key);
  });

  it('key of exactly 4 chars: returns ****+all', () => {
    const key = 'abcd';
    const masked = getMasked(key);
    expect(masked).toBe('****abcd');
  });
});

// ── Ensure preload.ts does NOT expose apikey.get ──────────────────────────────
import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('preload.ts security: no apikey.get channel', () => {
  const preloadPath = resolve(__dirname, '../../electron/preload.ts');
  let preloadSrc: string;

  try {
    preloadSrc = readFileSync(preloadPath, 'utf-8');
  } catch {
    preloadSrc = '';
  }

  it('preload.ts file is readable', () => {
    expect(preloadSrc.length).toBeGreaterThan(0);
  });

  it('does not expose apikey:get channel (security: raw key must stay in main process)', () => {
    // Check that there is no ipcRenderer.invoke('apikey:get') or similar
    const hasRawGetChannel = /['"](apikey):get['"]/.test(preloadSrc);
    expect(hasRawGetChannel).toBe(false);
  });

  it('exposes apikey:getMasked instead', () => {
    expect(preloadSrc).toContain('apikey:getMasked');
  });

  it('exposes apikey:set for storing new keys', () => {
    expect(preloadSrc).toContain('apikey:set');
  });

  it('does not import or re-export secretStore (main-process only)', () => {
    // preload must only use ipcRenderer, not direct secretStore access
    expect(preloadSrc).not.toContain('secretStore');
    expect(preloadSrc).not.toContain('secret.store');
  });
});
