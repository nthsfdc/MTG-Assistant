import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useSessionStore } from '../store/sessionStore';
import { SessionCard } from '../components/SessionCard';
import { useT } from '../i18n';
import type { StorageWarningEvent } from '../../../shared/types';

function EmptyState({ onNew, onImport }: { onNew: () => void; onImport: () => void }) {
  const { t } = useT();
  return (
    <div className="flex flex-col items-center justify-center h-full text-center py-24">
      <div className="w-16 h-16 rounded-2xl bg-surface-2 border border-border flex items-center justify-center text-3xl mb-4">🎙</div>
      <p className="text-text-primary font-medium mb-1">{t.dashboard.emptyTitle}</p>
      <p className="text-text-muted text-sm mb-6">{t.dashboard.emptyHint}</p>
      <div className="flex gap-3">
        <button onClick={onNew} className="px-4 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors">
          {t.dashboard.newMeeting}
        </button>
        <button onClick={onImport} className="px-4 py-2 bg-surface-2 hover:bg-surface border border-border text-text-primary rounded-lg text-sm transition-colors">
          {t.dashboard.importFile}
        </button>
      </div>
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
  const [diskWarning, setDiskWarning] = useState<StorageWarningEvent | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    loadSessions().finally(() => setLoading(false));
    const unsub = window.api.on.storageWarning(e => setDiskWarning(e));
    return () => unsub();
  }, [loadSessions]);

  async function handleDelete(id: string) {
    if (!confirm(t.dashboard.deleteConfirm)) return;
    await deleteSession(id);
  }

  function getSessionRoute(s: { id: string; status: string; inputType: string }) {
    if (s.status === 'recording') return `/session/${s.id}/rec`;
    return `/session/${s.id}`;
  }

  return (
    <div className="flex flex-col h-full">
      {/* Disk warning banner */}
      {diskWarning && (
        <div className={`px-4 py-2 text-xs flex items-center gap-2 ${diskWarning.threshold === 'block' ? 'bg-red-500/15 text-red-400 border-b border-red-500/20' : 'bg-yellow-500/10 text-yellow-400 border-b border-yellow-500/20'}`}>
          <span>⚠</span>
          <span>{diskWarning.threshold === 'block' ? t.dashboard.diskBlock : t.dashboard.diskWarn}</span>
          <span className="text-text-muted/70">({(diskWarning.freeBytes / 1024 / 1024 / 1024).toFixed(1)} GB {t.dashboard.diskFree})</span>
          <button onClick={() => setDiskWarning(null)} className="ml-auto opacity-60 hover:opacity-100">✕</button>
        </div>
      )}

      <div className="flex items-center justify-between px-6 py-4 border-b border-border flex-shrink-0">
        <div>
          <h1 className="text-base font-semibold text-text-primary">{t.dashboard.title}</h1>
          <p className="text-xs text-text-muted mt-0.5">{loading ? t.dashboard.loading : t.dashboard.sessions(sessions.length)}</p>
        </div>
        <div className="flex gap-2">
          <button onClick={() => navigate('/session/import')}
            className="flex items-center gap-2 px-3.5 py-2 bg-surface-2 hover:bg-surface border border-border text-text-primary rounded-lg text-sm transition-colors">
            {t.dashboard.importFile}
          </button>
          <button onClick={() => navigate('/session/setup')}
            className="flex items-center gap-2 px-3.5 py-2 bg-accent hover:bg-accent-hover text-white rounded-lg text-sm transition-colors">
            {t.dashboard.newMeeting}
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto p-6">
        {loading ? <Skeleton /> : sessions.length === 0 ? (
          <EmptyState onNew={() => navigate('/session/setup')} onImport={() => navigate('/session/import')} />
        ) : (
          <div className="space-y-2 max-w-3xl">
            {sessions.map(s => (
              <SessionCard key={s.id} session={s}
                onOpen={() => navigate(getSessionRoute(s))}
                onDelete={() => handleDelete(s.id)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
