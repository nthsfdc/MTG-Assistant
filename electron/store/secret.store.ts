/**
 * Secret store: keytar (OS keychain) primary, vault.enc AES-256-GCM fallback.
 * Never exposes raw keys to the renderer process.
 */
import crypto from 'crypto';
import fs from 'fs';
import { app } from 'electron';
import path from 'path';

const APP_NAME = 'mtg-assistant';

function vaultPath(): string {
  return path.join(app.getPath('userData'), 'vault.enc');
}

/** Machine-bound key derived from app path (not exported; vault.enc useless on another machine). */
function machineKey(): Buffer {
  const seed = `${process.env.COMPUTERNAME ?? process.env.HOSTNAME ?? 'mtg'}:${app.getPath('userData')}`;
  return crypto.createHash('sha256').update(seed).digest();
}

function loadVault(): Record<string, string> {
  try {
    const raw = fs.readFileSync(vaultPath());
    const iv  = raw.subarray(0, 16);
    const tag = raw.subarray(16, 32);
    const enc = raw.subarray(32);
    const dec = crypto.createDecipheriv('aes-256-gcm', machineKey(), iv);
    dec.setAuthTag(tag);
    return JSON.parse(dec.update(enc).toString('utf-8') + dec.final('utf-8'));
  } catch { return {}; }
}

function saveVault(data: Record<string, string>): void {
  const iv  = crypto.randomBytes(16);
  const enc = crypto.createCipheriv('aes-256-gcm', machineKey(), iv);
  const ct  = Buffer.concat([enc.update(JSON.stringify(data), 'utf-8'), enc.final()]);
  const tag = enc.getAuthTag();
  fs.writeFileSync(vaultPath(), Buffer.concat([iv, tag, ct]));
}

async function keytarGet(service: string): Promise<string | null> {
  try {
    const keytar = await import('keytar');
    return await keytar.getPassword(APP_NAME, service) ?? null;
  } catch { return null; }
}

async function keytarSet(service: string, key: string): Promise<boolean> {
  try {
    const keytar = await import('keytar');
    await keytar.setPassword(APP_NAME, service, key);
    return true;
  } catch { return false; }
}

export const secretStore = {
  async get(service: string): Promise<string | null> {
    const v = await keytarGet(service);
    if (v !== null) return v;
    return loadVault()[service] ?? null;
  },

  async set(service: string, key: string): Promise<void> {
    const ok = await keytarSet(service, key);
    if (!ok) {
      const vault = loadVault();
      vault[service] = key;
      saveVault(vault);
    }
  },

  async exists(service: string): Promise<boolean> {
    const v = await keytarGet(service);
    if (v !== null) return true;
    return service in loadVault();
  },

  /** Returns "****abcd" (last 4 chars). Never returns the raw key. */
  async getMasked(service: string): Promise<string> {
    const key = await this.get(service);
    if (!key) return '';
    return '****' + key.slice(-4);
  },
};
