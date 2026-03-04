import { sessionStore } from '../store/session.store';
import { fileStore }    from '../store/file.store';
import { logger }       from '../utils/logger';
import type { MeetingMinutes, TranscriptSegment } from '../../shared/types';

class SearchIndexService {
  /**
   * Build search_index.json for a session after the pipeline completes.
   * Concatenates: title + purpose + decisions + todos + concerns + next_actions + transcript text.
   */
  build(
    sessionId: string,
    title: string,
    minutes: MeetingMinutes | null,
    segments: TranscriptSegment[],
  ): void {
    try {
      const parts: string[] = [title];
      const m = minutes?.data;
      if (m) {
        parts.push(m.purpose);
        m.decisions.forEach(d => parts.push(typeof d === 'string' ? d : (d as { text: string }).text));
        m.todos.forEach(t => { parts.push(t.task); if (t.assignee) parts.push(t.assignee); });
        m.concerns.forEach(c => parts.push(c));
        m.next_actions.forEach(a => parts.push(a));
      }
      segments.forEach(s => parts.push(s.text));
      const text = parts.filter(Boolean).join(' ');
      fileStore.writeJson(sessionId, 'search_index.json', { text });
      logger.info('[SearchIndex] built', { sessionId, chars: text.length });
    } catch (err) {
      logger.warn('[SearchIndex] build failed (non-fatal)', { sessionId, error: (err as Error).message });
    }
  }

  /**
   * Query all sessions. Returns session IDs that match the query string.
   * Falls back to title-only for sessions without a search index (e.g. legacy sessions).
   */
  query(q: string): string[] {
    const lower   = q.trim().toLowerCase();
    if (!lower)   return [];
    const results: string[] = [];
    for (const s of sessionStore.list()) {
      if (s.title.toLowerCase().includes(lower)) {
        results.push(s.id);
        continue;
      }
      const idx = fileStore.readJson<{ text: string }>(s.id, 'search_index.json');
      if (idx?.text.toLowerCase().includes(lower)) results.push(s.id);
    }
    return results;
  }
}

export const searchIndexService = new SearchIndexService();
