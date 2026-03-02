import type { SessionMeta } from '../../../shared/types';
import { StatusBadge } from './StatusBadge';
import { useT } from '../i18n';

export function SessionCard({ session, onOpen, onDelete }: {
  session: SessionMeta; onOpen: () => void; onDelete: () => void;
}) {
  const { t } = useT();

  function fmtDate(ts: number) {
    return new Date(ts).toLocaleDateString(t.dateLocale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
  }
  function fmtDur(ms: number | null) {
    if (!ms) return '—';
    const m = Math.floor(ms / 60000), s = Math.floor((ms % 60000) / 1000);
    return t.card.duration(m, s);
  }

  return (
    <div
      onClick={onOpen}
      className="group flex items-center gap-3 px-4 py-3 bg-surface rounded-xl border border-border hover:border-accent/40 hover:bg-surface-2 transition-all cursor-pointer"
    >
      <div className="w-9 h-9 flex-shrink-0 rounded-lg bg-accent-subtle flex items-center justify-center text-accent text-base">
        🎙
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-text-primary truncate">{session.title}</p>
        <p className="text-xs text-text-muted mt-0.5">{fmtDate(session.startedAt)}</p>
      </div>
      <div className="flex-shrink-0 flex items-center gap-4 text-xs text-text-muted">
        <span>{fmtDur(session.durationMs)}</span>
        <StatusBadge status={session.status} />
      </div>
      <button
        onClick={e => { e.stopPropagation(); onDelete(); }}
        className="flex-shrink-0 opacity-0 group-hover:opacity-100 w-7 h-7 flex items-center justify-center rounded-md hover:bg-red-500/15 hover:text-red-400 text-text-muted transition-all"
        title={t.card.delete}
      >✕</button>
    </div>
  );
}
