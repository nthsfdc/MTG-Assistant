import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../store/sessionStore';
import { SessionCard } from '../components/SessionCard';
import { useT } from '../i18n';

function EmptyState({ onNew }: { onNew: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-border flex items-center justify-center text-3xl mb-4">🎙</div>
      <p className="text-text-primary font-medium mb-1">{t.dashboard.emptyTitle}</p>
      <p className="text-text-muted text-sm mb-6">{t.dashboard.emptyHint}</p>
      <button onClick={onNew} className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors">
        {t.dashboard.newMeeting}
      </button>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-2 max-w-3xl">
      {[...Array(3)].map((_, i) => <div key={i} className="h-16 bg-surface rounded-xl border border-border animate-pulse" />)}
    </div>
  );
}

export function Dashboard() {
  const { t } = useT();
  const { sessions, loadSessions, deleteSession } = useSessionStore();
  const [loading, setLoading] = useState(true);
  const navigate = useNavigate();

  useEffect(() => { loadSessions().finally(() => setLoading(false)); }, [loadSessions]);

  async function handleDelete(id: string) {
    if (!confirm(t.dashboard.deleteConfirm)) return;
    await deleteSession(id);
  }

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold text-text-primary">{t.dashboard.title}</h1>
          <p className="text-xs text-text-muted mt-0.5">{loading ? t.dashboard.loading : t.dashboard.sessions(sessions.length)}</p>
        </div>
        <button
          onClick={() => navigate('/session/setup')}
          className="flex items-center gap-2 px-3.5 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm font-medium transition-colors"
        >
          {t.dashboard.newMeeting}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        {loading ? <Skeleton /> : sessions.length === 0 ? (
          <EmptyState onNew={() => navigate('/session/setup')} />
        ) : (
          <div className="space-y-2 max-w-3xl">
            {sessions.map(s => (
              <SessionCard key={s.id} session={s}
                onOpen={() => navigate(s.status === 'recording' ? `/session/${s.id}/live` : `/session/${s.id}`)}
                onDelete={() => handleDelete(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
