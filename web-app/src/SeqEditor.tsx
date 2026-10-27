import { useEffect, useRef, useState } from 'react';
import { MessageSquarePlus, Plus, Redo2, StickyNote, Trash2, Undo2 } from 'lucide-react';
import {
  ARROWS, declareParticipants, freshParticipant, insertLine, messageLine, moveLine, parseSeq, removeLines, setLine,
  type Message, type Participant, type Row,
} from './seqModel';
import { palette, textWidth } from './flowScene';
import type { Theme } from './mermaidSource';

// Edit a sequence diagram by hand: add, rename, reorder and remove participants;
// drag from one lifeline to another to add a message; drag rows to reorder;
// double-click to edit text. Every change rewrites lines of the mermaid source.

const COL = 180, TOP = 16, HEAD_H = 40, ROW = 46, FIRST = TOP + HEAD_H + 34, LEFT = 110;

type Sel = { kind: 'part'; id: string } | { kind: 'row'; line: number } | null;
type Drag =
  | { kind: 'row'; line: number; y0: number; y: number }
  | { kind: 'part'; id: string; x0: number; x: number }
  | { kind: 'msg'; from: string; x: number; y: number };

const indentOf = (l: string) => /^\s*/.exec(l)?.[0] || '    ';

export default function SeqEditor({ code: initial, theme, onSave, onClose }: {
  code: string;
  theme: Theme;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<{ code: string; past: string[]; future: string[]; tag: string }>({ code: initial, past: [], future: [], tag: '' });
  const [sel, setSel] = useState<Sel>(null);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [edit, setEdit] = useState<{ sel: NonNullable<Sel>; value: string } | null>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const code = hist.code;
  const m = parseSeq(code);
  const p = palette(theme);
  const parts = m.participants;
  const xOf = (id: string) => LEFT + Math.max(0, parts.findIndex((q) => q.id === id)) * COL;
  const rowY = (i: number) => FIRST + i * ROW;
  const height = rowY(m.rows.length) + 30;
  const width = LEFT + Math.max(1, parts.length) * COL + 60;

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
    setEdit({ sel: { kind: 'part', id }, value: 'New participant' });
  };
  const deletePart = (id: string) => {
    const used = m.rows.filter((r) => r.kind === 'msg' && (r.msg.from === id || r.msg.to === id));
    if (used.length && !window.confirm(`Delete ${part(id)?.label ?? id} and its ${used.length} message${used.length === 1 ? '' : 's'}?`)) return;
    const target = part(id);
    apply(removeLines(code, [...used.map((r) => r.line), ...(target?.line !== null && target ? [target.line] : [])]));
    setSel(null);
  };
  const setMsg = (line: number, change: Partial<Message>, tag = '') => {
    const r = rowAt(line);
    if (r?.kind !== 'msg') return;
    apply(setLine(code, line, messageLine({ ...r.msg, ...change }, indentOf(m.lines[line]))), tag);
  };
  const addMessage = (from: string, to: string, before: number | null) => {
    const indent = before !== null ? indentOf(m.lines[before]) : lineIndent();
    const next = insertLine(code, before, messageLine({ from, to, arrow: '->>', act: '', text: 'message' }, indent));
    apply(next);
    const line = before ?? parseSeq(next).rows.at(-1)?.line ?? 0;
    setSel({ kind: 'row', line });
    setEdit({ sel: { kind: 'row', line }, value: 'message' });
  };
  const addNote = () => {
    const over = sel?.kind === 'part' ? sel.id : parts[0]?.id;
    if (!over) return;
    apply(insertLine(code, null, `${lineIndent()}Note over ${over}: note`));
  };
  const deleteSelection = () => {
    if (!sel) return;
    if (sel.kind === 'part') deletePart(sel.id);
    else { apply(removeLines(code, [sel.line])); setSel(null); }
  };
  const commitEdit = () => {
    if (!edit) return;
    const v = edit.value.trim();
    if (edit.sel.kind === 'part') setPart(edit.sel.id, { label: v || edit.sel.id });
    else {
      const r = rowAt(edit.sel.line);
      if (r?.kind === 'msg') setMsg(edit.sel.line, { text: v });
      else if (r && v) apply(setLine(code, edit.sel.line, `${indentOf(m.lines[edit.sel.line])}${v}`));
    }
    setEdit(null);
  };

  // ── Gestures ──
  const toSvg = (e: { clientX: number; clientY: number }) => {
    const ctm = svgRef.current?.getScreenCTM();
    if (!ctm) return { x: 0, y: 0 };
    const pt = new DOMPoint(e.clientX, e.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  };
  const dropIndex = (y: number) => Math.max(0, Math.min(m.rows.length, Math.round((y - FIRST + ROW / 2) / ROW)));
  const partIndexAt = (x: number) => Math.max(0, Math.min(parts.length - 1, Math.round((x - LEFT) / COL)));

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
      const k = dropIndex(drag.y);
      const before = m.rows[k]?.line ?? null;
      if (before !== drag.line) {
        const next = moveLine(code, drag.line, before);
        apply(next);
        const moved = before === null ? parseSeq(next).rows.at(-1)?.line : before > drag.line ? before - 1 : before;
        if (moved !== undefined) setSel({ kind: 'row', line: moved });
      }
    } else if (drag.kind === 'part' && Math.abs(drag.x - drag.x0) > 20) {
      reorder(drag.id, partIndexAt(drag.x));
    } else if (drag.kind === 'msg') {
      const to = parts[partIndexAt(drag.x)];
      if (to && Math.abs(drag.x - xOf(to.id)) < COL / 2) addMessage(drag.from, to.id, m.rows[dropIndex(drag.y)]?.line ?? null);
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
        if (sel.kind === 'part') setEdit({ sel, value: part(sel.id)?.label ?? '' });
        else { const r = rowAt(sel.line); if (r) setEdit({ sel, value: r.kind === 'msg' ? r.msg.text : r.text }); }
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const selRow = sel?.kind === 'row' ? rowAt(sel.line) : undefined;
  const selPart = sel?.kind === 'part' ? part(sel.id) : undefined;

  // Where the inline editor sits.
  const editBox = (() => {
    if (!edit) return null;
    if (edit.sel.kind === 'part') return { x: xOf(edit.sel.id), y: TOP + HEAD_H / 2, w: 160 };
    const i = m.rows.findIndex((r) => r.line === (edit.sel as { line: number }).line);
    if (i < 0) return null;
    const r = m.rows[i];
    if (r.kind === 'msg') {
      const a = xOf(r.msg.from), b = xOf(r.msg.to);
      return { x: a === b ? a + 60 : (a + b) / 2, y: rowY(i) - 12, w: Math.max(160, Math.abs(b - a) - 20) };
    }
    return { x: width / 2, y: rowY(i), w: Math.min(width - 40, 420) };
  })();

  const rowsView = m.rows.map((r: Row, i) => {
    const y0 = rowY(i);
    const lifted = drag?.kind === 'row' && drag.line === r.line;
    const y = lifted ? y0 + (drag.y - drag.y0) : y0;
    const isSel = sel?.kind === 'row' && sel.line === r.line;
    const down = (e: React.PointerEvent) => {
      if (e.button) return;
      e.stopPropagation();
      setEdit(null);
      setSel({ kind: 'row', line: r.line });
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      setDrag({ kind: 'row', line: r.line, y0: toSvg(e).y, y: toSvg(e).y });
    };
    const dbl = (e: React.MouseEvent) => { e.stopPropagation(); setEdit({ sel: { kind: 'row', line: r.line }, value: r.kind === 'msg' ? r.msg.text : r.text }); };
    if (r.kind === 'other') {
      return (
        <g key={r.line} className={`dge-seq-other${isSel ? ' is-sel' : ''}${lifted ? ' is-lifted' : ''}`} onPointerDown={down} onDoubleClick={dbl}>
          <rect x={20 + r.depth * 14} y={y - 14} width={width - 40 - r.depth * 28} height={28} rx="4" />
          <text x={30 + r.depth * 14} y={y + 5} fontSize="12" fontFamily="IBM Plex Mono, ui-monospace, monospace">{r.text}</text>
        </g>
      );
    }
    const a = xOf(r.msg.from), b = xOf(r.msg.to);
    const dotted = r.msg.arrow.includes('--');
    const both = r.msg.arrow.startsWith('<<');
    const head = /x$/.test(r.msg.arrow) ? 'x' : /\)$/.test(r.msg.arrow) ? 'open' : /->$|-->$/.test(r.msg.arrow) && !r.msg.arrow.endsWith('>>') ? 'none' : 'pt';
    const end = head === 'pt' ? 'url(#seq-pt)' : head === 'x' ? 'url(#seq-x)' : head === 'open' ? 'url(#seq-open)' : undefined;
    const d = a === b ? `M${a},${y - 8} h46 v18 h-42` : `M${a},${y} L${b + (b > a ? -3 : 3)},${y}`;
    return (
      <g key={r.line} className={`dge-seq-msg${isSel ? ' is-sel' : ''}${lifted ? ' is-lifted' : ''}`} onPointerDown={down} onDoubleClick={dbl}>
        <path d={a === b ? d : `M${Math.min(a, b)},${y} H${Math.max(a, b)}`} className="dge-edge-hit" />
        <path d={d} fill="none" stroke={isSel ? 'var(--accent)' : p.line} strokeWidth="1.5" strokeDasharray={dotted ? '4 4' : undefined} markerEnd={end} markerStart={both ? 'url(#seq-pt)' : undefined} />
        <text x={a === b ? a + 54 : (a + b) / 2} y={a === b ? y - 2 : y - 8} textAnchor={a === b ? 'start' : 'middle'} fill={p.text} fontSize="13">{r.msg.text || ' '}</text>
      </g>
    );
  });

  const dropLine = drag && (drag.kind === 'row' || drag.kind === 'msg') ? rowY(dropIndex(drag.y)) - ROW / 2 : null;

  return (
    <>
      <div className="md-diagram-bar dge-bar">
        <span className="md-diagram-kind">sequenceDiagram · editing</span>
        <span className="dge-tools">
          <button className="file-action-btn" onClick={addParticipant}><Plus size={13} aria-hidden /> Participant</button>
          <button className="file-action-btn" onClick={() => parts.length && addMessage(parts[0].id, (parts[1] ?? parts[0]).id, null)} disabled={!parts.length} title="Or drag from one lifeline to another">
            <MessageSquarePlus size={13} aria-hidden /> Message
          </button>
          <button className="file-action-btn" onClick={addNote} disabled={!parts.length} title="Add a note over the selected participant"><StickyNote size={13} aria-hidden /> Note</button>
          <span className="dge-sep" />
          <button className="file-action-btn" onClick={undo} disabled={!hist.past.length} aria-label="Undo" title="Undo (Ctrl+Z)"><Undo2 size={13} aria-hidden /></button>
          <button className="file-action-btn" onClick={redo} disabled={!hist.future.length} aria-label="Redo" title="Redo (Ctrl+Shift+Z)"><Redo2 size={13} aria-hidden /></button>
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
        ) : selRow ? (
          <label className="dge-wide">Line<input value={selRow.text} onChange={(e) => apply(setLine(code, selRow.line, `${indentOf(m.lines[selRow.line])}${e.target.value}`), `line:${selRow.line}`)} spellCheck={false} /></label>
        ) : (
          <span className="dge-hint">
            Drag from one lifeline to another to add a message · drag rows up or down to reorder · drag a participant sideways to move it · double-click to edit text
          </span>
        )}
        {sel && <button className="file-action-btn dge-delete" onClick={deleteSelection}><Trash2 size={13} aria-hidden /> Delete</button>}
      </div>

      <div className="dge-stage">
        <div className="dge-canvas" style={{ width, height }}>
          <svg
            ref={svgRef}
            className="dge-svg"
            width={width}
            height={height}
            viewBox={`0 0 ${width} ${height}`}
            onPointerDown={() => { setSel(null); setEdit(null); }}
            onPointerMove={onMove}
            onPointerUp={onUp}
            fontFamily="IBM Plex Sans, system-ui, sans-serif"
          >
            <defs>
              <marker id="seq-pt" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill={p.line} /></marker>
              <marker id="seq-open" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10" fill="none" stroke={p.line} strokeWidth="1.5" /></marker>
              <marker id="seq-x" viewBox="0 0 10 10" refX="5" refY="5" markerWidth="9" markerHeight="9" orient="auto"><path d="M1,1 L9,9 M9,1 L1,9" stroke={p.line} strokeWidth="1.6" /></marker>
            </defs>

            {parts.map((q) => {
              const lifted = drag?.kind === 'part' && drag.id === q.id;
              const x = xOf(q.id) + (lifted ? drag.x - drag.x0 : 0);
              const w = Math.min(COL - 16, Math.max(90, textWidth(q.label) + 28));
              return (
                <g key={q.id} className={`dge-seq-part${sel?.kind === 'part' && sel.id === q.id ? ' is-sel' : ''}${lifted ? ' is-lifted' : ''}`}>
                  <line
                    className="dge-lifeline"
                    x1={x} y1={TOP + HEAD_H} x2={x} y2={height - 10}
                    onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); (e.currentTarget as Element).setPointerCapture?.(e.pointerId); const at = toSvg(e); setDrag({ kind: 'msg', from: q.id, x: at.x, y: at.y }); }}
                  >
                    <title>Drag to another lifeline to add a message</title>
                  </line>
                  <line x1={x} y1={TOP + HEAD_H} x2={x} y2={height - 10} stroke={p.stroke} strokeDasharray="3 4" pointerEvents="none" />
                  <g
                    onPointerDown={(e) => {
                      if (e.button) return;
                      e.stopPropagation();
                      setEdit(null);
                      setSel({ kind: 'part', id: q.id });
                      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
                      const at = toSvg(e);
                      setDrag({ kind: 'part', id: q.id, x0: at.x, x: at.x });
                    }}
                    onDoubleClick={(e) => { e.stopPropagation(); setEdit({ sel: { kind: 'part', id: q.id }, value: q.label }); }}
                  >
                    <rect x={x - w / 2} y={TOP} width={w} height={HEAD_H} rx={q.actor ? 20 : 3} fill={p.fill} stroke={p.stroke} />
                    <text x={x} y={TOP + HEAD_H / 2 + 5} textAnchor="middle" fill={p.text} fontSize="14">{q.label}</text>
                  </g>
                </g>
              );
            })}

            {rowsView}

            {dropLine !== null && <line className="dge-drop" x1={10} x2={width - 10} y1={dropLine} y2={dropLine} />}
            {drag?.kind === 'msg' && (
              <line className="dge-rubber" x1={xOf(drag.from)} y1={drag.y} x2={drag.x} y2={drag.y} markerEnd="url(#seq-pt)" />
            )}
          </svg>
          {edit && editBox && (
            <input
              className="dge-rename"
              autoFocus
              value={edit.value}
              style={{ left: editBox.x, top: editBox.y, width: editBox.w }}
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
