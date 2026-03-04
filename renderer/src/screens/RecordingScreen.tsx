import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useRecordingStore } from '../store/recordingStore';
import { useRecording }      from '../context/RecordingContext';
import { useT } from '../i18n';

function pad(n: number) { return n.toString().padStart(2, '0'); }

export function RecordingScreen() {
  const { t } = useT();
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { startRecording, stopRecording } = useRecording();
  const { sessionId: activeId, elapsed } = useRecordingStore();
  const [stopping, setStopping] = useState(false);

  useEffect(() => {
    if (activeId !== sessionId) {
      window.api.settings.get().then(s => {
        startRecording(sessionId!, s.inputDeviceId || undefined).catch(console.error);
      });
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleStop = useCallback(async () => {
    if (stopping || !sessionId) return;
    setStopping(true);
    stopRecording();
    await window.api.session.stop(sessionId);
    navigate(`/session/${sessionId}`);
  }, [stopping, sessionId, stopRecording, navigate]);

  const elapsed_str = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-3 border-b border-border flex-shrink-0 bg-surface">
        <div className="flex items-center gap-3">
          <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
          <span className="text-sm font-mono tabular-nums text-text-primary">{elapsed_str}</span>
          <span className="text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">{t.recording.micOnly}</span>
        </div>
        <button onClick={handleStop} disabled={stopping}
          className="px-4 py-1.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-400 text-sm rounded-lg transition-colors disabled:opacity-50">
          {stopping ? t.recording.stopping : t.recording.stop}
        </button>
      </div>
      <div className="flex-1 flex items-center justify-center text-center text-text-muted">
        <div>
          <p className="text-4xl mb-3">🎙</p>
          <p className="text-sm">{t.recording.hint}</p>
          <p className="text-xs text-text-muted/60 mt-2">{t.recording.pipelineAfterStop}</p>
        </div>
      </div>
    </div>
  );
}
