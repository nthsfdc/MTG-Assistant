import { app, BrowserWindow, Menu, session } from 'electron';
import path from 'path';
import { registerSessionIpc }  from './ipc/session.ipc';
import { registerAudioIpc }    from './ipc/audio.ipc';
import { registerSettingsIpc, initStorageRoot, getSettings } from './ipc/settings.ipc';
import { registerExportIpc }   from './ipc/export.ipc';
import { registerStorageIpc }  from './ipc/storage.ipc';
import { diskMonitor }         from './utils/disk-monitor';
import { autoCleanupService }  from './services/auto-cleanup.service';
import { sessionStore }        from './store/session.store';
import { logger }              from './utils/logger';

async function recoverInterruptedSessions(win: BrowserWindow): Promise<void> {
  const interrupted = sessionStore.getProcessing();
  if (interrupted.length === 0) return;
  logger.info('[Startup] found interrupted sessions, attempting recovery', { count: interrupted.length });
  for (const s of interrupted) {
    try {
      const { postMeetingService } = await import('./services/post-meeting.service');
      const { fileStore } = await import('./store/file.store');
      const checkpoint = fileStore.readPipeline(s.id);
      if (!checkpoint) {
        // No checkpoint — mark as error; cannot safely recover
        sessionStore.markError(s.id, 'Pipeline interrupted (no checkpoint)', false);
        continue;
      }
      logger.info('[Startup] resuming session from checkpoint', { sessionId: s.id });
      await postMeetingService.run(
        s.id, s.lang, s.inputType ?? 'recording', win, undefined, s.sourceFilePath,
      );
    } catch (err) {
      logger.error('[Startup] recovery failed', { sessionId: s.id, error: (err as Error).message });
      sessionStore.markError(s.id, `Recovery failed: ${(err as Error).message}`, false);
    }
  }
}

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1280, height: 820, minWidth: 960, minHeight: 600,
    backgroundColor: '#0f1117',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: false,
    },
  });

  // Register all IPC handlers
  registerSettingsIpc();
  initStorageRoot();
  registerSessionIpc(win);
  registerAudioIpc();
  registerExportIpc();
  registerStorageIpc();

  // Start background services
  diskMonitor.start(win);
  const settings = getSettings();
  autoCleanupService.run(settings.autoCleanupDays);

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
    win.webContents.openDevTools({ mode: 'detach' });
  } else {
    win.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  // Attempt crash recovery after renderer is ready
  win.webContents.once('did-finish-load', () => {
    void recoverInterruptedSessions(win);
  });
}

Menu.setApplicationMenu(null);
app.whenReady().then(() => {
  session.defaultSession.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'mediaKeySystem');
  });
  createWindow();
});
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
