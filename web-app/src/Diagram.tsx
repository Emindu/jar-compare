import { useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { DiagramLinks, type DiagramEntry } from './diagramLinks';

// Mermaid diagrams: rendering, plus an interaction layer on top of the SVG that
// mermaid produces. Each rendered SVG is indexed into nodes and edges, which
// powers click-to-trace (upstream / downstream paths), in-diagram search,
// highlighting from `code` mentions in the surrounding text, and SVG/PNG export.

type Theme = 'light' | 'dark';

// ── Rendering ──────────────────────────────────────────────────────────────

type MermaidApi = typeof import('mermaid').default;
let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme: Theme | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** Renders serially: mermaid keeps global state and doesn't like concurrent renders. */
function renderMermaid(src: string, theme: Theme): Promise<string> {
  const job = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    if (mermaidTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'var(--font-sans)',
        // Errors are shown in our own block; don't let mermaid append its own to <body>.
        suppressErrorRendering: true,
      });
      mermaidTheme = theme;
    }
    const id = `mmd-${++renderSeq}`;
    try {
      await mermaid.parse(src);
      const { svg } = await mermaid.render(id, src);
      return svg;
    } finally {
      // A failed render can leave its scratch container behind.
      document.getElementById(`d${id}`)?.remove();
    }
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

// ── Indexing ───────────────────────────────────────────────────────────────

interface DItem {
  key: string;
  kind: 'node' | 'edge';
  els: Element[];
  chunks: string[]; // separate text runs (label lines)
  text: string;
  from?: string;
  to?: string;
  cluster?: boolean; // a flowchart subgraph
}

interface DGraph {
  items: Map<string, DItem>;
  /** 'flow': edges have endpoints, trace transitively. 'sequence': trace direct messages. */
  mode: 'flow' | 'sequence' | null;
}

const graphs = new WeakMap<SVGSVGElement, DGraph>();

function textChunks(els: Element[]): string[] {
  const out: string[] = [];
  for (const el of els) {
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n = w.nextNode(); n; n = w.nextNode()) {
      const s = n.textContent?.replace(/\s+/g, ' ').trim();
      if (s) out.push(s);
    }
  }
  return out;
}

function indexDiagram(svg: SVGSVGElement): DGraph {
  const items = new Map<string, DItem>();
  const add = (key: string, kind: DItem['kind'], el: Element, extra: Partial<DItem> = {}) => {
    let it = items.get(key);
    if (!it) { it = { key, kind, els: [], chunks: [], text: '', ...extra }; items.set(key, it); }
    it.els.push(el);
    el.setAttribute('data-dg', key);
    return it;
  };
  const role = svg.getAttribute('aria-roledescription') || '';
  const prefix = svg.id ? `${svg.id}-` : '';
  const local = (id: string) => (prefix && id.startsWith(prefix) ? id.slice(prefix.length) : id);
  let mode: DGraph['mode'] = null;

  if (role === 'sequence') {
    mode = 'sequence';
    svg.querySelectorAll('rect.actor[name]').forEach((r) => add(`n:${r.getAttribute('name')}`, 'node', r.parentElement ?? r));
    svg.querySelectorAll('line.actor-line[name]').forEach((l) => add(`n:${l.getAttribute('name')}`, 'node', l));
    const lines = [...svg.querySelectorAll('[data-et="message"]')];
    const texts = [...svg.querySelectorAll('text.messageText')];
    lines.forEach((l, i) => {
      const it = add(`e:${l.getAttribute('data-id') ?? i}`, 'edge', l, {
        from: `n:${l.getAttribute('data-from')}`,
        to: `n:${l.getAttribute('data-to')}`,
      });
      if (texts.length === lines.length) add(it.key, 'edge', texts[i]);
    });
  } else {
    if (role.startsWith('flowchart')) mode = 'flow';
    svg.querySelectorAll('g.node[id]').forEach((g) => {
      const id = local(g.id);
      const m = /^flowchart-(.+)-\d+$/.exec(id);
      add(`n:${m ? m[1] : id}`, 'node', g);
    });
    // Subgraphs are nodes too: edges may start or end on them.
    svg.querySelectorAll('g.cluster[id]').forEach((g) => add(`n:${local(g.id)}`, 'node', g, { cluster: true }));
    const edgeKey = new Map<string, string>();
    svg.querySelectorAll('path[data-edge="true"][data-id]').forEach((p) => {
      const did = p.getAttribute('data-id')!;
      const extra: Partial<DItem> = {};
      // Flowchart edge ids are L_<from>_<to>_<n>; node ids may contain "_" so try each split.
      const m = mode === 'flow' ? /^L_(.+)_\d+$/.exec(did) : null;
      if (m) {
        const s = m[1];
        for (let i = s.indexOf('_'); i > 0; i = s.indexOf('_', i + 1)) {
          const a = `n:${s.slice(0, i)}`, b = `n:${s.slice(i + 1)}`;
          if (items.has(a) && items.has(b)) { extra.from = a; extra.to = b; break; }
        }
      }
      edgeKey.set(did, `e:${did}`);
      add(`e:${did}`, 'edge', p, extra);
    });
    svg.querySelectorAll('g.edgeLabel g.label[data-id]').forEach((l) => {
      const key = edgeKey.get(l.getAttribute('data-id')!);
      const g = l.closest('g.edgeLabel');
      if (key && g) add(key, 'edge', g);
    });
  }

  for (const it of items.values()) {
    it.chunks = textChunks(it.els);
    it.text = it.chunks.join(' ');
  }
  return { items, mode };
}

function getGraph(svg: SVGSVGElement): DGraph {
  let g = graphs.get(svg);
  if (!g) { g = indexDiagram(svg); graphs.set(svg, g); }
  return g;
}

function itemLabel(g: DGraph, key: string): string {
  const it = g.items.get(key);
  if (!it) return '';
  if (it.kind === 'edge' && !it.text && it.from && it.to) {
    return `${itemLabel(g, it.from)} → ${itemLabel(g, it.to)}`;
  }
  return it.chunks[0] || key.slice(2);
}

/** Nodes drawn inside a subgraph (mermaid doesn't nest them in the DOM, so go by geometry). */
function clusterMembers(g: DGraph, cluster: DItem): string[] {
  const box = cluster.els[0].getBoundingClientRect();
  return [...g.items.values()]
    .filter((it) => it.kind === 'node' && it !== cluster)
    .filter((it) => {
      const r = it.els[0].getBoundingClientRect();
      const cx = r.x + r.width / 2, cy = r.y + r.height / 2;
      return r.width > 0 && cx > box.left && cx < box.right && cy > box.top && cy < box.bottom;
    })
    .map((it) => it.key);
}

/** Selected item(s) plus everything upstream / downstream of them. */
function trace(g: DGraph, key: string): { sel: Set<string>; up: Set<string>; down: Set<string> } {
  const up = new Set<string>(), down = new Set<string>();
  const sel = new Set([key]);
  const it = g.items.get(key);
  if (!it) return { sel, up, down };
  // Selecting a subgraph traces from everything inside it.
  if (it.cluster) clusterMembers(g, it).forEach((k) => sel.add(k));
  const edges = [...g.items.values()].filter((e) => e.kind === 'edge' && e.from && e.to);
  if (it.kind === 'edge') {
    if (it.from) up.add(it.from);
    if (it.to) down.add(it.to);
    return { sel, up, down };
  }
  if (g.mode === 'sequence') {
    for (const e of edges) {
      if (e.from === key) { down.add(e.key); down.add(e.to!); }
      else if (e.to === key) { up.add(e.key); up.add(e.from!); }
    }
    return { sel, up, down };
  }
  const walk = (dir: 'down' | 'up', into: Set<string>) => {
    const queue = [...sel];
    const seen = new Set(sel);
    while (queue.length) {
      const cur = queue.shift()!;
      for (const e of edges) {
        const [a, b] = dir === 'down' ? [e.from!, e.to!] : [e.to!, e.from!];
        if (a !== cur) continue;
        into.add(e.key);
        if (!seen.has(b)) { seen.add(b); into.add(b); queue.push(b); }
      }
    }
  };
  walk('down', down);
  walk('up', up);
  sel.forEach((k) => { up.delete(k); down.delete(k); });
  return { sel, up, down };
}

const FOCUS_CLASSES = ['dg-on', 'dg-sel', 'dg-up', 'dg-down', 'dg-hit'];

/** Apply selection / search highlighting to a rendered SVG. Returns the number of search hits. */
function applyFocus(svg: SVGSVGElement, sel: string | null, query: string): number {
  const g = getGraph(svg);
  svg.querySelectorAll('[data-dg]').forEach((e) => e.classList.remove(...FOCUS_CLASSES));
  const mark = (key: string, ...cls: string[]) => g.items.get(key)?.els.forEach((e) => e.classList.add('dg-on', ...cls));
  const q = query.trim().toLowerCase();
  let hits = 0;
  let focus = false;
  if (q) {
    focus = true;
    for (const it of g.items.values()) {
      if (it.text.toLowerCase().includes(q)) { hits++; mark(it.key, 'dg-hit'); }
    }
  } else if (sel && g.items.has(sel)) {
    focus = true;
    const t = trace(g, sel);
    t.up.forEach((k) => mark(k, 'dg-up'));
    t.down.forEach((k) => mark(k, 'dg-down'));
    t.sel.forEach((k) => mark(k, 'dg-sel'));
  }
  svg.classList.toggle('dg-focus', focus);
  return hits;
}

function applyXref(svg: SVGSVGElement, keys: string[] | null) {
  const g = getGraph(svg);
  svg.querySelectorAll('.dg-xref').forEach((e) => e.classList.remove('dg-xref'));
  keys?.forEach((k) => g.items.get(k)?.els.forEach((e) => e.classList.add('dg-xref')));
}

const isWordChar = (c: string | undefined) => !!c && /[\p{L}\p{N}_]/u.test(c);

/** True if `needle` occurs in `hay` not glued to other word characters. */
function containsWord(hay: string, needle: string): boolean {
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    if (!isWordChar(hay[i - 1]) && !isWordChar(hay[i + needle.length])) return true;
  }
  return false;
}

/** Diagram items that a `code` mention in the text refers to. */
function matchItems(g: DGraph, code: string): string[] {
  const c = code.trim().toLowerCase();
  if (c.length < 4) return [];
  const out: string[] = [];
  for (const it of g.items.values()) {
    const t = it.text.toLowerCase();
    // `TwelveDataSourceAdapter` → node "TwelveDataSourceAdapter retry + circuit breaker";
    // `config/extractor-pipelines.yml` → node "extractor-pipelines.yml + application.yml".
    const head = (ch: string) => ch.split(' ')[0].toLowerCase();
    if (containsWord(t, c) || it.chunks.some((ch) => head(ch).length >= 6 && containsWord(c, head(ch)))) {
      out.push(it.key);
    }
  }
  return out;
}

// ── Export ─────────────────────────────────────────────────────────────────

function serializeSvg(svg: SVGSVGElement): { xml: string; width: number; height: number } {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.classList.remove('dg-focus');
  clone.querySelectorAll('[data-dg]').forEach((e) => {
    e.removeAttribute('data-dg');
    e.classList.remove(...FOCUS_CLASSES, 'dg-xref');
  });
  const vb = svg.viewBox.baseVal;
  const width = Math.ceil(vb?.width || svg.getBoundingClientRect().width);
  const height = Math.ceil(vb?.height || svg.getBoundingClientRect().height);
  clone.setAttribute('width', String(width));
  clone.setAttribute('height', String(height));
  clone.style.maxWidth = '';
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  const css = getComputedStyle(document.documentElement);
  const bg = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  bg.setAttribute('x', String(vb?.x ?? 0));
  bg.setAttribute('y', String(vb?.y ?? 0));
  bg.setAttribute('width', '100%');
  bg.setAttribute('height', '100%');
  if (vb?.width) { bg.setAttribute('width', String(vb.width)); bg.setAttribute('height', String(vb.height)); }
  bg.setAttribute('fill', css.getPropertyValue('--bg').trim() || '#ffffff');
  clone.insertBefore(bg, clone.firstChild);
  // The page's CSS variables don't exist in a standalone file.
  const font = (css.getPropertyValue('--font-sans').trim() || 'sans-serif').replace(/"/g, "'");
  const xml = new XMLSerializer().serializeToString(clone).replace(/var\(--font-sans\)/g, font);
  return { xml, width, height };
}

async function svgToPng(svg: SVGSVGElement, scale = 2): Promise<Blob> {
  const { xml, width, height } = serializeSvg(svg);
  const img = new Image();
  img.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
  await img.decode();
  const canvas = document.createElement('canvas');
  canvas.width = width * scale;
  canvas.height = height * scale;
  const ctx = canvas.getContext('2d')!;
  ctx.scale(scale, scale);
  ctx.drawImage(img, 0, 0, width, height);
  return new Promise((resolve, reject) => {
    try {
      canvas.toBlob((b) => (b ? resolve(b) : reject(new Error('PNG export failed'))), 'image/png');
    } catch (e) {
      reject(e);
    }
  });
}

function save(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Components ─────────────────────────────────────────────────────────────

/** Keeps a host's SVG highlighting in sync with selection / search state. */
function useFocus(
  hostRef: RefObject<HTMLElement | null>,
  countRef: RefObject<HTMLElement | null>,
  dep: unknown,
  sel: string | null,
  query: string,
) {
  useEffect(() => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg) return;
    const hits = applyFocus(svg, sel, query);
    if (countRef.current) countRef.current.textContent = query.trim() ? `${hits} match${hits === 1 ? '' : 'es'}` : '';
  }, [hostRef, countRef, dep, sel, query]);
}

function keyAt(target: EventTarget | null): string | null {
  return (target as Element | null)?.closest?.('[data-dg]')?.getAttribute('data-dg') ?? null;
}

function SearchBox({ query, setQuery, countRef }: { query: string; setQuery: (q: string) => void; countRef: RefObject<HTMLSpanElement | null> }) {
  return (
    <span className="dg-search">
      <input
        className="flame-search"
        placeholder="Find in diagram…"
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }}
        spellCheck={false}
      />
      <span className="dg-count" ref={countRef} />
    </span>
  );
}

function TraceChip({ label, onClear }: { label: string; onClear: () => void }) {
  return (
    <span className="dg-chip" title="Upstream in amber, downstream in green">
      <span className="dg-chip-dot" />
      Tracing <strong>{label}</strong>
      <button onClick={onClear} aria-label="Clear selection">✕</button>
    </span>
  );
}

function ExportMenu({ hostRef, code, theme, name }: {
  hostRef: RefObject<HTMLElement | null>; code: string; theme: Theme; name: string;
}) {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState('');
  const flash = (s: string) => { setStatus(s); setTimeout(() => setStatus(''), 1800); };

  // Labels drawn as HTML (foreignObject) can taint the canvas in some browsers;
  // fall back to re-rendering with plain SVG text labels for raster export.
  const png = async (): Promise<Blob> => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg) throw new Error('Diagram not rendered');
    try {
      return await svgToPng(svg);
    } catch {
      const plain = await renderMermaid(`%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\n${code}`, theme);
      const holder = document.createElement('div');
      holder.style.cssText = 'position:fixed;left:-99999px;top:0';
      holder.innerHTML = plain;
      document.body.appendChild(holder);
      try { return await svgToPng(holder.querySelector('svg')!); } finally { holder.remove(); }
    }
  };

  const act = async (kind: 'svg' | 'png' | 'copy-png' | 'copy-src') => {
    setOpen(false);
    try {
      const svg = hostRef.current?.querySelector('svg');
      if (kind === 'svg') {
        if (!svg) throw new Error('Diagram not rendered');
        save(new Blob([serializeSvg(svg).xml], { type: 'image/svg+xml' }), `${name}.svg`);
      } else if (kind === 'png') {
        save(await png(), `${name}.png`);
      } else if (kind === 'copy-png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': png() })]);
      } else {
        await navigator.clipboard.writeText(code);
      }
      flash(kind.startsWith('copy') ? '✓ Copied' : '✓ Saved');
    } catch (e) {
      console.error(e);
      flash('Export failed');
    }
  };

  return (
    <span className="dg-export">
      <button className="file-action-btn" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {status || 'Export ▾'}
      </button>
      {open && (
        <span className="dg-menu" onMouseLeave={() => setOpen(false)}>
          <button onClick={() => act('svg')}>Download SVG</button>
          <button onClick={() => act('png')}>Download PNG</button>
          <button onClick={() => act('copy-png')}>Copy as PNG</button>
          <button onClick={() => act('copy-src')}>Copy source</button>
        </span>
      )}
    </span>
  );
}

export function MermaidBlock({ code, theme, name }: { code: string; theme: Theme; name: string }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ key: string; label: string } | null>(null);
  const [query, setQuery] = useState('');
  const sel = selected?.key ?? null;
  const figRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const entryRef = useRef<DiagramEntry | null>(null);
  const links = useContext(DiagramLinks);
  // A stable object: React 19 re-applies innerHTML whenever this object changes,
  // which would wipe the highlight classes set on the SVG.
  const html = useMemo(() => ({ __html: svg }), [svg]);

  useEffect(() => {
    let alive = true;
    renderMermaid(code, theme)
      .then((s) => { if (alive) { setSvg(s); setError(''); } })
      .catch((e) => { if (alive) { setSvg(''); setError(String(e?.message || e)); } });
    return () => { alive = false; };
  }, [code, theme]);

  useFocus(hostRef, countRef, `${svg}|${showSource}`, sel, query);

  // Let `code` mentions in the document find and highlight things in this diagram.
  useEffect(() => {
    if (!links || !svg || showSource) return;
    const svgEl = () => hostRef.current?.querySelector('svg') ?? null;
    const entry: DiagramEntry = {
      el: figRef.current!,
      find: (c) => { const s = svgEl(); return s ? matchItems(getGraph(s), c) : []; },
      preview: (keys) => { const s = svgEl(); if (s) applyXref(s, keys); },
      select: (k) => { setQuery(''); choose(k); },
    };
    entryRef.current = entry;
    return links.register(entry);
  }, [links, svg, showSource]);

  useEffect(() => {
    if (links && entryRef.current) links.onSelect(entryRef.current, sel);
  }, [links, sel]);

  function choose(k: string | null) {
    const s = hostRef.current?.querySelector('svg');
    setSelected(k && s ? { key: k, label: itemLabel(getGraph(s), k) } : null);
  }

  // Clicking a node selects it; clicking it again or the background clears.
  const toggle = (k: string | null) => {
    setQuery('');
    choose(k && k !== sel ? k : null);
  };

  return (
    <figure className="md-diagram" ref={figRef}>
      <div className="md-diagram-bar">
        <span className="md-diagram-kind">◇ {code.trim().split(/\s/)[0] || 'diagram'}</span>
        {svg && !showSource && <SearchBox query={query} setQuery={setQuery} countRef={countRef} />}
        {selected && !query && <TraceChip label={selected.label} onClear={() => choose(null)} />}
        <span className="md-diagram-actions">
          <button className="file-action-btn" onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'Diagram' : 'Source'}
          </button>
          {svg && !showSource && <ExportMenu hostRef={hostRef} code={code} theme={theme} name={name} />}
          {svg && <button className="file-action-btn" onClick={() => setExpanded(true)}>⤢ Expand</button>}
        </span>
      </div>
      {showSource ? (
        <pre className="md-diagram-src">{code}</pre>
      ) : error ? (
        <div className="md-diagram-error">
          <strong>Diagram error</strong>
          <pre>{error}</pre>
        </div>
      ) : svg ? (
        <div
          className="md-diagram-svg"
          ref={hostRef}
          title="Click a node to trace its connections · double-click to expand"
          onClick={(e) => toggle(keyAt(e.target))}
          onDoubleClick={() => setExpanded(true)}
          dangerouslySetInnerHTML={html}
        />
      ) : (
        <div className="md-diagram-loading">Rendering diagram…</div>
      )}
      {expanded && svg && (
        <DiagramModal
          svg={svg}
          sel={sel}
          selLabel={selected?.label ?? ''}
          toggle={toggle}
          clear={() => choose(null)}
          query={query}
          setQuery={setQuery}
          onClose={() => setExpanded(false)}
          exportMenu={<ExportMenu hostRef={hostRef} code={code} theme={theme} name={name} />}
        />
      )}
    </figure>
  );
}

function DiagramModal({
  svg, sel, selLabel, toggle, clear, query, setQuery, onClose, exportMenu,
}: {
  svg: string;
  sel: string | null;
  toggle: (k: string | null) => void;
  clear: () => void;
  query: string;
  setQuery: (q: string) => void;
  selLabel: string;
  onClose: () => void;
  exportMenu: React.ReactNode;
}) {
  // Open at fit-to-width, but never so small that labels become unreadable.
  const [zoom, setZoom] = useState(() => {
    const m = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/.exec(svg);
    const w = m ? parseFloat(m[1]) : 0;
    return w ? Math.max(0.5, Math.min(1, (window.innerWidth * 0.94 - 96) / w)) : 1;
  });
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);

  const html = useMemo(() => ({ __html: svg }), [svg]);
  useFocus(hostRef, countRef, svg, sel, query);

  const fitZoom = () => {
    const vb = hostRef.current?.querySelector('svg')?.viewBox?.baseVal;
    const avail = (bodyRef.current?.clientWidth ?? 0) - 48;
    return vb?.width && avail > 0 ? Math.min(1, avail / vb.width) : 1;
  };

  // Mermaid emits width="100%" + a max-width style, so it always shrinks to fit.
  // Size it from its viewBox instead so 100% means the diagram's natural size.
  useEffect(() => {
    const el = hostRef.current?.querySelector('svg');
    const vb = el?.viewBox?.baseVal;
    if (!el || !vb || !vb.width) return;
    el.style.maxWidth = 'none';
    el.setAttribute('width', String(vb.width * zoom));
    el.setAttribute('height', String(vb.height * zoom));
  }, [svg, zoom]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !(e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div className="qo-overlay md-modal-overlay" onClick={onClose}>
      <div className="md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="md-diagram-bar">
          <span className="md-diagram-kind">{Math.round(zoom * 100)}%</span>
          <SearchBox query={query} setQuery={setQuery} countRef={countRef} />
          {sel && selLabel && !query && <TraceChip label={selLabel} onClear={clear} />}
          <span className="md-diagram-actions">
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>−</button>
            <button className="file-action-btn" onClick={() => setZoom(fitZoom())}>Fit</button>
            <button className="file-action-btn" onClick={() => setZoom(1)}>100%</button>
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}>+</button>
            {exportMenu}
            <button className="file-action-btn" onClick={onClose}>✕ Close</button>
          </span>
        </div>
        <div
          className="md-modal-body"
          ref={bodyRef}
          onMouseDown={(e) => {
            const b = bodyRef.current;
            if (b) drag.current = { x: e.clientX, y: e.clientY, l: b.scrollLeft, t: b.scrollTop, moved: false };
          }}
          onMouseMove={(e) => {
            const b = bodyRef.current, d = drag.current;
            if (!b || !d) return;
            if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 4) d.moved = true;
            b.scrollLeft = d.l - (e.clientX - d.x);
            b.scrollTop = d.t - (e.clientY - d.y);
          }}
          onMouseUp={(e) => {
            // A click (not a drag) selects / clears like in the inline view.
            if (drag.current && !drag.current.moved) {
              toggle(keyAt(e.target));
            }
            drag.current = null;
          }}
          onMouseLeave={() => { drag.current = null; }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setZoom((z) => Math.min(6, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
          }}
        >
          <div className="md-modal-svg" ref={hostRef} dangerouslySetInnerHTML={html} />
        </div>
      </div>
    </div>
  );
}
