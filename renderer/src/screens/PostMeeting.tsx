import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../components/StatusBadge';
import type { SessionDetail, NormalizedSegment, TodoItem, LangCode } from '../../../shared/types';
import { useT } from '../i18n';

type Tab = 'overview' | 'transcript' | 'minutes' | 'todos';

function msToTime(ms: number) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60).toString().padStart(2, '0')}:${(s % 60).toString().padStart(2, '0')}`;
}

type MergedBlock = {
  speakerId: string; normalizedText: string; originalText: string;
  hasLlm: boolean; detectedLang: LangCode | undefined;
};

const JA_PUNCT = /[。！？…]$/;
const INNER_SPACE_JA = /\s+(?=[をがはにへのでもとや])/g; // space before particles

const JA_PARTICLE_START = /^[をがはにへのでもとや]/;
const JA_MID_END = /[をがはにへのでもとやてにをがはにへのでもとや]$/;

function joinJa(prev: string, next: string): string {
  const trimmedPrev = prev.trimEnd();
  const trimmedNext = next.trimStart();
  // Mid-sentence: prev ends with particle/connector OR next starts with particle
  if (JA_MID_END.test(trimmedPrev) || JA_PARTICLE_START.test(trimmedNext))
    return trimmedPrev + trimmedNext;
  const base = JA_PUNCT.test(trimmedPrev) ? trimmedPrev : trimmedPrev + '。';
  return base + trimmedNext;
}

function joinLatin(prev: string, next: string): string {
  return prev.trimEnd() + ' ' + next.trimStart();
}

function cleanJa(text: string): string {
  return text.replace(INNER_SPACE_JA, '').replace(/\s+/g, '');
}

function mergeConsecutive(segs: NormalizedSegment[]): MergedBlock[] {
  const out: MergedBlock[] = [];
  for (const seg of segs) {
    const last = out[out.length - 1];
    if (last && last.speakerId === seg.speakerId) {
      const lang = last.detectedLang;
      last.normalizedText = lang === 'ja'
        ? joinJa(last.normalizedText, seg.normalizedText)
        : joinLatin(last.normalizedText, seg.normalizedText);
      last.originalText = lang === 'ja'
        ? joinJa(last.originalText, seg.originalText)
        : joinLatin(last.originalText, seg.originalText);
      if (seg.method === 'llm') last.hasLlm = true;
    } else {
      const lang = seg.detectedLang;
      const norm = lang === 'ja' ? cleanJa(seg.normalizedText) : seg.normalizedText;
      out.push({ speakerId: seg.speakerId, normalizedText: norm, originalText: seg.originalText, hasLlm: seg.method === 'llm', detectedLang: lang });
    }
  }
  // Final pass: remove stray spaces inside Japanese blocks
  for (const blk of out) {
    if (blk.detectedLang === 'ja') blk.normalizedText = cleanJa(blk.normalizedText);
  }
  return out;
}

function PriorityBadge({ p }: { p: TodoItem['priority'] }) {
  const { t } = useT();
  const c = { high: 'text-red-400 bg-red-500/10', medium: 'text-amber-400 bg-amber-500/10', low: 'text-text-muted bg-surface-2' }[p];
  return <span className={`text-xs px-1.5 py-0.5 rounded font-medium flex-shrink-0 ${c}`}>{t.post.priority[p]}</span>;
}

export function PostMeeting() {
  const { t } = useT();
  const { id: sessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [detail,    setDetail]    = useState<SessionDetail | null>(null);
  const [tab,       setTab]       = useState<Tab>('overview');
  const [statusMsg, setStatusMsg] = useState('');
  const [exporting, setExporting] = useState(false);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!sessionId) return;
    const load = async () => {
      const d = await window.api.session.get(sessionId);
      setDetail(d);
      if (d?.status === 'processing') pollRef.current = setTimeout(load, 3000);
    };
    const unsub = window.api.on.sessionStatus(e => { if (e.sessionId === sessionId) setStatusMsg(e.detail ?? ''); });
    load();
    return () => { if (pollRef.current) clearTimeout(pollRef.current); unsub(); };
  }, [sessionId]);

  async function handleExport() {
    if (!sessionId || exporting) return;
    setExporting(true);
    try { await window.api.export.markdown(sessionId); } finally { setExporting(false); }
  }

  if (!detail) return (
    <div className="flex items-center justify-center h-full text-text-muted">
      <div className="text-center"><p className="text-2xl mb-2 animate-pulse">⟳</p><p className="text-sm">{t.post.loading}</p></div>
    </div>
  );

  const isProcessing = detail.status === 'processing';
  const m = detail.minutes?.data;

  const STEPS: Record<string, string> = {
    batch_stt: t.post.steps.batch_stt, lang_detect: t.post.steps.lang_detect,
    normalizing: t.post.steps.normalizing, summarizing: t.post.steps.summarizing,
    exporting: t.post.steps.exporting,
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
        <button onClick={() => navigate('/')} className="text-text-muted hover:text-text-primary transition-colors">←</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-text-primary truncate">{detail.title}</h1>
          <div className="flex items-center gap-3 mt-0.5">
            <StatusBadge status={detail.status} />
            {detail.durationMs != null && <span className="text-xs text-text-muted">{t.post.duration(Math.floor(detail.durationMs / 60000))}</span>}
          </div>
        </div>
        <button onClick={handleExport} disabled={exporting || isProcessing}
          className="px-3.5 py-1.5 border border-border rounded-lg text-sm text-text-dim hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-40">
          {exporting ? '…' : '↓ Markdown'}
        </button>
      </div>
      {isProcessing && (
        <div className="px-6 py-2.5 bg-amber-500/10 border-b border-amber-500/20 text-xs text-amber-400 flex items-center gap-2">
          <span className="animate-spin">⟳</span> {STEPS[statusMsg] ?? t.post.processing}
        </div>
      )}
      {detail.status === 'error' && detail.errorMsg && (
        <div className="px-6 py-2.5 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400">{t.post.error}{detail.errorMsg}</div>
      )}
      <div className="flex gap-0 px-6 border-b border-border flex-shrink-0">
        {(['transcript', 'minutes', 'overview', 'todos'] as Tab[]).map(tb => {
          const labels: Record<Tab, string> = {
            overview:   t.post.tabs.overview,
            transcript: t.post.tabs.transcript,
            minutes:    t.post.tabs.minutes,
            todos:      `${t.post.tabs.todos}${m ? ` (${m.todos.length})` : ''}`,
          };
          return (
            <button key={tb} onClick={() => setTab(tb)}
              className={`px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px ${tab === tb ? 'text-text-primary border-accent' : 'text-text-muted border-transparent hover:text-text-dim'}`}>
              {labels[tb]}
            </button>
          );
        })}
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'overview' && m && (
          <div className="w-full space-y-6">
            <div><h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.purpose}</h3><p className="text-sm text-text-dim leading-relaxed">{m.purpose}</p></div>
            {m.decisions.length > 0 && <div><h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.decisions}</h3><ul className="space-y-1.5">{m.decisions.map((d, i) => <li key={i} className="flex gap-2 text-sm text-text-dim"><span className="text-accent mt-0.5">✓</span>{d}</li>)}</ul></div>}
            {m.concerns.length > 0 && <div><h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.concerns}</h3><ul className="space-y-1.5">{m.concerns.map((c, i) => <li key={i} className="flex gap-2 text-sm text-text-dim"><span className="text-amber-400 mt-0.5">!</span>{c}</li>)}</ul></div>}
            {m.next_actions.length > 0 && <div><h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.nextActions}</h3><ul className="space-y-1.5">{m.next_actions.map((a, i) => <li key={i} className="flex gap-2 text-sm text-text-dim"><span className="text-text-muted mt-0.5">→</span>{a}</li>)}</ul></div>}
          </div>
        )}
        {tab === 'overview' && !m && <p className="text-sm text-text-muted">{isProcessing ? t.post.generating : t.post.noData}</p>}
        {tab === 'transcript' && (
          <div className="w-full space-y-2">
            {detail.segments.length === 0 ? <p className="text-sm text-text-muted">{t.post.noTranscript}</p> :
              detail.segments.map(s => (
                <div key={s.id} className="flex gap-3">
                  <span className="text-xs text-text-muted font-mono pt-0.5 w-14 text-right flex-shrink-0">{msToTime(s.startMs)}</span>
                  <p className="text-sm text-text-dim leading-relaxed">{s.text}</p>
                </div>
              ))}
          </div>
        )}
        {tab === 'minutes' && (
          <div className="w-full space-y-4">
            {!detail.normalized || detail.normalized.length === 0
              ? <p className="text-sm text-text-muted">{isProcessing ? t.post.generating : t.post.noTranscript}</p>
              : mergeConsecutive(detail.normalized).map((blk, i) => (
                <div key={i} className="flex gap-3">
                  <div className="flex flex-col items-end gap-0.5 w-12 flex-shrink-0 pt-0.5">
                    <span className="text-xs text-text-muted font-mono">{blk.speakerId.replace('speaker_', 'S')}</span>
                    <span className={`text-[10px] px-1 py-px rounded leading-none ${blk.hasLlm ? 'text-accent bg-accent/10' : 'text-text-muted bg-surface-2'}`}>
                      {blk.hasLlm ? 'llm' : 'rule'}
                    </span>
                  </div>
                  <p className="text-sm text-text-primary leading-relaxed">{blk.normalizedText}</p>
                </div>
              ))
            }
          </div>
        )}
        {tab === 'todos' && (
          <div className="w-full space-y-2">
            {!m || m.todos.length === 0 ? <p className="text-sm text-text-muted">{t.post.noTodos}</p> :
              m.todos.map((todo, i) => (
                <div key={i} className="flex items-start gap-3 px-4 py-3.5 bg-surface rounded-xl border border-border">
                  <PriorityBadge p={todo.priority} />
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-text-primary">{todo.task}</p>
                    {(todo.assignee || todo.deadline) && (
                      <div className="flex gap-4 mt-1.5 text-xs text-text-muted">
                        {todo.assignee && <span>👤 {todo.assignee}</span>}
                        {todo.deadline && <span>📅 {todo.deadline}</span>}
                      </div>
                    )}
                  </div>
                </div>
              ))}
          </div>
        )}
      </div>
    </div>
  );
}
