import { create } from 'zustand';
import type { SessionMeta } from '../../../shared/types';

interface SessionStore {
  sessions: SessionMeta[];
  loadSessions: () => Promise<void>;
  deleteSession: (id: string) => Promise<void>;
}

export const useSessionStore = create<SessionStore>((set) => ({
  sessions: [],
  async loadSessions() {
    const sessions = await window.api.session.list();
    set({ sessions });
  },
  async deleteSession(id: string) {
    await window.api.session.delete(id);
    set(s => ({ sessions: s.sessions.filter(x => x.id !== id) }));
  },
}));
