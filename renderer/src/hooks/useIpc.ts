import { useEffect } from 'react';
import { useCaptionStore } from '../store/captionStore';
import type { SessionDoneEvent, SessionStatusEvent, ErrorEvent } from '../../../shared/types';

export function useLiveIpc(
  sessionId: string | null,
  opts?: {
    onDone?:   (e: SessionDoneEvent)   => void;
    onStatus?: (e: SessionStatusEvent) => void;
    onError?:  (e: ErrorEvent)         => void;
  }
) {
  const { onPartial, onFinal, onTranslation } = useCaptionStore();
  useEffect(() => {
    if (!sessionId) return;
    const u = [
      window.api.on.sttPartial(onPartial),
      window.api.on.sttFinal(onFinal),
      window.api.on.translation(onTranslation),
      window.api.on.sessionDone(e  => opts?.onDone?.(e)),
      window.api.on.sessionStatus(e => opts?.onStatus?.(e)),
      window.api.on.error(e        => opts?.onError?.(e)),
    ];
    return () => u.forEach(fn => fn());
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, onPartial, onFinal, onTranslation]);
}
