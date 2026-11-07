import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Redo2, StickyNote, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import {
  KIND_NAME, addEdge, addNode, addNote, deleteLine, deleteNodes, parseGraph, renameNode,
  setEdge, type GraphKind, type GrafModel,
} from './graphModel';
import { setLine } from './seqModel';
import { renderMermaid, type Theme } from './mermaidSource';

// Edit class, state and ER diagrams on the drawing mermaid makes, the way
// SeqEditor does for sequences: mermaid tags every node, edge, label and note
// in its SVG; those are matched back to source lines, and a transparent layer
// on top takes the gestures. Mermaid keeps the layout — nothing is moved by
// hand — but anything can be added, renamed, redirected, retyped or deleted.

interface Box { x: number; y: number; w: number; h: number }
interface NodeGeo { box: Box; title: Box | null; members: Map<number, Box> }
interface EdgeGeo { d: string; box: Box; label: Box | null }
interface Geo {
  vb: Box;
  nodes: Map<string, NodeGeo>;
  edges: Map<number, EdgeGeo>;          // by edge order
  notes: Map<number, Box>;              // by note order
  complete: boolean;
}

type Sel =
  | { t: 'node'; name: string }
  | { t: 'edge'; order: number }
  | { t: 'member'; line: number }
  | { t: 'note'; order: number }
  | null;
type Edit = { value: string; box: Box; commit: (v: string) => void };
type Drag = { from: string; x: number; y: number } | null;

const pad = (b: Box, p: number): Box => ({ x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 });
const R = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });
const union = (bs: (Box | null)[]): Box | null => {
  const ok = bs.filter((b): b is Box => !!b && b.w + b.h > 0);
  if (!ok.length) return null;
  const x = Math.min(...ok.map((b) => b.x)), y = Math.min(...ok.map((b) => b.y));
  return { x, y, w: Math.max(...ok.map((b) => b.x + b.w)) - x, h: Math.max(...ok.map((b) => b.y + b.h)) - y };
};

/** Arrow kinds offered per diagram, for the selected edge. */
const ARROWS: Record<GraphKind, { token: string; label: string }[]> = {
  class: [
    { token: '<|--', label: 'Inheritance' }, { token: '<|..', label: 'Realization' },
    { token: '*--', label: 'Composition' }, { token: 'o--', label: 'Aggregation' },
    { token: '-->', label: 'Association' }, { token: '..>', label: 'Dependency' },
  ],
  state: [{ token: '-->', label: 'Arrow' }, { token: '--', label: 'Line' }],
  er: [
    { token: '||--||', label: 'one ↔ one' }, { token: '||--o{', label: 'one ↔ zero+' },
    { token: '||--|{', label: 'one ↔ one+' }, { token: '||--o|', label: 'one ↔ 0..1' },
    { token: '}o--||', label: 'zero+ ↔ one' }, { token: '}|--||', label: 'one+ ↔ one' },
    { token: '|o--||', label: '0..1 ↔ one' }, { token: '}o--o{', label: 'zero+ ↔ zero+' },
  ],
};

const NODE_LABEL: Record<GraphKind, string> = { class: 'Class', state: 'State', er: 'Entity' };

/** Match mermaid's drawing to the source model and measure everything. */
function measure(svg: SVGSVGElement, m: GrafModel): Geo {
  const rootInv = svg.getScreenCTM()?.inverse();
  let complete = true;
  const boxOf = (el: Element | null): Box | null => {
    if (!el) return null;
    const g = el as SVGGraphicsElement;
    if (!g.getBBox || !rootInv) return null;
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    const t = rootInv.multiply(ctm);
    const b = g.getBBox();
    const a = new DOMPoint(b.x, b.y).matrixTransform(t), c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(t);
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
  };

  const vbb = svg.viewBox.baseVal;
  const vb = { x: vbb.x, y: vbb.y, w: vbb.width, h: vbb.height };
  const geo: Geo = { vb, nodes: new Map(), edges: new Map(), notes: new Map(), complete: true };
  if (vb.w + vb.h <= 0) return geo;
  const prefix = svg.id ? `${svg.id}-` : '';
  const local = (el: Element) => (el.id.startsWith(prefix) ? el.id.slice(prefix.length) : el.id);

  // Nodes and notes: g.node elements, classified by their id.
  const noteEls: Box[] = [];
  for (const g of svg.querySelectorAll('g.node')) {
    const id = local(g);
    let mt: RegExpExecArray | null;
    if (m.kind === 'class') {
      if ((mt = /^classId-(.+)-(\d+)$/.exec(id))) {
        const node = m.nodes.find((n) => n.name === mt![1]);
        if (!node) continue;
        const members = new Map<number, Box>();
        // The drawing has member rows (no brackets) and method rows (brackets)
        // in the model's order for each; zip them by line.
        const mine = m.members.get(node.name) ?? [];
        const plain = mine.filter((r) => !r.method).map((r) => r.line);
        const meth = mine.filter((r) => r.method).map((r) => r.line);
        [...g.querySelectorAll('g.members-group g.label')].forEach((el, i) => { if (i < plain.length) { const b = boxOf(el); if (b) members.set(plain[i], b); } });
        [...g.querySelectorAll('g.methods-group g.label')].forEach((el, i) => { if (i < meth.length) { const b = boxOf(el); if (b) members.set(meth[i], b); } });
        geo.nodes.set(node.name, {
          box: boxOf(g) ?? { x: vb.x, y: vb.y, w: 0, h: 0 },
          title: boxOf(g.querySelector('g.label-group g.label')),
          members,
        });
        continue;
      }
      if (/^note\d+$/.test(id)) { const b = boxOf(g); if (b) noteEls.push(b); }
      continue;
    }
    if (m.kind === 'er') {
      if ((mt = /^entity-(.+)-(\d+)$/.exec(id))) {
        const node = m.nodes.find((n) => n.name === mt![1]);
        if (!node) continue;
        const members = new Map<number, Box>();
        // Attribute rows: four label cells (type, name, keys, comment) per attribute.
        const cells = [...g.querySelectorAll('g.label')].filter((c) => /attribute-/.test(c.getAttribute('class') ?? ''));
        const rows: Box[] = [];
        for (let i = 0; i + 3 < cells.length; i += 4) {
          const b = union([boxOf(cells[i]), boxOf(cells[i + 1]), boxOf(cells[i + 2]), boxOf(cells[i + 3])]);
          if (b) rows.push(b);
        }
        (m.members.get(node.name) ?? []).forEach((attr, i) => { if (i < rows.length) members.set(attr.line, rows[i]); });
        geo.nodes.set(node.name, {
          box: boxOf(g) ?? { x: vb.x, y: vb.y, w: 0, h: 0 },
          title: boxOf(g.querySelector('g.label.name')),
          members,
        });
      }
      continue;
    }
    // state: id like `state-One-7`; the trailing number isn't reliable, match the name.
    if ((mt = /^state-(.+)-\d+$/.exec(id)) && !/root_(start|end)/.test(id)) {
      if (id.includes('----note-')) { const b = boxOf(g); if (b) noteEls.push(b); continue; }
      const node = m.nodes.find((n) => n.name === mt![1] && n.name !== '[*]');
      if (!node) continue;
      geo.nodes.set(node.name, { box: boxOf(g) ?? { x: vb.x, y: vb.y, w: 0, h: 0 }, title: null, members: new Map() });
    }
  }

  // Edges: the path of each relation, transition or relationship.
  const pathSel = m.kind === 'class' ? 'path.relation' : m.kind === 'state' ? 'path.transition' : 'path.relationshipLine';
  // Relation ids carry an ordinal; class counts from 1, state assigns `edgeN` from 0.
  const idRe = new RegExp(m.kind === 'state' ? '^edge(\\d+)$' : '^id_.*_(\\d+)$');
  const first = m.kind === 'class' ? 1 : 0;
  for (const p of svg.querySelectorAll(pathSel)) {
    const mt = idRe.exec(local(p));
    if (!mt) continue;
    const n = +mt[1] - first;
    const e = m.edges[n];
    if (!e || geo.edges.has(n)) { complete = false; continue; }
    const b = boxOf(p);
    if (b) geo.edges.set(n, { d: p.getAttribute('d') ?? '', box: pad(b, 4), label: null });
  }
  // Labels: the positioned g.edgeLabel groups, in the same order as the
  // labelled relations in the source.
  const labelEls = [...svg.querySelectorAll('g.edgeLabel')].filter((g) => (g.textContent ?? '').trim());
  const labelled = m.edges.map((e, i) => ({ i, e })).filter(({ e }) => (e.label ?? '').trim());
  if (labelEls.length === labelled.length) {
    labelled.forEach(({ i }, k) => {
      const geoE = geo.edges.get(i);
      const b = boxOf(labelEls[k]);
      if (geoE && b) geoE.label = b;
    });
  }

  // Notes, in drawing order == source order (note ids count differently per type).
  noteEls.forEach((b, i) => {
    if (i < m.notes.length) geo.notes.set(m.notes[i].order, b);
  });

  geo.complete = complete && geo.edges.size === m.edges.length;
  if (m.kind !== 'state' && geo.nodes.size < m.nodes.filter((n) => n.name !== '[*]').length) geo.complete = false;
  return geo;
}

export default function GraphEditor({ code: initial, kind, theme, onSave, onClose }: {
  code: string;
  kind: GraphKind;
  theme: Theme;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<{ code: string; past: string[]; future: string[] }>({ code: initial, past: [], future: [] });
  const [geo, setGeo] = useState<Geo | null>(null);
  const [renderError, setRenderError] = useState('');
  const [sel, setSel] = useState<Sel>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [drag, setDrag] = useState<Drag>(null);
  const [zoom, setZoom] = useState(1);
  const [pending, setPending] = useState<{ name: string } | { order: number } | { note: number } | null>(null);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const fitted = useRef(false);
  const code = hist.code;
  const m = parseGraph(code, kind);

  useEffect(() => {
    let alive = true;
    renderMermaid(code, theme).then((out) => {
      const host = hostRef.current;
      if (!alive || !host) return;
      host.innerHTML = out;
      const svg = host.querySelector('svg');
      if (!svg) return;
      const vb = svg.viewBox.baseVal;
      let z = zoomRef.current;
      if (!fitted.current && stageRef.current && vb.width) {
        fitted.current = true;
        z = Math.max(0.4, Math.min(1, (stageRef.current.clientWidth - 48) / vb.width));
        zoomRef.current = z;
        setZoom(z);
      }
      svg.style.maxWidth = 'none';
      svg.setAttribute('width', String(vb.width * z));
      svg.setAttribute('height', String(vb.height * z));
      setGeo(measure(svg, parseGraph(code, kind)));
      setRenderError('');
    }).catch((e) => { if (alive) setRenderError(String((e as Error)?.message ?? e).split('\n')[0]); });
    return () => { alive = false; };
  }, [code, kind, theme]);

  useEffect(() => {
    zoomRef.current = zoom;
    const svg = hostRef.current?.querySelector('svg');
    const vb = svg?.viewBox.baseVal;
    if (svg && vb?.width) { svg.setAttribute('width', String(vb.width * zoom)); svg.setAttribute('height', String(vb.height * zoom)); }
  }, [zoom]);

  const apply = (next: string) => setHist((h) => (next === h.code ? h : { code: next, past: [...h.past.slice(-99), h.code], future: [] }));
  const undo = () => setHist((h) => (h.past.length ? { code: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.code, ...h.future] } : h));
  const redo = () => setHist((h) => (h.future.length ? { code: h.future[0], past: [...h.past, h.code], future: h.future.slice(1) } : h));
  const dirty = hist.past.length > 0;
  const close = () => { if (!dirty || window.confirm('Discard your changes to this diagram?')) onClose(); };

  const selNode = sel?.t === 'node' ? m.nodes.find((n) => n.name === sel.name) : undefined;
  const selEdge = sel?.t === 'edge' ? m.edges[sel.order] : undefined;
  const selMember = sel?.t === 'member' ? [...m.members.values()].flatMap((l) => l).find((r) => r.line === sel.line) : undefined;
  const selNote = sel?.t === 'note' ? m.notes.find((n) => n.order === sel.order) : undefined;

  // ── Edits ──
  const startRename = (name: string) => {
    const g = geo?.nodes.get(name);
    const node = m.nodes.find((n) => n.name === name);
    if (!g || !node) return;
    const box = g.title ?? g.box;
    setEdit({
      value: node.hasLabel ? node.label : node.name, box,
      commit: (v) => { apply(renameNode(code, kind, name, v)); },
    });
  };
  const startMember = (line: number) => {
    const box = [...(geo?.nodes.values() ?? [])].flatMap((g) => [...g.members.entries()]).find(([l]) => l === line)?.[1];
    const row = [...m.members.values()].flatMap((l) => l).find((r) => r.line === line);
    if (!box || !row) return;
    setEdit({ value: row.text, box, commit: (v) => { apply(setLine(code, line, (code.split('\n')[line].match(/^\s*/)?.[0] ?? '') + v)); } });
  };
  const startEdgeLabel = (order: number) => {
    const g = geo?.edges.get(order);
    const e = m.edges[order];
    if (!g || !e) return;
    if (e.label === undefined && g.label === null) apply(setEdge(code, kind, e.line, { label: 'label' })); // give the new label a placeholder
    setEdit({
      value: e.label ?? 'label', box: g.label ?? { ...g.box, h: 20 },
      commit: (v) => { apply(setEdge(code, kind, e.line, { label: v })); },
    });
  };
  const startNote = (order: number) => {
    const box = geo?.notes.get(order);
    const note = m.notes.find((n) => n.order === order);
    if (!box || !note) return;
    setEdit({
      value: note.text, box,
      commit: (v) => {
        const keep = code.split('\n')[note.line].trim();
        const head = /\s*:\s/.test(keep) ? keep.split(/\s*:\s/)[0] : '';
        apply(setLine(code, note.line, (code.split('\n')[note.line].match(/^\s*/)?.[0] ?? '') + (head ? `${head} : ${v}` : `note for ${note.target ?? ''} "${v}"`)));
      },
    });
  };
  const deleteSelection = () => {
    if (!sel) return;
    if (sel.t === 'node') {
      const node = m.nodes.find((n) => n.name === sel.name);
      if (!node || node.name === '[*]') return;
      const touching = m.edges.filter((e) => e.left === sel.name || e.right === sel.name).length;
      if (touching && !window.confirm(`Delete ${node.name} and its ${touching} connection${touching === 1 ? '' : 's'}?`)) return;
      apply(deleteNodes(code, kind, [sel.name]));
    } else if (sel.t === 'edge') {
      const e = m.edges[sel.order];
      if (e) apply(deleteLine(code, e.line));
    } else if (sel.t === 'member') {
      apply(deleteLine(code, sel.line));
    } else if (sel.t === 'note') {
      const note = m.notes.find((n) => n.order === sel.order);
      if (note) apply(deleteLine(code, note.line));
    }
    setSel(null);
  };

  // A just-added item opens its inline editor as soon as the drawing is back.
  if (pending && geo) {
    const ready = 'name' in pending ? geo.nodes.get(pending.name) : 'order' in pending ? geo.edges.get(pending.order) : geo.notes.get(pending.note);
    if (ready) {
      const which = pending;
      setPending(null);
      if ('name' in which) startRename(which.name);
      else if ('order' in which) startEdgeLabel(which.order);
      else startNote(which.note);
    }
  }

  const add = () => {
    const res = addNode(code, kind);
    apply(res.code);
    setPending({ name: res.name });
  };
  const addTheNote = () => {
    const name = sel?.t === 'node' ? sel.name : m.nodes.find((n) => n.name !== '[*]')?.name;
    if (!name) return;
    const res = addNote(code, kind, name);
    const order = parseGraph(res.code, kind).notes.at(-1)?.order ?? 0;
    apply(res.code);
    setSel({ t: 'note', order });
    setPending({ note: order });
  };

  // ── Gestures ──
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const ctm = overlayRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };
  const nodeAt = (x: number, y: number): string | null => {
    for (const [name, g] of geo?.nodes ?? []) if (x >= g.box.x - 4 && x <= g.box.x + g.box.w + 4 && y >= g.box.y - 4 && y <= g.box.y + g.box.h + 4) return name;
    return null;
  };
  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = toSvg(e);
    setDrag({ ...drag, x: at.x, y: at.y });
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.from) {
      const to = nodeAt(drag.x, drag.y);
      if (to && to !== drag.from) {
        const next = addEdge(code, kind, drag.from, to);
        apply(next);
        const e = parseGraph(next, kind).edges.at(-1);
        if (e) { setSel({ t: 'edge', order: e.order }); setPending({ order: e.order }); }
      }
    }
    setDrag(null);
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName);
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); e.stopImmediatePropagation(); onSave(code); return; }
      if (typing) return;
      if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.stopImmediatePropagation(); if (e.shiftKey) redo(); else undo(); return; }
      if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); e.stopImmediatePropagation(); redo(); return; }
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deleteSelection(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (sel) setSel(null); else close(); return; }
      if (e.key === 'Enter' && sel) {
        e.preventDefault();
        if (sel.t === 'node') startRename(sel.name);
        else if (sel.t === 'edge') startEdgeLabel(sel.order);
        else if (sel.t === 'member') startMember(sel.line);
        else startNote(sel.order);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const fit = () => { const st = stageRef.current; if (st && geo) setZoom(Math.max(0.3, Math.min(2, (st.clientWidth - 48) / geo.vb.w))); };

  const startNodeDrag = (e: React.PointerEvent, name: string) => {
    if (e.button) return;
    e.stopPropagation();
    setEdit(null);
    setSel({ t: 'node', name });
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const at = toSvg(e);
    setDrag({ from: name, x: at.x, y: at.y });
  };

  // Hit areas and selection marks, in the drawing's own coordinates.
  const overlay: React.ReactNode[] = [];
  if (geo) {
    for (const [order, g] of geo.edges) {
      overlay.push(<path key={`e-${order}`} className="dge-edge-hit" d={g.d}
        onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); setSel({ t: 'edge', order }); }}
        onDoubleClick={(e) => { e.stopPropagation(); startEdgeLabel(order); }} />);
    }
    for (const [order, b] of geo.notes) {
      overlay.push(<rect key={`n-${order}`} className="dge-hit" {...R(b)}
        onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); setSel({ t: 'note', order }); }}
        onDoubleClick={(e) => { e.stopPropagation(); startNote(order); }} />);
    }
    for (const [name, g] of geo.nodes) {
      overlay.push(<rect key={`nd-${name}`} className="dge-hit" {...R(g.box)}
        onPointerDown={(e) => startNodeDrag(e, name)}
        onDoubleClick={(e) => { e.stopPropagation(); if (name === '[*]') return; startRename(name); }} />);
      if (name === '[*]') continue;
      for (const [line, box] of g.members) if (!(g.title && inBox(box, g.title))) overlay.push(<rect key={`m-${line}`} className="dge-hit" {...R(box)}
        onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); setSel({ t: 'member', line }); }}
        onDoubleClick={(e) => { e.stopPropagation(); startMember(line); }} />);
    }
    // Selection.
    if (sel?.t === 'node') {
      const b = geo.nodes.get(sel.name)?.box;
      if (b) overlay.push(<rect key="sel" className="dge-sel" {...R(pad(b, 3))} />);
    } else if (sel?.t === 'edge') {
      const g = geo.edges.get(sel.order);
      if (g) {
        overlay.push(<path key="sel-e" className="dge-selpath" d={g.d} />);
        if (g.label) overlay.push(<rect key="sel-el" className="dge-sel" {...R(pad(g.label, 2))} />);
      }
    } else if (sel?.t === 'member') {
      for (const g of geo.nodes.values()) { const b = g.members.get(sel.line); if (b) overlay.push(<rect key="sel-m" className="dge-sel" {...R(pad(b, 2))} />); }
    } else if (sel?.t === 'note') {
      const b = geo.notes.get(sel.order);
      if (b) overlay.push(<rect key="sel-t" className="dge-sel" {...R(pad(b, 3))} />);
    }
    // Connection rubber band.
    if (drag?.from) {
      const from = geo.nodes.get(drag.from);
      const target = nodeAt(drag.x, drag.y);
      const to = target && target !== drag.from ? geo.nodes.get(target) : null;
      overlay.push(<line key="rubber" className="dge-rubber"
        x1={from ? from.box.x + from.box.w / 2 : 0} y1={from ? from.box.y + from.box.h / 2 : 0}
        x2={to ? to.box.x + to.box.w / 2 : drag.x} y2={to ? to.box.y + to.box.h / 2 : drag.y} />);
      if (target && target !== drag.from) overlay.push(<rect key="tgt" className="dge-sel" {...R(pad(geo.nodes.get(target)!.box, 3))} />);
    }
  }

  return (
    <>
      <div className="md-diagram-bar dge-bar">
        <span className="md-diagram-kind">{KIND_NAME[kind]} · editing</span>
        <span className="dge-tools">
          <button className="file-action-btn" onClick={add}><Plus size={13} aria-hidden /> {NODE_LABEL[kind]}</button>
          {kind !== 'er' && (
            <button className="file-action-btn" onClick={addTheNote} disabled={!m.nodes.some((n) => n.name !== '[*]')} title="Add a note to the selected node"><StickyNote size={13} aria-hidden /> Note</button>
          )}
          <span className="dge-sep" />
          <button className="file-action-btn" onClick={undo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={13} aria-hidden /></button>
          <button className="file-action-btn" onClick={redo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 size={13} aria-hidden /></button>
          <span className="dge-sep" />
          <button className="file-action-btn" onClick={() => setZoom((z) => Math.max(0.3, z / 1.2))} aria-label="Zoom out"><Minus size={13} aria-hidden /></button>
          <span className="dge-zoom">{Math.round(zoom * 100)}%</span>
          <button className="file-action-btn" onClick={() => setZoom((z) => Math.min(2, z * 1.2))} aria-label="Zoom in"><Plus size={13} aria-hidden /></button>
          <button className="file-action-btn" onClick={fit}>Fit</button>
        </span>
        <span className="md-diagram-actions">
          <button className="file-action-btn" onClick={close}>Cancel</button>
          <button className="wb-btn wb-btn-primary dge-save" onClick={() => onSave(code)} title="Write the diagram back into the document (Ctrl+S)">Save</button>
        </span>
      </div>

      <div className="dge-inspector">
        {selNode && selNode.name !== '[*]' ? (
          <>
            <label>Name<input value={selNode.hasLabel ? selNode.label : selNode.name} onChange={(e) => apply(renameNode(code, kind, selNode!.name, e.target.value))} spellCheck={false} /></label>
            <span className="dge-hint">{selNode.hasLabel ? `id ${selNode.name}` : 'the id is renamed everywhere it appears'}</span>
          </>
        ) : selEdge ? (
          <>
            <label>{selEdge.left} → {selEdge.right}</label>
            <label>Label<input
              value={selEdge.label ?? ''} onChange={(e) => apply(setEdge(code, kind, selEdge!.line, { label: e.target.value === '' ? undefined : e.target.value }))}
              placeholder={kind === 'er' ? 'relates' : '(none)'} spellCheck={false}
            /></label>
            {ARROWS[kind].length > 1 && (
              <label>Kind
                <select value={selEdge.arrow} onChange={(e) => apply(setEdge(code, kind, selEdge!.line, { arrow: e.target.value }))}>
                  {ARROWS[kind].map((a) => <option key={a.token} value={a.token}>{a.label}  {a.token}</option>)}
                </select>
              </label>
            )}
          </>
        ) : selMember ? (
          <label className="dge-wide">{kind === 'class' ? 'Member' : 'Attribute'}<input
            value={selMember.text} onChange={(e) => { const ind = code.split('\n')[selMember!.line].match(/^\s*/)?.[0] ?? ''; apply(setLine(code, selMember!.line, ind + e.target.value)); }}
            spellCheck={false}
          /></label>
        ) : selNote ? (
          <label className="dge-wide">Note<input
            value={selNote.text} onChange={(e) => {
              const ind = code.split('\n')[selNote!.line].match(/^\s*/)?.[0] ?? '';
              const old = code.split('\n')[selNote!.line].trim();
              const head = /\s:\s/.test(old) ? old.split(/\s:\s/)[0] : `note for ${selNote!.target ?? ''} `;
              apply(setLine(code, selNote!.line, /\s:\s/.test(old) ? `${ind}${head} : ${e.target.value}` : `${ind}${head}"${e.target.value}"`));
            }}
            spellCheck={false}
          /></label>
        ) : (
          <span className="dge-hint">
            Drag from one {NODE_LABEL[kind].toLowerCase()} to another to connect them · double-click any text to edit it · Del deletes the selection
          </span>
        )}
        {!geo?.complete && geo && (
          <span className="dge-warn"><TriangleAlert size={12} aria-hidden /> Some parts aren't matched to the drawing; edit their lines in the document.</span>
        )}
        {renderError && <span className="dge-warn">Mermaid can't draw this: {renderError}</span>}
        {sel && <button className="file-action-btn dge-delete" onClick={deleteSelection} title="Delete (Del)"><Trash2 size={13} aria-hidden /> Delete</button>}
      </div>

      <div className="dge-stage" ref={stageRef}>
        <div className="dge-canvas" style={geo ? { width: geo.vb.w * zoom, height: geo.vb.h * zoom } : undefined}>
          <div className="dge-seq-host" ref={hostRef} />
          {geo && (
            <svg
              ref={overlayRef}
              className="dge-hitlayer"
              width={geo.vb.w * zoom}
              height={geo.vb.h * zoom}
              viewBox={`${geo.vb.x} ${geo.vb.y} ${geo.vb.w} ${geo.vb.h}`}
              onPointerDown={() => { setSel(null); setEdit(null); }}
              onPointerMove={onMove}
              onPointerUp={onUp}
            >
              <rect className="dge-hit-bg" x={geo.vb.x} y={geo.vb.y} width={geo.vb.w} height={geo.vb.h} />
              {overlay}
            </svg>
          )}
          {!geo && !renderError && <div className="dge-empty">Drawing…</div>}
          {edit && geo && (
            <input
              className="dge-rename"
              autoFocus
              value={edit.value}
              style={{
                left: (edit.box.x + edit.box.w / 2 - geo.vb.x) * zoom,
                top: (edit.box.y + edit.box.h / 2 - geo.vb.y) * zoom,
                width: Math.max(160, (edit.box.w + 24) * zoom),
              }}
              onChange={(e) => setEdit({ ...edit, value: e.target.value })}
              onFocus={(e) => e.target.select()}
              onBlur={() => { edit.commit(edit.value.trim()); setEdit(null); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); edit.commit(edit.value.trim()); setEdit(null); }
                if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setEdit(null); }
              }}
              spellCheck={false}
              aria-label="Text"
            />
          )}
        </div>
      </div>
    </>
  );
}

/** Is box A inside the labelled title area B? (skips double hit areas.) */
function inBox(a: Box, b: Box): boolean {
  return a.x >= b.x && a.y >= b.y && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h;
}
