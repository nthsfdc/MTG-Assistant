import { sessionStore } from '../store/session.store';
import { fileStore } from '../store/file.store';
import { logger } from '../utils/logger';

class AutoCleanupService {
  /**
   * Delete derived files (audio.pcm, audio.wav, transcript.jsonl, normalized.json)
   * for sessions older than `days` days. Keeps: minutes.json, export.md, pipeline.json.
   * days=0 → disabled.
   */
  run(days: number): void {
    if (days <= 0) return;
    const cutoff = Date.now() - days * 24 * 60 * 60 * 1000;
    const sessions = sessionStore.list();
    let cleaned = 0;
    for (const s of sessions) {
      if (s.status !== 'done') continue;
      const endedAt = s.endedAt ?? s.startedAt;
      if (endedAt > cutoff) continue;
      if (!fileStore.exists(s.id, 'minutes.json')) continue; // safety: only if pipeline completed
      try {
        fileStore.deleteArtifacts(s.id);
        cleaned++;
      } catch (err) {
        logger.warn('[AutoCleanup] failed to clean session', { sessionId: s.id, error: (err as Error).message });
      }
    }
    if (cleaned > 0) logger.info('[AutoCleanup] cleaned sessions', { count: cleaned, days });
  }
}

export const autoCleanupService = new AutoCleanupService();
