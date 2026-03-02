import type { SessionStatus } from '../../../shared/types';
import { useT } from '../i18n';

const DOT: Record<SessionStatus, { dot: string; text: string }> = {
  recording:  { dot: 'bg-red-500 animate-pulse',   text: 'text-red-400'     },
  processing: { dot: 'bg-amber-500 animate-pulse', text: 'text-amber-400'   },
  done:       { dot: 'bg-emerald-500',             text: 'text-emerald-400' },
  error:      { dot: 'bg-red-500',                 text: 'text-red-400'     },
};

export function StatusBadge({ status }: { status: SessionStatus }) {
  const { t } = useT();
  const c = DOT[status];
  return (
    <span className={`inline-flex items-center gap-1.5 text-xs font-medium ${c.text}`}>
      <span className={`w-1.5 h-1.5 rounded-full ${c.dot}`} />
      {t.status[status]}
    </span>
  );
}
