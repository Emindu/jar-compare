// Mermaid source helpers: the shared (serialised) mermaid instance, per-diagram
// view options (layout engine, direction, look, theme), collapsing flowchart
// subgraphs into single nodes, and locating parse errors.

export type Theme = 'light' | 'dark';

export interface ViewOptions {
  layout: 'dagre' | 'elk';
  dir: '' | 'LR' | 'TD' | 'RL' | 'BT'; // '' = as written
  look: 'classic' | 'handDrawn';
  theme: 'auto' | 'default' | 'neutral' | 'forest' | 'dark' | 'base';
}

export const DEFAULT_VIEW: ViewOptions = { layout: 'dagre', dir: '', look: 'classic', theme: 'auto' };

// ── Shared mermaid instance ────────────────────────────────────────────────

type MermaidApi = typeof import('mermaid').default;
let mermaidPromise: Promise<MermaidApi> | null = null;
let elkPromise: Promise<void> | null = null;
let mermaidTheme: Theme | null = null;
let queue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** The ELK layout engine is large; only load it when a diagram asks for it. */
function loadElk(mermaid: MermaidApi): Promise<void> {
  if (!elkPromise) {
    elkPromise = import('@mermaid-js/layout-elk').then((m) => mermaid.registerLayoutLoaders(m.default));
  }
  return elkPromise;
}

/** Run mermaid work one job at a time: it keeps global state and doesn't like concurrency. */
function enqueue<T>(fn: (m: MermaidApi) => Promise<T>, theme: Theme = mermaidTheme ?? 'light'): Promise<T> {
  const job = queue.then(async () => {
    const mermaid = await loadMermaid();
    if (mermaidTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'var(--font-sans)',
        // Errors are shown in our own UI; don't let mermaid append its own to <body>.
        suppressErrorRendering: true,
      });
      mermaidTheme = theme;
    }
    return fn(mermaid);
  });
  queue = job.catch(() => undefined);
  return job;
}

export function renderMermaid(src: string, theme: Theme): Promise<string> {
  return enqueue(async (mermaid) => {
    if (/"layout":"elk"/.test(src)) await loadElk(mermaid);
    const id = `mmd-${++renderSeq}`;
    try {
      await mermaid.parse(src);
      const { svg } = await mermaid.render(id, src);
      return svg;
    } finally {
      // A failed render can leave its scratch container behind.
      document.getElementById(`d${id}`)?.remove();
    }
  }, theme);
}

// ── Errors ─────────────────────────────────────────────────────────────────

export interface MermaidError {
  message: string;
  /** 1-based line within the diagram source, when mermaid reports one. */
  line: number | null;
}

function toError(e: unknown): MermaidError {
  const err = e as { message?: string; hash?: { loc?: { first_line?: number } } };
  const message = String(err?.message ?? e);
  const line = err?.hash?.loc?.first_line ?? Number(/\bline (\d+)/i.exec(message)?.[1] ?? NaN);
  return { message, line: Number.isFinite(line) ? line : null };
}

/** The parser's message without its ASCII-art pointer lines. */
export function cleanMermaidMessage(message: string): string {
  return message
    .split('\n')
    .filter((l) => l.trim() && !/^[-\s]*\^$/.test(l) && !/^\.\.\./.test(l))
    .join('\n');
}

/** Parse only; resolves to null when the source is valid. */
export function checkMermaid(src: string): Promise<MermaidError | null> {
  return enqueue(async (mermaid) => {
    try {
      await mermaid.parse(src);
      return null;
    } catch (e) {
      return toError(e);
    }
  });
}

// ── Source transforms ──────────────────────────────────────────────────────

/** Split off a leading YAML frontmatter block (it must stay first in the source). */
function splitFrontmatter(src: string): { fm: string; body: string } {
  const m = /^\s*---\r?\n[\s\S]*?\r?\n---[ \t]*\r?\n/.exec(src);
  return m ? { fm: m[0], body: src.slice(m[0].length) } : { fm: '', body: src };
}

/** Diagram keyword (flowchart, sequenceDiagram, …) from the first meaningful line. */
export function diagramType(src: string): string {
  for (const raw of splitFrontmatter(src).body.split('\n')) {
    const line = raw.trim();
    if (!line || line.startsWith('%%')) continue;
    return line.split(/\s+/)[0];
  }
  return '';
}

export const isFlowchart = (src: string) => /^(flowchart|graph)$/.test(diagramType(src));

const SHAPES: Record<string, [string, string]> = {
  square: ['[', ']'], round: ['(', ')'], stadium: ['([', '])'], subroutine: ['[[', ']]'],
  cylinder: ['[(', ')]'], circle: ['((', '))'], doublecircle: ['(((', ')))'], diamond: ['{', '}'],
  hexagon: ['{{', '}}'], odd: ['>', ']'], lean_right: ['[/', '/]'], lean_left: ['[\\', '\\]'],
  trapezoid: ['[/', '\\]'], inv_trapezoid: ['[\\', '/]'],
};

const quote = (s: string) => `"${s.replace(/"/g, '#quot;')}"`;

/** Mermaid link syntax for a parsed edge, e.g. arrow_point + dotted → "-.->". */
function arrow(type: string, stroke: string): string {
  if (stroke === 'invisible') return '~~~';
  const head = ({ arrow_point: '>', arrow_cross: 'x', arrow_circle: 'o' } as Record<string, string>)[type.replace('double_', '')] ?? '';
  const tail = type.startsWith('double_') ? (head === '>' ? '<' : head) : '';
  const line = stroke === 'dotted' ? '-.-' : stroke === 'thick' ? (head ? '==' : '===') : head ? '--' : '---';
  return tail + line + head;
}

interface FlowVertex { id: string; text?: string; type?: string; classes?: string[]; styles?: string[]; labelType?: string }
interface FlowEdge { start: string; end: string; type?: string; stroke?: string; text?: string }
interface FlowSub { id: string; title: string; dir?: string }
interface FlowDb {
  getDirection(): string;
  getVertices(): Map<string, FlowVertex>;
  getEdges(): FlowEdge[];
  getSubGraphs(): FlowSub[];
  getClasses(): Map<string, { id: string; styles: string[] }>;
  getData(): { nodes: { id: string; parentId?: string; isGroup?: boolean }[] };
}

/**
 * Rebuild a flowchart with the given subgraphs folded into single nodes. Edges into
 * or out of a folded subgraph are re-attached to it; edges inside it disappear.
 * Click handlers and link styles are dropped from the rebuilt source.
 */
function rebuildFlowchart(db: FlowDb, collapsed: Set<string>, dir: string): string {
  const parent = new Map<string, string | undefined>();
  for (const n of db.getData().nodes) parent.set(n.id, n.parentId || undefined);
  const subs = db.getSubGraphs();
  const subIds = new Set(subs.map((s) => s.id));
  /** The outermost collapsed subgraph containing id (or id itself). */
  const rep = (id: string) => {
    let out = id;
    for (let p = parent.get(id); p; p = parent.get(p)) if (collapsed.has(p)) out = p;
    return out;
  };
  const hidden = (id: string) => rep(id) !== id;

  const vertices = [...db.getVertices().values()].filter((v) => !subIds.has(v.id));
  const memberCount = (id: string) => vertices.filter((v) => rep(v.id) === id).length;
  const lines: string[] = [`flowchart ${dir || db.getDirection() || 'TB'}`];
  for (const c of db.getClasses().values()) if (c.styles?.length) lines.push(`classDef ${c.id} ${c.styles.join(',')}`);
  lines.push('classDef dgCollapsed stroke-dasharray:6 3,stroke-width:2px');

  const vertexLine = (v: FlowVertex, indent: string) => {
    const [a, b] = SHAPES[v.type ?? 'square'] ?? SHAPES.square;
    const text = v.text ?? v.id;
    const label = v.labelType === 'markdown' ? `"\`${text}\`"` : quote(text);
    lines.push(`${indent}${v.id}${a}${label}${b}${v.classes?.length ? `:::${v.classes.join(',')}` : ''}`);
    if (v.styles?.length) lines.push(`${indent}style ${v.id} ${v.styles.join(',')}`);
  };

  const emitGroup = (groupId: string | undefined, indent: string) => {
    for (const s of subs.filter((x) => parent.get(x.id) === groupId)) {
      if (hidden(s.id)) continue;
      if (collapsed.has(s.id)) {
        const n = memberCount(s.id);
        lines.push(`${indent}${s.id}[[${quote(`${s.title || s.id}<br/><small>⊞ ${n} node${n === 1 ? '' : 's'}</small>`)}]]:::dgCollapsed`);
        continue;
      }
      lines.push(`${indent}subgraph ${s.id}[${quote(s.title || s.id)}]`);
      if (s.dir) lines.push(`${indent}  direction ${s.dir}`);
      emitGroup(s.id, indent + '  ');
      lines.push(`${indent}end`);
    }
    for (const v of vertices) if (parent.get(v.id) === groupId && !hidden(v.id)) vertexLine(v, indent);
  };
  emitGroup(undefined, '');

  // Re-attach edges; merge duplicates created by folding.
  const merged = new Map<string, { a: string; b: string; arrow: string; labels: string[] }>();
  for (const e of db.getEdges()) {
    const a = rep(e.start), b = rep(e.end);
    if (a === b && a !== e.start) continue; // inside a folded subgraph
    const ar = arrow(e.type ?? 'arrow_point', e.stroke ?? 'normal');
    const key = `${a}|${b}|${ar}`;
    const m = merged.get(key) ?? { a, b, arrow: ar, labels: [] };
    if (e.text && !m.labels.includes(e.text)) m.labels.push(e.text);
    merged.set(key, m);
  }
  for (const m of merged.values()) {
    const label = m.labels.length > 2 ? `${m.labels[0]} (+${m.labels.length - 1})` : m.labels.join(' / ');
    lines.push(`${m.a} ${m.arrow}${label ? `|${quote(label)}|` : ''} ${m.b}`);
  }
  return lines.join('\n');
}

/** Ids and titles of a flowchart's subgraphs. */
export function flowchartSubgraphs(src: string): Promise<{ id: string; title: string }[]> {
  return enqueue(async (mermaid) => {
    const d = await mermaid.mermaidAPI.getDiagramFromText(src);
    return ((d.db as unknown as FlowDb).getSubGraphs?.() ?? []).map((s) => ({ id: s.id, title: s.title || s.id }));
  });
}

/** Apply view options and folded subgraphs to a diagram's source. */
export async function prepareSource(code: string, opts: ViewOptions, collapsed: Set<string>): Promise<string> {
  const { fm, body: original } = splitFrontmatter(code);
  let body = original;
  if (isFlowchart(code)) {
    if (collapsed.size) {
      body = await enqueue(async (mermaid) => {
        const d = await mermaid.mermaidAPI.getDiagramFromText(original);
        return rebuildFlowchart(d.db as unknown as FlowDb, collapsed, opts.dir);
      });
    } else if (opts.dir) {
      body = body.replace(/^(\s*(?:flowchart|graph))(?:[ \t]+[A-Za-z]{2})?/m, `$1 ${opts.dir}`);
    }
  }
  const cfg: Record<string, string> = {};
  if (opts.layout === 'elk') cfg.layout = 'elk';
  if (opts.look === 'handDrawn') cfg.look = 'handDrawn';
  if (opts.theme !== 'auto') cfg.theme = opts.theme;
  const directive = Object.keys(cfg).length ? `%%{init: ${JSON.stringify(cfg)}}%%\n` : '';
  return fm + directive + body;
}
