import { contextBridge, ipcRenderer } from 'electron';
import type {
  StartSessionPayload, StartSessionResult,
  SessionMeta, SessionDetail, AppSettings,
  SttPartialEvent, SttFinalEvent, TranslationEvent,
  SessionStatusEvent, SessionDoneEvent, ErrorEvent,
} from '../shared/types';

type Unsub = () => void;

function sub<T>(channel: string, cb: (e: T) => void): Unsub {
  const h = (_: unknown, e: T) => cb(e);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
}

const api = {
  session: {
    start: (p: StartSessionPayload) =>
      ipcRenderer.invoke('session:start', p) as Promise<StartSessionResult>,
    stop: (sessionId: string) =>
      ipcRenderer.invoke('session:stop', { sessionId }) as Promise<void>,
    list: () =>
      ipcRenderer.invoke('session:list') as Promise<SessionMeta[]>,
    get: (sessionId: string) =>
      ipcRenderer.invoke('session:get', { sessionId }) as Promise<SessionDetail>,
    delete: (sessionId: string) =>
      ipcRenderer.invoke('session:delete', { sessionId }) as Promise<void>,
  },

  audio: {
    chunk: (seq: number, pcm: ArrayBuffer) =>
      ipcRenderer.send('audio:chunk', { seq, pcm }),
  },

  export: {
    markdown: (sessionId: string) =>
      ipcRenderer.invoke('export:markdown', { sessionId }) as Promise<{ filePath: string }>,
  },

  settings: {
    get: () =>
      ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    save: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke('settings:save', patch) as Promise<void>,
  },

  apikey: {
    set: (service: 'deepgram' | 'openai' | 'deepl', key: string) =>
      ipcRenderer.invoke('apikey:set', { service, key }) as Promise<void>,
    exists: (service: 'deepgram' | 'openai' | 'deepl') =>
      ipcRenderer.invoke('apikey:exists', { service }) as Promise<boolean>,
    get: (service: 'deepgram' | 'openai' | 'deepl') =>
      ipcRenderer.invoke('apikey:get', { service }) as Promise<string | null>,
  },

  on: {
    sttPartial:    (cb: (e: SttPartialEvent) => void): Unsub    => sub('stt:partial', cb),
    sttFinal:      (cb: (e: SttFinalEvent) => void): Unsub      => sub('stt:final', cb),
    translation:   (cb: (e: TranslationEvent) => void): Unsub   => sub('translation', cb),
    sessionStatus: (cb: (e: SessionStatusEvent) => void): Unsub => sub('session:status', cb),
    sessionDone:   (cb: (e: SessionDoneEvent) => void): Unsub   => sub('session:done', cb),
    error:         (cb: (e: ErrorEvent) => void): Unsub         => sub('error', cb),
  },
};

contextBridge.exposeInMainWorld('api', api);

export type MainApi = typeof api;
