import { create } from 'zustand';

interface RecordingStore {
  sessionId: string | null;
  elapsed:   number;
  setActive: (id: string) => void;
  tick:      () => void;
  clear:     () => void;
}

export const useRecordingStore = create<RecordingStore>(set => ({
  sessionId: null,
  elapsed:   0,
  setActive: (id) => set({ sessionId: id, elapsed: 0 }),
  tick:      () => set(s => ({ elapsed: s.elapsed + 1 })),
  clear:     () => set({ sessionId: null, elapsed: 0 }),
}));
