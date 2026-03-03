import { useEffect } from 'react';
import type { SessionDoneEvent, SessionStatusEvent, ErrorEvent } from '../../../shared/types';

// Caption subscriptions (sttPartial/sttFinal/translation) are handled
// by RecordingProvider at App level — they persist across route changes.
// This hook only subscribes to session lifecycle events.
export function useLiveIpc(
  sessionId: string | null,
  opts?: {
    onDone?:   (e: SessionDoneEvent)   => void;
    onStatus?: (e: SessionStatusEvent) => void;
    onError?:  (e: ErrorEvent)         => void;
  }
) {
  useEffect(() => {
    if (!sessionId) return;
    const u = [
      window.api.on.sessionDone(e   => opts?.onDone?.(e)),
      window.api.on.sessionStatus(e => opts?.onStatus?.(e)),
      window.api.on.error(e         => opts?.onError?.(e)),
    ];
    return () => u.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
}
