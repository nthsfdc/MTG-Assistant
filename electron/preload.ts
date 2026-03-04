import { contextBridge, ipcRenderer } from 'electron';
import type {
  StartSessionPayload, StartSessionResult,
  ImportPayload, MediaProbeResult,
  SessionMeta, SessionDetail, AppSettings, StorageStats,
  SessionStatusEvent, SessionDoneEvent, ErrorEvent, StorageWarningEvent,
  PipelineStep,
} from '../shared/types';

type Unsub = () => void;

function sub<T>(channel: string, cb: (e: T) => void): Unsub {
  const h = (_: unknown, e: T) => cb(e);
  ipcRenderer.on(channel, h);
  return () => ipcRenderer.off(channel, h);
}

const api = {
  session: {
    start:           (p: StartSessionPayload) =>
      ipcRenderer.invoke('session:start', p) as Promise<StartSessionResult>,
    stop:            (sessionId: string) =>
      ipcRenderer.invoke('session:stop', { sessionId }) as Promise<void>,
    list:            () =>
      ipcRenderer.invoke('session:list') as Promise<SessionMeta[]>,
    get:             (sessionId: string) =>
      ipcRenderer.invoke('session:get', { sessionId }) as Promise<SessionDetail | null>,
    delete:          (sessionId: string) =>
      ipcRenderer.invoke('session:delete', { sessionId }) as Promise<void>,
    import:          (p: ImportPayload) =>
      ipcRenderer.invoke('session:import', p) as Promise<StartSessionResult>,
    retryStep:       (sessionId: string, step: PipelineStep) =>
      ipcRenderer.invoke('session:retryStep', { sessionId, step }) as Promise<void>,
    resumePipeline:  (sessionId: string) =>
      ipcRenderer.invoke('session:resumePipeline', { sessionId }) as Promise<void>,
  },

  audio: {
    chunk: (seq: number, pcm: ArrayBuffer) =>
      ipcRenderer.send('audio:chunk', { seq, pcm }),
  },

  media: {
    probe: (filePath: string) =>
      ipcRenderer.invoke('media:probe', { filePath }) as Promise<MediaProbeResult>,
  },

  export: {
    markdown:     (sessionId: string) =>
      ipcRenderer.invoke('export:markdown',     { sessionId }) as Promise<{ filePath: string }>,
    todoMarkdown: (sessionId: string) =>
      ipcRenderer.invoke('export:todoMarkdown', { sessionId }) as Promise<{ filePath: string }>,
  },

  settings: {
    get:  () =>
      ipcRenderer.invoke('settings:get') as Promise<AppSettings>,
    save: (patch: Partial<AppSettings>) =>
      ipcRenderer.invoke('settings:save', patch) as Promise<void>,
  },

  apikey: {
    set:       (service: string, key: string) =>
      ipcRenderer.invoke('apikey:set',       { service, key }) as Promise<void>,
    exists:    (service: string) =>
      ipcRenderer.invoke('apikey:exists',    { service }) as Promise<boolean>,
    getMasked: (service: string) =>
      ipcRenderer.invoke('apikey:getMasked', { service }) as Promise<string>,
    // apikey.get intentionally omitted — renderer must never receive raw API keys
  },

  storage: {
    getStats:   () =>
      ipcRenderer.invoke('storage:getStats') as Promise<StorageStats>,
    setRoot:    (rootPath: string) =>
      ipcRenderer.invoke('storage:setRoot', { rootPath }) as Promise<void>,
    runCleanup: () =>
      ipcRenderer.invoke('storage:runCleanup') as Promise<void>,
  },

  search: {
    query: (query: string) =>
      ipcRenderer.invoke('search:query', { query }) as Promise<string[]>,
  },

  on: {
    sessionStatus:  (cb: (e: SessionStatusEvent)  => void): Unsub => sub('session:status',  cb),
    sessionDone:    (cb: (e: SessionDoneEvent)     => void): Unsub => sub('session:done',    cb),
    error:          (cb: (e: ErrorEvent)           => void): Unsub => sub('error',           cb),
    storageWarning: (cb: (e: StorageWarningEvent)  => void): Unsub => sub('storage:warning', cb),
    // sttPartial / sttFinal / translation intentionally removed (batch-only)
  },
};

contextBridge.exposeInMainWorld('api', api);

export type MainApi = typeof api;
