import { create } from 'zustand';
import type { SttPartialEvent, SttFinalEvent, TranslationEvent } from '../../../shared/types';

export interface CaptionLine {
  id: string; speakerId: string; text: string;
  isFinal: boolean; translation: string | null; startMs: number;
}

interface CaptionStore {
  lines: CaptionLine[];
  onPartial: (e: SttPartialEvent) => void;
  onFinal:   (e: SttFinalEvent)   => void;
  onTranslation: (e: TranslationEvent) => void;
  clear: () => void;
}

export const useCaptionStore = create<CaptionStore>((set) => ({
  lines: [],
  onPartial({ speakerId, text }) {
    set(s => {
      const idx = s.lines.findIndex(l => !l.isFinal && l.speakerId === speakerId);
      const p: CaptionLine = { id: `p:${speakerId}`, speakerId, text, isFinal: false, translation: null, startMs: Date.now() };
      if (idx >= 0) { const lines = [...s.lines]; lines[idx] = p; return { lines }; }
      return { lines: [...s.lines, p] };
    });
  },
  onFinal({ speakerId, text, startMs }) {
    set(s => ({
      lines: [...s.lines.filter(l => !(l.speakerId === speakerId && !l.isFinal)),
              { id: `f:${speakerId}:${startMs}`, speakerId, text, isFinal: true, translation: null, startMs }],
    }));
  },
  onTranslation({ speakerId, sourceText, translatedText }) {
    set(s => {
      for (let i = s.lines.length - 1; i >= 0; i--) {
        if (s.lines[i].speakerId === speakerId && s.lines[i].isFinal && s.lines[i].text === sourceText) {
          const lines = [...s.lines]; lines[i] = { ...lines[i], translation: translatedText }; return { lines };
        }
      }
      return s;
    });
  },
  clear: () => set({ lines: [] }),
}));
