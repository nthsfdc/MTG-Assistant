import { NavLink } from 'react-router-dom';
import type { ReactNode } from 'react';
import { useT } from '../i18n';

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
  return (
    <div className="flex h-screen overflow-hidden bg-bg">
      <aside className="w-56 flex-shrink-0 flex flex-col bg-surface border-r border-border">
        <div className="px-4 pt-5 pb-4 flex items-center gap-2.5">
          <span className="text-xl">🎙</span>
          <span className="text-sm font-semibold text-text-primary tracking-wide">MTG Assistant</span>
        </div>
        <nav className="flex-1 px-2 space-y-0.5">
          <NavItem to="/"         icon="🏠" label={t.nav.dashboard} end />
          <NavItem to="/settings" icon="⚙️" label={t.nav.settings} />
        </nav>
        <div className="px-4 py-3 text-xs text-text-muted border-t border-border">v1.0.0</div>
      </aside>
      <main className="flex-1 overflow-hidden flex flex-col">{children}</main>
    </div>
  );
}
