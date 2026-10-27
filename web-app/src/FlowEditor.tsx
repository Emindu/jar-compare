import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Group, LayoutGrid, Minus, Plus, Redo2, Trash2, Undo2 } from 'lucide-react';
import {
  EDGE_STYLES, SHAPE_NAMES, ancestors, freshId, parseFlow, serializeFlow, type FlowModel, type Point,
} from './flowModel';
import { buildScene, edgeAttrs, nodeMarkup, palette, positionsFromSvg, shapePath, type Scene } from './flowScene';
import { renderMermaid, type Theme } from './mermaidSource';

// Edit a flowchart by hand: move nodes anywhere, add nodes and links, rename,
// change shapes and link styles, group into subgraphs. Saving writes mermaid
// text plus a `%% @layout` comment with the positions.

interface Sel { nodes: string[]; edge: number | null; sub: string | null }
const NONE: Sel = { nodes: [], edge: null, sub: null };
type Rename = { kind: 'node'; id: string; value: string } | { kind: 'sub'; id: string; value: string } | { kind: 'edge'; index: number; value: string };
type Drag =
  | { kind: 'move'; ids: string[]; start: Point; orig: Record<string, Point>; before: FlowModel; moved: boolean }
  | { kind: 'connect'; from: string; to: Point }
  | { kind: 'marquee'; start: Point; to: Point; add: boolean };

const GRID = 10;
const snap = (v: number) => Math.round(v / GRID) * GRID;

/** Automatic positions for a model, from a hidden mermaid render. */
async function autoPositions(m: FlowModel, theme: Theme): Promise<Record<string, Point>> {
  const svgText = await renderMermaid(serializeFlow(m, false), theme);
  const host = document.createElement('div');
  host.style.cssText = 'position:fixed;left:-20000px;top:0;visibility:hidden;width:4000px';
  host.innerHTML = svgText;
  document.body.appendChild(host);
  try {
    const svg = host.querySelector('svg');
    if (svg) { svg.removeAttribute('style'); svg.setAttribute('width', '3000'); }
    return svg ? positionsFromSvg(svg) : {};
  } finally {
    host.remove();
  }
}

/** Give every node (and empty subgraph) a position, keeping the ones it has. */
function placeMissing(m: FlowModel): FlowModel {
  const pos = { ...m.pos };
  const xs = Object.values(pos);
  let y = xs.length ? Math.max(...xs.map((p) => p.y)) + 110 : 60;
  let x = 80;
  const needs = [
    ...m.nodes.map((n) => n.id),
    ...m.subs.filter((s) => !m.nodes.some((n) => m.parent[n.id] === s.id) && !m.subs.some((c) => m.parent[c.id] === s.id)).map((s) => s.id),
  ];
  for (const id of needs) {
    if (pos[id]) continue;
    pos[id] = { x, y };
    x += 180;
    if (x > 800) { x = 80; y += 110; }
  }
  return { ...m, pos };
}

function deleteNodes(m: FlowModel, ids: string[]): FlowModel {
  const gone = new Set(ids);
  const ref = (l: string) => /^(style|click|class)\s+(\S+)/.exec(l)?.[2];
  const pos = { ...m.pos };
  const parent = { ...m.parent };
  ids.forEach((id) => { delete pos[id]; delete parent[id]; });
  return {
    ...m,
    nodes: m.nodes.filter((n) => !gone.has(n.id)),
    edges: m.edges.filter((e) => !gone.has(e.from) && !gone.has(e.to)),
    extra: m.extra.filter((l) => !gone.has(ref(l) ?? '')),
    pos,
    parent,
  };
}

/** Remove a subgraph, keeping its contents in the enclosing one. */
function ungroup(m: FlowModel, id: string): FlowModel {
  const parent = { ...m.parent };
  const up = parent[id];
  for (const [k, p] of Object.entries(parent)) if (p === id) parent[k] = up;
  delete parent[id];
  const pos = { ...m.pos };
  delete pos[id];
  return { ...m, subs: m.subs.filter((s) => s.id !== id), edges: m.edges.filter((e) => e.from !== id && e.to !== id), parent, pos };
}

/** Every node inside a subgraph, at any depth. */
function nodesIn(m: FlowModel, sub: string): string[] {
  return m.nodes.filter((n) => ancestors(m, n.id).includes(sub)).map((n) => n.id);
}

export default function FlowEditor({ code, theme, getRendered, onSave, onClose }: {
  code: string;
  theme: Theme;
  getRendered: () => SVGSVGElement | null;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<{ m: FlowModel | null; past: FlowModel[]; future: FlowModel[]; tag: string }>({ m: null, past: [], future: [], tag: '' });
  const [error, setError] = useState('');
  const [sel, setSel] = useState<Sel>(NONE);
  const [rename, setRename] = useState<Rename | null>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [zoom, setZoom] = useState(1);
  const [busy, setBusy] = useState(false);
  const [frame, setFrame] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const [getSvg] = useState(() => getRendered);
  const m = hist.m;
  const p = palette(theme);

  // Load: parse, then start from saved positions or the layout mermaid drew.
  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        await document.fonts?.ready;
        const parsed = await parseFlow(code);
        let pos = parsed.pos;
        if (!Object.keys(pos).length) {
          const rendered = getSvg();
          pos = rendered ? positionsFromSvg(rendered) : {};
          if (!Object.keys(pos).length) pos = await autoPositions(parsed, theme);
        }
        if (alive) setHist({ m: placeMissing({ ...parsed, pos }), past: [], future: [], tag: '' });
      } catch (e) {
        if (alive) setError(String((e as Error)?.message ?? e));
      }
    })();
    return () => { alive = false; };
  }, [code, theme, getSvg]);

  const scene: Scene | null = useMemo(() => (m ? buildScene(m) : null), [m]);

  // The canvas extends well past the content so there is room to drag outward;
  // it only changes when no drag is under way so things don't jump mid-gesture.
  if (scene && !drag) {
    const b = scene.bounds, pad = 320;
    const x = Math.floor((b.x - pad) / 100) * 100, y = Math.floor((b.y - pad) / 100) * 100;
    const next = { x, y, w: Math.ceil((b.x + b.w + pad - x) / 100) * 100, h: Math.ceil((b.y + b.h + pad - y) / 100) * 100 };
    if (!frame || frame.x !== next.x || frame.y !== next.y || frame.w !== next.w || frame.h !== next.h) setFrame(next);
  }

  // Keep the view still when the frame grows to the left or top.
  const prevFrame = useRef<{ x: number; y: number } | null>(null);
  const centred = useRef(false);
  useLayoutEffect(() => {
    const st = stageRef.current;
    if (!frame || !st) return;
    if (!centred.current && scene) {
      centred.current = true;
      const b = scene.bounds;
      st.scrollLeft = ((b.x + b.w / 2) - frame.x) * zoom - st.clientWidth / 2;
      st.scrollTop = ((b.y + b.h / 2) - frame.y) * zoom - st.clientHeight / 2;
    } else if (prevFrame.current) {
      st.scrollLeft += (prevFrame.current.x - frame.x) * zoom;
      st.scrollTop += (prevFrame.current.y - frame.y) * zoom;
    }
    prevFrame.current = { x: frame.x, y: frame.y };
  }, [frame, zoom, scene]);

  /** Apply a change as one undo step (`tag` merges consecutive edits of the same field). */
  const apply = (fn: (m: FlowModel) => FlowModel, tag = '') => {
    setHist((h) => {
      if (!h.m) return h;
      const merge = tag && tag === h.tag;
      return { m: fn(h.m), past: merge ? h.past : [...h.past.slice(-99), h.m], future: [], tag };
    });
  };
  const undo = () => setHist((h) => (h.past.length && h.m ? { m: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.m, ...h.future], tag: '' } : h));
  const redo = () => setHist((h) => (h.future.length && h.m ? { m: h.future[0], past: [...h.past, h.m], future: h.future.slice(1), tag: '' } : h));
  const dirty = hist.past.length > 0;

  const toDiagram = (e: { clientX: number; clientY: number }): Point => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };

  const addNode = (at: Point, connectFrom?: string) => {
    if (!m) return;
    const id = freshId(m);
    const parent = connectFrom ? m.parent[connectFrom] : undefined;
    apply((x) => ({
      ...x,
      nodes: [...x.nodes, { id, label: 'New node', shape: 'square', classes: [] }],
      edges: connectFrom ? [...x.edges, { from: connectFrom, to: id, label: '', type: 'arrow_point', stroke: 'normal' }] : x.edges,
      parent: { ...x.parent, [id]: parent },
      pos: { ...x.pos, [id]: { x: snap(at.x), y: snap(at.y) } },
    }));
    setSel({ ...NONE, nodes: [id] });
    setRename({ kind: 'node', id, value: 'New node' });
  };

  const viewCentre = (): Point => {
    const st = stageRef.current;
    if (!st || !frame) return { x: 100, y: 100 };
    return { x: frame.x + (st.scrollLeft + st.clientWidth / 2) / zoom, y: frame.y + (st.scrollTop + st.clientHeight / 2) / zoom };
  };

  const deleteSelection = () => {
    if (!m) return;
    if (sel.nodes.length) apply((x) => deleteNodes(x, sel.nodes));
    else if (sel.edge !== null) { const i = sel.edge; apply((x) => ({ ...x, edges: x.edges.filter((_, k) => k !== i) })); }
    else if (sel.sub) { const id = sel.sub; apply((x) => ungroup(x, id)); }
    setSel(NONE);
  };

  const group = () => {
    if (!m) return;
    const id = freshId(m, 'G');
    const parents = new Set(sel.nodes.map((n) => m.parent[n]));
    const outer = parents.size === 1 ? [...parents][0] : undefined;
    const c = viewCentre();
    apply((x) => {
      const parent = { ...x.parent, [id]: outer };
      sel.nodes.forEach((n) => { parent[n] = id; });
      return { ...x, subs: [...x.subs, { id, title: 'Group' }], parent, pos: sel.nodes.length ? x.pos : { ...x.pos, [id]: { x: snap(c.x), y: snap(c.y) } } };
    });
    setSel({ ...NONE, sub: id });
    setRename({ kind: 'sub', id, value: 'Group' });
  };

  const arrange = async () => {
    if (!m) return;
    setBusy(true);
    try {
      const pos = await autoPositions(m, theme);
      apply((x) => placeMissing({ ...x, pos: { ...pos } }));
      centred.current = false;
    } finally {
      setBusy(false);
    }
  };

  const commitRename = () => {
    if (!rename) return;
    const v = rename.value.trim();
    if (rename.kind === 'node') { const id = rename.id; apply((x) => ({ ...x, nodes: x.nodes.map((n) => (n.id === id ? { ...n, label: v || n.id } : n)) })); }
    else if (rename.kind === 'sub') { const id = rename.id; apply((x) => ({ ...x, subs: x.subs.map((s) => (s.id === id ? { ...s, title: v || s.id } : s)) })); }
    else { const i = rename.index; apply((x) => ({ ...x, edges: x.edges.map((e, k) => (k === i ? { ...e, label: v } : e)) })); }
    setRename(null);
  };

  const save = () => { if (m) onSave(serializeFlow(m)); };
  const close = () => { if (!dirty || window.confirm('Discard your changes to this diagram?')) onClose(); };

  // Keyboard: Delete, undo/redo, Escape, Enter to rename, arrows to nudge, Ctrl/Cmd+S to save.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (/^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || t.isContentEditable);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopImmediatePropagation(); save(); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopImmediatePropagation(); redo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (sel.nodes.length || sel.edge !== null || sel.sub) setSel(NONE); else close(); return; }
      if (e.key === 'Enter' && m) {
        if (sel.nodes.length === 1) { const n = m.nodes.find((x) => x.id === sel.nodes[0]); if (n) { e.preventDefault(); setRename({ kind: 'node', id: n.id, value: n.label }); } }
        else if (sel.edge !== null) { e.preventDefault(); setRename({ kind: 'edge', index: sel.edge, value: m.edges[sel.edge]?.label ?? '' }); }
        return;
      }
      const d = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (d && sel.nodes.length) {
        e.preventDefault();
        const step = e.shiftKey ? 1 : GRID;
        apply((x) => {
          const pos = { ...x.pos };
          sel.nodes.forEach((id) => { const q = pos[id]; if (q) pos[id] = { x: q.x + d[0] * step, y: q.y + d[1] * step }; });
          return { ...x, pos };
        }, `nudge:${sel.nodes.join(',')}`);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  // ── Pointer gestures ──
  const startMove = (e: React.PointerEvent, ids: string[]) => {
    if (!m) return;
    const orig: Record<string, Point> = {};
    ids.forEach((id) => { if (m.pos[id]) orig[id] = m.pos[id]; });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'move', ids, start: toDiagram(e), orig, before: m, moved: false });
  };

  const onNodeDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    setRename(null);
    let nodes = sel.nodes;
    if (e.shiftKey || e.metaKey || e.ctrlKey) nodes = nodes.includes(id) ? nodes.filter((x) => x !== id) : [...nodes, id];
    else if (!nodes.includes(id)) nodes = [id];
    setSel({ ...NONE, nodes });
    if (nodes.includes(id)) startMove(e, nodes);
  };

  const onSubDown = (e: React.PointerEvent, id: string) => {
    if (e.button !== 0 || !m) return;
    e.stopPropagation();
    setRename(null);
    setSel({ ...NONE, sub: id });
    const inner = nodesIn(m, id);
    startMove(e, inner.length ? inner : [id]);
  };

  const onHandleDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'connect', from: id, to: toDiagram(e) });
  };

  const onBackgroundDown = (e: React.PointerEvent) => {
    if (e.button !== 0) return;
    setRename(null);
    const at = toDiagram(e);
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    setDrag({ kind: 'marquee', start: at, to: at, add: e.shiftKey });
    if (!e.shiftKey) setSel(NONE);
  };

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = toDiagram(e);
    if (drag.kind === 'move') {
      const dx = at.x - drag.start.x, dy = at.y - drag.start.y;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      if (!drag.moved) setDrag({ ...drag, moved: true });
      setHist((h) => {
        if (!h.m) return h;
        const pos = { ...h.m.pos };
        for (const [id, o] of Object.entries(drag.orig)) pos[id] = { x: snap(o.x + dx), y: snap(o.y + dy) };
        return { ...h, m: { ...h.m, pos } };
      });
    } else {
      setDrag({ ...drag, to: at });
    }
  };

  const nodeAt = (e: { clientX: number; clientY: number }): string | null =>
    (document.elementFromPoint(e.clientX, e.clientY) as Element | null)?.closest('[data-node]')?.getAttribute('data-node') ?? null;

  const subAt = (pt: Point, exclude: Set<string>): string | null => {
    if (!scene) return null;
    let best: { id: string; depth: number } | null = null;
    for (const s of scene.subs) {
      if (exclude.has(s.id)) continue;
      if (Math.abs(pt.x - s.x) <= s.w / 2 && Math.abs(pt.y - s.y) <= s.h / 2 && (!best || s.depth > best.depth)) best = { id: s.id, depth: s.depth };
    }
    return best?.id ?? null;
  };

  const onUp = (e: React.PointerEvent) => {
    if (!drag || !m) { setDrag(null); return; }
    if (drag.kind === 'move') {
      if (drag.moved) {
        // Dropping nodes inside another subgraph's box moves them into it.
        let next = m;
        if (sel.nodes.length && !sel.sub) {
          const at = toDiagram(e);
          const own = new Set<string>();
          for (const id of drag.ids) { own.add(id); ancestors(m, id).forEach((a) => own.add(a)); }
          const target = subAt(at, own);
          if (target) {
            const parent = { ...m.parent };
            drag.ids.forEach((id) => { parent[id] = target; });
            next = { ...m, parent };
          }
        }
        const before = drag.before;
        setHist((h) => ({ m: next, past: [...h.past.slice(-99), before], future: [], tag: '' }));
      }
    } else if (drag.kind === 'connect') {
      const to = nodeAt(e);
      if (to && to !== drag.from) {
        const from = drag.from;
        apply((x) => ({ ...x, edges: [...x.edges, { from, to, label: '', type: 'arrow_point', stroke: 'normal' }] }));
        setSel({ ...NONE, edge: m.edges.length });
      } else if (!to) {
        addNode(drag.to, drag.from);
      }
    } else if (drag.kind === 'marquee' && scene) {
      const x0 = Math.min(drag.start.x, drag.to.x), x1 = Math.max(drag.start.x, drag.to.x);
      const y0 = Math.min(drag.start.y, drag.to.y), y1 = Math.max(drag.start.y, drag.to.y);
      if (x1 - x0 > 4 || y1 - y0 > 4) {
        const hit = scene.nodes.filter((n) => n.x >= x0 && n.x <= x1 && n.y >= y0 && n.y <= y1).map((n) => n.id);
        setSel({ ...NONE, nodes: drag.add ? [...new Set([...sel.nodes, ...hit])] : hit });
      }
    }
    setDrag(null);
  };

  const onWheel = (e: React.WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    setZoom((z) => Math.min(3, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
  };

  if (error) {
    return (
      <div className="dge-empty">
        <p>This flowchart can't be edited: {error}</p>
        <button className="wb-btn" onClick={onClose}>Close</button>
      </div>
    );
  }
  if (!m || !scene || !frame) return <div className="dge-empty">Loading diagram…</div>;

  const selNode = sel.nodes.length === 1 ? m.nodes.find((n) => n.id === sel.nodes[0]) : undefined;
  const selEdge = sel.edge !== null ? m.edges[sel.edge] : undefined;
  const selSub = sel.sub ? m.subs.find((s) => s.id === sel.sub) : undefined;
  const sceneNode = (id: string) => scene.nodes.find((n) => n.id === id);
  const subChoices = (exclude: string[]) => m.subs.filter((s) => !exclude.includes(s.id) && !exclude.some((x) => ancestors(m, s.id).includes(x)));
  const styleOf = (e: { type: string; stroke: string }) => Math.max(0, EDGE_STYLES.findIndex(([t, s]) => t === e.type && s === e.stroke));
  const commonParent = (() => {
    const ps = new Set(sel.nodes.map((n) => m.parent[n] ?? ''));
    return ps.size === 1 ? [...ps][0] : null;
  })();

  // Rename box position, in stage pixels.
  const renameBox = (() => {
    if (!rename) return null;
    if (rename.kind === 'node') { const n = sceneNode(rename.id); return n ? { x: n.x, y: n.y, w: Math.max(n.w, 140) } : null; }
    if (rename.kind === 'sub') { const s = scene.subs.find((x) => x.id === rename.id); return s ? { x: s.x, y: s.y - s.h / 2 + 15, w: Math.max(s.w * 0.7, 140) } : null; }
    const e = scene.edges.find((x) => x.index === rename.index);
    return e ? { x: e.lx, y: e.ly, w: 160 } : null;
  })();

  const single = sel.nodes.length === 1 ? sceneNode(sel.nodes[0]) : undefined;
  const handles = single ? [
    { x: single.x + single.w / 2, y: single.y }, { x: single.x, y: single.y + single.h / 2 },
    { x: single.x - single.w / 2, y: single.y }, { x: single.x, y: single.y - single.h / 2 },
  ] : [];
  const connectFrom = drag?.kind === 'connect' ? sceneNode(drag.from) : undefined;

  return (
    <>
      <div className="md-diagram-bar dge-bar">
        <span className="md-diagram-kind">flowchart · editing</span>
        <span className="dge-tools">
          <button className="file-action-btn" onClick={() => addNode(viewCentre())} title="Add a node (or double-click empty space)"><Plus size={13} aria-hidden /> Node</button>
          <button className="file-action-btn" onClick={group} title={sel.nodes.length ? 'Put the selected nodes in a subgraph' : 'Add an empty subgraph'}><Group size={13} aria-hidden /> Group</button>
          <button className="file-action-btn" onClick={arrange} disabled={busy} title="Lay everything out automatically again"><LayoutGrid size={13} aria-hidden /> {busy ? 'Arranging…' : 'Auto-arrange'}</button>
          <span className="dge-sep" />
          <button className="file-action-btn" onClick={undo} disabled={!hist.past.length} title="Undo (Ctrl+Z)" aria-label="Undo"><Undo2 size={13} aria-hidden /></button>
          <button className="file-action-btn" onClick={redo} disabled={!hist.future.length} title="Redo (Ctrl+Shift+Z)" aria-label="Redo"><Redo2 size={13} aria-hidden /></button>
          <span className="dge-sep" />
          <button className="file-action-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.2))} aria-label="Zoom out"><Minus size={13} aria-hidden /></button>
          <span className="dge-zoom">{Math.round(zoom * 100)}%</span>
          <button className="file-action-btn" onClick={() => setZoom((z) => Math.min(3, z * 1.2))} aria-label="Zoom in"><Plus size={13} aria-hidden /></button>
        </span>
        <span className="md-diagram-actions">
          <button className="file-action-btn" onClick={close}>Cancel</button>
          <button className="wb-btn wb-btn-primary dge-save" onClick={save} title="Write the diagram back into the document (Ctrl+S)">Save</button>
        </span>
      </div>

      <div className="dge-inspector">
        {selNode ? (
          <>
            <label>Label<input value={selNode.label} onChange={(e) => { const v = e.target.value; apply((x) => ({ ...x, nodes: x.nodes.map((n) => (n.id === selNode.id ? { ...n, label: v } : n)) }), `label:${selNode.id}`); }} spellCheck={false} /></label>
            <label>Shape
              <select value={selNode.shape} onChange={(e) => { const v = e.target.value; apply((x) => ({ ...x, nodes: x.nodes.map((n) => (n.id === selNode.id ? { ...n, shape: v } : n)) })); }}>
                {SHAPE_NAMES.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
                {!SHAPE_NAMES.some((s) => s.id === selNode.shape) && <option value={selNode.shape}>{selNode.shape}</option>}
              </select>
            </label>
          </>
        ) : selEdge ? (
          <>
            <label>Label<input value={selEdge.label} onChange={(e) => { const v = e.target.value; const i = sel.edge!; apply((x) => ({ ...x, edges: x.edges.map((d, k) => (k === i ? { ...d, label: v } : d)) }), `edge:${i}`); }} spellCheck={false} placeholder="none" /></label>
            <label>Style
              <select value={styleOf(selEdge)} onChange={(e) => { const [t, s] = EDGE_STYLES[+e.target.value]; const i = sel.edge!; apply((x) => ({ ...x, edges: x.edges.map((d, k) => (k === i ? { ...d, type: t, stroke: s } : d)) })); }}>
                {EDGE_STYLES.map(([, , label], i) => <option key={label} value={i}>{label}</option>)}
              </select>
            </label>
            <button className="file-action-btn" onClick={() => { const i = sel.edge!; apply((x) => ({ ...x, edges: x.edges.map((d, k) => (k === i ? { ...d, from: d.to, to: d.from } : d)) })); }}>Reverse</button>
          </>
        ) : selSub ? (
          <>
            <label>Title<input value={selSub.title} onChange={(e) => { const v = e.target.value; apply((x) => ({ ...x, subs: x.subs.map((s) => (s.id === selSub.id ? { ...s, title: v } : s)) }), `sub:${selSub.id}`); }} spellCheck={false} /></label>
            <button className="file-action-btn" onClick={deleteSelection}>Ungroup</button>
          </>
        ) : null}
        {sel.nodes.length > 0 && (
          <label>Subgraph
            <select
              value={commonParent ?? '\u0000'}
              onChange={(e) => { const v = e.target.value || undefined; apply((x) => { const parent = { ...x.parent }; sel.nodes.forEach((n) => { parent[n] = v; }); return { ...x, parent }; }); }}
            >
              {commonParent === null && <option value={'\u0000'} disabled>mixed</option>}
              <option value="">none</option>
              {subChoices([]).map((s) => <option key={s.id} value={s.id}>{s.title || s.id}</option>)}
            </select>
          </label>
        )}
        {sel.nodes.length > 1 && <span className="dge-hint">{sel.nodes.length} nodes selected</span>}
        {(sel.nodes.length > 0 || sel.edge !== null) && (
          <button className="file-action-btn dge-delete" onClick={deleteSelection} title="Delete (Del)"><Trash2 size={13} aria-hidden /> Delete</button>
        )}
        {!sel.nodes.length && sel.edge === null && !sel.sub && (
          <span className="dge-hint">
            Drag to move · double-click empty space for a new node · drag a node's dot onto another node to link them, or onto empty space for a new linked node · double-click to rename · drag across empty space to select several
          </span>
        )}
      </div>

      <div className="dge-stage" ref={stageRef} onWheel={onWheel}>
        <div className="dge-canvas" style={{ width: frame.w * zoom, height: frame.h * zoom }}>
          <svg
            ref={svgRef}
            className={`dge-svg${drag?.kind === 'connect' ? ' is-connecting' : ''}`}
            width={frame.w * zoom}
            height={frame.h * zoom}
            viewBox={`${frame.x} ${frame.y} ${frame.w} ${frame.h}`}
            onPointerDown={onBackgroundDown}
            onPointerMove={onMove}
            onPointerUp={onUp}
            onDoubleClick={(e) => { if (e.target === svgRef.current || (e.target as Element).classList.contains('dge-grid')) addNode(toDiagram(e)); }}
            fontFamily="IBM Plex Sans, system-ui, sans-serif"
          >
            <defs>
              <pattern id="dge-dots" width={GRID * 2} height={GRID * 2} patternUnits="userSpaceOnUse">
                <circle cx="1" cy="1" r="1" className="dge-dot" />
              </pattern>
              <marker id="dge-m-pt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={p.line} /></marker>
              <marker id="dge-m-x" viewBox="0 0 10 10" refX="7" refY="5" markerWidth="9" markerHeight="9" orient="auto-start-reverse"><path d="M2,1 L8,9 M8,1 L2,9" stroke={p.line} strokeWidth="1.6" /></marker>
              <marker id="dge-m-o" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><circle cx="5" cy="5" r="3.6" fill="none" stroke={p.line} strokeWidth="1.5" /></marker>
            </defs>
            <rect className="dge-grid" x={frame.x} y={frame.y} width={frame.w} height={frame.h} fill="url(#dge-dots)" />

            {scene.subs.map((s) => (
              <g key={s.id} className={`dge-sub${sel.sub === s.id ? ' is-sel' : ''}`} onPointerDown={(e) => onSubDown(e, s.id)} onDoubleClick={(e) => { e.stopPropagation(); setRename({ kind: 'sub', id: s.id, value: m.subs.find((x) => x.id === s.id)?.title ?? '' }); }}>
                <rect x={s.x - s.w / 2} y={s.y - s.h / 2} width={s.w} height={s.h} rx="4" fill={p.cluster} stroke={p.clusterStroke} />
                <text x={s.x} y={s.y - s.h / 2 + 20} textAnchor="middle" fill={p.text} fontSize="13">{s.title}</text>
              </g>
            ))}

            {scene.edges.map((e) => {
              const a = edgeAttrs(e, p, 'dge-m');
              const isSel = sel.edge === e.index;
              return (
                <g key={e.key} className={`dge-edge${isSel ? ' is-sel' : ''}`}
                  onPointerDown={(ev) => { if (ev.button) return; ev.stopPropagation(); setRename(null); setSel({ ...NONE, edge: e.index }); }}
                  onDoubleClick={(ev) => { ev.stopPropagation(); setRename({ kind: 'edge', index: e.index, value: m.edges[e.index]?.label ?? '' }); }}
                >
                  <path d={e.d} className="dge-edge-hit" />
                  <path d={e.d} fill="none" stroke={isSel ? 'var(--accent)' : a.stroke} strokeWidth={a['stroke-width']} strokeDasharray={a['stroke-dasharray']} markerEnd={a['marker-end']} markerStart={a['marker-start']} />
                  {e.label.length > 0 && (
                    <g>
                      <rect x={e.lx - e.lw / 2} y={e.ly - e.lh / 2} width={e.lw} height={e.lh} rx="2" fill={p.labelBg} />
                      <text textAnchor="middle" fill={p.text} fontSize="13">
                        {e.label.map((l, i) => <tspan key={i} x={e.lx} y={e.ly - e.lh / 2 + 16 + i * 19}>{l}</tspan>)}
                      </text>
                    </g>
                  )}
                </g>
              );
            })}

            {scene.nodes.map((n) => {
              const isSel = sel.nodes.includes(n.id);
              return (
                <g key={n.id} data-node={n.id} className={`dge-node${isSel ? ' is-sel' : ''}`} transform={`translate(${n.x},${n.y})`}
                  onPointerDown={(e) => onNodeDown(e, n.id)}
                  onDoubleClick={(e) => { e.stopPropagation(); setRename({ kind: 'node', id: n.id, value: m.nodes.find((x) => x.id === n.id)?.label ?? '' }); }}
                >
                  <g dangerouslySetInnerHTML={{ __html: nodeMarkup(n, p) }} />
                  {isSel && <path className="dge-outline" d={shapePath(n.shape, n.w + 8, n.h + 8)} />}
                </g>
              );
            })}

            {handles.map((h, i) => (
              <circle key={i} className="dge-handle" cx={h.x} cy={h.y} r={6} onPointerDown={(e) => onHandleDown(e, single!.id)}>
                <title>Drag onto another node to link them</title>
              </circle>
            ))}

            {connectFrom && drag?.kind === 'connect' && (
              <line className="dge-rubber" x1={connectFrom.x} y1={connectFrom.y} x2={drag.to.x} y2={drag.to.y} markerEnd="url(#dge-m-pt)" />
            )}
            {drag?.kind === 'marquee' && (
              <rect className="dge-marquee" x={Math.min(drag.start.x, drag.to.x)} y={Math.min(drag.start.y, drag.to.y)} width={Math.abs(drag.to.x - drag.start.x)} height={Math.abs(drag.to.y - drag.start.y)} />
            )}
          </svg>

          {rename && renameBox && (
            <input
              className="dge-rename"
              autoFocus
              value={rename.value}
              style={{ left: (renameBox.x - frame.x) * zoom, top: (renameBox.y - frame.y) * zoom, width: renameBox.w * zoom }}
              onChange={(e) => setRename({ ...rename, value: e.target.value })}
              onFocus={(e) => e.target.select()}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitRename(); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setRename(null); }
              }}
              spellCheck={false}
              aria-label="Label"
            />
          )}
        </div>
      </div>
    </>
  );
}
