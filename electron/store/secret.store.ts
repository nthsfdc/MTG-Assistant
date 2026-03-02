/**
 * Simple JSON file store — replaces keytar (no native compilation needed).
 * Stores keys in plaintext in userData; fine for local-only internal tool.
 */
import fs from 'fs';
import { paths, ensureDir } from '../utils/paths';

function vaultPath() { return paths.settings.replace('settings.json', 'vault.json'); }

function read(): Record<string, string> {
  try {
    ensureDir(require('path').dirname(vaultPath()));
    if (!fs.existsSync(vaultPath())) return {};
    return JSON.parse(fs.readFileSync(vaultPath(), 'utf-8')) as Record<string, string>;
  } catch { return {}; }
}

function write(data: Record<string, string>): void {
  fs.writeFileSync(vaultPath(), JSON.stringify(data, null, 2), 'utf-8');
}

export const secretStore = {
  async set(account: string, value: string): Promise<void> {
    const v = read(); v[account] = value; write(v);
  },
  async get(account: string): Promise<string | null> {
    return read()[account] ?? null;
  },
  async exists(account: string): Promise<boolean> {
    return account in read();
  },
};
