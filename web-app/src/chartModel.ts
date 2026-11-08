// Editable text parts of the remaining mermaid kinds — gantt, pie, journey,
// timeline, mindmap, gitGraph, quadrantChart and sankey. Unlike the graph
// types there is no node model: each source line has one or more text spans
// ("Design" in a gantt task, a pie label, a commit id…), and the drawing's
// text elements are matched to those spans so they can be edited in place.

import { diagramType } from './mermaidSource';

export type ChartKind = 'gantt' | 'pie' | 'journey' | 'timeline' | 'mindmap' | 'gitGraph' | 'quadrantChart' | 'sankey';

/** One editable text span inside a source line. */
export interface ChartRow {
  line: number;
  /** Start of the span (inclusive) within its line. */
  start: number;
  /** End of the span (exclusive) within its line. */
  end: number;
  /** The span's text, trimmed — what the drawing shows. */
  text: string;
}

export const CHART_NAME: Record<ChartKind, string> = {
  gantt: 'gantt', pie: 'pie', journey: 'journey', timeline: 'timeline',
  mindmap: 'mindmap', gitGraph: 'gitGraph', quadrantChart: 'quadrantChart', sankey: 'sankey',
};

/** Which chart kind a diagram source is, or null when it has another editor. */
export function chartKindOf(src: string): ChartKind | null {
  const t = diagramType(src);
  if (t === 'sankey' || t === 'sankey-beta') return 'sankey';
  return (['gantt', 'pie', 'journey', 'timeline', 'mindmap', 'gitGraph', 'quadrantChart'] as const)
    .some((k) => k === t) ? (t as ChartKind) : null;
}

const CLEAN = /^\s*(?:%%|dateFormat|axisFormat|excludesFormatter|excludes|todayMarker|tickInterval|weekInterval|weekLabel|showData|jsKey)/;
const norm = (s: string) => s.replace(/\s+/g, ' ').trim();

/** A row covering the trimmed span of `text` inside `line`, searched from `from`. */
function spanRow(line: string, index: number, text: string, from = 0): ChartRow | null {
  const t = norm(text);
  if (!t) return null;
  const start = line.indexOf(t, from);
  if (start < 0) return null;
  return { line: index, start, end: start + t.length, text: t };
}

/** `keyword text` lines: `title …`, `section …`, `quadrant-1 …`. */
const keywordRow = (keywords: string) => (line: string, index: number): ChartRow | null => {
  const m = new RegExp(`^\\s*(${keywords})(\\s+)(.+)$`).exec(line);
  return m ? spanRow(line, index, m[3]) : null;
};

/** Every trimmed piece between the line's `:` separators (journey steps, timeline events). */
function colonRows(line: string, index: number): ChartRow[] {
  const out: ChartRow[] = [];
  let at = 0;
  for (const piece of line.split(':')) {
    const start = line.indexOf(piece, at);
    const row = spanRow(line, index, piece, at);
    if (row) out.push(row);
    at = start + piece.length + 1;
  }
  return out;
}

const MINDMAP_SHAPE = /\(\((.*?)\)\)\s*$|\((.*?)\)\s*$|\[(.*?)\]\s*$|\{(.*?)\}\s*$/;

/** The mindmap node's own text — inside the shape wrapper, or the bare word. */
function mindmapRow(line: string, index: number): ChartRow | null {
  if (/::icon\(/.test(line)) return null;
  const t = norm(line);
  const m = MINDMAP_SHAPE.exec(t);
  if (m) {
    const inner = m[1] ?? m[2] ?? m[3] ?? m[4] ?? '';
    return spanRow(line, index, inner);
  }
  return /[(){}[\]]/.test(t) ? null : spanRow(line, index, t);
}

/** Parse the editable text spans of a source. */
export function parseChart(code: string, kind: ChartKind): ChartRow[] {
  const lines = code.split('\n');
  const rows: ChartRow[] = [];
  lines.forEach((l, i) => {
    if (!norm(l) || CLEAN.test(l)) return;
    if (i === 0 && kind !== 'pie') return; // the kind's own header line
    switch (kind) {
      case 'gantt':
        if (/^\s*(?:title|section)\b/.test(l)) { const r = keywordRow('title|section')(l, i); if (r) rows.push(r); }
        else if (l.includes(':')) { const r = spanRow(l, i, l.split(':')[0]); if (r) rows.push(r); }
        break;
      case 'pie': {
        // `pie title Pets` (title on the header line) has the row after `title`.
        const head = i === 0 && /(?:^|\s)title\s/.test(l) ? l.replace(/^\s*pie\b/, '') : null;
        if (head) { const r = keywordRow('title')(head, i); if (r) rows.push({ ...r, start: r.start + l.length - head.length, end: r.end + l.length - head.length }); }
        if (/^\s*title\b/.test(l)) { const r = keywordRow('title')(l, i); if (r) rows.push(r); }
        const slice = /^(\s*)"?([^":]+?)"?\s*:\s*[\d.]+\s*(?:%%.*)?$/.exec(l);
        if (slice) { const r = spanRow(l, i, slice[2]); if (r) rows.push(r); }
        break;
      }
      case 'journey':
        if (/^\s*(?:title|section)\b/.test(l)) { const r = keywordRow('title|section')(l, i); if (r) rows.push(r); }
        else if (l.includes(':')) rows.push(...colonRows(l, i).slice(0, 3)); // task : score : actor
        break;
      case 'timeline':
        if (/^\s*(?:title|section)\b/.test(l)) { const r = keywordRow('title|section')(l, i); if (r) rows.push(r); }
        else if (l.includes(':')) rows.push(...colonRows(l, i));
        else { const r = spanRow(l, i, l); if (r) rows.push(r); }
        break;
      case 'mindmap': {
        const r = mindmapRow(l, i);
        if (r) rows.push(r);
        break;
      }
      case 'gitGraph': {
        if (/^\s*(?:option|class)\b/.test(l)) break;
        const id = /id:?\s*"([^"]*)"/.exec(l);
        if (id) { const r = spanRow(l, i, id[1]); if (r) rows.push(r); break; }
        const kw = /^\s*(?:branch|merge|checkout|label|reset|tag)(?::\S*)?\s+(\S+)/.exec(l);
        if (kw) { const r = spanRow(l, i, kw[1]); if (r) rows.push(r); }
        break;
      }
      case 'quadrantChart':
        if (/^\s*(?:x|y)-axis\b/.test(l)) break; // `x-axis Low --> High` — a whole-line gradient, not editable here
        if (/^\s*quadrant-\d\b/.test(l)) { const r = keywordRow('quadrant-\\d')(l, i); if (r) rows.push(r); }
        else if (/^\s*title\b/.test(l)) { const r = keywordRow('title')(l, i); if (r) rows.push(r); }
        else if (/:\s*\[/.test(l)) { // `Campaign A: [0.3, 0.6]`
          const m = /^\s*([^:]+?):\s*\[/.exec(l);
          if (m) { const r = spanRow(l, i, m[1]); if (r) rows.push(r); }
        }
        break;
      case 'sankey': {
        // `Emoji,music,2000` — the volume isn't drawn, only the node names are.
        const at = l.indexOf(',');
        const at2 = at < 0 ? -1 : l.indexOf(',', at + 1);
        for (const [start, end] of [[0, at], [at + 1, at2]] as const) {
          if (end < 0 && start !== 0) break;
          const piece = l.slice(start, end < 0 ? undefined : end);
          const r = spanRow(l, i, piece.trim().replace(/^"|"$/g, ''), start);
          if (r) rows.push(r);
        }
        break;
      }
    }
  });
  return rows;
}

/** Replace a row's span in the source. */
export function setChartRow(code: string, row: ChartRow, value: string): string {
  const lines = code.split('\n');
  const line = lines[row.line] ?? '';
  const v = value.replace(/\s+/g, ' ').trim();
  lines[row.line] = line.slice(0, row.start) + v + line.slice(row.end);
  return lines.join('\n');
}

/** Whitelist-normalized matching key. */
export const rowKey = (t: string) => norm(t).toLowerCase();
