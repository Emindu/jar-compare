// Editable line-oriented models for the other main mermaid graph types:
// classDiagram, stateDiagram(-v2) and erDiagram. Like seqModel, everything
// works on source lines and anything the parser doesn't recognise is kept as
// written. Every node knows where its declaration lives and every edge which
// line it came from, so the drawing can be matched back to the source.

import { insertLine, removeLines, setLine } from './seqModel';
import { diagramType } from './mermaidSource';

export type GraphKind = 'class' | 'state' | 'er';

/** A node's declaration: `class X {…}`, `state X`, or just an entity name. */
export interface GrafNode {
  name: string;
  /** Display label (class bracket / state description), or the name itself. */
  label: string;
  /** True when `label` comes from the source and can be edited separately. */
  hasLabel: boolean;
  /** Line of `class X` / `state X`; null for nodes that only appear in edges. */
  decl: number | null;
  /** First line of the `class X {`(er `X {`) block, and its closing `}`. */
  blockStart: number | null;
  blockEnd: number | null;
  /** First-appearance order, to sanity-match mermaid's node ids (class / er). */
  order: number;
}

export interface GrafMember { line: number; text: string; method: boolean }

export interface GrafEdge {
  line: number;
  left: string;
  right: string;
  /** `<|--`, `-->`, `||--o{` … as written between the two names. */
  arrow: string;
  /** Optional `"card"` strings beside the arrow (class relationships). */
  cardLeft?: string;
  cardRight?: string;
  /** Text after `:` — undefined when the source has no label part. */
  label?: string;
  order: number;
}

export interface GrafNote { line: number; target: string | null; text: string; order: number }

export interface GrafModel {
  kind: GraphKind;
  header: number;
  lines: string[];
  nodes: GrafNode[];
  /** Member / attribute lines of each node, by name. */
  members: Map<string, GrafMember[]>;
  edges: GrafEdge[];
  notes: GrafNote[];
}

/** Which of the three kinds a diagram source is, or null (an editor exists
 *  only for flowcharts, sequences and these three). */
export function graphKindOf(src: string): GraphKind | null {
  switch (diagramType(src)) {
    case 'classDiagram': case 'classDiagram-v2': return 'class';
    case 'stateDiagram': case 'stateDiagram-v2': return 'state';
    case 'erDiagram': return 'er';
    default: return null;
  }
}

export const KIND_NAME: Record<GraphKind, string> = { class: 'classDiagram', state: 'stateDiagram', er: 'erDiagram' };

// ── Parsers ────────────────────────────────────────────────────────────────

const CLEAN = /^\s*(?:direction|accTitle|accDescr|%%)/;
const indent = (l: string) => /^\s*/.exec(l)?.[0] ?? '';
const trim = (l: string) => l.trim();

const klass = (m: GrafModel, name: string): GrafNode => {
  let n = m.nodes.find((x) => x.name === name);
  if (!n) { n = { name, label: name, hasLabel: false, decl: null, blockStart: null, blockEnd: null, order: m.nodes.length }; m.nodes.push(n); }
  return n;
};

export function parseGraph(code: string, kind: GraphKind): GrafModel {
  const lines = code.split('\n');
  const header = Math.max(0, lines.findIndex((l) => new RegExp(`^\\s*(?:${kind === 'class' ? 'classDiagram' : kind === 'state' ? 'stateDiagram' : 'erDiagram'})\\b`).test(l)));
  const m: GrafModel = { kind, header, lines, nodes: [], members: new Map(), edges: [], notes: [] };
  const members = (name: string) => {
    let list = m.members.get(name);
    if (!list) { list = []; m.members.set(name, list); }
    return list;
  };
  const addMember = (name: string, line: number, text: string) => members(name).push({ line, text: trim(text), method: kind === 'class' && /\(/.test(text) });
  /** The node a block started on `line` belongs to, for its closing `}`. */
  let open: GrafNode | null = null;

  lines.forEach((l, i) => {
    if (i === header || CLEAN.test(l) || !l.trim()) return;
    let match: RegExpExecArray | null;

    if (kind === 'class') {
      // Inside a member block: attribute lines (`<<stereotype>>` kept verbatim).
      if (open && /^\s*\}/.test(l)) { open.blockEnd = i; open = null; return; }
      if (open) { if (!/^\s*<</.test(l) && l.trim()) addMember(open.name, i, l); return; }
      // `class X` / `class X["Label"]` (optionally opening a member block)
      if ((match = /^\s*class\s+([\w~]+)(?:\s*\[(.+?)\])?\s*(\{)?\s*$/.exec(l))) {
        const n = klass(m, match[1]);
        n.decl ??= i;
        const raw = match[2]?.trim() ?? '';
        if (match[2]) { n.label = raw.replace(/^"|"$/g, ''); n.hasLabel = true; }
        if (match[3]) { n.blockStart = i; open = n; }
        return;
      }
      if ((match = /^\s*note\s+for\s+([\w~]+)\s+"(.*)"\s*$/.exec(l))) {
        klass(m, match[1]);
        m.notes.push({ line: i, target: match[1], text: match[2], order: m.notes.length });
        return;
      }
      // `X <|-- Y` / `Order "1" *-- "many" Line` (optionally `: label`)
      if ((match = /^\s*([\w~]+)(\s+"[^"]*")?\s+([<|>.*=-]+)(\s+"[^"]*")?\s+([\w~]+)\s*(?::\s*(.*))?$/.exec(l))
        && /^[<|>.*=-]+$/.test(match[3])) {
        klass(m, match[1]);
        klass(m, match[5]);
        m.edges.push({
          line: i, left: match[1], right: match[5], arrow: match[3], order: m.edges.length,
          cardLeft: match[2]?.trim(), cardRight: match[4]?.trim(),
          label: match[6] !== undefined ? match[6].trim() : undefined,
        });
        return;
      }
      // `Dog : +bark() void` — a member in one-line form
      if ((match = /^\s*([\w~]+)\s*:\s*(.+)$/.exec(l))) {
        klass(m, match[1]);
        addMember(match[1], i, match[2]);
        return;
      }
      return;
    }

    if (kind === 'state') {
      // `state X` / `state "Desc" as X` (optionally opening a composite block)
      if ((match = /^\s*state\s+(?:"(.+)"\s+as\s+)?([\w-]+)(\s*\{)?\s*$/.exec(l))) {
        const n = klass(m, match[2]);
        n.decl ??= i;
        if (match[1]) { n.label = match[1]; n.hasLabel = true; }
        return; // composite blocks: members keep their lines, the block isn't editable
      }
      // `A --> B : label` (also `[*]`; inside composite blocks these still count)
      if ((match = /^\s*(\[[*x ]?\]|[\w-]+)\s+(-->|-\.->|-\.|--|-)\s+(\[[*x ]?\]|[\w-]+)\s*(?::\s*(.*))?$/.exec(l))) {
        klass(m, match[1] === '[*]' ? '[*]' : match[1]);
        klass(m, match[3] === '[*]' ? '[*]' : match[3]);
        m.edges.push({
          line: i, left: match[1], right: match[3], arrow: match[2], order: m.edges.length,
          label: match[4] !== undefined ? match[4].trim() : undefined,
        });
        return;
      }
      if ((match = /^\s*note\s+(?:left|right|over)\s+of\s+([\w-]+)\s*:\s*(.*)$/.exec(l))) {
        klass(m, match[1]);
        m.notes.push({ line: i, target: match[1], text: match[2].trim(), order: m.notes.length });
        return;
      }
      return;
    }

    // er
    if ((match = /^\s*([\w]+)\s+([|}][|o]?)(--|\.\.)([|o{][|{]?)\s+([\w]+)\s*(?::\s*(.*))?$/.exec(l))) {
      klass(m, match[1]); klass(m, match[5]);
      m.edges.push({
        line: i, left: match[1], right: match[5], arrow: match[2] + match[3] + match[4], order: m.edges.length,
        label: match[6] !== undefined ? match[6].trim() : undefined,
      });
      return;
    }
    if ((match = /^\s*([\w]+)\s*\{\s*$/.exec(l))) {
      const n = klass(m, match[1]);
      n.blockStart = i; n.decl ??= i; open = n;
      return;
    }
    if (open && /^\s*\}/.test(l)) { open.blockEnd = i; open = null; return; }
    if (open && !/^\s*%%/.test(l)) { addMember(open.name, i, l); return; }
  });
  for (const n of m.nodes) n.label ||= n.name;
  return m;
}

const freshName = (m: GrafModel, base: string) => {
  const taken = new Set(m.nodes.map((n) => n.name));
  for (let i = 1; ; i++) if (!taken.has(`${base}${i}`)) return `${base}${i}`;
};

// ── Edge lines ──────────────────────────────────────────────────────────────

export function edgeLine(e: GrafEdge): string {
  return `${e.left}${e.cardLeft ? ` ${e.cardLeft}` : ''} ${e.arrow}${e.cardRight ? ` ${e.cardRight}` : ''} ${e.right}${e.label === undefined ? '' : ` : ${e.label}`}`;
}

// ── Edits ───────────────────────────────────────────────────────────────────

/** Add a bare node; returns the new source and the node's name. */
export function addNode(code: string, kind: GraphKind): { code: string; name: string } {
  const m = parseGraph(code, kind);
  const name = freshName(m, kind === 'er' ? 'NEW_' : 'New');
  const blocks = m.nodes.map((n) => n.blockEnd).filter((x): x is number => x !== null);
  const at = kind === 'er' ? m.lines.length : blocks.length ? Math.max(...blocks) + 1 : m.header + 1;
  const text = kind === 'class' ? `    class ${name}`
    : kind === 'state' ? `    state ${name}`
      : `${name} {\n    }`;
  return { code: insertLine(code, at, text), name };
}

/** Replace one of the whitespace-separated name tokens on a line. */
function swapToken(text: string, from: string, to: string): string {
  return text.split(/\s+/).map((t) => (t === from ? to : t)).join(' ');
}

/**
 * Rename a node. Nodes with their own label (class bracket / state description)
 * are relabelled; others change their id everywhere it appears — declaration,
 * edges, notes and one-line members.
 */
export function renameNode(code: string, kind: GraphKind, name: string, next: string): string {
  const m = parseGraph(code, kind);
  const node = m.nodes.find((n) => n.name === name);
  if (!node) return code;
  const value = next.trim() || name;
  const lines = code.split('\n');
  const pad = (i: number) => indent(lines[i]);
  const swap = (i: number, text: string) => { lines[i] = pad(i) + text; };

  if (node.hasLabel && node.decl !== null) {
    swap(node.decl, lines[node.decl].trim().replace(
      kind === 'class' ? /\[(.+?)\]/ : /"(.+)"\s+as\s+/,
      kind === 'class' ? `["${value.replace(/"/g, '')}"]` : `"${value.replace(/"/g, '')}" as `,
    ));
    return lines.join('\n');
  }

  if (kind === 'class' && node.decl !== null) {
    swap(node.decl, lines[node.decl].trim().replace(new RegExp(`(class\\s+)${name}\\b`), `$1${value}`));
  } else if (kind === 'state' && node.decl !== null) {
    swap(node.decl, lines[node.decl].trim().replace(new RegExp(`(state\\s+)${name}\\b`), `$1${value}`));
  } else if (kind === 'er' && node.blockStart !== null) {
    swap(node.blockStart, `${value} {`);
  }

  // Edges: rewrite the side that was the old name (keeping cardinalities by
  // rewriting the whole relation line only when it has none).
  for (const e of m.edges) if (e.left === name || e.right === name) {
    if (e.cardLeft || e.cardRight) {
      let text = lines[e.line].trim();
      text = swapToken(text, e.left, e.left === name ? value : e.left);
      text = swapToken(text, e.right, e.right === name ? value : e.right);
      swap(e.line, text);
    } else {
      swap(e.line, edgeLine({ ...e, left: e.left === name ? value : e.left, right: e.right === name ? value : e.right }));
    }
  }
  // Notes and one-line members keep their shape; only the name token moves.
  const keepShape = (i: number) => swap(i, swapToken(lines[i].trim(), name, value));
  for (const nt of m.notes) if (nt.target === name) keepShape(nt.line);
  if (kind === 'class') for (const row of m.members.get(name) ?? []) keepShape(row.line);
  return lines.join('\n');
}

export function deleteNodes(code: string, kind: GraphKind, names: string[]): string {
  const m = parseGraph(code, kind);
  const gone = new Set(names);
  const drop = new Set<number>();
  for (const n of m.nodes.filter((n) => gone.has(n.name))) {
    if (n.decl !== null) drop.add(n.decl);
    if (n.blockStart !== null && n.blockEnd !== null) for (let i = n.blockStart; i <= n.blockEnd; i++) drop.add(i);
  }
  if (kind !== 'state') {
    for (const e of m.edges) if (gone.has(e.left) || gone.has(e.right)) drop.add(e.line);
  } else {
    // States re-appear as `[*]`; only drop the transitions that name them.
    for (const e of m.edges) if ((gone.has(e.left) && e.left !== '[*]') || (gone.has(e.right) && e.right !== '[*]')) drop.add(e.line);
  }
  for (const nt of m.notes) if (nt.target && gone.has(nt.target)) drop.add(nt.line);
  // One-line members of the deleted classes.
  for (const [name, list] of m.members) if (gone.has(name)) list.forEach((r) => drop.add(r.line));
  return removeLines(code, [...drop]);
}

export function addEdge(code: string, kind: GraphKind, left: string, right: string): string {
  const m = parseGraph(code, kind);
  const arrow = kind === 'class' ? '-->' : kind === 'state' ? '-->' : '||--o{';
  const line = kind === 'er' ? `${left} ${arrow} ${right} : relates` : `${left} ${arrow} ${right}`;
  const at = m.edges.length ? Math.max(...m.edges.map((e) => e.line)) + 1 : m.header + 1;
  const pad = m.edges.length ? indent(m.lines[Math.max(...m.edges.map((e) => e.line))]) : '    ';
  return insertLine(code, at, pad + line);
}

export function setEdge(code: string, kind: GraphKind, line: number, patch: Partial<GrafEdge>): string {
  const m = parseGraph(code, kind);
  const e = m.edges.find((q) => q.line === line);
  if (!e) return code;
  const next: GrafEdge = { ...e, ...patch };
  return setLine(code, line, indent(code.split('\n')[line]) + edgeLine(next));
}

export function deleteLine(code: string, line: number): string {
  return removeLines(code, [line]);
}

/** Add a note attached to a node; returns the new source and the note's line. */
export function addNote(code: string, kind: GraphKind, name: string): { code: string; line: number } {
  const m = parseGraph(code, kind);
  const at = m.lines.length;
  const next = insertLine(code, at, kind === 'class' ? `    note for ${name} "note"` : `    note right of ${name} : note`);
  // insertLine pushes before trailing blanks; find where it landed.
  const moved = parseGraph(next, kind).notes.at(-1);
  return { code: next, line: moved?.line ?? at };
}
