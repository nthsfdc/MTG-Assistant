import { ipcMain } from 'electron';
import { fileStore } from '../store/file.store';

let _activeSessionId: string | null = null;

export function setActiveSession(id: string | null): void {
  _activeSessionId = id;
}

export function registerAudioIpc(): void {
  ipcMain.on('audio:chunk', (_event, { pcm }: { seq: number; pcm: ArrayBuffer }) => {
    if (!_activeSessionId) return;
    fileStore.appendAudio(_activeSessionId, Buffer.from(pcm));
    // NOTE: no STT forwarding — batch-only pipeline
  });
}
