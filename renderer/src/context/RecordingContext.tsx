import { createContext, useContext, useRef, useEffect, type ReactNode } from 'react';
import { useAudioCapture }   from '../hooks/useAudioCapture';
import { useCaptionStore }   from '../store/captionStore';
import { useRecordingStore } from '../store/recordingStore';

interface RecordingCtx {
  startRecording: (sessionId: string, deviceId?: string) => Promise<void>;
  stopRecording:  () => void;
}

const Ctx = createContext<RecordingCtx>({
  startRecording: async () => {},
  stopRecording:  () => {},
});

export function RecordingProvider({ children }: { children: ReactNode }) {
  const { start, stop }              = useAudioCapture();
  const { setActive, tick, clear }   = useRecordingStore();
  const { onPartial, onFinal, onTranslation } = useCaptionStore();
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  // Caption IPC subscriptions live here — persist across route changes
  useEffect(() => {
    const unsubs = [
      window.api.on.sttPartial(onPartial),
      window.api.on.sttFinal(onFinal),
      window.api.on.translation(onTranslation),
    ];
    return () => unsubs.forEach(f => f());
  }, [onPartial, onFinal, onTranslation]);

  async function startRecording(sessionId: string, deviceId?: string): Promise<void> {
    if (sessionIdRef.current === sessionId) return; // already recording
    sessionIdRef.current = sessionId;
    const { hasSysAudio } = await start(deviceId);
    setActive(sessionId, hasSysAudio);
    timerRef.current = setInterval(tick, 1000);
  }

  function stopRecording(): void {
    stop();
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    clear();
    sessionIdRef.current = null;
  }

  return <Ctx.Provider value={{ startRecording, stopRecording }}>{children}</Ctx.Provider>;
}

export const useRecording = () => useContext(Ctx);
