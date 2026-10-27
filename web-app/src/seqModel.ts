// An editable view of a mermaid sequence diagram. The source is line-oriented,
// so edits work on lines: notes, loops, comments and anything else unknown are
// kept as they are.

export interface Participant { id: string; label: string; actor: boolean; line: number | null }

export interface Message { from: string; to: string; arrow: string; act: string; text: string }

export type Row =
  | { kind: 'msg'; line: number; msg: Message }
  | { kind: 'other'; line: number; text: string; depth: number };

export interface SeqModel { lines: string[]; header: number; participants: Participant[]; rows: Row[] }

/** Arrow kinds, longest first so the parser picks the right one. */
export const ARROWS: { arrow: string; label: string }[] = [
  { arrow: '<<-->>', label: 'Both ways, dotted' },
  { arrow: '<<->>', label: 'Both ways' },
  { arrow: '-->>', label: 'Reply (dotted)' },
  { arrow: '->>', label: 'Call' },
  { arrow: '-->', label: 'Dotted line' },
  { arrow: '->', label: 'Line' },
  { arrow: '--x', label: 'Dotted, lost' },
  { arrow: '-x', label: 'Lost (x)' },
  { arrow: '--)', label: 'Async reply' },
  { arrow: '-)', label: 'Async' },
];

const ARROW_RE = ARROWS.map((a) => a.arrow.replace(/[-<>)]/g, (c) => `\\${c}`)).join('|');
const MSG = new RegExp(`^(\\s*)([^\\s:+<>-][^:]*?)\\s*(${ARROW_RE})([+-]?)\\s*([^:]+?)\\s*:(.*)$`);
const PART = /^(\s*)(?:create\s+)?(participant|actor)\s+(.+?)(?:\s+as\s+(.+?))?\s*$/;
const OPEN = /^\s*(loop|alt|opt|par|critical|break|rect|box)\b/;
const CLOSE = /^\s*end\s*$/;

export function parseSeq(code: string): SeqModel {
  const lines = code.split('\n');
  const header = lines.findIndex((l) => /^\s*sequenceDiagram\b/.test(l));
  const participants: Participant[] = [];
  const seen = new Map<string, Participant>();
  const touch = (id: string, line: number | null, label?: string, actor = false) => {
    let p = seen.get(id);
    if (!p) { p = { id, label: label ?? id, actor, line }; seen.set(id, p); participants.push(p); }
    else if (line !== null && p.line === null) { p.line = line; if (label) p.label = label; p.actor = actor; }
    return p;
  };
  const rows: Row[] = [];
  let depth = 0;
  lines.forEach((l, i) => {
    if (i <= header || !l.trim()) return;
    const pm = PART.exec(l);
    if (pm) { touch(pm[3], i, pm[4], pm[2] === 'actor'); return; }
    const mm = MSG.exec(l);
    if (mm) {
      touch(mm[2], null); touch(mm[5], null);
      rows.push({ kind: 'msg', line: i, msg: { from: mm[2], to: mm[5], arrow: mm[3], act: mm[4], text: mm[6].trim() } });
      return;
    }
    if (CLOSE.test(l)) depth = Math.max(0, depth - 1);
    rows.push({ kind: 'other', line: i, text: l.trim(), depth });
    if (OPEN.test(l)) depth++;
  });
  return { lines, header: Math.max(0, header), participants, rows };
}

export function messageLine(m: Message, indent = '    '): string {
  return `${indent}${m.from}${m.arrow}${m.act}${m.to}: ${m.text}`;
}

const indentOf = (l: string) => /^\s*/.exec(l)?.[0] ?? '';

/** Rewrite one line. */
export function setLine(code: string, line: number, text: string): string {
  const lines = code.split('\n');
  lines[line] = text;
  return lines.join('\n');
}

export function removeLines(code: string, which: number[]): string {
  const drop = new Set(which);
  return code.split('\n').filter((_, i) => !drop.has(i)).join('\n');
}

/** Move line `from` so it ends up just before line `before` (or at the end). */
export function moveLine(code: string, from: number, before: number | null): string {
  const lines = code.split('\n');
  const [l] = lines.splice(from, 1);
  let at = before === null ? lines.length : before > from ? before - 1 : before;
  // Keep a trailing blank line after the diagram's last line.
  if (before === null) while (at > 0 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, l);
  return lines.join('\n');
}

export function insertLine(code: string, before: number | null, text: string): string {
  const lines = code.split('\n');
  let at = before ?? lines.length;
  if (before === null) while (at > 0 && !lines[at - 1].trim()) at--;
  lines.splice(at, 0, text);
  return lines.join('\n');
}

/**
 * Declare every participant explicitly, in the given order, right after the
 * header (so their order and labels can be edited). Returns the new source.
 */
export function declareParticipants(code: string, order: Participant[]): string {
  const m = parseSeq(code);
  const declared = new Set(m.participants.filter((p) => p.line !== null).map((p) => p.line!));
  const indent = m.rows[0] ? indentOf(m.lines[m.rows[0].line]) || '    ' : '    ';
  const decl = order.map((p) => `${indent}${p.actor ? 'actor' : 'participant'} ${p.id}${p.label !== p.id ? ` as ${p.label}` : ''}`);
  const lines = m.lines.filter((_, i) => !declared.has(i));
  lines.splice(m.header + 1, 0, ...decl);
  return lines.join('\n');
}

export function freshParticipant(m: SeqModel): string {
  const used = new Set(m.participants.map((p) => p.id));
  for (let i = 1; ; i++) if (!used.has(`P${i}`)) return `P${i}`;
}
