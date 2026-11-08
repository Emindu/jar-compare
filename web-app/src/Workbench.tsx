import type { ReactNode } from 'react';
import { House, Minus, Moon, Plus, Sun, type LucideIcon } from 'lucide-react';
import { TOOLS, type Tool, type JvmState } from './shell';

// The workbench shell: a title bar (brand, breadcrumb, actions), an activity
// bar for switching tools, and a status bar. Each tool renders into the main
// area between them.

export function TitleBar({
  crumbs, onHome, actions, center, dirty,
}: {
  crumbs: string[];
  /** Mark the last crumb as having unsaved changes. */
  dirty?: boolean;
  onHome: () => void;
  actions?: ReactNode;
  center?: ReactNode;
}) {
  return (
    <header className="wb-title">
      <div className="wb-title-left">
        <button className="wb-brand" onClick={onHome} title="Home">
          <span className="wb-logo" aria-hidden>jc</span>
          <span className="wb-brand-name">jar-compare</span>
        </button>
        {crumbs.map((c, i) => (
          <span key={i} className={`wb-crumb${i === crumbs.length - 1 ? ' is-last' : ''}`}>
            <span className="wb-crumb-sep" aria-hidden>/</span>
            <span className="wb-crumb-text" title={c}>{c}</span>
            {dirty && i === crumbs.length - 1 && <span className="wb-dirty" title="Unsaved changes" aria-label="Unsaved changes" />}
          </span>
        ))}
      </div>
      <div className="wb-title-center">{center}</div>
      <div className="wb-title-right">{actions}</div>
    </header>
  );
}

/** Page-wide text size: smaller / the current percentage (click to reset) / larger. */
export function FontControl({ scale, onSet }: { scale: number; onSet: (next: number) => void }) {
  const step = (d: number) => {
    const next = Math.round((scale + d) * 20) / 20;
    onSet(Math.min(1.4, Math.max(0.8, next)));
  };
  return (
    <span className="wb-font-ctl">
      <button className="wb-icon-btn" onClick={() => step(-0.05)} title="Decrease page text size" aria-label="Decrease page text size"><Minus size={15} /></button>
      <button className="wb-font-pct" onClick={() => onSet(1)} title="Reset page text size to 100%" aria-label="Reset page text size to 100%">{Math.round(scale * 100)}%</button>
      <button className="wb-icon-btn" onClick={() => step(0.05)} title="Increase page text size" aria-label="Increase page text size"><Plus size={15} /></button>
    </span>
  );
}

export function ThemeButton({ theme, onToggle }: { theme: 'light' | 'dark'; onToggle: () => void }) {
  const next = theme === 'dark' ? 'light' : 'dark';
  return (
    <button className="wb-icon-btn" onClick={onToggle} title={`Switch to ${next} theme`} aria-label={`Switch to ${next} theme`}>
      {theme === 'dark' ? <Moon size={16} /> : <Sun size={16} />}
    </button>
  );
}

export function ActivityBar({ tool, onSelect, busy }: { tool: Tool; onSelect: (t: Tool) => void; busy?: Partial<Record<Tool, boolean>> }) {
  const item = (id: Tool, name: string, Icon: LucideIcon, key?: string) => (
    <button
      key={id}
      className={`wb-activity-btn${tool === id ? ' is-active' : ''}`}
      onClick={() => onSelect(id)}
      title={key ? `${name} (${key})` : name}
      aria-label={name}
      aria-current={tool === id ? 'page' : undefined}
    >
      <Icon size={18} strokeWidth={1.75} />
      {busy?.[id] && <span className="wb-activity-dot" aria-hidden />}
    </button>
  );
  return (
    <nav className="wb-activity" aria-label="Tools">
      {item('home', 'Home', House)}
      {TOOLS.map((t) => item(t.id, t.name, t.Icon, t.key))}
    </nav>
  );
}

export function StatusBar({ jvm, left, right }: { jvm: JvmState; left?: ReactNode; right?: ReactNode }) {
  const label = jvm === 'ready' ? 'JVM ready' : jvm === 'loading' ? 'JVM loading…' : jvm === 'error' ? 'JVM failed to start' : 'JVM offline';
  return (
    <footer className="wb-status">
      <span className={`wb-status-jvm is-${jvm}`}>
        <span className="wb-dot" aria-hidden />
        {label}
      </span>
      {left}
      <span className="wb-status-spacer" />
      {right}
    </footer>
  );
}
