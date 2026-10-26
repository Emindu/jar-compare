import { useEffect, useMemo, useRef, useState } from 'react';
import ReactDiffViewer, { DiffMethod } from 'react-diff-viewer-continued';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import { diffLines } from 'diff';
import { ArrowLeftRight, ChevronUp, ChevronDown, Copy, X, Search } from 'lucide-react';
import { CHANGE_META, CHANGE_OF, allEntries, type Change, type DiffResult, type FileStatus } from './diffModel';

// Compare results in the workbench: a tree of changed entries with status
// filters (left), and tabs, a path bar and a side-by-side or unified diff of
// the selected entry (right). Keys: / filter, j / k next / previous file,
// n / p next / previous change.

type Chip = 'changed' | Change | 'all';

interface TNode {
  name: string;
  key: string;
  children: TNode[];
  entry?: { path: string; status: FileStatus };
}

export interface CompareStatus { change: string; view: string; lang: string }

function langOf(path: string): { id: string; label: string } {
  const name = path.split(' -> ').pop()!.toLowerCase();
  if (name.endsWith('.class') || name.endsWith('.java')) return { id: 'java', label: 'Java' };
  if (/\.(ya?ml)$/.test(name)) return { id: 'yaml', label: 'YAML' };
  if (/\.(xml|xsd|wsdl|pom|html?)$/.test(name)) return { id: 'markup', label: 'XML' };
  if (/\.(properties|mf)$/.test(name) || name.endsWith('manifest.mf')) return { id: 'properties', label: 'Properties' };
  if (name.endsWith('.json')) return { id: 'json', label: 'JSON' };
  if (name.endsWith('.sql')) return { id: 'sql', label: 'SQL' };
  return { id: 'text', label: 'Text' };
}

const baseName = (path: string) => path.split(' -> ').pop()!.split('/').pop() || path;
const kb = (chars: number) => (chars < 1024 ? `${chars} B` : `${(chars / 1024).toFixed(1)} KB`);

/** Build the changes tree; nested archives become folders of their own changes. */
function buildTree(entries: { path: string; status: FileStatus }[]): TNode {
  const root: TNode = { name: '', key: '', children: [] };
  const byKey = new Map<string, TNode>([['', root]]);
  for (const e of entries) {
    const chain = e.path.split(' -> ');
    let parent = root;
    chain.forEach((seg, ci) => {
      const parts = seg.split('/').filter(Boolean);
      parts.forEach((part, pi) => {
        const key = [...chain.slice(0, ci), parts.slice(0, pi + 1).join('/')].join(' -> ');
        let node = byKey.get(key);
        if (!node) {
          node = { name: part, key, children: [] };
          byKey.set(key, node);
          parent.children.push(node);
        }
        parent = node;
      });
    });
    parent.entry = e;
  }
  const finish = (n: TNode): TNode => {
    n.children = n.children.map(finish);
    // Compact single-child folder chains: com/ → acme/ → orders/ becomes com/acme/orders/.
    while (!n.entry && n.children.length === 1 && !n.children[0].entry && n.children[0].children.length && n !== root) {
      const c = n.children[0];
      n.name = `${n.name}/${c.name}`;
      n.key = c.key;
      n.children = c.children;
    }
    n.children.sort((a, b) => {
      const ad = a.entry ? 1 : 0, bd = b.entry ? 1 : 0;
      return ad - bd || a.name.localeCompare(b.name);
    });
    return n;
  };
  return finish(root);
}

export default function CompareView({
  diff, nameA, nameB, theme, selected, onSelect, onNested, expanding, expanded, onSwap, onStatus,
}: {
  diff: DiffResult;
  nameA: string;
  nameB: string;
  theme: 'light' | 'dark';
  selected: string | null;
  onSelect: (path: string | null) => void;
  onNested: (path: string) => void;
  expanding: string | null;
  expanded: Set<string>;
  onSwap: () => void;
  onStatus?: (s: CompareStatus) => void;
}) {
  const [chip, setChip] = useState<Chip>('changed');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [tabs, setTabs] = useState<string[]>([]);
  const [split, setSplit] = useState(true);
  const [ignoreWs, setIgnoreWs] = useState(false);
  const [hunkCount, setHunkCount] = useState(0);
  const [hunk, setHunk] = useState(-1);
  const filterRef = useRef<HTMLInputElement>(null);
  const diffRef = useRef<HTMLDivElement>(null);

  const entries = useMemo(() => allEntries(diff), [diff]);
  const statusOf = useMemo(() => new Map(entries.map((e) => [e.path, e.status])), [entries]);
  const counts = useMemo(() => {
    const c = { add: 0, del: 0, mod: 0, same: 0 };
    for (const e of entries) c[CHANGE_OF[e.status]]++;
    return c;
  }, [entries]);
  const total = entries.length;

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return entries.filter((e) => {
      const ch = CHANGE_OF[e.status];
      const okChip = chip === 'all' || (chip === 'changed' ? ch !== 'same' : ch === chip);
      return okChip && (!q || e.path.toLowerCase().includes(q));
    });
  }, [entries, chip, query]);
  const tree = useMemo(() => buildTree(visible), [visible]);

  // Files in display order, for j / k.
  const order = useMemo(() => {
    const out: string[] = [];
    const walk = (n: TNode) => {
      if (n.entry) out.push(n.entry.path);
      if (!collapsed.has(n.key) || !n.key) n.children.forEach(walk);
    };
    walk(tree);
    return out;
  }, [tree, collapsed]);

  const shownTabs = selected && !tabs.includes(selected) ? [...tabs, selected] : tabs;
  const open = (path: string) => {
    if (!tabs.includes(path)) setTabs((t) => [...t, path]);
    onSelect(path);
  };
  const closeTab = (path: string) => {
    const i = shownTabs.indexOf(path);
    const rest = shownTabs.filter((t) => t !== path);
    setTabs(rest);
    if (path === selected) onSelect(rest[Math.min(i, rest.length - 1)] ?? null);
  };

  const status = selected ? statusOf.get(selected) ?? null : null;
  const change = status ? CHANGE_OF[status] : null;
  const c1 = (selected && diff.contents[selected]?.content1) || '';
  const c2 = (selected && diff.contents[selected]?.content2) || '';
  const lang = selected ? langOf(selected) : { id: 'text', label: 'Text' };
  const lineCounts = useMemo(() => {
    let add = 0, del = 0;
    for (const part of diffLines(c1, c2, { ignoreWhitespace: ignoreWs })) {
      if (part.added) add += part.count ?? 0;
      else if (part.removed) del += part.count ?? 0;
    }
    return { add, del };
  }, [c1, c2, ignoreWs]);

  // Group changed rows of the rendered diff into hunks for n / p.
  const hunks = () => {
    const rows = [...(diffRef.current?.querySelectorAll('tr') ?? [])];
    const out: HTMLTableRowElement[][] = [];
    let cur: HTMLTableRowElement[] | null = null;
    for (const r of rows) {
      const changed = !!r.querySelector('[class*="-diff-added"], [class*="-diff-removed"]');
      if (changed) { if (!cur) { cur = []; out.push(cur); } cur.push(r); } else cur = null;
    }
    return out;
  };
  // The diff renders asynchronously, so recount hunks whenever its rows change.
  useEffect(() => {
    const el = diffRef.current;
    if (!el) return;
    let raf = requestAnimationFrame(() => { setHunkCount(hunks().length); setHunk(-1); });
    const mo = new MutationObserver(() => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => setHunkCount(hunks().length));
    });
    mo.observe(el, { childList: true, subtree: true });
    return () => { cancelAnimationFrame(raf); mo.disconnect(); };
  }, [selected, split, ignoreWs, c1, c2]);

  const goHunk = (dir: 1 | -1) => {
    const hs = hunks();
    if (!hs.length) return;
    const next = hunk < 0 ? (dir > 0 ? 0 : hs.length - 1) : (hunk + dir + hs.length) % hs.length;
    setHunk(next);
    hs[next][0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    for (const r of hs[next]) {
      r.classList.remove('cv-flash');
      void r.offsetWidth;
      r.classList.add('cv-flash');
    }
  };

  const goFile = (dir: 1 | -1) => {
    if (!order.length) return;
    const i = selected ? order.indexOf(selected) : -1;
    open(order[i < 0 ? (dir > 0 ? 0 : order.length - 1) : Math.min(order.length - 1, Math.max(0, i + dir))]);
  };

  // Keyboard: / filter, j/k files, n/p changes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) {
        if (e.key === 'Escape' && t === filterRef.current) { setQuery(''); t.blur(); }
        return;
      }
      if (e.key === '/') { e.preventDefault(); filterRef.current?.focus(); }
      else if (e.key === 'j') goFile(1);
      else if (e.key === 'k') goFile(-1);
      else if (e.key === 'n') goHunk(1);
      else if (e.key === 'p') goHunk(-1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    onStatus?.({
      change: hunkCount ? (hunk >= 0 ? `change ${hunk + 1}/${hunkCount}` : `${hunkCount} change${hunkCount === 1 ? '' : 's'}`) : '',
      view: split ? 'split' : 'unified',
      lang: selected ? lang.label : '',
    });
  }, [onStatus, hunk, hunkCount, split, selected, lang.label]);

  const highlight = (source: string) =>
    lang.id === 'text' || c1.length + c2.length > 400_000 ? <span>{source}</span> : (
      <SyntaxHighlighter
        language={lang.id}
        style={theme === 'dark' ? oneDark : oneLight}
        PreTag="span"
        CodeTag="span"
        customStyle={{ background: 'transparent', padding: 0, margin: 0, display: 'inline', textShadow: 'none' }}
        codeTagProps={{ style: { fontFamily: 'var(--font-mono)', background: 'transparent', textShadow: 'none' } }}
      >
        {source}
      </SyntaxHighlighter>
    );

  const toggleDir = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      return next;
    });

  const renderNode = (n: TNode, depth: number): React.ReactNode => {
    const hasKids = n.children.length > 0;
    const isOpen = !collapsed.has(n.key);
    const pad = { paddingLeft: 12 + depth * 14 };
    if (!n.entry) {
      return (
        <li key={n.key}>
          <button className="cv-row is-dir" style={pad} onClick={() => toggleDir(n.key)} aria-expanded={isOpen}>
            <span className="cv-caret" aria-hidden>{isOpen ? '▾' : '▸'}</span>
            <span className="cv-name">{n.name}/</span>
          </button>
          {isOpen && <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
        </li>
      );
    }
    const { path, status } = n.entry;
    const ch = CHANGE_OF[status];
    const nested = status === 'modifiedNested';
    const busy = expanding === path;
    return (
      <li key={n.key}>
        <button
          className={`cv-row${selected === path ? ' is-selected' : ''}${ch === 'del' ? ' is-removed' : ''}`}
          style={pad}
          onClick={() => open(path)}
          onDoubleClick={nested ? () => onNested(path) : undefined}
          title={nested ? `${path}: double-click to compare its contents` : path}
        >
          <span className="cv-caret" aria-hidden onClick={hasKids ? (e) => { e.stopPropagation(); toggleDir(n.key); } : undefined}>
            {hasKids ? (isOpen ? '▾' : '▸') : ''}
          </span>
          <span className="cv-name">{n.name}</span>
          {nested && <span className="cv-nested">{busy ? 'comparing…' : expanded.has(path) ? 'nested ✓' : 'nested ↵'}</span>}
          <span className={`cv-glyph g-${ch}`} aria-label={CHANGE_META[ch].label}>{CHANGE_META[ch].glyph}</span>
        </button>
        {hasKids && isOpen && <ul>{n.children.map((c) => renderNode(c, depth + 1))}</ul>}
      </li>
    );
  };

  const chipCount: Record<Chip, number> = { changed: total - counts.same, add: counts.add, del: counts.del, mod: counts.mod, same: counts.same, all: total };
  const chips: Chip[] = ['changed', 'add', 'del', 'mod', 'same', 'all'];
  const chipLabel = (c: Chip) => (c === 'changed' || c === 'all' ? c : CHANGE_META[c].glyph);

  const dir = selected ? selected.slice(0, selected.length - baseName(selected).length) : '';

  return (
    <div className="cv">
      <aside className="cv-side">
        <header className="cv-side-hd">
          <h2 className="wb-label">Changes</h2>
          <span className="cv-side-count">{visible.length} of {total}</span>
        </header>
        <label className="cv-filter">
          <Search size={13} aria-hidden />
          <input ref={filterRef} value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Filter paths" spellCheck={false} aria-label="Filter paths" />
          <kbd>/</kbd>
        </label>
        <div className="cv-chips" role="group" aria-label="Show">
          {chips.map((c) => (
            <button
              key={c}
              className={`cv-chip chip-${c}${chip === c ? ' is-on' : ''}`}
              onClick={() => setChip(c)}
              disabled={c !== 'changed' && c !== 'all' && !chipCount[c]}
              aria-pressed={chip === c}
            >
              {chipLabel(c)} <b>{chipCount[c]}</b>
            </button>
          ))}
        </div>
        <ul className="cv-tree">
          {tree.children.map((n) => renderNode(n, 0))}
          {!visible.length && <li className="cv-none">No entries match.</li>}
        </ul>
      </aside>

      <section className="cv-main">
        <header className="cv-head">
          <span className="cv-side-a"><var>a/</var> {nameA}</span>
          <button className="cv-swap" onClick={onSwap} title="Swap a/ and b/ and compare again" aria-label="Swap and compare again">
            <ArrowLeftRight size={14} />
          </button>
          <span className="cv-side-b"><var>b/</var> {nameB}</span>
          <span className="cv-summary">
            <span className="g-add">+{counts.add} added</span>
            <span className="g-del">−{counts.del} removed</span>
            <span className="g-mod">~{counts.mod} modified</span>
            <span className="g-same">≡{counts.same} same source</span>
          </span>
        </header>

        {shownTabs.length > 0 && (
          <div className="cv-tabs" role="tablist">
            {shownTabs.map((t) => {
              const st = statusOf.get(t);
              const ch = st ? CHANGE_OF[st] : 'mod';
              return (
                <div key={t} className={`cv-tab${t === selected ? ' is-active' : ''}`} role="tab" aria-selected={t === selected}>
                  <button className="cv-tab-open" onClick={() => onSelect(t)} title={t}>
                    <span className={`g-${ch}`}>{CHANGE_META[ch].glyph}</span> {baseName(t)}
                  </button>
                  <button className="cv-tab-x" onClick={() => closeTab(t)} aria-label={`Close ${baseName(t)}`}><X size={12} /></button>
                </div>
              );
            })}
          </div>
        )}

        {selected && change ? (
          <>
            <div className="cv-path">
              <span className="cv-path-text" title={selected}>
                <span className="cv-path-dir">{dir.replace(/ -> /g, ' › ')}</span>
                <b>{baseName(selected)}</b>
              </span>
              <span className={`cv-badge b-${change}`}>{CHANGE_META[change].glyph} {CHANGE_META[change].label}</span>
              {status !== 'modifiedNested' && (lineCounts.add > 0 || lineCounts.del > 0) && (
                <span className="cv-lines"><span className="g-add">+{lineCounts.add}</span> <span className="g-del">−{lineCounts.del}</span></span>
              )}
              <span className="cv-path-spacer" />
              {status !== 'modifiedNested' && (
                <>
                  <span className="cv-seg" role="group" aria-label="Diff layout">
                    <button className={split ? 'is-on' : ''} onClick={() => setSplit(true)} aria-pressed={split}>Split</button>
                    <button className={!split ? 'is-on' : ''} onClick={() => setSplit(false)} aria-pressed={!split}>Unified</button>
                  </span>
                  <label className="cv-check">
                    <input type="checkbox" checked={ignoreWs} onChange={(e) => setIgnoreWs(e.target.checked)} /> Ignore whitespace
                  </label>
                  <button className="cv-icon" onClick={() => goHunk(-1)} disabled={!hunkCount} title="Previous change (p)" aria-label="Previous change"><ChevronUp size={15} /></button>
                  <button className="cv-icon" onClick={() => goHunk(1)} disabled={!hunkCount} title="Next change (n)" aria-label="Next change"><ChevronDown size={15} /></button>
                  <span className="cv-change">{hunkCount ? `change ${Math.max(hunk + 1, 0) || '–'} / ${hunkCount}` : 'no changes'}</span>
                </>
              )}
              <button className="wb-btn cv-copy" onClick={() => navigator.clipboard?.writeText(selected)}><Copy size={13} /> Copy path</button>
            </div>

            {status === 'identicalSourceClasses' && (
              <div className="cv-note g-same">
                <b>≡ Same source.</b> The bytecode differs (compiler version, line numbers or debug info), but it decompiles to identical Java.
              </div>
            )}

            <div className="cv-diff" ref={diffRef}>
              {status === 'modifiedNested' ? (
                <div className="cv-nested-panel">
                  <h3>{baseName(selected)} differs</h3>
                  <p>This archive is nested inside both builds. Compare its contents to see every changed class and resource in the tree.</p>
                  <button className="wb-btn wb-btn-primary" disabled={expanding === selected} onClick={() => onNested(selected)}>
                    {expanding === selected ? 'Comparing…' : expanded.has(selected) ? 'Show its changes' : 'Compare contents'}
                  </button>
                  <p className="cv-hint">Tip: double-click a nested archive in the tree.</p>
                </div>
              ) : (
                <ReactDiffViewer
                  oldValue={c1}
                  newValue={c2}
                  splitView={split}
                  compareMethod={ignoreWs ? DiffMethod.TRIMMED_LINES : DiffMethod.CHARS}
                  useDarkTheme={theme === 'dark'}
                  leftTitle={`a/ ${nameA} · ${kb(c1.length)}`}
                  rightTitle={`b/ ${nameB} · ${kb(c2.length)}`}
                  renderContent={highlight}
                  extraLinesSurroundingDiff={4}
                  hideSummary
                  loadingElement={() => <div className="cv-loading">Computing diff…</div>}
                  styles={DIFF_STYLES}
                />
              )}
            </div>
          </>
        ) : (
          <div className="cv-empty">
            <p className="cv-empty-title">{total} entries changed between these builds</p>
            <p>Pick one from the tree, or press <kbd>j</kbd> to walk through them. <kbd>n</kbd> and <kbd>p</kbd> jump between changes inside a file.</p>
          </div>
        )}
      </section>
    </div>
  );
}

// Theme the diff with the workbench tokens (the same values work in both themes).
const vars = {
  diffViewerBackground: 'var(--bg)',
  diffViewerColor: 'var(--text)',
  addedBackground: 'color-mix(in srgb, var(--add) 12%, transparent)',
  addedColor: 'var(--text)',
  removedBackground: 'color-mix(in srgb, var(--del) 12%, transparent)',
  removedColor: 'var(--text)',
  wordAddedBackground: 'color-mix(in srgb, var(--add) 30%, transparent)',
  wordRemovedBackground: 'color-mix(in srgb, var(--del) 30%, transparent)',
  addedGutterBackground: 'color-mix(in srgb, var(--add) 18%, transparent)',
  removedGutterBackground: 'color-mix(in srgb, var(--del) 18%, transparent)',
  gutterBackground: 'var(--bg)',
  gutterBackgroundDark: 'var(--bg)',
  highlightBackground: 'var(--selection)',
  highlightGutterBackground: 'var(--selection)',
  codeFoldGutterBackground: 'var(--sidebar)',
  codeFoldBackground: 'var(--sidebar)',
  emptyLineBackground: 'color-mix(in srgb, var(--raised) 45%, transparent)',
  gutterColor: 'var(--text-faint)',
  addedGutterColor: 'var(--add)',
  removedGutterColor: 'var(--del)',
  codeFoldContentColor: 'var(--text-muted)',
  diffViewerTitleBackground: 'var(--panel)',
  diffViewerTitleColor: 'var(--text-muted)',
  diffViewerTitleBorderColor: 'var(--line)',
};
const DIFF_STYLES = {
  variables: { dark: vars, light: vars },
  diffContainer: { minWidth: 'auto' },
  line: { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '20px' },
  contentText: { fontFamily: 'var(--font-mono)', fontSize: '13px', lineHeight: '20px' },
  lineNumber: { fontFamily: 'var(--font-mono)', fontSize: '12px' },
  gutter: { minWidth: '44px', padding: '0 10px' },
  marker: { width: '20px', paddingLeft: '4px' },
  titleBlock: { fontFamily: 'var(--font-mono)', fontSize: '12px', padding: '6px 12px' },
  codeFold: { fontFamily: 'var(--font-mono)', fontSize: '12px' },
};
