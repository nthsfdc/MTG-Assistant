import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { useCaptionStore }   from '../store/captionStore';
import { useRecordingStore } from '../store/recordingStore';
import { useRecording }      from '../context/RecordingContext';
import { useLiveIpc }        from '../hooks/useIpc';
import type { CaptionLine }  from '../store/captionStore';
import { useT } from '../i18n';

const PALETTE = [
  { fg: 'text-indigo-400', dim: 'text-indigo-400/50' },
  { fg: 'text-emerald-400', dim: 'text-emerald-400/50' },
  { fg: 'text-amber-400', dim: 'text-amber-400/50' },
  { fg: 'text-rose-400', dim: 'text-rose-400/50' },
  { fg: 'text-cyan-400', dim: 'text-cyan-400/50' },
];
const colorMap = new Map<string, number>();
let colorIdx = 0;
function getColor(id: string) {
  if (!colorMap.has(id)) colorMap.set(id, colorIdx++ % PALETTE.length);
  return PALETTE[colorMap.get(id)!];
}

function Caption({ line }: { line: CaptionLine }) {
  const c = getColor(line.speakerId);
  const label = line.speakerId.replace('speaker_', 'S');
  return (
    <div className={line.isFinal ? 'opacity-100' : 'opacity-50'}>
      <div className="flex items-baseline gap-2">
        <span className={`text-xs font-semibold w-5 flex-shrink-0 ${c.fg}`}>{label}</span>
        <p className="text-sm text-text-primary leading-relaxed">{line.text}</p>
      </div>
      {line.translation && <p className={`text-xs pl-7 mt-0.5 ${c.dim}`}>{line.translation}</p>}
    </div>
  );
}

function pad(n: number) { return n.toString().padStart(2, '0'); }

export function LiveSession() {
  const { t } = useT();
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { lines, clear } = useCaptionStore();
  const { startRecording, stopRecording } = useRecording();
  const { sessionId: activeId, elapsed, hasSysAudio } = useRecordingStore();
  const [stopping, setStopping] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useLiveIpc(sessionId ?? null, { onDone: () => navigate(`/session/${sessionId}`) });

  useEffect(() => {
    // Only start audio if this session isn't already being recorded
    if (activeId !== sessionId) {
      clear(); colorMap.clear(); colorIdx = 0;
      window.api.settings.get().then(s => {
        startRecording(sessionId!, s.inputDeviceId || undefined).catch(console.error);
      });
    }
    // No cleanup stop — audio persists across route changes
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [lines.length]);

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
          <span className="text-xs text-text-muted bg-surface-2 px-2 py-0.5 rounded">
            {hasSysAudio ? t.live.micAndSystem : t.live.micOnly}
          </span>
        </div>
        <button onClick={handleStop} disabled={stopping}
          className="px-4 py-1.5 bg-red-500/15 hover:bg-red-500/25 border border-red-500/30 text-red-400 text-sm font-medium rounded-lg transition-colors disabled:opacity-50">
          {stopping ? t.live.stopping : t.live.stop}
        </button>
      </div>
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-6 py-5 space-y-3">
        {lines.length === 0 ? (
          <div className="flex items-center justify-center h-full text-center text-text-muted">
            <div><p className="text-3xl mb-3">🎙</p><p className="text-sm">{t.live.waitingAudio}</p></div>
          </div>
        ) : (
          lines.map(line => <Caption key={line.id} line={line} />)
        )}
      </div>
    </div>
  );
}
