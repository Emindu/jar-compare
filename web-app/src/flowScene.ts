// Geometry and drawing for flowcharts with saved positions. The SVG mirrors the
// structure mermaid emits (g.node#…-flowchart-ID-n, path[data-edge][data-id],
// g.cluster, g.edgeLabel), so tracing, search, export and the minimap work on it.

import type { FlowModel, Point } from './flowModel';
import type { Theme } from './mermaidSource';

export interface Palette { fill: string; stroke: string; text: string; line: string; cluster: string; clusterStroke: string; labelBg: string; bg: string }

export function palette(theme: Theme): Palette {
  return theme === 'dark'
    ? { fill: '#1f2020', stroke: '#9aa0a6', text: '#e6e6e6', line: '#b8bcc2', cluster: '#25282c', clusterStroke: '#4b5058', labelBg: '#16181b', bg: '#0F1216' }
    : { fill: '#f2f2f2', stroke: '#8a8f96', text: '#24292f', line: '#5c6168', cluster: '#fafafa', clusterStroke: '#c7ccd2', labelBg: '#ffffff', bg: '#FAFBFC' };
}

const FONT = '14px "IBM Plex Sans", system-ui, sans-serif';
const LINE_H = 19;
let ctx: CanvasRenderingContext2D | null = null;

export function textWidth(s: string): number {
  if (!ctx) ctx = document.createElement('canvas').getContext('2d');
  if (!ctx) return s.length * 7.5;
  ctx.font = FONT;
  return ctx.measureText(s).width;
}

/** Display lines of a label: <br> splits lines, tags and markdown markers are dropped. */
export function labelLines(label: string): string[] {
  return label
    .replace(/#quot;/g, '"').replace(/#amp;/g, '&').replace(/#lt;/g, '<').replace(/#gt;/g, '>')
    .split(/<br\s*\/?>|\n/i)
    .map((l) => l.replace(/<[^>]+>/g, '').replace(/\*\*|__|`/g, '').replace(/^fa:fa-[\w-]+\s*/, '').trim());
}

export interface SNode { id: string; shape: string; x: number; y: number; w: number; h: number; lines: string[]; style: Record<string, string> }
export interface SSub { id: string; title: string; x: number; y: number; w: number; h: number; depth: number }
export interface SEdge {
  key: string; index: number; from: string; to: string; d: string;
  label: string[]; lx: number; ly: number; lw: number; lh: number;
  type: string; stroke: string; style: Record<string, string>;
}
export interface Scene { nodes: SNode[]; subs: SSub[]; edges: SEdge[]; bounds: { x: number; y: number; w: number; h: number } }

/** Size of a node's outline for its label, before shape-specific growth. */
function boxSize(lines: string[]): { w: number; h: number } {
  const tw = Math.max(20, ...lines.map(textWidth));
  return { w: Math.max(70, tw + 32), h: Math.max(40, lines.length * LINE_H + 21) };
}

/** Outer size of a shape that fits a w×h label box. */
function outerSize(shape: string, w: number, h: number): { w: number; h: number } {
  switch (shape) {
    case 'diamond': { const s = w * 0.62 + h; return { w: Math.max(s, w + 20), h: Math.max(s * 0.7, h + 20) }; }
    case 'circle': case 'doublecircle': { const d = Math.max(w, h) + 8; return { w: d, h: d }; }
    case 'hexagon': return { w: w + h / 2, h };
    case 'lean_right': case 'lean_left': case 'trapezoid': case 'inv_trapezoid': return { w: w + h / 2, h };
    case 'cylinder': return { w, h: h + 14 };
    case 'subroutine': return { w: w + 16, h };
    case 'odd': return { w: w + h / 4, h };
    default: return { w, h };
  }
}

/** Parse "fill:#f9f,stroke:#333,stroke-width:2px" into attributes. */
export function parseStyle(s: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of s.split(/[,;]/)) {
    const i = part.indexOf(':');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

function stylesFor(m: FlowModel): { node: Map<string, Record<string, string>>; edge: Map<number, Record<string, string>> } {
  const classDefs = new Map<string, Record<string, string>>();
  const nodeStyle = new Map<string, Record<string, string>>();
  const edge = new Map<number, Record<string, string>>();
  let edgeDefault: Record<string, string> | null = null;
  for (const l of m.extra) {
    let r: RegExpExecArray | null;
    if ((r = /^classDef\s+(\S+)\s+(.+)$/.exec(l))) for (const c of r[1].split(',')) classDefs.set(c, parseStyle(r[2]));
    else if ((r = /^style\s+(\S+)\s+(.+)$/.exec(l))) nodeStyle.set(r[1], parseStyle(r[2]));
    else if ((r = /^linkStyle\s+(\S+)\s+(.+?);?$/.exec(l))) {
      const st = parseStyle(r[2]);
      if (r[1] === 'default') edgeDefault = st;
      else for (const i of r[1].split(',')) edge.set(+i, st);
    }
  }
  const node = new Map<string, Record<string, string>>();
  for (const n of m.nodes) {
    const st: Record<string, string> = { ...(classDefs.get('default') ?? {}) };
    for (const c of n.classes) Object.assign(st, classDefs.get(c) ?? {});
    Object.assign(st, nodeStyle.get(n.id) ?? {});
    node.set(n.id, st);
  }
  if (edgeDefault) m.edges.forEach((_, i) => edge.set(i, { ...edgeDefault, ...(edge.get(i) ?? {}) }));
  return { node, edge };
}

/** Where the ray from a node's centre towards p leaves its outline. */
function boundary(n: { shape?: string; x: number; y: number; w: number; h: number }, p: Point): Point {
  const dx = p.x - n.x, dy = p.y - n.y;
  if (!dx && !dy) return { x: n.x, y: n.y };
  const hw = n.w / 2, hh = n.h / 2;
  let t: number;
  if (n.shape === 'diamond') t = 1 / (Math.abs(dx) / hw + Math.abs(dy) / hh);
  else if (n.shape === 'circle' || n.shape === 'doublecircle') t = hw / Math.hypot(dx, dy);
  else t = Math.min(dx ? hw / Math.abs(dx) : Infinity, dy ? hh / Math.abs(dy) : Infinity);
  return { x: n.x + dx * t, y: n.y + dy * t };
}

export function buildScene(m: FlowModel): Scene {
  const st = stylesFor(m);
  const nodes: SNode[] = m.nodes.map((n, i) => {
    const lines = labelLines(n.label);
    const b = boxSize(lines);
    const o = outerSize(n.shape, b.w, b.h);
    const p = m.pos[n.id] ?? { x: 100 + (i % 4) * 180, y: 60 + Math.floor(i / 4) * 110 };
    return { id: n.id, shape: n.shape, x: p.x, y: p.y, w: o.w, h: o.h, lines, style: st.node.get(n.id) ?? {} };
  });
  const byId = new Map<string, { shape?: string; x: number; y: number; w: number; h: number }>(nodes.map((n) => [n.id, n]));

  // Subgraph boxes wrap their members, innermost first.
  const depth = (id: string) => { let d = 0; for (let p = m.parent[id]; p; p = m.parent[p]) d++; return d; };
  const subs: SSub[] = [];
  const order = [...m.subs].sort((a, b) => depth(b.id) - depth(a.id));
  for (const s of order) {
    const members = [...m.nodes.map((n) => n.id), ...m.subs.map((x) => x.id)].filter((id) => m.parent[id] === s.id && byId.has(id));
    const title = labelLines(s.title).join(' ');
    let box: { x: number; y: number; w: number; h: number };
    if (members.length) {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const id of members) {
        const b = byId.get(id)!;
        x0 = Math.min(x0, b.x - b.w / 2); y0 = Math.min(y0, b.y - b.h / 2);
        x1 = Math.max(x1, b.x + b.w / 2); y1 = Math.max(y1, b.y + b.h / 2);
      }
      x0 -= 18; x1 += 18; y0 -= 34; y1 += 16;
      const minW = textWidth(title) + 28;
      if (x1 - x0 < minW) { const g = (minW - (x1 - x0)) / 2; x0 -= g; x1 += g; }
      box = { x: (x0 + x1) / 2, y: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
    } else {
      const p = m.pos[s.id] ?? { x: 120, y: 120 };
      box = { x: p.x, y: p.y, w: Math.max(160, textWidth(title) + 28), h: 90 };
    }
    byId.set(s.id, box);
    subs.push({ id: s.id, title, ...box, depth: depth(s.id) });
  }
  subs.sort((a, b) => a.depth - b.depth);

  // Edges: straight between outlines; parallel ones bow apart; self-links loop.
  const pairCount = new Map<string, number>();
  const pairSeen = new Map<string, number>();
  for (const e of m.edges) { const k = [e.from, e.to].sort().join('\u0000'); pairCount.set(k, (pairCount.get(k) ?? 0) + 1); }
  const idCount = new Map<string, number>();
  const edges: SEdge[] = [];
  m.edges.forEach((e, index) => {
    const a = byId.get(e.from), b = byId.get(e.to);
    if (!a || !b) return;
    const base = `L_${e.from}_${e.to}`;
    const n = idCount.get(base) ?? 0;
    idCount.set(base, n + 1);
    const label = e.label ? labelLines(e.label) : [];
    const lw = label.length ? Math.max(...label.map(textWidth)) + 10 : 0;
    const lh = label.length * LINE_H + 4;
    let d: string, lx: number, ly: number;
    if (e.from === e.to) {
      const x = a.x + a.w / 2, y = a.y;
      d = `M${x},${y - 10} C${x + 46},${y - 40} ${x + 46},${y + 40} ${x},${y + 10}`;
      lx = x + 40 + lw / 2; ly = y;
    } else {
      const k = [e.from, e.to].sort().join('\u0000');
      const total = pairCount.get(k)!;
      const i = pairSeen.get(k) ?? 0;
      pairSeen.set(k, i + 1);
      // Offset of this edge among its parallel siblings, measured in a fixed direction.
      const sign = e.from < e.to ? 1 : -1;
      const off = (i - (total - 1) / 2) * 34 * sign;
      const vx = b.x - a.x, vy = b.y - a.y, len = Math.hypot(vx, vy) || 1;
      const nx = -vy / len, ny = vx / len;
      const c = { x: (a.x + b.x) / 2 + nx * off * 1.6, y: (a.y + b.y) / 2 + ny * off * 1.6 };
      const p0 = boundary(a, off ? c : b), p1 = boundary(b, off ? c : a);
      if (off) {
        d = `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} Q${c.x.toFixed(1)},${c.y.toFixed(1)} ${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
        lx = 0.25 * p0.x + 0.5 * c.x + 0.25 * p1.x; ly = 0.25 * p0.y + 0.5 * c.y + 0.25 * p1.y;
      } else {
        d = `M${p0.x.toFixed(1)},${p0.y.toFixed(1)} L${p1.x.toFixed(1)},${p1.y.toFixed(1)}`;
        lx = (p0.x + p1.x) / 2; ly = (p0.y + p1.y) / 2;
      }
    }
    edges.push({ key: `${base}_${n}`, index, from: e.from, to: e.to, d, label, lx, ly, lw, lh, type: e.type, stroke: e.stroke, style: st.edge.get(index) ?? {} });
  });

  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const b of [...nodes, ...subs]) {
    x0 = Math.min(x0, b.x - b.w / 2); y0 = Math.min(y0, b.y - b.h / 2);
    x1 = Math.max(x1, b.x + b.w / 2); y1 = Math.max(y1, b.y + b.h / 2);
  }
  for (const e of edges) {
    if (!e.label.length && e.from !== e.to) continue;
    x0 = Math.min(x0, e.lx - e.lw / 2); y0 = Math.min(y0, e.ly - e.lh / 2);
    x1 = Math.max(x1, e.lx + e.lw / 2 + (e.from === e.to ? 40 : 0)); y1 = Math.max(y1, e.ly + e.lh / 2);
  }
  if (!Number.isFinite(x0)) { x0 = 0; y0 = 0; x1 = 200; y1 = 100; }
  return { nodes, subs, edges, bounds: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
}

// ── Markup ─────────────────────────────────────────────────────────────────

const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The outline path of a shape centred on 0,0. */
export function shapePath(shape: string, w: number, h: number): string {
  const hw = w / 2, hh = h / 2;
  const r = (rx: number) => `M${-hw + rx},${-hh} H${hw - rx} A${rx},${rx} 0 0 1 ${hw},${-hh + rx} V${hh - rx} A${rx},${rx} 0 0 1 ${hw - rx},${hh} H${-hw + rx} A${rx},${rx} 0 0 1 ${-hw},${hh - rx} V${-hh + rx} A${rx},${rx} 0 0 1 ${-hw + rx},${-hh} Z`;
  switch (shape) {
    case 'round': return r(8);
    case 'stadium': return r(Math.min(hh, hw));
    case 'circle': case 'doublecircle': return `M${-hw},0 A${hw},${hw} 0 1 0 ${hw},0 A${hw},${hw} 0 1 0 ${-hw},0 Z`;
    case 'diamond': return `M0,${-hh} L${hw},0 L0,${hh} L${-hw},0 Z`;
    case 'hexagon': { const k = h / 4; return `M${-hw + k},${-hh} H${hw - k} L${hw},0 L${hw - k},${hh} H${-hw + k} L${-hw},0 Z`; }
    case 'lean_right': { const k = h / 4; return `M${-hw + k},${-hh} H${hw} L${hw - k},${hh} H${-hw} Z`; }
    case 'lean_left': { const k = h / 4; return `M${-hw},${-hh} H${hw - k} L${hw},${hh} H${-hw + k} Z`; }
    case 'trapezoid': { const k = h / 4; return `M${-hw + k},${-hh} H${hw - k} L${hw},${hh} H${-hw} Z`; }
    case 'inv_trapezoid': { const k = h / 4; return `M${-hw},${-hh} H${hw} L${hw - k},${hh} H${-hw + k} Z`; }
    case 'odd': { const k = h / 4; return `M${-hw},${-hh} H${hw} V${hh} H${-hw} L${-hw + k},0 Z`; }
    case 'cylinder': {
      const ry = 7;
      return `M${-hw},${-hh + ry} A${hw},${ry} 0 0 1 ${hw},${-hh + ry} V${hh - ry} A${hw},${ry} 0 0 1 ${-hw},${hh - ry} Z M${-hw},${-hh + ry} A${hw},${ry} 0 0 0 ${hw},${-hh + ry}`;
    }
    case 'subroutine': return `M${-hw},${-hh} H${hw} V${hh} H${-hw} Z M${-hw + 8},${-hh} V${hh} M${hw - 8},${-hh} V${hh}`;
    default: return `M${-hw},${-hh} H${hw} V${hh} H${-hw} Z`;
  }
}

/** Shape and label of a node, centred on 0,0 (goes inside g.node). */
export function nodeMarkup(n: SNode, p: Palette): string {
  const fill = n.style.fill ?? p.fill, stroke = n.style.stroke ?? p.stroke;
  const sw = n.style['stroke-width'] ?? '1.2';
  const dash = n.style['stroke-dasharray'] ? ` stroke-dasharray="${esc(n.style['stroke-dasharray'])}"` : '';
  let out = `<path d="${shapePath(n.shape, n.w, n.h)}" fill="${esc(fill)}" stroke="${esc(stroke)}" stroke-width="${esc(sw.replace('px', ''))}"${dash}/>`;
  if (n.shape === 'doublecircle') out += `<path d="${shapePath('circle', n.w - 8, n.h - 8)}" fill="none" stroke="${esc(stroke)}"/>`;
  const color = n.style.color ?? p.text;
  const y0 = -((n.lines.length - 1) * LINE_H) / 2 + 5 + (n.shape === 'cylinder' ? 4 : 0);
  out += `<text text-anchor="middle" fill="${esc(color)}" font-size="14">${n.lines.map((l, i) => `<tspan x="0" y="${(y0 + i * LINE_H).toFixed(1)}">${esc(l)}</tspan>`).join('')}</text>`;
  return out;
}

function markerDefs(id: string, color: string): string {
  return `<marker id="${id}-pt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="${color}"/></marker>`
    + `<marker id="${id}-x" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,1 L8,9 M8,1 L2,9" stroke="${color}" stroke-width="1.6"/></marker>`
    + `<marker id="${id}-o" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><circle cx="5" cy="5" r="3.6" fill="none" stroke="${color}" stroke-width="1.5"/></marker>`;
}

/** Stroke attributes and arrow markers for an edge. */
export function edgeAttrs(e: Pick<SEdge, 'type' | 'stroke' | 'style'>, p: Palette, markerId: string): Record<string, string> {
  const head = e.type.replace('double_', '');
  const mk = head === 'arrow_point' ? 'pt' : head === 'arrow_cross' ? 'x' : head === 'arrow_circle' ? 'o' : '';
  const color = e.style.stroke ?? p.line;
  const a: Record<string, string> = {
    fill: 'none',
    stroke: e.stroke === 'invisible' ? 'transparent' : color,
    'stroke-width': (e.style['stroke-width'] ?? (e.stroke === 'thick' ? '3' : '1.5')).replace('px', ''),
  };
  if (e.stroke === 'dotted') a['stroke-dasharray'] = '3 4';
  if (mk && e.stroke !== 'invisible') {
    a['marker-end'] = `url(#${markerId}-${mk})`;
    if (e.type.startsWith('double_')) a['marker-start'] = `url(#${markerId}-${mk})`;
  }
  return a;
}

let svgSeq = 0;

/** A complete flowchart SVG, structured like mermaid's output. */
export function sceneSvg(scene: Scene, theme: Theme): string {
  const p = palette(theme);
  const id = `flow-${++svgSeq}`;
  const pad = 12;
  const { x, y, w, h } = scene.bounds;
  const vb = `${(x - pad).toFixed(1)} ${(y - pad).toFixed(1)} ${(w + pad * 2).toFixed(1)} ${(h + pad * 2).toFixed(1)}`;
  const attrs = (a: Record<string, string>) => Object.entries(a).map(([k, v]) => `${k}="${esc(v)}"`).join(' ');
  const clusters = scene.subs.map((s) =>
    `<g class="cluster" id="${id}-${esc(s.id)}"><rect x="${(s.x - s.w / 2).toFixed(1)}" y="${(s.y - s.h / 2).toFixed(1)}" width="${s.w.toFixed(1)}" height="${s.h.toFixed(1)}" rx="4" fill="${p.cluster}" stroke="${p.clusterStroke}"/>`
    + `<text x="${s.x.toFixed(1)}" y="${(s.y - s.h / 2 + 20).toFixed(1)}" text-anchor="middle" fill="${p.text}" font-size="13">${esc(s.title)}</text></g>`).join('');
  const paths = scene.edges.map((e) => `<path data-edge="true" data-id="${esc(e.key)}" d="${e.d}" ${attrs(edgeAttrs(e, p, id))}/>`).join('');
  const labels = scene.edges.filter((e) => e.label.length).map((e) => {
    const top = e.ly - e.lh / 2;
    return `<g class="edgeLabel"><g class="label" data-id="${esc(e.key)}"><rect x="${(e.lx - e.lw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${e.lw.toFixed(1)}" height="${e.lh.toFixed(1)}" fill="${p.labelBg}" rx="2"/>`
      + `<text text-anchor="middle" fill="${p.text}" font-size="13">${e.label.map((l, i) => `<tspan x="${e.lx.toFixed(1)}" y="${(top + 16 + i * LINE_H).toFixed(1)}">${esc(l)}</tspan>`).join('')}</text></g></g>`;
  }).join('');
  const nodes = scene.nodes.map((n, i) => `<g class="node" id="${id}-flowchart-${esc(n.id)}-${i}" transform="translate(${n.x.toFixed(1)},${n.y.toFixed(1)})">${nodeMarkup(n, p)}</g>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" id="${id}" class="flowchart dg-free" width="100%" viewBox="${vb}" style="max-width: ${(w + pad * 2).toFixed(0)}px;" role="graphics-document document" aria-roledescription="flowchart-v2" font-family="IBM Plex Sans, system-ui, sans-serif">`
    + `<defs>${markerDefs(id, p.line)}</defs>`
    + `<g class="clusters">${clusters}</g><g class="edgePaths">${paths}</g><g class="edgeLabels">${labels}</g><g class="nodes">${nodes}</g></svg>`;
}

/** Node centres read from a diagram mermaid rendered (to start editing from its layout). */
export function positionsFromSvg(svg: SVGSVGElement): Record<string, Point> {
  const out: Record<string, Point> = {};
  const prefix = svg.id ? `${svg.id}-` : '';
  const root = svg.getScreenCTM();
  if (!root) return out;
  const inv = root.inverse();
  const centre = (el: SVGGraphicsElement): Point | null => {
    const ctm = el.getScreenCTM();
    if (!ctm) return null;
    const b = el.getBBox();
    const pt = new DOMPoint(b.x + b.width / 2, b.y + b.height / 2).matrixTransform(ctm).matrixTransform(inv);
    return { x: pt.x, y: pt.y };
  };
  svg.querySelectorAll<SVGGElement>('g.node[id]').forEach((g) => {
    const local = prefix && g.id.startsWith(prefix) ? g.id.slice(prefix.length) : g.id;
    const m = /^flowchart-(.+)-\d+$/.exec(local);
    const c = centre(g);
    if (m && c) out[m[1]] = c;
  });
  svg.querySelectorAll<SVGGElement>('g.cluster[id]').forEach((g) => {
    const local = prefix && g.id.startsWith(prefix) ? g.id.slice(prefix.length) : g.id;
    const c = centre(g);
    if (c && !out[local]) out[local] = c;
  });
  return out;
}
