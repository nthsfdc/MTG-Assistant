import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useT } from '../i18n';
import { useRecordingStore } from '../store/recordingStore';

function pad(n: number) { return n.toString().padStart(2, '0'); }

function NavItem({ to, icon, label, end }: { to: string; icon: string; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end}
      className={({ isActive }) =>
        `flex items-center gap-2.5 px-3 py-2 rounded-lg text-sm transition-colors ${
          isActive ? 'bg-accent/15 text-accent font-medium' : 'text-text-muted hover:text-text-primary hover:bg-surface-2'
        }`
      }
    >
      <span>{icon}</span>{label}
    </NavLink>
  );
}

export function Layout({ children }: { children: ReactNode }) {
  const { t } = useT();
  const { sessionId, elapsed } = useRecordingStore();
  const elapsed_str = `${pad(Math.floor(elapsed / 60))}:${pad(elapsed % 60)}`;

  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <aside className="w-56 flex-shrink-0 flex flex-col bg-surface border-r border-border">
        <div className="px-4 pt-5 pb-4 flex items-center gap-2.5">
          <span className="text-xl">🎙</span>
          <span className="text-sm font-semibold text-text-primary tracking-wide">{t.appName}</span>
        </div>
        <nav className="flex-1 px-2 space-y-0.5">
          <NavItem to="/"         icon="🏠" label={t.nav.dashboard} end />
          <NavItem to="/settings" icon="⚙️" label={t.nav.settings} />
        </nav>
        {sessionId && (
          <NavLink to={`/session/${sessionId}/rec`}
            className="mx-2 mb-2 px-3 py-2 rounded-lg bg-red-500/10 border border-red-500/20 hover:bg-red-500/15 transition-colors flex items-center gap-2">
            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
            <span className="text-xs text-red-400 font-mono tabular-nums">{elapsed_str}</span>
            <span className="text-xs text-red-400/70 ml-auto">●REC</span>
          </NavLink>
        )}
        <div className="px-4 py-3 text-xs text-text-muted border-t border-border">v1.4.0</div>
      </aside>
      <main className="flex-1 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}
