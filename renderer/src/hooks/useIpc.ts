import { useEffect } from 'react';
import type { SessionDoneEvent, SessionStatusEvent, ErrorEvent } from '../../../shared/types';

export function useSessionIpc(
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
      window.api.on.sessionDone(e   => { if (e.sessionId === sessionId) opts?.onDone?.(e);   }),
      window.api.on.sessionStatus(e => { if (e.sessionId === sessionId) opts?.onStatus?.(e); }),
      window.api.on.error(e         => { if (e.sessionId === sessionId) opts?.onError?.(e);  }),
    ];
    return () => u.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);
}
