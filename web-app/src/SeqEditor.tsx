import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Minus, Plus, Redo2, StickyNote, Trash2, Undo2 } from 'lucide-react';
import {
  ARROWS, blocksOf, declareParticipants, freshParticipant, insertLine, isNote, messageLine, moveLine, parseSeq,
  removeLines, setLine, splitBlock, splitNote, type Message, type Participant, type SeqModel,
} from './seqModel';
import { renderMermaid, type Theme } from './mermaidSource';

// Edit a sequence diagram on the drawing mermaid makes (the same one the
// document shows). Mermaid tags each participant, lifeline, message, note and
// block in its SVG; those are matched back to source lines, and a transparent
// layer on top takes the clicks and drags. Every edit rewrites source lines, so
// anything the editor doesn't understand is kept as written.

interface Box { x: number; y: number; w: number; h: number }
interface PartGeo { top: Box; bottom: Box | null; x: number; lifeTop: number; lifeBottom: number }
interface Geo {
  vb: Box;
  parts: Map<string, PartGeo>;
  msgs: Map<number, { box: Box; text: Box | null; y: number }>;
  notes: Map<number, Box>;
  blocks: Map<number, { label: Box; cond: Box | null; frame: Box; sections: { line: number; box: Box }[] }>;
  /** Source lines with the y where they sit, top to bottom: where new lines can go. */
  anchors: { line: number; y: number }[];
  complete: boolean;
}

type Sel = { kind: 'part'; id: string } | { kind: 'row'; line: number } | null;
type Drag =
  | { kind: 'row'; line: number; box: Box; y0: number; y: number }
  | { kind: 'part'; id: string; x0: number; x: number }
  | { kind: 'msg'; from: string; x: number; y: number };
type Edit = { kind: 'part'; id: string; value: string; box: Box } | { kind: 'row'; line: number; value: string; box: Box };

const WRAPS = ['loop', 'alt', 'opt', 'par', 'critical', 'break'];
const indentOf = (l: string) => /^\s*/.exec(l)?.[0] || '    ';
const union = (boxes: (Box | null)[]): Box | null => {
  const bs = boxes.filter((b): b is Box => !!b && b.w + b.h > 0);
  if (!bs.length) return null;
  const x0 = Math.min(...bs.map((b) => b.x)), y0 = Math.min(...bs.map((b) => b.y));
  const x1 = Math.max(...bs.map((b) => b.x + b.w)), y1 = Math.max(...bs.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
};
/** Attributes for an SVG rect covering a box. */
const R = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });
const pad = (b: Box, px: number, py = px): Box => ({ x: b.x - px, y: b.y - py, w: b.w + px * 2, h: b.h + py * 2 });

/** Match mermaid's SVG to the source lines and measure everything in SVG units. */
function measure(svg: SVGSVGElement, m: SeqModel): Geo {
  const rootInv = svg.getScreenCTM()?.inverse();
  const boxOf = (el: Element): Box | null => {
    const g = el as SVGGraphicsElement;
    if (!g.getBBox || !rootInv) return null;
    const b = g.getBBox();
    const ctm = g.getScreenCTM();
    if (!ctm) return null;
    const t = rootInv.multiply(ctm);
    const a = new DOMPoint(b.x, b.y).matrixTransform(t), c = new DOMPoint(b.x + b.width, b.y + b.height).matrixTransform(t);
    return { x: Math.min(a.x, c.x), y: Math.min(a.y, c.y), w: Math.abs(c.x - a.x), h: Math.abs(c.y - a.y) };
  };
  const all = (sel: string) => [...svg.querySelectorAll(sel)];
  const byId = (et: string) => {
    const groups = new Map<string, Element[]>();
    for (const el of all(`[data-et="${et}"]`)) {
      const id = el.getAttribute('data-id') ?? '';
      if (!groups.has(id)) groups.set(id, []);
      groups.get(id)!.push(el);
    }
    return [...groups.entries()].sort((a, b) => +a[0].replace(/\D/g, '') - +b[0].replace(/\D/g, '')).map(([, els]) => els);
  };

  const vbb = svg.viewBox.baseVal;
  const vb = { x: vbb.x, y: vbb.y, w: vbb.width, h: vbb.height };
  const parts = new Map<string, PartGeo>();
  for (const p of m.participants) {
    const id = CSS.escape(p.id);
    const top = union(all(`[data-et="participant"][data-id="${id}"]`).map(boxOf));
    const bottomEls = all(`.actor-bottom[name="${id}"]`).flatMap((e) => (e.nextElementSibling?.tagName === 'text' ? [e, e.nextElementSibling] : [e]));
    const life = svg.querySelector(`[data-et="life-line"][data-id="${id}"]`);
    const lb = life ? boxOf(life) : null;
    if (!top) continue;
    parts.set(p.id, {
      top, bottom: union(bottomEls.map(boxOf)),
      x: lb ? lb.x + lb.w / 2 : top.x + top.w / 2,
      lifeTop: lb ? lb.y : top.y + top.h, lifeBottom: lb ? lb.y + lb.h : vb.y + vb.h,
    });
  }

  const anchors: { line: number; y: number }[] = [];
  let complete = true;

  const msgRows = m.rows.filter((r) => r.kind === 'msg');
  const msgEls = byId('message');
  const msgs = new Map<number, { box: Box; text: Box | null; y: number }>();
  if (msgEls.length === msgRows.length) {
    msgEls.forEach((els, i) => {
      const line = els[0];
      const texts: Element[] = [];
      for (let t = line.previousElementSibling; t && t.tagName === 'text' && t.classList.contains('messageText'); t = t.previousElementSibling) texts.push(t);
      const lb = boxOf(line), tb = union(texts.map(boxOf));
      if (!lb) return;
      const y = line.tagName === 'line' ? lb.y + lb.h / 2 : lb.y;
      msgs.set(msgRows[i].line, { box: pad(union([lb, tb])!, 6, 5), text: tb, y });
      anchors.push({ line: msgRows[i].line, y: tb ? tb.y : lb.y });
    });
  } else complete = false;

  const noteRows = m.rows.filter((r) => r.kind === 'other' && isNote(r.text));
  const noteEls = byId('note');
  const notes = new Map<number, Box>();
  if (noteEls.length === noteRows.length) {
    noteEls.forEach((els, i) => {
      const b = union(els.filter((e) => e.tagName === 'rect').map(boxOf)) ?? union(els.map(boxOf));
      if (b) { notes.set(noteRows[i].line, b); anchors.push({ line: noteRows[i].line, y: b.y }); }
    });
  } else complete = false;

  const blockList = blocksOf(m);
  const ctlEls = byId('control-structure');
  const blocks = new Map<number, { label: Box; cond: Box | null; frame: Box; sections: { line: number; box: Box }[] }>();
  if (ctlEls.length === blockList.length) {
    ctlEls.forEach((els, i) => {
      const b = blockList[i];
      const pick = (cls: string) => els.filter((e) => e.classList.contains(cls));
      const frame = union(pick('loopLine').map(boxOf));
      const label = union([...pick('labelBox'), ...pick('labelText')].map(boxOf));
      if (!frame || !label) return;
      const titles = pick('sectionTitle');
      const sections = b.sections.map((line, k) => ({ line, box: titles[k] ? boxOf(titles[k]) : null })).filter((s): s is { line: number; box: Box } => !!s.box);
      blocks.set(b.open, { label, cond: union(pick('loopText').map(boxOf)), frame, sections });
      anchors.push({ line: b.open, y: frame.y }, { line: b.end, y: frame.y + frame.h - 2 });
      sections.forEach((s) => anchors.push({ line: s.line, y: s.box.y - 6 }));
    });
  } else complete = false;

  anchors.sort((a, b) => a.y - b.y || a.line - b.line);
  return { vb, parts, msgs, notes, blocks, anchors, complete };
}

export default function SeqEditor({ code: initial, theme, onSave, onClose }: {
  code: string;
  theme: Theme;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<{ code: string; past: string[]; future: string[]; tag: string }>({ code: initial, past: [], future: [], tag: '' });
  const [sel, setSel] = useState<Sel>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [pending, setPending] = useState<{ kind: 'part'; id: string } | { kind: 'row'; line: number } | null>(null);
  const [geo, setGeo] = useState<Geo | null>(null);
  const [renderError, setRenderError] = useState('');
  const [zoom, setZoom] = useState(1);
  const hostRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const zoomRef = useRef(1);
  const fitted = useRef(false);
  const code = hist.code;
  const m = parseSeq(code);
  const parts = m.participants;

  // Draw with mermaid, exactly as the document does, then measure the result.
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
      setGeo(measure(svg, parseSeq(code)));
      setRenderError('');
    }).catch((e) => { if (alive) setRenderError(String((e as Error)?.message ?? e).split('\n')[0]); });
    return () => { alive = false; };
  }, [code, theme]);

  useEffect(() => {
    zoomRef.current = zoom;
    const svg = hostRef.current?.querySelector('svg');
    const vb = svg?.viewBox.baseVal;
    if (svg && vb?.width) { svg.setAttribute('width', String(vb.width * zoom)); svg.setAttribute('height', String(vb.height * zoom)); }
  }, [zoom]);

  const apply = (next: string, tag = '') => setHist((h) => (next === h.code ? h : {
    code: next, past: tag && tag === h.tag ? h.past : [...h.past.slice(-99), h.code], future: [], tag,
  }));
  const undo = () => setHist((h) => (h.past.length ? { code: h.past[h.past.length - 1], past: h.past.slice(0, -1), future: [h.code, ...h.future], tag: '' } : h));
  const redo = () => setHist((h) => (h.future.length ? { code: h.future[0], past: [...h.past, h.code], future: h.future.slice(1), tag: '' } : h));
  const dirty = hist.past.length > 0;
  const close = () => { if (!dirty || window.confirm('Discard your changes to this diagram?')) onClose(); };

  const rowAt = (line: number) => m.rows.find((r) => r.line === line);
  const part = (id: string) => parts.find((q) => q.id === id);
  const lineIndent = () => (m.rows[0] ? indentOf(m.lines[m.rows[0].line]) : '    ');
  const block = (line: number) => blocksOf(m).find((b) => b.open === line);

  // ── Edits ──
  const setPart = (id: string, change: Partial<Participant>, tag = '') => {
    const target = part(id);
    if (!target) return;
    const next = { ...target, ...change };
    if (target.line !== null) {
      apply(setLine(code, target.line, `${indentOf(m.lines[target.line])}${next.actor ? 'actor' : 'participant'} ${id}${next.label && next.label !== id ? ` as ${next.label}` : ''}`), tag);
    } else {
      apply(declareParticipants(code, parts.map((q) => (q.id === id ? next : q))), tag);
    }
  };
  const reorder = (id: string, toIndex: number) => {
    const order = parts.filter((q) => q.id !== id);
    order.splice(Math.max(0, Math.min(order.length, toIndex)), 0, part(id)!);
    if (order.some((q, i) => q.id !== parts[i].id)) apply(declareParticipants(code, order));
  };
  const addParticipant = () => {
    const id = freshParticipant(m);
    apply(declareParticipants(code, [...parts, { id, label: 'New participant', actor: false, line: null }]));
    setSel({ kind: 'part', id });
    setPending({ kind: 'part', id });
  };
  const setMsg = (line: number, change: Partial<Message>, tag = '') => {
    const r = rowAt(line);
    if (r?.kind !== 'msg') return;
    apply(setLine(code, line, messageLine({ ...r.msg, ...change }, indentOf(m.lines[line]))), tag);
  };
  const setRowText = (line: number, text: string, tag = '') => apply(setLine(code, line, `${indentOf(m.lines[line])}${text}`), tag);
  /** Insert a line before `before` (null = at the end) and select it. */
  const insertRow = (before: number | null, text: string, editIt = true) => {
    const indent = before !== null ? indentOf(m.lines[before]) : lineIndent();
    const next = insertLine(code, before, `${indent}${text}`);
    apply(next);
    const line = before ?? (parseSeq(next).rows.at(-1)?.line ?? 0);
    setSel({ kind: 'row', line });
    if (editIt) setPending({ kind: 'row', line });
  };
  const addMessage = (from: string, to: string, before: number | null) =>
    insertRow(before, messageLine({ from, to, arrow: '->>', act: '', text: 'message' }, ''));
  const addNote = () => {
    const over = sel?.kind === 'part' ? sel.id : parts[0]?.id;
    if (!over) return;
    const before = sel?.kind === 'row' ? nextLine(sel.line) : null;
    insertRow(before, `Note over ${over}: note`);
  };
  /** The source line after `line` that is still a row, or null at the end. */
  const nextLine = (line: number) => m.rows.find((r) => r.line > line)?.line ?? null;
  const wrap = (keyword: string) => {
    if (sel?.kind !== 'row') return;
    const r = rowAt(sel.line);
    if (!r) return;
    const b = r.kind === 'other' ? block(r.line) : undefined;
    const first = sel.line, last = b ? b.end : sel.line;
    const indent = indentOf(m.lines[first]);
    const lines = code.split('\n');
    for (let i = first; i <= last; i++) lines[i] = `    ${lines[i]}`;
    lines.splice(last + 1, 0, `${indent}end`);
    lines.splice(first, 0, `${indent}${keyword} ${keyword === 'loop' ? 'every cycle' : 'condition'}`);
    apply(lines.join('\n'));
    setSel({ kind: 'row', line: first });
    setPending({ kind: 'row', line: first });
  };
  const deleteSelection = () => {
    if (!sel) return;
    if (sel.kind === 'part') {
      const used = m.rows.filter((r) => r.kind === 'msg' && (r.msg.from === sel.id || r.msg.to === sel.id));
      if (used.length && !window.confirm(`Delete ${part(sel.id)?.label ?? sel.id} and its ${used.length} message${used.length === 1 ? '' : 's'}?`)) return;
      const target = part(sel.id);
      apply(removeLines(code, [...used.map((r) => r.line), ...(target && target.line !== null ? [target.line] : [])]));
    } else {
      const b = block(sel.line);
      // Deleting a block keeps what is inside it.
      if (b) {
        const lines = code.split('\n');
        for (let i = b.open + 1; i < b.end; i++) lines[i] = lines[i].replace(/^ {4}/, '');
        apply(lines.filter((_, i) => i !== b.open && i !== b.end && !b.sections.includes(i)).join('\n'));
      } else apply(removeLines(code, [sel.line]));
    }
    setSel(null);
  };

  // Inline editing: what text a line shows on the drawing, and how to write it back.
  const shownText = (line: number): string => {
    const r = rowAt(line);
    if (!r) return '';
    if (r.kind === 'msg') return r.msg.text;
    if (isNote(r.text)) return splitNote(r.text).body;
    return splitBlock(r.text).cond;
  };
  const writeShown = (line: number, v: string) => {
    const r = rowAt(line);
    if (!r) return;
    if (r.kind === 'msg') setMsg(line, { text: v });
    else if (isNote(r.text)) setRowText(line, `${splitNote(r.text).head}: ${v}`);
    else setRowText(line, `${splitBlock(r.text).keyword}${v ? ` ${v}` : ''}`);
  };
  const writeShownTag = (line: number, v: string) => {
    const r = rowAt(line);
    if (r?.kind === 'other') setRowText(line, `${splitBlock(r.text).keyword}${v ? ` ${v}` : ''}`, `cond:${line}`);
  };
  const rowBox = (line: number): Box | null => {
    if (!geo) return null;
    const msg = geo.msgs.get(line);
    if (msg) return msg.text ?? msg.box;
    const note = geo.notes.get(line);
    if (note) return note;
    const b = geo.blocks.get(line);
    if (b) return b.cond ?? b.label;
    for (const x of geo.blocks.values()) { const s = x.sections.find((q) => q.line === line); if (s) return s.box; }
    return null;
  };
  const startEdit = (s: NonNullable<Sel>) => {
    if (s.kind === 'part') {
      const g = geo?.parts.get(s.id);
      if (g) setEdit({ kind: 'part', id: s.id, value: part(s.id)?.label ?? s.id, box: g.top });
    } else {
      const b = rowBox(s.line);
      if (b) setEdit({ kind: 'row', line: s.line, value: shownText(s.line), box: b });
    }
  };
  const commitEdit = () => {
    if (!edit) return;
    const v = edit.value.trim();
    if (edit.kind === 'part') setPart(edit.id, { label: v || edit.id });
    else writeShown(edit.line, v);
    setEdit(null);
  };

  // A just-added item gets its inline editor once the new drawing is measured.
  if (pending && geo) {
    const ready = pending.kind === 'part' ? geo.parts.get(pending.id) : rowBox(pending.line);
    if (ready) {
      setPending(null);
      if (pending.kind === 'part') setEdit({ kind: 'part', id: pending.id, value: part(pending.id)?.label ?? pending.id, box: (ready as PartGeo).top });
      else setEdit({ kind: 'row', line: pending.line, value: shownText(pending.line), box: ready as Box });
    }
  }

  // ── Gestures ──
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const ctm = overlayRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };
  /** The line a new or moved row goes before, for a drop at y (null = the end). */
  const beforeAt = (y: number, skip?: number): number | null => geo?.anchors.find((a) => a.y > y && a.line !== skip)?.line ?? null;
  const dropY = (y: number, skip?: number): number => {
    if (!geo) return y;
    const i = geo.anchors.findIndex((a) => a.y > y && a.line !== skip);
    const prev = geo.anchors.filter((a, k) => a.line !== skip && (i < 0 || k < i)).at(-1);
    const next = i >= 0 ? geo.anchors[i] : null;
    if (prev && next) return (prev.y + next.y) / 2 + 4;
    return next ? next.y - 8 : (prev ? prev.y + 26 : y);
  };
  const partOrder = () => parts.filter((q) => geo?.parts.has(q.id)).map((q) => ({ id: q.id, x: geo!.parts.get(q.id)!.x }));
  const nearestPart = (x: number) => partOrder().reduce<{ id: string; x: number } | null>((best, q) => (!best || Math.abs(q.x - x) < Math.abs(best.x - x) ? q : best), null);

  const onMove = (e: React.PointerEvent) => {
    if (!drag) return;
    const at = toSvg(e);
    if (drag.kind === 'row') setDrag({ ...drag, y: at.y });
    else if (drag.kind === 'part') setDrag({ ...drag, x: at.x });
    else setDrag({ ...drag, x: at.x, y: at.y });
  };
  const onUp = () => {
    if (!drag) return;
    if (drag.kind === 'row' && Math.abs(drag.y - drag.y0) > 8) {
      const before = beforeAt(drag.y, drag.line);
      if (before !== drag.line && before !== nextLine(drag.line)) {
        // Indent the line to fit where it lands (inside a block if it goes before its `end` or `else`).
        const target = before === null ? lineIndent()
          : /^\s*(end|else|and|option)\b/.test(m.lines[before]) ? `${indentOf(m.lines[before])}    ` : indentOf(m.lines[before]);
        const moved0 = moveLine(code, drag.line, before);
        const moved = before === null ? parseSeq(moved0).rows.at(-1)?.line : before > drag.line ? before - 1 : before;
        const next = moved === undefined ? moved0 : setLine(moved0, moved, target + moved0.split('\n')[moved].trim());
        apply(next);
        if (moved !== undefined) setSel({ kind: 'row', line: moved });
      }
    } else if (drag.kind === 'part' && Math.abs(drag.x - drag.x0) > 20) {
      const target = nearestPart(drag.x);
      if (target) reorder(drag.id, parts.findIndex((q) => q.id === target.id));
    } else if (drag.kind === 'msg') {
      const to = nearestPart(drag.x);
      if (to && Math.abs(drag.x - to.x) < 90) addMessage(drag.from, to.id, beforeAt(drag.y));
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
      if (e.key === 'Enter' && sel) { e.preventDefault(); startEdit(sel); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const selRow = sel?.kind === 'row' ? rowAt(sel.line) : undefined;
  const selPart = sel?.kind === 'part' ? part(sel.id) : undefined;
  const selBlock = selRow?.kind === 'other' ? block(selRow.line) : undefined;
  const fit = () => { const st = stageRef.current; if (st && geo) setZoom(Math.max(0.3, Math.min(2, (st.clientWidth - 48) / geo.vb.w))); };

  // Hit areas and selection marks, in the drawing's own coordinates.
  const onRowDown = (e: React.PointerEvent, line: number, box: Box, movable: boolean) => {
    if (e.button) return;
    e.stopPropagation();
    setEdit(null);
    setSel({ kind: 'row', line });
    if (!movable) return;
    (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
    const y = toSvg(e).y;
    setDrag({ kind: 'row', line, box, y0: y, y });
  };
  const onDbl = (e: React.MouseEvent, s: NonNullable<Sel>) => { e.stopPropagation(); startEdit(s); };
  const overlay: React.ReactNode[] = [];
  if (geo) {
    const els = overlay;
    for (const [id, g] of geo.parts) {
      els.push(
        <rect key={`life-${id}`} className="dge-hit dge-hit-life" x={g.x - 9} y={g.lifeTop} width={18} height={Math.max(0, g.lifeBottom - g.lifeTop)}
          onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const at = toSvg(e); setDrag({ kind: 'msg', from: id, x: at.x, y: at.y }); }}>
          <title>Drag to another lifeline to add a message</title>
        </rect>,
      );
    }
    for (const [line, b] of geo.blocks) {
      els.push(<rect key={`blk-${line}`} className="dge-hit" {...R(pad(union([b.label, b.cond])!, 3))} onPointerDown={(e) => onRowDown(e, line, b.frame, false)} onDoubleClick={(e) => onDbl(e, { kind: 'row', line })} />);
      b.sections.forEach((s) => els.push(<rect key={`sec-${s.line}`} className="dge-hit" {...R(pad(s.box, 4))} onPointerDown={(e) => onRowDown(e, s.line, s.box, false)} onDoubleClick={(e) => onDbl(e, { kind: 'row', line: s.line })} />));
    }
    for (const [line, b] of geo.notes) els.push(<rect key={`note-${line}`} className="dge-hit" {...R(b)} onPointerDown={(e) => onRowDown(e, line, b, true)} onDoubleClick={(e) => onDbl(e, { kind: 'row', line })} />);
    for (const [line, g] of geo.msgs) els.push(<rect key={`msg-${line}`} className="dge-hit" {...R(g.box)} onPointerDown={(e) => onRowDown(e, line, g.box, true)} onDoubleClick={(e) => onDbl(e, { kind: 'row', line })} />);
    for (const [id, g] of geo.parts) {
      for (const [k, b] of [['t', g.top], ['b', g.bottom]] as const) {
        if (!b) continue;
        els.push(
          <rect key={`part-${id}-${k}`} className="dge-hit dge-hit-part" {...R(b)}
            onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); setSel({ kind: 'part', id }); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const x = toSvg(e).x; setDrag({ kind: 'part', id, x0: x, x }); }}
            onDoubleClick={(e) => onDbl(e, { kind: 'part', id })} />,
        );
      }
    }
    // Selection.
    if (sel?.kind === 'part') {
      const g = geo.parts.get(sel.id);
      if (g) [g.top, g.bottom].forEach((b, i) => b && els.push(<rect key={`sel-p${i}`} className="dge-sel" {...R(pad(b, 3))} />));
    } else if (sel?.kind === 'row') {
      const b = geo.blocks.get(sel.line);
      if (b) els.push(<rect key="sel-f" className="dge-sel dge-sel-frame" {...R(pad(b.frame, 2))} />, <rect key="sel-l" className="dge-sel" {...R(pad(union([b.label, b.cond])!, 3))} />);
      else { const r = geo.msgs.get(sel.line)?.box ?? geo.notes.get(sel.line) ?? rowBox(sel.line); if (r) els.push(<rect key="sel-r" className="dge-sel" {...R(pad(r, 2))} />); }
    }
    // Drag feedback.
    if (drag?.kind === 'row' && Math.abs(drag.y - drag.y0) > 8) {
      const y = dropY(drag.y, drag.line);
      els.push(<rect key="ghost" className="dge-ghost" {...R(drag.box)} y={drag.box.y + (drag.y - drag.y0)} />);
      els.push(<line key="drop" className="dge-drop" x1={geo.vb.x + 8} x2={geo.vb.x + geo.vb.w - 8} y1={y} y2={y} />);
    } else if (drag?.kind === 'part' && Math.abs(drag.x - drag.x0) > 20) {
      const g = geo.parts.get(drag.id)!, target = nearestPart(drag.x);
      els.push(<rect key="ghost" className="dge-ghost" {...R(g.top)} x={g.top.x + (drag.x - drag.x0)} />);
      if (target) els.push(<line key="drop" className="dge-drop" x1={target.x} x2={target.x} y1={geo.vb.y + 4} y2={geo.vb.y + geo.vb.h - 4} />);
    } else if (drag?.kind === 'msg') {
      const from = geo.parts.get(drag.from)!, to = nearestPart(drag.x);
      const y = dropY(drag.y);
      els.push(<line key="drop" className="dge-drop" x1={geo.vb.x + 8} x2={geo.vb.x + geo.vb.w - 8} y1={y} y2={y} />);
      els.push(<line key="rubber" className="dge-rubber" x1={from.x} y1={drag.y} x2={to && Math.abs(to.x - drag.x) < 90 ? to.x : drag.x} y2={drag.y} markerEnd="url(#seq-ov-pt)" />);
    }
  }

  return (
    <>
      <div className="md-diagram-bar dge-bar">
        <span className="md-diagram-kind">sequenceDiagram · editing</span>
        <span className="dge-tools">
          <button className="file-action-btn" onClick={addParticipant}><Plus size={13} aria-hidden /> Participant</button>
          <button className="file-action-btn" onClick={() => parts.length && addMessage(parts[0].id, (parts[1] ?? parts[0]).id, sel?.kind === 'row' ? nextLine(sel.line) : null)} disabled={!parts.length} title="Or drag from one lifeline to another">
            <MessageSquarePlus size={13} aria-hidden /> Message
          </button>
          <button className="file-action-btn" onClick={addNote} disabled={!parts.length} title="Add a note over the selected participant, or after the selected line"><StickyNote size={13} aria-hidden /> Note</button>
          <select className="dge-wrap" value="" disabled={sel?.kind !== 'row'} onChange={(e) => wrap(e.target.value)} aria-label="Wrap the selected line in a block" title="Wrap the selected line in a block">
            <option value="" disabled>Wrap in…</option>
            {WRAPS.map((w) => <option key={w} value={w}>{w}</option>)}
          </select>
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
        {selPart ? (
          <>
            <label>Label<input value={selPart.label} onChange={(e) => setPart(selPart.id, { label: e.target.value || selPart.id }, `label:${selPart.id}`)} spellCheck={false} /></label>
            <label>Kind
              <select value={selPart.actor ? 'actor' : 'participant'} onChange={(e) => setPart(selPart.id, { actor: e.target.value === 'actor' })}>
                <option value="participant">Participant</option>
                <option value="actor">Actor</option>
              </select>
            </label>
            <span className="dge-hint">id {selPart.id} · drag the box sideways to reorder</span>
          </>
        ) : selRow?.kind === 'msg' ? (
          <>
            <label>Text<input value={selRow.msg.text} onChange={(e) => setMsg(selRow.line, { text: e.target.value }, `msg:${selRow.line}`)} spellCheck={false} /></label>
            <label>From<select value={selRow.msg.from} onChange={(e) => setMsg(selRow.line, { from: e.target.value })}>{parts.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select></label>
            <label>To<select value={selRow.msg.to} onChange={(e) => setMsg(selRow.line, { to: e.target.value })}>{parts.map((q) => <option key={q.id} value={q.id}>{q.label}</option>)}</select></label>
            <label>Arrow<select value={selRow.msg.arrow} onChange={(e) => setMsg(selRow.line, { arrow: e.target.value })}>{ARROWS.map((a) => <option key={a.arrow} value={a.arrow}>{a.label}  {a.arrow}</option>)}</select></label>
          </>
        ) : selBlock ? (
          <>
            <label>Block
              <select value={selBlock.keyword} onChange={(e) => setRowText(selBlock.open, `${e.target.value} ${splitBlock(selRow!.kind === 'other' ? selRow!.text : '').cond}`.trim())}>
                {WRAPS.map((w) => <option key={w} value={w}>{w}</option>)}
              </select>
            </label>
            <label>Condition<input value={shownText(selBlock.open)} onChange={(e) => writeShownTag(selBlock.open, e.target.value)} spellCheck={false} /></label>
          </>
        ) : selRow ? (
          <label className="dge-wide">Line<input value={selRow.text} onChange={(e) => setRowText(selRow.line, e.target.value, `line:${selRow.line}`)} spellCheck={false} /></label>
        ) : (
          <span className="dge-hint">
            Drag from one lifeline to another to add a message · drag messages and notes up or down to reorder · drag a participant sideways to move it · double-click any text to edit it
          </span>
        )}
        {!geo?.complete && geo && <span className="dge-warn">Some lines aren't matched to the drawing; select them in Source to edit.</span>}
        {renderError && <span className="dge-warn">Mermaid can't draw this: {renderError}</span>}
        {sel && <button className="file-action-btn dge-delete" onClick={deleteSelection} title={selBlock ? 'Remove the block, keep its contents' : 'Delete (Del)'}><Trash2 size={13} aria-hidden /> {selBlock ? 'Unwrap' : 'Delete'}</button>}
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
              <defs>
                <marker id="seq-ov-pt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" className="dge-rubber-head" /></marker>
              </defs>
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
              onBlur={commitEdit}
              onKeyDown={(e) => {
                if (e.key === 'Enter') { e.preventDefault(); commitEdit(); }
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
