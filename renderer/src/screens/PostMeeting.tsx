import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { StatusBadge } from '../components/StatusBadge';
import { PipelineProgress } from '../components/PipelineProgress';
import type { SessionDetail, NormalizedSegment, TodoItem, DecisionItem, LangCode, PipelineStep } from '../../../shared/types';
import { useT } from '../i18n';

type Tab = 'overview' | 'transcript' | 'todos';

/** Format ms as [mm:ss] or [hh:mm:ss] when >= 1h. */
function formatMs(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0)
    return `${h.toString().padStart(2, '0')}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

type MergedBlock = {
  speakerId: string; normalizedText: string; originalText: string;
  hasLlm: boolean; detectedLang: LangCode | undefined;
  startMs: number | undefined;
};

type TranscriptParagraph = { startMs: number | undefined; sentences: string[] };

const JA_PUNCT = /[。！？…]$/;
const JA_PARTICLE_START = /^[をがはにへのでもとや]/;
const JA_MID_END = /[をがはにへのでもとやてにをがはにへのでもとや]$/;
const INNER_SPACE_JA = /\s+(?=[をがはにへのでもとや])/g;

function joinJa(prev: string, next: string): string {
  // Simply concatenate — JA_PREDICATES handles 。 insertion after actual sentence endings.
  // Adding 。 here caused false breaks at mid-sentence segment cuts (な、し、 etc.).
  return prev.trimEnd() + next.trimStart();
}

function joinLatin(prev: string, next: string): string {
  return prev.trimEnd() + ' ' + next.trimStart();
}

function cleanJa(text: string): string {
  return text.replace(INNER_SPACE_JA, '').replace(/\s+/g, '');
}

// ── Transcript readability utilities ─────────────────────────────────────────

/** Fix common punctuation artifacts from spoken-text STT output. */
function normalizePunctuation(text: string): string {
  return text
    .replace(/\s+([,.;:!?。、！？])/g, '$1')  // spaces before punctuation
    .replace(/\.{2,}/g, '.')                   // ".." → "."
    .replace(/,{2,}/g, ',')                    // ",," → ","
    .replace(/[。]{2,}/g, '。')                // "。。" → "。"
    .replace(/[、]{2,}/g, '、')                // "、、" → "、"
    .replace(/、。/g, '。')                     // "、。" → "。"
    .replace(/。[、,]/g, '。')                  // "。、" "。," → "。"
    .replace(/[,.]\./g, '.')                   // ",." → "."
    .replace(/\.,/g, '.');                     // ".," → "."
}

const JA_CONNECTORS = /。\s*(こちら|そして|また|そのため|続いて|さらに)/g;
// Do NOT insert 。 when predicate is followed by conjunctive particles (sentence continues).
const JA_PREDICATES = /(です|ます|ました|でした|ください|します|できます|となります|になります|可能です)(?![。\n、]|が|ので|のに|けど|けれど|から|し[、。\s]|り)/g;

/** Fix Japanese-specific punctuation artifacts (applied only when detectedLang === 'ja'). */
function normalizeJapanesePunctuation(text: string): string {
  return text
    .replace(/。\s*。+/g, '。')        // collapse repeated 。
    .replace(JA_CONNECTORS, ' $1')    // remove incorrect 。 before connectors
    .replace(JA_PREDICATES, '$1。\n') // add sentence break after predicate endings
    .replace(/。\n\n+/g, '。\n');     // collapse multiple blank lines
}

/** Split text into individual sentences on terminal punctuation. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[。！？!?])\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);
}

/** Group sentences into display paragraphs (≤ maxSentences or ≤ maxChars). */
function groupParagraphs(sentences: string[], maxSentences = 3, maxChars = 150): string[][] {
  if (sentences.length === 0) return [];
  const groups: string[][] = [];
  let cur: string[] = [];
  let len = 0;
  for (const s of sentences) {
    if (cur.length > 0 && (cur.length >= maxSentences || len + s.length > maxChars)) {
      groups.push(cur); cur = []; len = 0;
    }
    cur.push(s); len += s.length;
  }
  if (cur.length > 0) groups.push(cur);
  return groups;
}

/** Build paragraphs from normalized segments, carrying the timestamp of the first segment in each paragraph. */
function mergeConsecutive(segs: NormalizedSegment[], startMsById: Map<string, number>): MergedBlock[] {
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
      out.push({
        speakerId: seg.speakerId, normalizedText: norm, originalText: seg.originalText,
        hasLlm: seg.method === 'llm', detectedLang: lang,
        startMs: startMsById.get(seg.sourceId),
      });
    }
  }
  for (const blk of out) {
    if (blk.detectedLang === 'ja') blk.normalizedText = cleanJa(blk.normalizedText);
  }
  return out;
}

/**
 * Build transcript paragraphs with cross-segment sentence joining.
 * Incomplete sentences (no terminal punctuation) are joined with the next segment,
 * and the timestamp of the earliest contributing segment is used.
 */
function buildTranscriptParagraphs(
  segs: NormalizedSegment[],
  startMsById: Map<string, number>,
): TranscriptParagraph[] {
  const result: TranscriptParagraph[] = [];
  let pendingText = '';
  let pendingMs: number | undefined;

  for (const seg of segs) {
    const segMs = startMsById.get(seg.sourceId);
    const base = normalizePunctuation(seg.normalizedText);
    const clean = seg.detectedLang === 'ja' ? normalizeJapanesePunctuation(base) : base;
    const isJa = seg.detectedLang === 'ja';

    // Join with any incomplete sentence carried from the previous segment
    const fullText = pendingText
      ? (isJa ? joinJa(pendingText, clean) : joinLatin(pendingText, clean))
      : clean;
    const blockMs = pendingText ? pendingMs : segMs;

    const sentences = splitSentences(fullText);
    if (sentences.length === 0) { pendingText = fullText; pendingMs = blockMs; continue; }

    const lastComplete = /[。！？!?]$/.test(sentences[sentences.length - 1].trim());
    if (lastComplete) {
      groupParagraphs(sentences).forEach((sents, gi) =>
        result.push({ startMs: gi === 0 ? blockMs : undefined, sentences: sents }));
      pendingText = ''; pendingMs = undefined;
    } else {
      // Flush complete sentences; carry the trailing incomplete fragment forward
      const complete = sentences.slice(0, -1);
      const incomplete = sentences[sentences.length - 1];
      if (complete.length > 0) {
        groupParagraphs(complete).forEach((sents, gi) =>
          result.push({ startMs: gi === 0 ? blockMs : undefined, sentences: sents }));
        pendingMs = segMs;  // incomplete fragment belongs to this segment's time
      } else {
        pendingMs = blockMs; // still part of the earlier block
      }
      pendingText = incomplete;
    }
  }

  if (pendingText) {
    const sentences = splitSentences(pendingText);
    groupParagraphs(sentences.length > 0 ? sentences : [pendingText]).forEach((sents, gi) =>
      result.push({ startMs: gi === 0 ? pendingMs : undefined, sentences: sents }));
  }

  return result;
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
  const [exporting,    setExporting]    = useState(false);
  const [todoExporting, setTodoExporting] = useState(false);
  const [todoCopied,   setTodoCopied]   = useState(false);
  const [checked,      setChecked]      = useState<Set<number>>(new Set());
  const [pipelineExpanded, setPipelineExpanded] = useState(true);
  const pollRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  async function load() {
    if (!sessionId) return;
    const d = await window.api.session.get(sessionId);
    setDetail(d);
    if (d?.status === 'processing') {
      pollRef.current = setTimeout(load, 3000);
    }
  }

  useEffect(() => {
    if (!sessionId) return;
    load();
    const unsub = window.api.on.sessionStatus(e => {
      if (e.sessionId === sessionId && (e.status === 'done' || e.status === 'error' || e.status === 'error_recoverable')) {
        void load();
      }
    });
    return () => { if (pollRef.current) clearTimeout(pollRef.current); unsub(); };
  }, [sessionId]);

  useEffect(() => {
    if (detail?.status === 'done') setPipelineExpanded(false);
  }, [detail?.status]);

  async function handleExport() {
    if (!sessionId || exporting) return;
    setExporting(true);
    try { await window.api.export.markdown(sessionId); } finally { setExporting(false); }
  }

  function buildCopyText(todos: NonNullable<typeof m>['todos']): string {
    const lines = ['■ ToDo'];
    todos.forEach(td => {
      const owner = td.assignee ? `担当: ${td.assignee}` : '担当: 未定';
      lines.push(`・${td.task}（${owner}）`);
    });
    return lines.join('\n');
  }

  async function handleTodoCopy() {
    if (!m) return;
    await navigator.clipboard.writeText(buildCopyText(m.todos));
    setTodoCopied(true);
    setTimeout(() => setTodoCopied(false), 2000);
  }

  async function handleTodoExport() {
    if (!sessionId || todoExporting) return;
    setTodoExporting(true);
    try { await window.api.export.todoMarkdown(sessionId); } finally { setTodoExporting(false); }
  }

  async function handleRetry(step: PipelineStep) {
    if (!sessionId) return;
    await window.api.session.retryStep(sessionId, step);
    void load();
  }

  async function handleResume() {
    if (!sessionId) return;
    await window.api.session.resumePipeline(sessionId);
    void load();
  }

  if (!detail) return (
    <div className="flex items-center justify-center h-full text-text-muted">
      <div className="text-center"><p className="text-2xl mb-2 animate-pulse">⟳</p><p className="text-sm">{t.post.loading}</p></div>
    </div>
  );

  const isProcessing = detail.status === 'processing';
  const isError = detail.status === 'error' || detail.status === 'error_recoverable';
  const m = detail.minutes?.data;

  // Compute overall pipeline percent for the thin header progress bar (UI-002)
  const pipelineSteps = detail.pipeline?.steps ?? [];
  const pipelineTotal = pipelineSteps.length;
  const pipelineDoneCount = pipelineSteps.filter(s => s.status === 'done').length;
  const pipelineRunningIdx = pipelineSteps.findIndex(s => s.status === 'running');
  const pipelineCurrent = pipelineRunningIdx >= 0 ? pipelineRunningIdx : pipelineDoneCount;
  const pipelinePct = pipelineTotal > 0 ? Math.round((pipelineCurrent / pipelineTotal) * 100) : 0;

  // Build sourceId → startMs lookup from raw segments (used for timestamps only; raw text not shown)
  const startMsById = new Map<string, number>(detail.segments.map(s => [s.id, s.startMs]));

  // Build display paragraphs: join cross-segment split sentences, timestamp = earliest segment.
  const transcriptParagraphs = !detail.normalized ? [] :
    buildTranscriptParagraphs(detail.normalized, startMsById);

  const TABS: Tab[] = ['overview', 'transcript', 'todos'];
  const tabLabels: Record<Tab, string> = {
    overview:   t.post.tabs.overview,
    transcript: t.post.tabs.transcript,
    todos:      `${t.post.tabs.todos}${m ? ` (${m.todos.length})` : ''}`,
  };

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-3 px-6 py-4 border-b border-border flex-shrink-0">
        <button onClick={() => navigate('/')} className="text-text-muted hover:text-text-primary transition-colors">←</button>
        <div className="flex-1 min-w-0">
          <h1 className="text-base font-semibold text-text-primary truncate">{detail.title}</h1>
          <div className="flex items-center gap-3 mt-0.5">
            <StatusBadge status={detail.status} />
            {detail.sourceFileName && (
              <span className="text-xs text-text-muted truncate max-w-xs">{detail.sourceFileName}</span>
            )}
            {detail.durationMs != null && (
              <span className="text-xs text-text-muted">{t.post.duration(Math.floor(detail.durationMs / 60000))}</span>
            )}
          </div>
        </div>
        <button onClick={handleExport} disabled={exporting || isProcessing}
          className="px-3.5 py-1.5 border border-border rounded-lg text-sm text-text-dim hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-40">
          {exporting ? '…' : '↓ Markdown'}
        </button>
      </div>

      {/* UI-002: Thin overall progress bar — visible only while processing */}
      {isProcessing && (
        <div className="h-0.5 bg-surface-2 flex-shrink-0">
          <div className="h-0.5 bg-accent transition-all duration-500" style={{ width: `${pipelinePct}%` }} />
        </div>
      )}

      {/* UI-001: Pipeline panel — always visible when processing/error; collapsible when done */}
      {(isProcessing || isError || detail.pipeline) && (
        <div className="px-6 py-3 border-b border-border bg-surface/50">
          {detail.status === 'done' && (
            <button
              onClick={() => setPipelineExpanded(v => !v)}
              className="text-xs text-text-muted hover:text-text-primary transition-colors flex items-center gap-1 mb-2">
              処理ログ {pipelineExpanded ? '▲' : '▼'}
            </button>
          )}
          {(detail.status !== 'done' || pipelineExpanded) && (
            <PipelineProgress
              pipeline={detail.pipeline}
              status={detail.status}
              onRetry={handleRetry}
              onResume={handleResume}
            />
          )}
        </div>
      )}

      {isError && detail.errorMsg && (
        <div className="px-6 py-2.5 bg-red-500/10 border-b border-red-500/20 text-xs text-red-400">
          {t.post.error}{detail.errorMsg}
        </div>
      )}

      <div className="flex gap-0 px-6 border-b border-border flex-shrink-0">
        {TABS.map(tb => (
          <button key={tb} onClick={() => setTab(tb)}
            className={`px-4 py-2.5 text-sm transition-colors border-b-2 -mb-px ${tab === tb ? 'text-text-primary border-accent' : 'text-text-muted border-transparent hover:text-text-dim'}`}>
            {tabLabels[tb]}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {tab === 'overview' && m && (
          <div className="w-full space-y-3">
            <div className="rounded-xl bg-surface/50 border border-border p-4">
              <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.purpose}</h3>
              <p className="text-sm text-text-dim leading-relaxed">{m.purpose}</p>
            </div>
            {m.decisions.length > 0 && (
              <div className="rounded-xl bg-surface/50 border border-border p-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.decisions}</h3>
                <ul className="space-y-1.5">{m.decisions.map((d: DecisionItem, i: number) => (
                  <li key={i} className="flex gap-2 text-sm text-text-dim">
                    <span className="text-accent mt-0.5 flex-shrink-0">✓</span>
                    <span>
                      {d.text}
                      {d.source_time && (
                        <span className="block text-xs text-text-muted font-mono mt-0.5">└ {d.source_time}</span>
                      )}
                    </span>
                  </li>
                ))}</ul>
              </div>
            )}
            {m.concerns.length > 0 && (
              <div className="rounded-xl bg-surface/50 border border-border p-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.concerns}</h3>
                <ul className="space-y-1.5">{m.concerns.map((c, i) => (
                  <li key={i} className="flex gap-2 text-sm text-text-dim"><span className="text-amber-400 mt-0.5">!</span>{c}</li>
                ))}</ul>
              </div>
            )}
            {m.next_actions.length > 0 && (
              <div className="rounded-xl bg-surface/50 border border-border p-4">
                <h3 className="text-xs font-semibold text-text-muted uppercase tracking-wider mb-2">{t.post.nextActions}</h3>
                <ul className="space-y-1.5">{m.next_actions.map((a, i) => (
                  <li key={i} className="flex gap-2 text-sm text-text-dim"><span className="text-text-muted mt-0.5">→</span>{a}</li>
                ))}</ul>
              </div>
            )}
          </div>
        )}
        {tab === 'overview' && !m && (
          <p className="text-sm text-text-muted">{isProcessing ? t.post.generating : t.post.noData}</p>
        )}

        {tab === 'transcript' && (
          <div className="w-full space-y-5">
            {transcriptParagraphs.length === 0
              ? <p className="text-sm text-text-muted">{isProcessing ? t.post.generating : t.post.noTranscript}</p>
              : transcriptParagraphs.map((para, i) => (
                <div key={i}>
                  {para.startMs != null && (
                    <div className="text-xs text-text-muted font-mono mb-1">{formatMs(para.startMs)}</div>
                  )}
                  <p className="text-base text-text-primary leading-relaxed whitespace-pre-line">
                    {para.sentences.join('\n')}
                  </p>
                </div>
              ))
            }
          </div>
        )}

        {tab === 'todos' && (
          <div className="w-full">
            {m && m.todos.length > 0 && (
              <div className="flex gap-2 mb-4">
                <button onClick={handleTodoCopy}
                  className="px-3 py-1.5 text-xs border border-border rounded-lg text-text-dim hover:text-text-primary hover:border-text-muted transition-colors">
                  {todoCopied ? t.post.todoCopied : t.post.todoCopy}
                </button>
                <button onClick={handleTodoExport} disabled={todoExporting}
                  className="px-3 py-1.5 text-xs border border-border rounded-lg text-text-dim hover:text-text-primary hover:border-text-muted transition-colors disabled:opacity-40">
                  {todoExporting ? '…' : t.post.todoExport}
                </button>
              </div>
            )}
            {!m || m.todos.length === 0 ? <p className="text-sm text-text-muted">{t.post.noTodos}</p> : (
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="border-b border-border">
                    <th className="text-left text-xs font-medium text-text-muted py-2 pr-3 w-8">#</th>
                    <th className="py-2 pr-4 w-8"></th>
                    <th className="text-left text-xs font-medium text-text-muted py-2 pr-4">
                      <span className="flex items-center gap-1.5">☑ {t.post.todoCol.task}</span>
                    </th>
                    <th className="text-left text-xs font-medium text-text-muted py-2 pr-4 w-36">
                      <span className="flex items-center gap-1.5">👤 {t.post.todoCol.assignee}</span>
                    </th>
                    <th className="text-left text-xs font-medium text-text-muted py-2 w-32">
                      <span className="flex items-center gap-1.5">📅 {t.post.todoCol.deadline}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {m.todos.map((todo, i) => {
                    const done = checked.has(i);
                    const toggle = () => setChecked(s => { const n = new Set(s); done ? n.delete(i) : n.add(i); return n; });
                    return (
                      <tr key={i} onClick={toggle} className={`border-b border-border/50 cursor-pointer transition-colors ${done ? 'opacity-40' : 'hover:bg-surface/50'}`}>
                        <td className="py-2.5 pr-3 text-xs text-text-muted tabular-nums">{i + 1}</td>
                        <td className="py-2.5 pr-4">
                          <input type="checkbox" checked={done} onChange={toggle} onClick={e => e.stopPropagation()}
                            className="w-3.5 h-3.5 rounded accent-accent cursor-pointer" />
                        </td>
                        <td className="py-2.5 pr-4">
                          <div className="flex items-center gap-2">
                            <PriorityBadge p={todo.priority} />
                            <span>
                              <span className={`text-text-primary ${done ? 'line-through' : ''}`}>{todo.task}</span>
                              {todo.source_time && (
                                <span className="block text-xs text-text-muted font-mono mt-0.5">└ {todo.source_time}</span>
                              )}
                            </span>
                          </div>
                        </td>
                        <td className={`py-2.5 pr-4 text-text-dim ${done ? 'line-through' : ''}`}>
                          {todo.assignee ?? <span className="text-text-muted/40">—</span>}
                        </td>
                        <td className={`py-2.5 text-text-dim ${done ? 'line-through' : ''}`}>
                          {todo.deadline ?? <span className="text-text-muted/40">—</span>}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
