import { create } from 'zustand';

interface RecordingStore {
  sessionId:   string | null;
  elapsed:     number;
  hasSysAudio: boolean;
  setActive: (id: string, sys: boolean) => void;
  tick:      () => void;
  clear:     () => void;
}

export const useRecordingStore = create<RecordingStore>(set => ({
  sessionId:   null,
  elapsed:     0,
  hasSysAudio: false,
  setActive: (id, sys) => set({ sessionId: id, elapsed: 0, hasSysAudio: sys }),
  tick:      () => set(s => ({ elapsed: s.elapsed + 1 })),
  clear:     () => set({ sessionId: null, elapsed: 0, hasSysAudio: false }),
}));
