// An editable model of a mermaid flowchart: nodes, edges, subgraphs and free
// positions. Read through mermaid's parser, written back as tidy mermaid text.
// Positions live in a `%% @layout {...}` comment, which other renderers ignore.

import { arrow, flowchartData, quote, SHAPES, splitFrontmatter } from './mermaidSource';

export interface FNode { id: string; label: string; shape: string; classes: string[]; markdown?: boolean }
export interface FEdge { from: string; to: string; label: string; type: string; stroke: string }
export interface FSub { id: string; title: string; dir?: string }
export interface Point { x: number; y: number }

export interface FlowModel {
  /** Frontmatter and %%{init}%% directives, kept verbatim at the top. */
  head: string;
  dir: string;
  nodes: FNode[];
  edges: FEdge[];
  subs: FSub[];
  /** Parent subgraph of a node or subgraph (absent = top level). */
  parent: Record<string, string | undefined>;
  /** classDef / style / linkStyle / click / comment lines, kept verbatim. */
  extra: string[];
  /** Centre of each node (and of empty subgraphs). */
  pos: Record<string, Point>;
}

export const SHAPE_NAMES: { id: string; label: string }[] = [
  { id: 'square', label: 'Rectangle' },
  { id: 'round', label: 'Rounded' },
  { id: 'stadium', label: 'Stadium' },
  { id: 'diamond', label: 'Decision' },
  { id: 'circle', label: 'Circle' },
  { id: 'cylinder', label: 'Database' },
  { id: 'hexagon', label: 'Hexagon' },
  { id: 'subroutine', label: 'Subroutine' },
  { id: 'lean_right', label: 'Input / output' },
  { id: 'trapezoid', label: 'Trapezoid' },
];

/** Link styles offered in the editor: [type, stroke, label]. */
export const EDGE_STYLES: [string, string, string][] = [
  ['arrow_point', 'normal', 'Arrow  -->'],
  ['arrow_open', 'normal', 'Line  ---'],
  ['arrow_point', 'dotted', 'Dotted  -.->'],
  ['arrow_point', 'thick', 'Thick  ==>'],
  ['double_arrow_point', 'normal', 'Both ways  <-->'],
  ['arrow_cross', 'normal', 'Cross  --x'],
  ['arrow_circle', 'normal', 'Circle  --o'],
];

const LAYOUT_LINE = /^[ \t]*%%[ \t]*@layout[ \t]+(\{.*\})[ \t]*$/m;

export function hasLayout(code: string): boolean {
  return LAYOUT_LINE.test(code);
}

export function readLayout(code: string): Record<string, Point> | null {
  const m = LAYOUT_LINE.exec(code);
  if (!m) return null;
  try {
    const raw = JSON.parse(m[1]) as Record<string, [number, number]>;
    const out: Record<string, Point> = {};
    for (const [k, v] of Object.entries(raw)) if (Array.isArray(v) && v.length === 2) out[k] = { x: +v[0], y: +v[1] };
    return out;
  } catch {
    return null;
  }
}

/** The source without its saved positions (back to automatic layout). */
export function stripLayout(code: string): string {
  return code.replace(/\n?^[ \t]*%%[ \t]*@layout[ \t]+\{.*\}[ \t]*$/m, '');
}

const PASS = /^\s*(classDef|style|linkStyle|click|accTitle|accDescr|%%(?!\{)(?![ \t]*@layout))/;

export async function parseFlow(code: string): Promise<FlowModel> {
  const { fm, body } = splitFrontmatter(code);
  const data = await flowchartData(code);
  const lines = body.split('\n');
  const head = fm + lines.filter((l) => /^\s*%%\{.*\}%%\s*$/.test(l)).map((l) => `${l.trim()}\n`).join('');
  const extra = lines.filter((l) => PASS.test(l)).map((l) => l.trim());
  return {
    head,
    dir: data.dir === 'TD' ? 'TB' : data.dir,
    nodes: data.vertices.map((v) => ({ id: v.id, label: v.text, shape: SHAPES[v.type] ? v.type : 'square', classes: v.classes, markdown: v.labelType === 'markdown' })),
    edges: data.edges.map((e) => ({ from: e.start, to: e.end, label: e.text, type: e.type, stroke: e.stroke })),
    subs: data.subs,
    parent: data.parent,
    extra,
    pos: readLayout(code) ?? {},
  };
}

function nodeLine(n: FNode): string {
  const cls = n.classes.length ? `:::${n.classes.join(',')}` : '';
  if (n.shape === 'square' && n.label === n.id && /^[\w-]+$/.test(n.id)) return `${n.id}${cls}`;
  const [a, b] = SHAPES[n.shape] ?? SHAPES.square;
  const label = n.markdown ? `"\`${n.label}\`"` : quote(n.label);
  return `${n.id}${a}${label}${b}${cls}`;
}

export function serializeFlow(m: FlowModel, withLayout = true): string {
  const out: string[] = [`flowchart ${m.dir || 'TB'}`];
  const emit = (group: string | undefined, indent: string) => {
    for (const s of m.subs.filter((x) => m.parent[x.id] === group)) {
      out.push(`${indent}subgraph ${s.id}[${quote(s.title || s.id)}]`);
      if (s.dir) out.push(`${indent}  direction ${s.dir}`);
      emit(s.id, `${indent}  `);
      out.push(`${indent}end`);
    }
    for (const n of m.nodes) if (m.parent[n.id] === group) out.push(indent + nodeLine(n));
  };
  emit(undefined, '  ');
  for (const e of m.edges) {
    const ar = arrow(e.type, e.stroke);
    const label = e.label && ar !== '~~~' ? `|${quote(e.label)}|` : '';
    out.push(`  ${e.from} ${ar}${label} ${e.to}`);
  }
  for (const l of m.extra) out.push(`  ${l}`);
  if (withLayout) {
    const keep = new Set([...m.nodes.map((n) => n.id), ...m.subs.map((s) => s.id)]);
    const layout: Record<string, [number, number]> = {};
    for (const [k, p] of Object.entries(m.pos)) if (keep.has(k)) layout[k] = [Math.round(p.x), Math.round(p.y)];
    out.push(`  %% @layout ${JSON.stringify(layout)}`);
  }
  return m.head + out.join('\n');
}

/** A fresh id like N1, N2… not used by any node or subgraph. */
export function freshId(m: FlowModel, prefix = 'N'): string {
  const used = new Set([...m.nodes.map((n) => n.id), ...m.subs.map((s) => s.id)]);
  for (let i = 1; ; i++) if (!used.has(`${prefix}${i}`)) return `${prefix}${i}`;
}

/** Subgraph ids from `id` up to the top. */
export function ancestors(m: FlowModel, id: string): string[] {
  const out: string[] = [];
  for (let p = m.parent[id]; p; p = m.parent[p]) out.push(p);
  return out;
}
