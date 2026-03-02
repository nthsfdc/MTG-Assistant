import fs from 'fs';
import path from 'path';
import { ipcMain } from 'electron';
import { secretStore } from '../store/secret.store';
import { paths, ensureDir } from '../utils/paths';
import type { AppSettings } from '../../shared/types';

const defaults: AppSettings = {
  inputDeviceId: '', outputDeviceId: '',
  transcriptionLanguage: '', uiLang: 'ja',
};

function loadFromDisk(): AppSettings {
  try {
    ensureDir(path.dirname(paths.settings));
    if (!fs.existsSync(paths.settings)) return { ...defaults };
    return { ...defaults, ...JSON.parse(fs.readFileSync(paths.settings, 'utf-8')) } as AppSettings;
  } catch { return { ...defaults }; }
}

function saveToDisk(s: AppSettings): void {
  fs.writeFileSync(paths.settings, JSON.stringify(s, null, 2), 'utf-8');
}

let _settings: AppSettings = loadFromDisk();

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => _settings);
  ipcMain.handle('settings:save', (_, patch: Partial<AppSettings>) => {
    _settings = { ..._settings, ...patch };
    saveToDisk(_settings);
  });
  ipcMain.handle('apikey:set',    (_, { service, key }: { service: string; key: string }) =>
    secretStore.set(service, key));
  ipcMain.handle('apikey:exists', (_, { service }: { service: string }) =>
    secretStore.exists(service));
}
