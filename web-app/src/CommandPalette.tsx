import { useEffect, useMemo, useRef, useState } from 'react';
import { Search } from 'lucide-react';
import { fuzzyScore } from './fuzzy';

// Cmd/Ctrl+K: jump to a class or symbol, or run a command. Type ">" for
// commands only and "@" for symbols only.

export interface PaletteItem {
  id: string;
  title: string;
  /** Muted text after the title (package, status, tool). */
  detail?: string;
  /** Leading mark: a kind letter for classes and symbols. */
  mark?: { text: string; tone: string };
  /** Shortcut shown on the right. */
  keys?: string;
  /** Extra text matched by the query (e.g. the full path). */
  match?: string;
  run: () => void;
}

type Group = 'Classes' | 'Symbols' | 'Commands';

function rank(items: PaletteItem[], q: string, limit: number): PaletteItem[] {
  if (!q) return items.slice(0, limit);
  const scored: { item: PaletteItem; score: number }[] = [];
  for (const item of items) {
    const a = fuzzyScore(q, item.title);
    const b = item.match ? fuzzyScore(q, item.match) : null;
    const score = Math.max(a != null ? a + 5 : -1, b ?? -1);
    if (score >= 0) scored.push({ item, score });
  }
  scored.sort((x, y) => y.score - x.score || x.item.title.length - y.item.title.length);
  return scored.slice(0, limit).map((s) => s.item);
}

export default function CommandPalette({
  classes: getClasses, symbols, commands: getCommands, initialQuery = '', onClose,
}: {
  classes: () => PaletteItem[];
  /** Built on first use: indexing every symbol can take a moment on big archives. */
  symbols?: () => PaletteItem[];
  commands: () => PaletteItem[];
  initialQuery?: string;
  onClose: () => void;
}) {
  // Built once per opening.
  const [classes] = useState(getClasses);
  const [commands] = useState(getCommands);
  const [query, setQuery] = useState(initialQuery);
  const [index, setIndex] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  const raw = query.trim();
  const mode = raw.startsWith('>') ? 'commands' : raw.startsWith('@') ? 'symbols' : 'all';
  const q = mode === 'all' ? raw : raw.slice(1).trim();
  const [getSymbols] = useState(() => symbols);
  const wantSymbols = !!symbols && (mode === 'symbols' || (mode === 'all' && q.length >= 2));
  const symbolIndex = useMemo(() => (wantSymbols && getSymbols ? getSymbols() : null), [wantSymbols, getSymbols]);

  const groups = useMemo(() => {
    const out: { name: Group; items: PaletteItem[] }[] = [];
    if (mode === 'all') out.push({ name: 'Classes', items: rank(classes, q, q ? 8 : 6) });
    if (symbolIndex && mode !== 'commands') out.push({ name: 'Symbols', items: rank(symbolIndex, q, mode === 'symbols' ? 40 : 5) });
    if (mode !== 'symbols') out.push({ name: 'Commands', items: rank(commands, q, mode === 'commands' ? 40 : q ? 6 : 8) });
    return out.filter((g) => g.items.length);
  }, [mode, q, classes, commands, symbolIndex]);

  const flat = groups.flatMap((g) => g.items);
  const active = Math.min(index, flat.length - 1);

  useEffect(() => {
    listRef.current?.querySelector('.cp-row.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active, query]);

  const run = (item: PaletteItem | undefined) => {
    if (!item) return;
    onClose();
    item.run();
  };

  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setIndex((i) => Math.min(Math.min(i, flat.length - 1) + 1, flat.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setIndex((i) => Math.max(Math.min(i, flat.length - 1) - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); run(flat[active]); }
    else if (e.key === 'Escape') { e.preventDefault(); onClose(); }
  };

  let n = -1;
  return (
    <div className="cp-overlay" onMouseDown={onClose}>
      <div className="cp" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <label className="cp-search">
          <Search size={16} aria-hidden />
          <input
            autoFocus
            value={query}
            onChange={(e) => { setQuery(e.target.value); setIndex(0); }}
            onKeyDown={onKey}
            placeholder="Search classes, files and commands…"
            spellCheck={false}
            aria-label="Search classes, files and commands"
            role="combobox"
            aria-expanded
            aria-controls="cp-list"
          />
          <span className="cp-modes">&gt; commands{symbols ? ' · @ symbols' : ''}</span>
        </label>
        <div className="cp-list" id="cp-list" role="listbox" ref={listRef}>
          {flat.length === 0 && <div className="cp-empty">Nothing matches “{q}”</div>}
          {groups.map((g) => (
            <div key={g.name} role="group" aria-label={g.name}>
              <div className="cp-group">{g.name}</div>
              {g.items.map((item) => {
                n++;
                const i = n;
                return (
                  <button
                    key={item.id}
                    role="option"
                    aria-selected={i === active}
                    className={`cp-row${i === active ? ' is-active' : ''}`}
                    onMouseMove={() => { if (i !== active) setIndex(i); }}
                    onClick={() => run(item)}
                  >
                    <span className={`cp-mark ${item.mark?.tone ?? 'cp-cmd'}`}>{item.mark?.text ?? '›'}</span>
                    <span className="cp-title">{item.title}</span>
                    {item.detail && <span className="cp-detail">{item.detail}</span>}
                    <span className="cp-spacer" />
                    {item.keys ? <kbd>{item.keys}</kbd> : i === active ? <kbd>↵</kbd> : null}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
        <div className="cp-foot">
          <span>↑↓ navigate</span>
          <span>↵ open</span>
          <span className="cp-spacer" />
          <span>esc close</span>
        </div>
      </div>
    </div>
  );
}
