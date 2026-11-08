import { useEffect, useRef, useState } from 'react';
import { Minus, Plus, Redo2, Trash2, TriangleAlert, Undo2 } from 'lucide-react';
import { CHART_NAME, chartKindOf, parseChart, setChartRow, rowKey, type ChartRow } from './chartModel';
import { removeLines } from './seqModel';
import { renderMermaid, type Theme } from './mermaidSource';

// A light-weight editor for the chart kinds (gantt, pie, journey, timeline,
// mindmap, gitGraph, quadrant, sankey): mermaid's drawing is kept as the
// document shows it, and every text it paints is matched back to a source
// span. Double-click any text to edit it in place; Del drops the line.

interface Box { x: number; y: number; w: number; h: number }
interface Geo {
  vb: Box;
  rows: ChartRow[];
  /** Matched box of each row, by its index in `rows`. */
  boxes: Map<number, Box>;
}

const pad = (b: Box, p: number): Box => ({ x: b.x - p, y: b.y - p, w: b.w + p * 2, h: b.h + p * 2 });
const R = (b: Box) => ({ x: b.x, y: b.y, width: b.w, height: b.h });

/** Match each drawn text element to the source span showing it. */
function measure(svg: SVGSVGElement, rows: ChartRow[]): Geo {
  const vbb = svg.viewBox.baseVal;
  const vb = { x: vbb.x, y: vbb.y, w: vbb.width, h: vbb.height };
  const geo: Geo = { vb, rows, boxes: new Map() };
  if (vb.w + vb.h <= 0) return geo;
  const screenToRoot = svg.getScreenCTM()?.inverse();
  if (!screenToRoot) return geo;

  // Every visible text run, in document order, with its box in drawing units.
  const drawn: { text: string; box: Box }[] = [];
  const walker = document.createTreeWalker(svg, NodeFilter.SHOW_TEXT);
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const text = (n.textContent ?? '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    const range = document.createRange();
    range.selectNodeContents(n);
    const r = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (!r || r.width + r.height <= 0) continue;
    const to = (x: number, y: number) => new DOMPoint(x, y).matrixTransform(screenToRoot);
    const a = to(r.left, r.top), b = to(r.right, r.bottom);
    drawn.push({ text, box: { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), w: Math.abs(b.x - a.x), h: Math.abs(b.y - a.y) } });
  }

  // Rows queue up by text; drawn texts claim their row in reading order.
  const queues = new Map<string, number[]>();
  rows.forEach((row, i) => {
    const k = rowKey(row.text);
    queues.set(k, [...(queues.get(k) ?? []), i]);
  });
  drawn.forEach(({ text, box }) => {
    let idx = queues.get(rowKey(text))?.shift();
    if (idx === undefined) {
      // sankey paints the node name together with its numeric total ("Emoji 3000").
      for (const [k, list] of queues) {
        const rest = text.toLowerCase().slice(k.length);
        if (list.length && /^[ \t\d,.%]+$/.test(rest)) { idx = list.shift(); break; }
      }
    }
    if (idx !== undefined) geo.boxes.set(idx, box);
  });
  return geo;
}

export default function ChartEditor({ code: initial, kind, theme, onSave, onClose }: {
  code: string;
  kind: NonNullable<ReturnType<typeof chartKindOf>>;
  theme: Theme;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const [hist, setHist] = useState<{ code: string; past: string[]; future: string[] }>({ code: initial, past: [], future: [] });
  const [geo, setGeo] = useState<Geo | null>(null);
  const [renderError, setRenderError] = useState('');
  const [sel, setSel] = useState<number | null>(null);
  const [edit, setEdit] = useState<{ idx: number; value: string; box: Box } | null>(null);
  const [zoom, setZoom] = useState(1);
  const hostRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const overlayRef = useRef<SVGSVGElement>(null);
  const zoomRef = useRef(1);
  const fitted = useRef(false);
  const code = hist.code;
  const rows = parseChart(code, kind);

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
      setGeo(measure(svg, parseChart(code, kind)));
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
  const close = () => { if (!hist.past.length || window.confirm('Discard your changes to this diagram?')) onClose(); };

  const selRow = sel !== null ? rows[sel] : undefined;
  const deletedSel = () => {
    if (sel === null || !rows[sel]) return;
    apply(removeLines(code, [rows[sel].line]));
    setSel(null);
  };

  const startEdit = (idx: number) => {
    const box = geo?.boxes.get(idx);
    if (!box || !rows[idx]) return;
    setEdit({ idx, value: rows[idx].text, box });
  };
  const commitEdit = () => {
    if (!edit) return;
    const row = rows[edit.idx];
    if (row && edit.value.trim() !== row.text) apply(setChartRow(code, row, edit.value));
    setEdit(null);
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
      if (e.key === 'Delete' || e.key === 'Backspace') { e.preventDefault(); deletedSel(); return; }
      if (e.key === 'Escape') { e.preventDefault(); e.stopImmediatePropagation(); if (sel !== null) setSel(null); else close(); return; }
      if (e.key === 'Enter' && sel !== null) { e.preventDefault(); startEdit(sel); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });

  const fit = () => { const st = stageRef.current; if (st && geo) setZoom(Math.max(0.3, Math.min(2, (st.clientWidth - 48) / geo.vb.w))); };

  const overlay: React.ReactNode[] = [];
  if (geo) {
    for (const [idx, box] of geo.boxes) {
      overlay.push(<rect key={`t-${idx}`} className="dge-hit" {...R(pad(box, 3))}
        onPointerDown={(e) => { if (e.button) return; e.stopPropagation(); setEdit(null); setSel(idx); }}
        onDoubleClick={(e) => { e.stopPropagation(); startEdit(idx); }} />);
    }
    if (sel !== null && geo.boxes.has(sel)) overlay.push(<rect key="sel" className="dge-sel" {...R(pad(geo.boxes.get(sel)!, 3))} />);
  }

  const matched = geo?.boxes.size ?? 0;

  return (
    <>
      <div className="md-diagram-bar dge-bar">
        <span className="md-diagram-kind">{CHART_NAME[kind]} · editing</span>
        <span className="dge-tools">
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
        {selRow ? (
          <>
            <label className="dge-wide">Text<input
              value={selRow.text}
              onChange={(e) => { const row = rows[sel!]; if (row) apply(setChartRow(code, row, e.target.value)); }}
              spellCheck={false}
            /></label>
            <span className="dge-hint">line {selRow.line + 1} · Del removes the whole line</span>
          </>
        ) : (
          <span className="dge-hint">Double-click any text in the drawing to edit it · Del removes the selected line</span>
        )}
        {geo && matched < rows.length && (
          <span className="dge-warn"><TriangleAlert size={12} aria-hidden /> {rows.length - matched} source text{rows.length - matched === 1 ? '' : 's'} not drawn (or duplicate labels)</span>
        )}
        {renderError && <span className="dge-warn">Mermaid can't draw this: {renderError}</span>}
        {selRow && <button className="file-action-btn dge-delete" onClick={deletedSel} title="Delete (Del)"><Trash2 size={13} aria-hidden /> Delete</button>}
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
