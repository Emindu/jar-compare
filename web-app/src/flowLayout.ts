// Hand-placed positions on mermaid's own flowchart drawing. Mermaid renders the
// diagram as usual; then its nodes are moved to the saved centres, links are
// re-routed between them, link labels follow, and subgraph boxes are refitted
// around their members. The shapes, fonts and colours stay mermaid's.

import { parseFlow, type FlowModel, type Point } from './flowModel';
import { renderMermaid, type Theme } from './mermaidSource';

export interface Box { x: number; y: number; w: number; h: number }

/** Sizes read from one mermaid render (positions in the drawing's own units). */
export interface Measure {
  nodes: Record<string, { w: number; h: number; centre: Point }>;
  clusters: Record<string, { labelW: number; labelH: number; box: Box }>;
  /** Per link (model order): label size, or null when it has no label. */
  labels: ({ w: number; h: number } | null)[];
  /** Per link: mermaid's own route and label centre, kept while neither end moves. */
  routes: ({ d: string; mid: Point | null } | null)[];
  /** Mermaid's own bounds, for diagrams nobody has moved yet. */
  bounds: Box;
}

export interface Geometry {
  nodes: Record<string, Box>;
  clusters: Record<string, Box & { labelW: number; labelH: number }>;
  edges: { index: number; from: string; to: string; d: string; label: Point | null; labelBox: Box | null }[];
  bounds: Box;
}

const centreOf = (b: Box): Point => ({ x: b.x + b.w / 2, y: b.y + b.h / 2 });

function svgId(svg: SVGSVGElement): string { return svg.id ? `${svg.id}-` : ''; }

/** Matrix from an element's own coordinates to the root drawing's coordinates. */
function toRoot(svg: SVGSVGElement, el: Element): DOMMatrix {
  const root = svg.getScreenCTM(), own = (el as SVGGraphicsElement).getScreenCTM?.();
  return root && own ? root.inverse().multiply(own) : new DOMMatrix();
}

function boxIn(svg: SVGSVGElement, el: Element): Box | null {
  const g = el as SVGGraphicsElement;
  if (!g.getBBox) return null;
  const b = g.getBBox();
  const t = toRoot(svg, el);
  const a = new DOMPoint(b.x, b.y).matrixTransform(t), c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(t);
  return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
}

function nodeEls(svg: SVGSVGElement): Map<string, SVGGElement> {
  const out = new Map<string, SVGGElement>();
  const prefix = svgId(svg);
  svg.querySelectorAll<SVGGElement>('g.node[id]').forEach((g) => {
    const local = prefix && g.id.startsWith(prefix) ? g.id.slice(prefix.length) : g.id;
    const m = /^flowchart-(.+)-\d+$/.exec(local);
    if (m) out.set(m[1], g);
  });
  return out;
}

function clusterEls(svg: SVGSVGElement): Map<string, SVGGElement> {
  const out = new Map<string, SVGGElement>();
  const prefix = svgId(svg);
  svg.querySelectorAll<SVGGElement>('g.cluster[id]').forEach((g) => out.set(prefix && g.id.startsWith(prefix) ? g.id.slice(prefix.length) : g.id, g));
  return out;
}

/** Link paths in model order (mermaid draws them in source order). */
function edgeEls(svg: SVGSVGElement, m: FlowModel): { path: SVGPathElement | null; label: SVGGElement | null }[] {
  const paths = [...svg.querySelectorAll<SVGPathElement>('path[data-edge="true"][data-id]')];
  const labels = [...svg.querySelectorAll<SVGGElement>('g.edgeLabel')];
  const labelFor = new Map<string, SVGGElement>();
  labels.forEach((l) => { const id = l.querySelector('[data-id]')?.getAttribute('data-id'); if (id) labelFor.set(id, l); });
  const used = new Set<SVGPathElement>();
  return m.edges.map((e, i) => {
    const want = `L_${e.from}_${e.to}_`;
    let p: SVGPathElement | undefined = paths[i] && paths[i].getAttribute('data-id')!.startsWith(want) && !used.has(paths[i]) ? paths[i] : undefined;
    if (!p) p = paths.find((x) => !used.has(x) && x.getAttribute('data-id')!.startsWith(want));
    if (p) used.add(p);
    return { path: p ?? null, label: p ? labelFor.get(p.getAttribute('data-id')!) ?? null : null };
  });
}

export function measureFlow(svg: SVGSVGElement, m: FlowModel): Measure {
  const nodes: Measure['nodes'] = {};
  for (const [id, g] of nodeEls(svg)) {
    const b = boxIn(svg, g);
    if (b) nodes[id] = { w: b.w, h: b.h, centre: centreOf(b) };
  }
  const clusters: Measure['clusters'] = {};
  for (const [id, g] of clusterEls(svg)) {
    const rect = g.querySelector(':scope > rect');
    const label = g.querySelector('.cluster-label');
    const b = rect ? boxIn(svg, rect) : null;
    const lb = label ? boxIn(svg, label) : null;
    if (b) clusters[id] = { labelW: lb?.w ?? 0, labelH: lb?.h ?? 0, box: b };
  }
  const els = edgeEls(svg, m);
  const labels = els.map(({ label }) => {
    const fo = label?.querySelector('foreignObject');
    const w = +(fo?.getAttribute('width') ?? 0), h = +(fo?.getAttribute('height') ?? 0);
    return w && h ? { w, h } : null;
  });
  const routes = els.map(({ path, label }, i) => {
    if (!path) return null;
    const t = toRoot(svg, path.parentElement ?? svg);
    const d = (path.getAttribute('d') ?? '').replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => {
      const q = new DOMPoint(+x, +y).matrixTransform(t);
      return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
    });
    const lb = label && labels[i] ? boxIn(svg, label) : null;
    return { d, mid: lb ? centreOf(lb) : null };
  });
  const vb = svg.viewBox.baseVal;
  return { nodes, clusters, labels, routes, bounds: { x: vb.x, y: vb.y, w: vb.width, h: vb.height } };
}

/** Centres for nodes that have no saved position yet: where mermaid put them. */
export function measuredPositions(meas: Measure): Record<string, Point> {
  const out: Record<string, Point> = {};
  for (const [id, n] of Object.entries(meas.nodes)) out[id] = n.centre;
  for (const [id, c] of Object.entries(meas.clusters)) out[id] = centreOf(c.box);
  return out;
}

/** Where a link leaves box a towards box b, mermaid style: off the facing side's middle. */
function route(a: Box, b: Box, shift: number, horizontal: boolean): { d: string; mid: Point } {
  const ca = centreOf(a), cb = centreOf(b);
  let p0: Point, p1: Point, c1: Point, c2: Point;
  if (horizontal) {
    const s = cb.x >= ca.x ? 1 : -1;
    p0 = { x: ca.x + (s * a.w) / 2, y: ca.y + shift };
    p1 = { x: cb.x - (s * b.w) / 2, y: cb.y + shift };
    const mx = (p0.x + p1.x) / 2;
    c1 = { x: mx, y: p0.y }; c2 = { x: mx, y: p1.y };
  } else {
    const s = cb.y >= ca.y ? 1 : -1;
    p0 = { x: ca.x + shift, y: ca.y + (s * a.h) / 2 };
    p1 = { x: cb.x + shift, y: cb.y - (s * b.h) / 2 };
    const my = (p0.y + p1.y) / 2;
    c1 = { x: p0.x, y: my }; c2 = { x: p1.x, y: my };
  }
  const f = (p: Point) => `${p.x.toFixed(2)},${p.y.toFixed(2)}`;
  const mid = { x: (p0.x + 3 * c1.x + 3 * c2.x + p1.x) / 8, y: (p0.y + 3 * c1.y + 3 * c2.y + p1.y) / 8 };
  return { d: `M${f(p0)} C${f(c1)} ${f(c2)} ${f(p1)}`, mid };
}

/** Node, subgraph and link geometry for the model's positions. */
export function flowGeometry(m: FlowModel, meas: Measure): Geometry {
  const nodes: Record<string, Box> = {};
  // Things still where mermaid put them keep mermaid's own boxes and routes.
  const still = new Set<string>();
  const near = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1 && Math.abs(a.y - b.y) < 1;
  for (const n of m.nodes) {
    const size = meas.nodes[n.id];
    if (size && (!m.pos[n.id] || near(m.pos[n.id], size.centre))) still.add(n.id);
  }
  for (const n of m.nodes) {
    const size = meas.nodes[n.id];
    const c = m.pos[n.id] ?? size?.centre;
    if (size && c) nodes[n.id] = { x: c.x - size.w / 2, y: c.y - size.h / 2, w: size.w, h: size.h };
  }

  // Subgraph boxes wrap their members, innermost first.
  const depth = (id: string) => { let d = 0; for (let p = m.parent[id]; p; p = m.parent[p]) d++; return d; };
  const clusters: Geometry['clusters'] = {};
  for (const s of [...m.subs].sort((a, b) => depth(b.id) - depth(a.id))) {
    const meta = meas.clusters[s.id];
    if (!meta) continue;
    const members = [
      ...m.nodes.filter((n) => m.parent[n.id] === s.id).map((n) => nodes[n.id]),
      ...m.subs.filter((x) => m.parent[x.id] === s.id).map((x) => clusters[x.id]),
    ].filter(Boolean) as Box[];
    const memberIds = [...m.nodes.filter((n) => m.parent[n.id] === s.id).map((n) => n.id), ...m.subs.filter((x) => m.parent[x.id] === s.id).map((x) => x.id)];
    const unmoved = memberIds.every((id) => still.has(id)) && (memberIds.length > 0 || !m.pos[s.id] || near(m.pos[s.id], centreOf(meta.box)));
    let box: Box;
    if (unmoved) {
      box = meta.box;
      still.add(s.id);
    } else if (members.length) {
      const x0 = Math.min(...members.map((b) => b.x)) - 14, x1 = Math.max(...members.map((b) => b.x + b.w)) + 14;
      const y0 = Math.min(...members.map((b) => b.y)) - meta.labelH - 14, y1 = Math.max(...members.map((b) => b.y + b.h)) + 14;
      const w = Math.max(x1 - x0, meta.labelW + 24);
      box = { x: (x0 + x1) / 2 - w / 2, y: y0, w, h: y1 - y0 };
    } else {
      const c = m.pos[s.id] ?? centreOf(meta.box);
      box = { x: c.x - meta.box.w / 2, y: c.y - meta.box.h / 2, w: meta.box.w, h: meta.box.h };
    }
    clusters[s.id] = { ...box, labelW: meta.labelW, labelH: meta.labelH };
  }

  const horizontal = /^(LR|RL)$/.test(m.dir);
  const boxFor = (id: string): Box | undefined => nodes[id] ?? clusters[id];
  const pairs = new Map<string, number[]>();
  m.edges.forEach((e, i) => { const k = [e.from, e.to].sort().join('\u0000'); pairs.set(k, [...(pairs.get(k) ?? []), i]); });
  const edges: Geometry['edges'] = [];
  m.edges.forEach((e, index) => {
    const a = boxFor(e.from), b = boxFor(e.to);
    if (!a || !b) return;
    let d: string, mid: Point;
    const own = meas.routes[index];
    if (own && still.has(e.from) && still.has(e.to)) {
      const size = meas.labels[index];
      const at = own.mid;
      edges.push({ index, from: e.from, to: e.to, d: own.d, label: at, labelBox: size && at ? { x: at.x - size.w / 2, y: at.y - size.h / 2, w: size.w, h: size.h } : null });
      return;
    }
    if (e.from === e.to) {
      const x = a.x + a.w, y = a.y + a.h / 2;
      d = `M${x - 6},${a.y} C${x + 30},${a.y - 34} ${x + 40},${y} ${x},${y}`;
      mid = { x: x + 28, y: a.y - 12 };
    } else {
      const sib = pairs.get([e.from, e.to].sort().join('\u0000'))!;
      const k = sib.indexOf(index);
      const shift = (k - (sib.length - 1) / 2) * 12;
      // Follow the diagram's direction unless the boxes sit clearly the other way.
      const ca = centreOf(a), cb = centreOf(b);
      const dx = Math.abs(cb.x - ca.x) - (a.w + b.w) / 2, dy = Math.abs(cb.y - ca.y) - (a.h + b.h) / 2;
      const across = horizontal ? dy > 20 && dx < 0 : dx > 20 && dy < 0;
      ({ d, mid } = route(a, b, shift, horizontal !== across));
    }
    const size = meas.labels[index];
    edges.push({
      index, from: e.from, to: e.to, d, label: mid,
      labelBox: size ? { x: mid.x - size.w / 2, y: mid.y - size.h / 2, w: size.w, h: size.h } : null,
    });
  });

  const all: Box[] = [...Object.values(nodes), ...Object.values(clusters), ...edges.flatMap((e) => (e.labelBox ? [e.labelBox] : []))];
  let bounds = meas.bounds;
  if (all.length) {
    const x0 = Math.min(...all.map((b) => b.x)) - 8, y0 = Math.min(...all.map((b) => b.y)) - 8;
    const x1 = Math.max(...all.map((b) => b.x + b.w)) + 8, y1 = Math.max(...all.map((b) => b.y + b.h)) + 8;
    bounds = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  return { nodes, clusters, edges, bounds };
}

/** Move mermaid's elements to the geometry (and size the drawing to `view`, default its bounds). */
export function applyGeometry(svg: SVGSVGElement, m: FlowModel, g: Geometry, view?: Box) {
  const local = (el: Element, p: Point) => new DOMPoint(p.x, p.y).matrixTransform(toRoot(svg, el.parentElement ?? svg).inverse());
  const translate = (el: Element, p: Point) => { const q = local(el, p); el.setAttribute('transform', `translate(${q.x.toFixed(2)}, ${q.y.toFixed(2)})`); };

  for (const [id, el] of nodeEls(svg)) {
    const b = g.nodes[id];
    if (!b) continue;
    // The node's own origin may sit off its visual centre; keep that offset.
    const cur = boxIn(svg, el);
    const tr = /translate\(\s*([-\d.e]+)[ ,]+([-\d.e]+)/.exec(el.getAttribute('transform') ?? '');
    if (!cur || !tr) continue;
    const at = toRoot(svg, el.parentElement ?? svg);
    const curOrigin = new DOMPoint(+tr[1], +tr[2]).matrixTransform(at);
    const off = { x: curOrigin.x - (cur.x + cur.w / 2), y: curOrigin.y - (cur.y + cur.h / 2) };
    translate(el, { x: b.x + b.w / 2 + off.x, y: b.y + b.h / 2 + off.y });
  }
  for (const [id, el] of clusterEls(svg)) {
    const b = g.clusters[id];
    const rect = el.querySelector(':scope > rect');
    if (!b || !rect) continue;
    const a = local(rect, { x: b.x, y: b.y }), c = local(rect, { x: b.x + b.w, y: b.y + b.h });
    rect.setAttribute('x', a.x.toFixed(2)); rect.setAttribute('y', a.y.toFixed(2));
    rect.setAttribute('width', (c.x - a.x).toFixed(2)); rect.setAttribute('height', (c.y - a.y).toFixed(2));
    const label = el.querySelector('.cluster-label');
    if (label) translate(label, { x: b.x + b.w / 2 - b.labelW / 2, y: b.y + 4 });
  }
  const els = edgeEls(svg, m);
  for (const e of g.edges) {
    const { path, label } = els[e.index] ?? {};
    if (path) {
      const inv = toRoot(svg, path.parentElement ?? svg).inverse();
      path.setAttribute('d', e.d.replace(/(-?[\d.]+),(-?[\d.]+)/g, (_, x, y) => {
        const q = new DOMPoint(+x, +y).matrixTransform(inv);
        return `${q.x.toFixed(2)},${q.y.toFixed(2)}`;
      }));
    }
    if (label && e.label) translate(label, e.label);
  }
  const v = view ?? g.bounds;
  svg.setAttribute('viewBox', `${v.x.toFixed(2)} ${v.y.toFixed(2)} ${v.w.toFixed(2)} ${v.h.toFixed(2)}`);
  if (!view) svg.style.maxWidth = `${v.w.toFixed(2)}px`;
}

/** Render a flowchart with saved positions: mermaid's drawing, nodes where they were put. */
export async function renderFreeFlow(code: string, theme: Theme): Promise<string> {
  const [out, model] = await Promise.all([renderMermaid(code, theme), parseFlow(code)]);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-30000px;top:0;visibility:hidden;width:3000px;pointer-events:none';
  host.innerHTML = out;
  document.body.appendChild(host);
  try {
    const svg = host.querySelector('svg');
    if (!svg) return out;
    const meas = measureFlow(svg, model);
    applyGeometry(svg, model, flowGeometry(model, meas));
    svg.classList.add('dg-free');
    return host.innerHTML;
  } finally {
    host.remove();
  }
}
