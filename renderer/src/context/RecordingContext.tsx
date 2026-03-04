import { createContext, useContext, useRef, type ReactNode } from 'react';
import { useAudioCapture }   from '../hooks/useAudioCapture';
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
  const { start, stop }            = useAudioCapture();
  const { setActive, tick, clear } = useRecordingStore();
  const timerRef     = useRef<ReturnType<typeof setInterval> | null>(null);
  const sessionIdRef = useRef<string | null>(null);

  async function startRecording(sessionId: string, deviceId?: string): Promise<void> {
    if (sessionIdRef.current === sessionId) return;
    sessionIdRef.current = sessionId;
    await start(deviceId);
    setActive(sessionId);
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
