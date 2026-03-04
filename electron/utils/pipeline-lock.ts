import { logger } from './logger';

const HARD_TIMEOUT       = 2 * 60 * 60 * 1000; // 2 h
const HEARTBEAT_INTERVAL =         30 * 1000;   // 30 s
const WATCHDOG_TIMEOUT   =     10 * 60 * 1000;  // 10 min

class PipelineLock {
  private _locked        = false;
  private _sessionId: string | null = null;
  private _killFn: (() => void) | null = null;
  private _heartbeat:   ReturnType<typeof setInterval> | null = null;
  private _watchdog:    ReturnType<typeof setInterval> | null = null;
  private _hardTimeout: ReturnType<typeof setTimeout>  | null = null;
  private _lastActivity = 0;

  isLocked()  { return this._locked; }
  lockedBy()  { return this._sessionId; }

  acquire(sessionId: string, killFn?: () => void): boolean {
    if (this._locked) {
      logger.warn('[PipelineLock] acquire failed — already locked', { lockedBy: this._sessionId, requestedBy: sessionId });
      return false;
    }
    this._locked       = true;
    this._sessionId    = sessionId;
    this._killFn       = killFn ?? null;
    this._lastActivity = Date.now();

    this._heartbeat = setInterval(() => { this._lastActivity = Date.now(); }, HEARTBEAT_INTERVAL);

    this._watchdog = setInterval(() => {
      if (Date.now() - this._lastActivity > WATCHDOG_TIMEOUT) {
        logger.warn('[PipelineLock] watchdog triggered — killing ffmpeg and releasing lock', { sessionId });
        this._killFn?.();
        this.release();
      }
    }, WATCHDOG_TIMEOUT / 2);

    this._hardTimeout = setTimeout(() => {
      logger.warn('[PipelineLock] hard timeout (2h) — releasing lock', { sessionId });
      this._killFn?.();
      this.release();
    }, HARD_TIMEOUT);

    return true;
  }

  release(): void {
    this._locked    = false;
    this._sessionId = null;
    this._killFn    = null;
    if (this._heartbeat)   { clearInterval(this._heartbeat);   this._heartbeat   = null; }
    if (this._watchdog)    { clearInterval(this._watchdog);    this._watchdog    = null; }
    if (this._hardTimeout) { clearTimeout(this._hardTimeout);  this._hardTimeout = null; }
  }

  touch(): void { this._lastActivity = Date.now(); }
}

export const pipelineLock = new PipelineLock();
