import { lazy, Suspense, useContext, useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { ChevronDown, Maximize2, Pause, PenLine, Play, SkipBack, SkipForward, SlidersHorizontal, StepBack, StepForward, X } from 'lucide-react';
import { DiagramEdit, DiagramLinks, type DiagramEntry } from './diagramLinks';
import { hasLayout, stripLayout } from './flowModel';
import { renderFreeFlow } from './flowLayout';

const DiagramEditor = lazy(() => import('./DiagramEditor'));
import {
  renderMermaid, checkMermaid, cleanMermaidMessage, prepareSource, diagramType, isFlowchart, flowchartSubgraphs,
  DEFAULT_VIEW, type Theme, type ViewOptions, type MermaidError,
} from './mermaidSource';

// Mermaid diagrams: rendering, plus an interaction layer on top of the SVG that
// mermaid produces. Each rendered SVG is indexed into nodes and edges, which
// powers click-to-trace (upstream / downstream paths), in-diagram search,
// highlighting from `code` mentions in the surrounding text, stepping through
// sequence diagrams, and SVG/PNG export. View options (layout engine, direction,
// look, theme) and folded subgraphs are applied to the source before rendering.

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

/** Messages of a sequence diagram, in order. */
function messages(g: DGraph): DItem[] {
  return [...g.items.values()].filter((it) => it.kind === 'edge' && g.mode === 'sequence');
}

/**
 * Apply search / step / selection highlighting to a rendered SVG (in that priority).
 * Returns the number of search hits.
 */
function applyFocus(svg: SVGSVGElement, sel: string | null, query: string, step: number | null = null): number {
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
  } else if (step !== null && g.mode === 'sequence') {
    // Messages up to the current step stay visible; the current one and its two ends stand out.
    focus = true;
    for (const it of g.items.values()) if (it.kind === 'node') mark(it.key);
    messages(g).forEach((m, i) => {
      if (i < step) mark(m.key);
      else if (i === step) {
        mark(m.key, 'dg-sel');
        if (m.from) mark(m.from, 'dg-up');
        if (m.to) mark(m.to, 'dg-down');
      }
    });
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
  step: number | null,
) {
  useEffect(() => {
    const svg = hostRef.current?.querySelector('svg');
    if (!svg) return;
    const hits = applyFocus(svg, sel, query, step);
    if (countRef.current) countRef.current.textContent = query.trim() ? `${hits} match${hits === 1 ? '' : 'es'}` : '';
  }, [hostRef, countRef, dep, sel, query, step]);
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

interface ChipAction { label: string; title: string; run: () => void }

function TraceChip({ label, onClear, action }: { label: string; onClear: () => void; action?: ChipAction | null }) {
  return (
    <span className="dg-chip" title="Upstream in amber, downstream in green">
      <span className="dg-chip-dot" />
      Tracing <strong>{label}</strong>
      {action && <button className="dg-chip-action" onClick={action.run} title={action.title}>{action.label}</button>}
      <button onClick={onClear} aria-label="Clear selection"><X size={13} aria-hidden /></button>
    </span>
  );
}

// ── View options menu ──────────────────────────────────────────────────────

function ViewMenu({ opts, setOpts, flow, collapsedCount, onCollapseAll, onExpandAll, onAutoLayout }: {
  /** Set when the diagram has hand-placed positions: offers to drop them. */
  onAutoLayout?: () => void;
  opts: ViewOptions;
  setOpts: (o: ViewOptions) => void;
  flow: boolean;
  collapsedCount: number;
  onCollapseAll: () => void;
  onExpandAll: () => void;
}) {
  const [open, setOpen] = useState(false);
  const changed = JSON.stringify(opts) !== JSON.stringify(DEFAULT_VIEW) || collapsedCount > 0;
  const row = <K extends keyof ViewOptions>(key: K, label: string, choices: [ViewOptions[K], string][]) => (
    <div className="dg-menu-row">
      <span className="dg-menu-label">{label}</span>
      <span className="dg-seg">
        {choices.map(([v, text]) => (
          <button key={String(v)} className={opts[key] === v ? 'active' : ''} onClick={() => setOpts({ ...opts, [key]: v })}>
            {text}
          </button>
        ))}
      </span>
    </div>
  );
  return (
    <span className="dg-export">
      <button className={`file-action-btn${changed ? ' active' : ''}`} onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <SlidersHorizontal size={13} aria-hidden /> View <ChevronDown size={13} aria-hidden />
      </button>
      {open && (
        <span className="dg-menu dg-view-menu" onMouseLeave={() => setOpen(false)}>
          {onAutoLayout ? (
            <div className="dg-menu-row">
              <span className="dg-menu-label">Positions</span>
              <span className="dg-free-note">Placed by hand in the editor. Other Mermaid viewers lay it out automatically.</span>
              <span className="dg-seg"><button onClick={() => { setOpen(false); onAutoLayout(); }}>Use automatic layout</button></span>
            </div>
          ) : <>
          {row('layout', 'Layout', [['dagre', 'Default'], ['elk', 'ELK']])}
          {flow && row('dir', 'Direction', [['', 'As written'], ['LR', '→'], ['TD', '↓'], ['RL', '←'], ['BT', '↑']])}
          {row('look', 'Look', [['classic', 'Classic'], ['handDrawn', 'Hand-drawn']])}
          {row('theme', 'Theme', [['auto', 'Auto'], ['default', 'Default'], ['neutral', 'Neutral'], ['forest', 'Forest'], ['dark', 'Dark'], ['base', 'Base']])}
          {flow && (
            <div className="dg-menu-row">
              <span className="dg-menu-label">Subgraphs</span>
              <span className="dg-seg">
                <button onClick={onCollapseAll}>⊟ Collapse all</button>
                <button onClick={onExpandAll} disabled={!collapsedCount}>⊞ Expand all{collapsedCount ? ` (${collapsedCount})` : ''}</button>
              </span>
            </div>
          )}
          {changed && (
            <button className="dg-menu-reset" onClick={() => { setOpts(DEFAULT_VIEW); onExpandAll(); }}>Reset view</button>
          )}
          </>}
        </span>
      )}
    </span>
  );
}

// ── Sequence step-through ──────────────────────────────────────────────────

function StepBar({ step, total, setStep, playing, setPlaying, onClose }: {
  step: number;
  total: number;
  setStep: (n: number) => void;
  playing: boolean;
  setPlaying: (p: boolean) => void;
  onClose: () => void;
}) {
  const last = Math.max(0, total - 1);
  return (
    <span className="dg-steps" role="group" aria-label="Step through messages">
      <button onClick={() => setStep(0)} disabled={step === 0} title="First (Home)" aria-label="First"><SkipBack size={13} aria-hidden /></button>
      <button onClick={() => setStep(Math.max(0, step - 1))} disabled={step === 0} title="Previous (←)" aria-label="Previous"><StepBack size={13} aria-hidden /></button>
      <span className="dg-steps-n">{step + 1} / {total}</span>
      <button onClick={() => setStep(Math.min(last, step + 1))} disabled={step >= last} title="Next (→)" aria-label="Next"><StepForward size={13} aria-hidden /></button>
      <button onClick={() => setStep(last)} disabled={step >= last} title="Last (End)" aria-label="Last"><SkipForward size={13} aria-hidden /></button>
      <button onClick={() => { if (step >= last) setStep(0); setPlaying(!playing); }} title="Play / pause (Space)" aria-label={playing ? 'Pause' : 'Play'}>
        {playing ? <Pause size={13} aria-hidden /> : <Play size={13} aria-hidden />}
      </button>
      <button onClick={onClose} title="Stop stepping" aria-label="Stop stepping"><X size={13} aria-hidden /></button>
    </span>
  );
}

// ── Errors ─────────────────────────────────────────────────────────────────

function DiagramError({ code, error }: { code: string; error: MermaidError }) {
  // Show the source with the reported line marked, plus the parser's own message.
  const lines = code.replace(/\n$/, '').split('\n');
  const at = error.line;
  const lo = at ? Math.max(0, at - 4) : 0;
  const hi = at ? Math.min(lines.length, at + 3) : Math.min(lines.length, 8);
  const message = cleanMermaidMessage(error.message);
  return (
    <div className="md-diagram-error">
      <strong>Diagram error{at ? ` on line ${at}` : ''}</strong>
      <pre className="dg-err-src">
        {lines.slice(lo, hi).map((l, i) => (
          <span key={lo + i} className={lo + i + 1 === at ? 'dg-err-line' : ''}>
            <span className="dg-err-n">{lo + i + 1}</span>{l || ' '}{'\n'}
          </span>
        ))}
      </pre>
      <pre>{message}</pre>
    </div>
  );
}

/** Small self-contained diagram render (used by the editor's live preview). */
export function MermaidPreview({ code, theme }: { code: string; theme: Theme }) {
  const [state, setState] = useState<{ svg: string; error: MermaidError | null }>({ svg: '', error: null });
  useEffect(() => {
    let alive = true;
    (async () => {
      const error = await checkMermaid(code);
      if (error) { if (alive) setState((s) => ({ svg: s.svg, error })); return; }
      try {
        const svg = await renderMermaid(code, theme);
        if (alive) setState({ svg, error: null });
      } catch (e) {
        if (alive) setState((s) => ({ svg: s.svg, error: { message: String((e as Error)?.message ?? e), line: null } }));
      }
    })();
    return () => { alive = false; };
  }, [code, theme]);
  const html = useMemo(() => ({ __html: state.svg }), [state.svg]);
  return (
    <>
      {state.error && <DiagramError code={code} error={state.error} />}
      {state.svg ? (
        <div className={`md-diagram-svg${state.error ? ' dg-stale' : ''}`} dangerouslySetInnerHTML={html} />
      ) : !state.error && <div className="md-diagram-loading">Rendering…</div>}
    </>
  );
}

function ExportMenu({ hostRef, code, source, theme, name }: {
  hostRef: RefObject<HTMLElement | null>; code: string; source: string; theme: Theme; name: string;
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
      const plain = await renderMermaid(`%%{init: {"htmlLabels": false, "flowchart": {"htmlLabels": false}}}%%\n${source}`, theme);
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
        {status || <>Export <ChevronDown size={13} aria-hidden /></>}
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
  const [source, setSource] = useState(code);
  const [error, setError] = useState<MermaidError | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [selected, setSelected] = useState<{ key: string; label: string; cluster: boolean } | null>(null);
  const [query, setQuery] = useState('');
  const [opts, setOpts] = useState<ViewOptions>(DEFAULT_VIEW);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const [step, setStep] = useState<number | null>(null);
  const [playing, setPlaying] = useState(false);
  const [msgCount, setMsgCount] = useState(0);
  const sel = selected?.key ?? null;
  const figRef = useRef<HTMLElement>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const countRef = useRef<HTMLSpanElement>(null);
  const entryRef = useRef<DiagramEntry | null>(null);
  const links = useContext(DiagramLinks);
  const edit = useContext(DiagramEdit);
  const [editing, setEditing] = useState(false);
  const kind = diagramType(code);
  const flow = isFlowchart(code);
  // Flowcharts with hand-placed positions are drawn by our own renderer.
  const free = flow && hasLayout(code);
  const editable = !!edit && (flow || kind === 'sequenceDiagram');
  // A stable object: React 19 re-applies innerHTML whenever this object changes,
  // which would wipe the highlight classes set on the SVG.
  const html = useMemo(() => ({ __html: svg }), [svg]);

  useEffect(() => {
    let alive = true;
    (async () => {
      // Check the source as written first so error line numbers match what the author sees.
      const err = await checkMermaid(code);
      if (!alive) return;
      if (err) { setSvg(''); setError(err); return; }
      try {
        if (free) {
          const out = await renderFreeFlow(code, theme);
          if (!alive) return;
          setSvg(out);
          setSource(code);
          setError(null);
          setMsgCount(0);
          return;
        }
        const prepared = await prepareSource(code, opts, collapsed);
        const out = await renderMermaid(prepared, theme);
        if (!alive) return;
        setSvg(out);
        setSource(prepared);
        setError(null);
        setMsgCount((out.match(/data-et="message"/g) || []).length);
      } catch (e) {
        if (alive) { setSvg(''); setError({ message: String((e as Error)?.message ?? e), line: null }); }
      }
    })();
    return () => { alive = false; };
  }, [code, theme, opts, collapsed, free]);

  useFocus(hostRef, countRef, `${svg}|${showSource}`, sel, query, step);

  // Auto-advance while playing.
  useEffect(() => {
    if (!playing || step === null) return;
    const t = setTimeout(() => {
      if (step + 1 >= msgCount) setPlaying(false);
      else setStep(step + 1);
    }, 1100);
    return () => clearTimeout(t);
  }, [playing, step, msgCount]);

  // Let `code` mentions in the document find and highlight things in this diagram.
  useEffect(() => {
    if (!links || !svg || showSource) return;
    const svgEl = () => hostRef.current?.querySelector('svg') ?? null;
    const entry: DiagramEntry = {
      el: figRef.current!,
      find: (c) => { const s = svgEl(); return s ? matchItems(getGraph(s), c) : []; },
      preview: (keys) => { const s = svgEl(); if (s) applyXref(s, keys); },
      select: (k) => { setQuery(''); setStep(null); choose(k); },
    };
    entryRef.current = entry;
    return links.register(entry);
  }, [links, svg, showSource]);

  useEffect(() => {
    if (links && entryRef.current) links.onSelect(entryRef.current, sel);
  }, [links, sel]);

  function choose(k: string | null) {
    const s = hostRef.current?.querySelector('svg');
    const g = s ? getGraph(s) : null;
    setSelected(k && g ? { key: k, label: itemLabel(g, k), cluster: !!g.items.get(k)?.cluster } : null);
  }

  // Clicking a node selects it; clicking it again or the background clears.
  const toggle = (k: string | null) => {
    setQuery('');
    if (step !== null) return; // clicks don't change focus while stepping
    choose(k && k !== sel ? k : null);
  };

  const setFold = (id: string, fold: boolean) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (fold) next.add(id); else next.delete(id);
      return next;
    });

  // Selected subgraph → offer to fold it; selected folded node → offer to unfold it.
  const selId = sel?.startsWith('n:') ? sel.slice(2) : null;
  const chipAction: ChipAction | null = !selId || !flow || free ? null
    : collapsed.has(selId) ? { label: '⊞ Expand', title: 'Show this subgraph’s nodes again', run: () => setFold(selId, false) }
    : selected?.cluster ? { label: '⊟ Collapse', title: 'Fold this subgraph into one node', run: () => setFold(selId, true) }
    : null;

  const collapseAll = async () => setCollapsed(new Set((await flowchartSubgraphs(code)).map((s) => s.id)));

  const startStepping = () => { setQuery(''); choose(null); setPlaying(false); setStep(0); };
  // While stepping, arrows / Home / End / Space / Escape drive this diagram (inline or
  // expanded) unless the key is typed into a field or aimed at another diagram.
  useEffect(() => {
    if (step === null) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.closest('.cm-editor'))) return;
      const other = t?.closest('.md-diagram');
      if (other && other !== figRef.current) return;
      const last = Math.max(0, msgCount - 1);
      const next = e.key === 'ArrowRight' ? Math.min(last, step + 1) : e.key === 'ArrowLeft' ? Math.max(0, step - 1)
        : e.key === 'Home' ? 0 : e.key === 'End' ? last : null;
      if (next !== null) { e.preventDefault(); setPlaying(false); setStep(next); }
      else if (e.key === ' ') { e.preventDefault(); setPlaying((p) => !p); }
      else if (e.key === 'Escape') { setStep(null); setPlaying(false); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [step, msgCount]);
  const stepBar = step !== null && (
    <StepBar
      step={step}
      total={msgCount}
      setStep={(n) => { setPlaying(false); setStep(n); }}
      playing={playing}
      setPlaying={setPlaying}
      onClose={() => { setStep(null); setPlaying(false); }}
    />
  );
  const viewMenu = (
    <ViewMenu
      opts={opts}
      setOpts={setOpts}
      flow={flow}
      collapsedCount={collapsed.size}
      onCollapseAll={collapseAll}
      onExpandAll={() => setCollapsed(new Set())}
      onAutoLayout={free && edit ? () => edit.replace(code, stripLayout(code)) : undefined}
    />
  );
  const editButton = editable && svg && (
    <button className="file-action-btn" onClick={() => { setStep(null); setPlaying(false); setEditing(true); }} title="Add, move, connect and rename by hand">
      <PenLine size={13} aria-hidden /> Edit
    </button>
  );

  return (
    <figure className="md-diagram" ref={figRef}>
      <div className="md-diagram-bar">
        <span className="md-diagram-kind">{kind || 'diagram'}</span>
        {svg && !showSource && step === null && <SearchBox query={query} setQuery={setQuery} countRef={countRef} />}
        {selected && !query && step === null && <TraceChip label={selected.label} onClear={() => choose(null)} action={chipAction} />}
        {stepBar}
        <span className="md-diagram-actions">
          {kind === 'sequenceDiagram' && svg && !showSource && step === null && msgCount > 0 && (
            <button className="file-action-btn" onClick={startStepping} title="Walk through the messages one by one"><Play size={13} aria-hidden /> Step</button>
          )}
          {!showSource && editButton}
          {svg && !showSource && viewMenu}
          <button className="file-action-btn" onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'Diagram' : 'Source'}
          </button>
          {svg && !showSource && <ExportMenu hostRef={hostRef} code={code} source={source} theme={theme} name={name} />}
          {svg && <button className="file-action-btn" onClick={() => setExpanded(true)}><Maximize2 size={13} aria-hidden /> Expand</button>}
        </span>
      </div>
      {showSource ? (
        <pre className="md-diagram-src">{code}</pre>
      ) : error ? (
        <DiagramError code={code} error={error} />
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
          step={step}
          onClose={() => setExpanded(false)}
          chipAction={chipAction}
          controls={<>
            {stepBar}
            {kind === 'sequenceDiagram' && step === null && msgCount > 0 && (
              <button className="file-action-btn" onClick={startStepping} title="Walk through the messages one by one"><Play size={13} aria-hidden /> Step</button>
            )}
          </>}
          menus={<>{editButton}{viewMenu}<ExportMenu hostRef={hostRef} code={code} source={source} theme={theme} name={name} /></>}
        />
      )}
      {editing && edit && (
        <Suspense fallback={null}>
          <DiagramEditor
            code={code}
            theme={theme}
            onSave={(next) => { if (edit.replace(code, next)) { setEditing(false); setExpanded(false); } }}
            onClose={() => setEditing(false)}
          />
        </Suspense>
      )}
    </figure>
  );
}

// ── Expanded view ──────────────────────────────────────────────────────────

/** Overview of a large diagram with the visible area marked; click or drag to move. */
function Minimap({ svg, hostRef, bodyRef, zoom }: {
  svg: string;
  hostRef: RefObject<HTMLDivElement | null>;
  bodyRef: RefObject<HTMLDivElement | null>;
  zoom: number;
}) {
  const [view, setView] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [img, setImg] = useState<{ src: string; w: number; h: number } | null>(null);
  const mapRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);

  // Mermaid's markup isn't well-formed XML (HTML labels), so serialise the live SVG instead.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const el = hostRef.current?.querySelector('svg');
      if (!el) return;
      const { xml, width, height } = serializeSvg(el);
      const scale = Math.min(220 / width, 160 / height);
      setImg({ src: 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml), w: width * scale, h: height * scale });
    });
    return () => cancelAnimationFrame(raf);
  }, [svg, hostRef]);

  useEffect(() => {
    const b = bodyRef.current;
    if (!b) return;
    const update = () => {
      const { scrollLeft, scrollTop, scrollWidth, scrollHeight, clientWidth, clientHeight } = b;
      const fits = scrollWidth <= clientWidth + 2 && scrollHeight <= clientHeight + 2;
      setView(fits ? null : {
        x: scrollLeft / scrollWidth, y: scrollTop / scrollHeight,
        w: clientWidth / scrollWidth, h: clientHeight / scrollHeight,
      });
    };
    const raf = requestAnimationFrame(update);
    b.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => { cancelAnimationFrame(raf); b.removeEventListener('scroll', update); window.removeEventListener('resize', update); };
  }, [bodyRef, zoom, svg]);

  if (!view || !img) return null;
  const moveTo = (e: React.MouseEvent) => {
    const b = bodyRef.current, m = mapRef.current;
    if (!b || !m) return;
    const r = m.getBoundingClientRect();
    const fx = (e.clientX - r.left) / r.width, fy = (e.clientY - r.top) / r.height;
    b.scrollLeft = fx * b.scrollWidth - b.clientWidth / 2;
    b.scrollTop = fy * b.scrollHeight - b.clientHeight / 2;
  };
  return (
    <div
      className="dg-minimap"
      ref={mapRef}
      onMouseDown={(e) => { e.stopPropagation(); dragging.current = true; moveTo(e); }}
      onMouseMove={(e) => { if (dragging.current) moveTo(e); }}
      onMouseUp={(e) => { e.stopPropagation(); dragging.current = false; }}
      onMouseLeave={() => { dragging.current = false; }}
      title="Overview · click or drag to move"
    >
      <img src={img.src} alt="" draggable={false} style={{ width: img.w, height: img.h }} />
      <span
        className="dg-minimap-view"
        style={{ left: `${view.x * 100}%`, top: `${view.y * 100}%`, width: `${view.w * 100}%`, height: `${view.h * 100}%` }}
      />
    </div>
  );
}

function DiagramModal({
  svg, sel, selLabel, toggle, clear, query, setQuery, step, onClose, chipAction, controls, menus,
}: {
  svg: string;
  sel: string | null;
  selLabel: string;
  toggle: (k: string | null) => void;
  clear: () => void;
  query: string;
  setQuery: (q: string) => void;
  step: number | null;
  onClose: () => void;
  chipAction: ChipAction | null;
  controls: React.ReactNode;
  menus: React.ReactNode;
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
  const modalRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number; moved: boolean } | null>(null);

  const html = useMemo(() => ({ __html: svg }), [svg]);
  useFocus(hostRef, countRef, svg, sel, query, step);

  // Take focus so Escape and page keys go to the expanded view.
  useEffect(() => { modalRef.current?.focus({ preventScroll: true }); }, []);

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
      if (e.key === 'Escape' && step === null && !(e.target instanceof HTMLInputElement)) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, step]);

  return (
    <div className="qo-overlay md-modal-overlay" onClick={onClose}>
      <div
        className="md-modal"
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        tabIndex={-1}
      >
        <div className="md-diagram-bar">
          <span className="md-diagram-kind">{Math.round(zoom * 100)}%</span>
          {step === null && <SearchBox query={query} setQuery={setQuery} countRef={countRef} />}
          {sel && selLabel && !query && step === null && <TraceChip label={selLabel} onClear={clear} action={chipAction} />}
          {controls}
          <span className="md-diagram-actions">
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>−</button>
            <button className="file-action-btn" onClick={() => setZoom(fitZoom())}>Fit</button>
            <button className="file-action-btn" onClick={() => setZoom(1)}>100%</button>
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}>+</button>
            {menus}
            <button className="file-action-btn" onClick={onClose}><X size={13} aria-hidden /> Close</button>
          </span>
        </div>
        <div className="md-modal-stage">
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
              if (drag.current && !drag.current.moved) toggle(keyAt(e.target));
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
          <Minimap svg={svg} hostRef={hostRef} bodyRef={bodyRef} zoom={zoom} />
        </div>
      </div>
    </div>
  );
}
