import { useEffect, useImperativeHandle, useRef, useState, type Ref } from 'react';
import { createPortal } from 'react-dom';
import { EditorState, EditorSelection, type ChangeSpec } from '@codemirror/state';
import {
  EditorView, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter,
  drawSelection, dropCursor, rectangularSelection, crosshairCursor, placeholder,
} from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab, undo, redo } from '@codemirror/commands';
import {
  syntaxHighlighting, HighlightStyle, bracketMatching, indentOnInput, foldGutter, foldKeymap, syntaxTree, ensureSyntaxTree,
} from '@codemirror/language';
import { diagnosticCount, linter, lintGutter, type Diagnostic } from '@codemirror/lint';
import {
  Bold, Braces, Code, Heading1, Heading2, Heading3, Image, Italic, Link, List, ListChecks, ListOrdered,
  Minus, Quote, Redo2, Search, Strikethrough, Table, TableProperties, Undo2, Workflow, type LucideIcon,
} from 'lucide-react';
import { markdown, markdownLanguage, markdownKeymap } from '@codemirror/lang-markdown';
import { languages } from '@codemirror/language-data';
import {
  autocompletion, completionKeymap, startCompletion, closeBrackets, closeBracketsKeymap, snippetCompletion,
  type Completion, type CompletionContext, type CompletionResult,
} from '@codemirror/autocomplete';
import { search, searchKeymap, highlightSelectionMatches, openSearchPanel } from '@codemirror/search';
import { tags as t } from '@lezer/highlight';
import { MermaidPreview } from './Diagram';
import { checkMermaid, cleanMermaidMessage, type Theme } from './mermaidSource';

// Markdown source editor (CodeMirror 6): syntax highlighting (including fenced
// code languages), list continuation on Enter, formatting shortcuts, a toolbar,
// slash-command snippets, fence-language / mermaid / heading-anchor
// autocompletion, table formatting and search.

export interface MdEditorHandle {
  /** Move the cursor to the nth heading (0-based, document order) and scroll it into view. */
  revealHeading: (index: number) => void;
}

// ── Look ───────────────────────────────────────────────────────────────────

const mdHighlight = HighlightStyle.define([
  { tag: t.heading1, fontWeight: '700', fontSize: '1.3em', color: 'var(--text)' },
  { tag: t.heading2, fontWeight: '700', fontSize: '1.15em', color: 'var(--text)' },
  { tag: [t.heading3, t.heading4, t.heading5, t.heading6], fontWeight: '700', color: 'var(--text)' },
  { tag: t.processingInstruction, color: 'var(--text-muted)' }, // #, *, `, > markers
  { tag: t.emphasis, fontStyle: 'italic' },
  { tag: t.strong, fontWeight: '700' },
  { tag: t.strikethrough, textDecoration: 'line-through' },
  { tag: t.link, color: 'var(--accent)' },
  { tag: t.url, color: 'var(--teal-text)', textDecoration: 'underline' },
  { tag: t.monospace, color: 'var(--purple-text)' },
  { tag: t.quote, color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: t.list, color: 'var(--amber-text)' },
  { tag: t.contentSeparator, color: 'var(--text-muted)' },
  { tag: t.labelName, color: 'var(--purple-text)' },
  // fenced code
  { tag: [t.keyword, t.modifier, t.operatorKeyword], color: 'var(--red-text)' },
  { tag: [t.string, t.special(t.string), t.regexp], color: 'var(--green-text)' },
  { tag: [t.number, t.bool, t.null, t.atom], color: 'var(--amber-text)' },
  { tag: [t.comment, t.lineComment, t.blockComment], color: 'var(--text-muted)', fontStyle: 'italic' },
  { tag: [t.typeName, t.className, t.namespace], color: 'var(--teal-text)' },
  { tag: [t.function(t.variableName), t.function(t.propertyName)], color: 'var(--accent)' },
  { tag: [t.propertyName, t.attributeName], color: 'var(--accent)' },
  { tag: t.meta, color: 'var(--text-muted)' },
]);

const editorTheme = EditorView.theme({
  '&': { height: '100%', background: 'var(--surface)', color: 'var(--text)', fontSize: '0.84rem' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '0.75rem 0', caretColor: 'var(--accent)' },
  '.cm-line': { padding: '0 1rem 0 0.5rem' },
  '.cm-gutters': { background: 'var(--surface)', color: 'var(--text-muted)', border: 'none', opacity: 0.7 },
  '.cm-activeLine': { background: 'var(--accent-subtle)' },
  '.cm-activeLineGutter': { background: 'transparent', color: 'var(--text)' },
  '&.cm-focused': { outline: 'none' },
  '.cm-cursor': { borderLeftColor: 'var(--accent)' },
  '&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection': {
    background: 'rgba(47, 129, 247, 0.28) !important',
  },
  '.cm-selectionMatch': { background: 'var(--amber-bg)' },
  '.cm-matchingBracket': { background: 'var(--surface-2)', outline: '1px solid var(--border)' },
  '.cm-placeholder': { color: 'var(--text-muted)' },
  '.cm-tooltip': { background: 'var(--surface)', border: '1px solid var(--border)', borderRadius: '6px', overflow: 'hidden' },
  '.cm-tooltip-autocomplete > ul': { fontFamily: 'var(--font-sans)', fontSize: '0.8rem', maxHeight: '18em' },
  '.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px !important' },
  '.cm-tooltip-autocomplete > ul > li[aria-selected]': { background: 'var(--accent)', color: '#fff' },
  '.cm-completionDetail': { color: 'inherit', opacity: 0.6, fontStyle: 'normal', marginLeft: '0.75em' },
  '.cm-completionInfo': { background: 'var(--surface)', border: '1px solid var(--border)', fontFamily: 'var(--font-mono)', fontSize: '0.75rem', whiteSpace: 'pre' },
  '.cm-panels': { background: 'var(--surface)', color: 'var(--text)', borderColor: 'var(--border)' },
  '.cm-panel.cm-search': { fontFamily: 'var(--font-sans)', fontSize: '0.8rem', padding: '6px 8px' },
  '.cm-panel.cm-search input, .cm-panel.cm-search button': {
    background: 'var(--bg)', color: 'var(--text)', border: '1px solid var(--border)', borderRadius: '5px', backgroundImage: 'none',
  },
  '.cm-searchMatch': { background: 'var(--amber-bg)', outline: '1px solid var(--amber)' },
  '.cm-searchMatch-selected': { background: 'var(--accent-subtle)' },
  '.cm-foldPlaceholder': { background: 'var(--surface-2)', border: 'none', color: 'var(--text-muted)' },
  '.cm-tooltip-lint': { fontFamily: 'var(--font-sans)', fontSize: '0.78rem' },
  '.cm-diagnostic': { whiteSpace: 'pre-wrap', padding: '4px 8px', maxWidth: '520px' },
  '.cm-diagnostic-error': { borderLeft: '3px solid var(--red)' },
  '.cm-lintRange-error': { backgroundColor: 'var(--red-bg)' },
  '.cm-lint-marker': { width: '0.9em', height: '0.9em' },
});

// ── Formatting commands ────────────────────────────────────────────────────

/** Toggle an inline wrapper (e.g. ** for bold) around each selection. */
function wrap(view: EditorView, before: string, after = before, placeholderText = 'text'): boolean {
  const { state } = view;
  view.dispatch(state.changeByRange((range) => {
    const text = state.sliceDoc(range.from, range.to);
    const outerFrom = range.from - before.length, outerTo = range.to + after.length;
    // Already wrapped → unwrap.
    if (outerFrom >= 0 && state.sliceDoc(outerFrom, range.from) === before && state.sliceDoc(range.to, outerTo) === after) {
      return {
        changes: [{ from: outerFrom, to: range.from }, { from: range.to, to: outerTo }],
        range: EditorSelection.range(outerFrom, range.to - before.length),
      };
    }
    if (text.startsWith(before) && text.endsWith(after) && text.length >= before.length + after.length) {
      const inner = text.slice(before.length, text.length - after.length);
      return { changes: { from: range.from, to: range.to, insert: inner }, range: EditorSelection.range(range.from, range.from + inner.length) };
    }
    const body = text || placeholderText;
    return {
      changes: { from: range.from, to: range.to, insert: before + body + after },
      range: EditorSelection.range(range.from + before.length, range.from + before.length + body.length),
    };
  }));
  view.focus();
  return true;
}

/** Toggle a line prefix (heading, quote, list) on every selected line. */
function linePrefix(view: EditorView, prefix: string | ((i: number) => string), strip: RegExp): boolean {
  const { state } = view;
  const changes: ChangeSpec[] = [];
  const seen = new Set<number>();
  for (const r of state.selection.ranges) {
    const first = state.doc.lineAt(r.from).number, last = state.doc.lineAt(r.to).number;
    const lines = [];
    for (let n = first; n <= last; n++) if (!seen.has(n)) { seen.add(n); lines.push(state.doc.line(n)); }
    const p0 = typeof prefix === 'string' ? prefix : prefix(0);
    const allHave = lines.every((l) => l.text.startsWith(p0) || (typeof prefix !== 'string' && strip.test(l.text)));
    lines.forEach((l, i) => {
      const m = strip.exec(l.text);
      const existing = m ? m[0].length : 0;
      const p = typeof prefix === 'string' ? prefix : prefix(i);
      changes.push({ from: l.from, to: l.from + existing, insert: allHave ? '' : p });
    });
  }
  view.dispatch({ changes });
  view.focus();
  return true;
}

const heading = (level: number) => (view: EditorView) => {
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  const cur = /^(#{1,6})\s+/.exec(line.text);
  const p = '#'.repeat(level) + ' ';
  view.dispatch({ changes: { from: line.from, to: line.from + (cur ? cur[0].length : 0), insert: cur?.[1].length === level ? '' : p } });
  view.focus();
  return true;
};

function insertBlock(view: EditorView, block: string, cursorOffset?: number): boolean {
  const { state } = view;
  const pos = state.selection.main.head;
  const line = state.doc.lineAt(pos);
  // Put blocks on their own paragraph.
  const lead = line.text.trim() ? (pos === line.to ? '\n\n' : '\n') : '';
  const insert = lead + block + '\n';
  view.dispatch({
    changes: { from: pos, insert },
    selection: { anchor: pos + lead.length + (cursorOffset ?? block.length) },
    scrollIntoView: true,
  });
  view.focus();
  return true;
}

function insertLink(view: EditorView, image = false): boolean {
  const { state } = view;
  const r = state.selection.main;
  const text = state.sliceDoc(r.from, r.to);
  const isUrl = /^https?:\/\/\S+$/.test(text);
  const label = isUrl ? (image ? 'alt text' : 'link text') : text || (image ? 'alt text' : 'link text');
  const url = isUrl ? text : 'https://';
  const insert = `${image ? '!' : ''}[${label}](${url})`;
  const labelFrom = r.from + (image ? 2 : 1);
  const sel = isUrl || !text
    ? EditorSelection.range(labelFrom, labelFrom + label.length)
    : EditorSelection.range(r.from + insert.length - 1 - url.length, r.from + insert.length - 1);
  view.dispatch({ changes: { from: r.from, to: r.to, insert }, selection: sel });
  view.focus();
  return true;
}

/** Re-align the GFM table around the cursor so its pipes line up. */
function formatTable(view: EditorView): boolean {
  const { state } = view;
  const doc = state.doc;
  const cur = doc.lineAt(state.selection.main.head).number;
  const isRow = (n: number) => n >= 1 && n <= doc.lines && /^\s*\|.*\|\s*$|^[^|]*\|[^|]*/.test(doc.line(n).text) && doc.line(n).text.includes('|');
  if (!isRow(cur)) return false;
  let first = cur, last = cur;
  while (isRow(first - 1)) first--;
  while (isRow(last + 1)) last++;
  const split = (s: string) => {
    let x = s.trim();
    if (x.startsWith('|')) x = x.slice(1);
    if (x.endsWith('|') && !x.endsWith('\\|')) x = x.slice(0, -1);
    return x.split(/(?<!\\)\|/).map((c) => c.trim());
  };
  const rows: string[][] = [];
  for (let n = first; n <= last; n++) rows.push(split(doc.line(n).text));
  const sepIdx = rows.findIndex((r) => r.every((c) => /^:?-+:?$/.test(c)));
  const cols = Math.max(...rows.map((r) => r.length));
  const align = rows[sepIdx]?.map((c) => (c.startsWith(':') && c.endsWith(':') ? 'c' : c.endsWith(':') ? 'r' : c.startsWith(':') ? 'l' : '')) ?? [];
  const width = Array.from({ length: cols }, (_, i) =>
    Math.max(3, ...rows.map((r, ri) => (ri === sepIdx ? 0 : (r[i] ?? '').length))));
  const out = rows.map((r, ri) => '| ' + width.map((w, i) => {
    if (ri === sepIdx) {
      const a = align[i] || '';
      return (a === 'l' || a === 'c' ? ':' : '-') + '-'.repeat(w - 2) + (a === 'r' || a === 'c' ? ':' : '-');
    }
    const c = r[i] ?? '';
    return align[i] === 'r' ? c.padStart(w) : align[i] === 'c' ? c.padStart(Math.floor((w + c.length) / 2)).padEnd(w) : c.padEnd(w);
  }).join(' | ') + ' |').join('\n');
  view.dispatch({ changes: { from: doc.line(first).from, to: doc.line(last).to, insert: out } });
  view.focus();
  return true;
}

const formatKeymap = [
  { key: 'Mod-b', run: (v: EditorView) => wrap(v, '**') },
  { key: 'Mod-i', run: (v: EditorView) => wrap(v, '*') },
  { key: 'Mod-Shift-x', run: (v: EditorView) => wrap(v, '~~') },
  { key: 'Mod-e', run: (v: EditorView) => wrap(v, '`', '`', 'code') },
  { key: 'Mod-k', run: (v: EditorView) => insertLink(v) },
  { key: 'Mod-Alt-1', run: heading(1) },
  { key: 'Mod-Alt-2', run: heading(2) },
  { key: 'Mod-Alt-3', run: heading(3) },
  { key: 'Mod-Shift-.', run: (v: EditorView) => linePrefix(v, '> ', /^>\s?/) },
  { key: 'Mod-Shift-8', run: (v: EditorView) => linePrefix(v, '- ', /^\s*[-*+]\s+(\[[ xX]\]\s+)?/) },
  { key: 'Mod-Shift-7', run: (v: EditorView) => linePrefix(v, (i) => `${i + 1}. `, /^\s*\d+[.)]\s+/) },
  { key: 'Mod-Shift-c', run: (v: EditorView) => linePrefix(v, '- [ ] ', /^\s*[-*+]\s+\[[ xX]\]\s+/) },
  { key: 'Mod-Alt-t', run: formatTable },
];

// ── Autocompletion ─────────────────────────────────────────────────────────

const TABLE = '| ${Column 1} | ${Column 2} | ${Column 3} |\n| --- | --- | --- |\n| ${} |  |  |\n|  |  |  |';
const FLOWCHART = '```mermaid\nflowchart LR\n    ${A}[${Start}] --> B{${Decision}}\n    B -->|yes| C[${Do it}]\n    B -->|no| D[${Skip}]\n```';
const SEQUENCE = '```mermaid\nsequenceDiagram\n    autonumber\n    participant ${A} as ${Client}\n    participant B as Server\n    A->>B: ${request}\n    B-->>A: response\n```';

const SLASH: Completion[] = [
  snippetCompletion('# ${Heading}', { label: '/h1', detail: 'Heading 1', type: 'keyword' }),
  snippetCompletion('## ${Heading}', { label: '/h2', detail: 'Heading 2', type: 'keyword' }),
  snippetCompletion('### ${Heading}', { label: '/h3', detail: 'Heading 3', type: 'keyword' }),
  snippetCompletion(TABLE, { label: '/table', detail: '3-column table', type: 'keyword', info: '| Column 1 | Column 2 |\n| --- | --- |' }),
  snippetCompletion('```${lang}\n${}\n```', { label: '/code', detail: 'Code block', type: 'keyword' }),
  snippetCompletion(FLOWCHART, { label: '/flowchart', detail: 'Mermaid flowchart', type: 'class', info: 'flowchart LR\n  A --> B' }),
  snippetCompletion(SEQUENCE, { label: '/sequence', detail: 'Mermaid sequence', type: 'class', info: 'sequenceDiagram\n  A->>B: msg' }),
  snippetCompletion('```mermaid\nclassDiagram\n    class ${Animal} {\n        +String name\n        +move()\n    }\n    ${Animal} <|-- Dog\n```', { label: '/class', detail: 'Mermaid class diagram', type: 'class' }),
  snippetCompletion('```mermaid\nstateDiagram-v2\n    [*] --> ${Idle}\n    Idle --> Running: start\n    Running --> [*]\n```', { label: '/state', detail: 'Mermaid state diagram', type: 'class' }),
  snippetCompletion('```mermaid\nerDiagram\n    ${CUSTOMER} ||--o{ ORDER : places\n```', { label: '/er', detail: 'Mermaid ER diagram', type: 'class' }),
  snippetCompletion('```mermaid\ngantt\n    title ${Plan}\n    dateFormat YYYY-MM-DD\n    section ${Phase}\n    Task A :a1, 2026-01-01, 7d\n    Task B :after a1, 5d\n```', { label: '/gantt', detail: 'Mermaid Gantt chart', type: 'class' }),
  snippetCompletion('```mermaid\npie title ${Title}\n    "A" : 40\n    "B" : 60\n```', { label: '/pie', detail: 'Mermaid pie chart', type: 'class' }),
  snippetCompletion('- [ ] ${Task}', { label: '/todo', detail: 'Task list item', type: 'keyword' }),
  snippetCompletion('- ${Item}', { label: '/list', detail: 'Bullet list', type: 'keyword' }),
  snippetCompletion('1. ${Item}', { label: '/numbered', detail: 'Numbered list', type: 'keyword' }),
  snippetCompletion('> ${Quote}', { label: '/quote', detail: 'Block quote', type: 'keyword' }),
  snippetCompletion('> [!NOTE]\n> ${Note}', { label: '/note', detail: 'Callout', type: 'keyword' }),
  snippetCompletion('[${text}](${https://})', { label: '/link', detail: 'Link', type: 'keyword' }),
  snippetCompletion('![${alt}](${https://})', { label: '/image', detail: 'Image', type: 'keyword' }),
  snippetCompletion('<details>\n<summary>${Summary}</summary>\n\n${}\n\n</details>', { label: '/details', detail: 'Collapsible block', type: 'keyword' }),
  snippetCompletion('---\n${}', { label: '/hr', detail: 'Horizontal rule', type: 'keyword' }),
];

const FENCE_LANGS = [
  'mermaid', 'java', 'kotlin', 'json', 'yaml', 'xml', 'sql', 'bash', 'shell', 'javascript', 'typescript',
  'python', 'go', 'rust', 'html', 'css', 'properties', 'groovy', 'scala', 'dockerfile', 'diff', 'text',
].map((l) => ({ label: l, type: l === 'mermaid' ? 'class' : 'constant' }));

const MERMAID_TYPES = [
  'flowchart LR', 'flowchart TD', 'sequenceDiagram', 'classDiagram', 'stateDiagram-v2', 'erDiagram',
  'gantt', 'pie', 'journey', 'mindmap', 'timeline', 'gitGraph', 'C4Context', 'quadrantChart', 'architecture-beta',
].map((l) => ({ label: l, type: 'class', boost: 1 }));

const MERMAID_WORDS: Completion[] = [
  ...['subgraph', 'end', 'direction LR', 'direction TB', 'classDef', 'class', 'style', 'linkStyle', 'click',
    'participant', 'actor', 'autonumber', 'activate', 'deactivate', 'loop', 'alt', 'else', 'opt', 'par', 'and',
    'critical', 'break', 'rect', 'Note right of', 'Note left of', 'Note over', 'title', 'section', 'dateFormat',
    'accTitle', 'accDescr', 'state', 'note'].map((l) => ({ label: l, type: 'keyword' })),
  ...['-->', '-.->', '==>', '---', '-->|label|', '->>', '-->>', '-x', '--x', '-)', '<|--', '*--', 'o--', '||--o{', '}o--||']
    .map((l) => ({ label: l, type: 'operator' })),
];

function slugify(text: string): string {
  return text.toLowerCase().trim().replace(/[^\p{L}\p{N}\s-]/gu, '').replace(/\s+/g, '-');
}

/** Returns the info string of the fenced code block the cursor is inside, or null. */
function fenceAt(ctx: CompletionContext): { info: string; codeStart: number } | null {
  let node = syntaxTree(ctx.state).resolveInner(ctx.pos, -1);
  for (; node; node = node.parent!) {
    if (node.name === 'FencedCode') {
      const info = node.getChild('CodeInfo');
      const firstLine = ctx.state.doc.lineAt(node.from);
      return { info: info ? ctx.state.sliceDoc(info.from, info.to) : '', codeStart: firstLine.to + 1 };
    }
    if (!node.parent) break;
  }
  return null;
}

function mdCompletions(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);

  // ```lang
  const fenceOpen = /^\s*(`{3,}|~{3,})([\w+-]*)$/.exec(before);
  if (fenceOpen) return { from: ctx.pos - fenceOpen[2].length, options: FENCE_LANGS, validFor: /^[\w+-]*$/ };

  const fence = fenceAt(ctx);
  if (fence) {
    if (!/^mermaid\b/i.test(fence.info)) return null;
    const word = ctx.matchBefore(/[\w-]*$|[-.=<>|*o}{)x]+$/);
    if (!word || (word.from === word.to && !ctx.explicit)) return null;
    const firstCodeLine = line.from <= fence.codeStart;
    return { from: word.from, options: firstCodeLine ? MERMAID_TYPES : MERMAID_WORDS };
  }

  // [text](#anchor)
  const anchor = /\]\(#([\w\p{L}-]*)$/u.exec(before);
  if (anchor) {
    const options: Completion[] = [];
    const seen = new Map<string, number>();
    for (let n = 1; n <= ctx.state.doc.lines; n++) {
      const m = /^#{1,6}\s+(.+?)\s*#*$/.exec(ctx.state.doc.line(n).text);
      if (!m) continue;
      let id = slugify(m[1].replace(/[*_`]/g, ''));
      const k = seen.get(id) ?? 0;
      seen.set(id, k + 1);
      if (k) id = `${id}-${k}`;
      options.push({ label: id, detail: m[1], type: 'variable' });
    }
    return { from: ctx.pos - anchor[1].length, options, validFor: /^[\w\p{L}-]*$/u };
  }

  // /command at the start of a line (or after list/quote markers)
  const slash = /(?:^|\s)(\/\w*)$/.exec(before);
  if (slash && /^\s*([-*+>]\s+)?\/\w*$/.test(before)) {
    return { from: ctx.pos - slash[1].length, options: SLASH, validFor: /^\/\w*$/ };
  }
  return null;
}

// ── Fences: typing ``` on an empty line also inserts the closing fence ─────

const autoCloseFence = EditorView.inputHandler.of((view, from, to, text) => {
  if (text !== '`' || from !== to) return false;
  const line = view.state.doc.lineAt(from);
  const before = line.text.slice(0, from - line.from);
  const m = /^(\s*)``$/.exec(before);
  if (!m || line.text.slice(from - line.from).trim()) return false;
  // Don't double up when this is the closing fence of an open block.
  const tree = syntaxTree(view.state).resolveInner(from, -1);
  for (let n: typeof tree | null = tree; n; n = n.parent) if (n.name === 'FencedCode') return false;
  view.dispatch({
    changes: { from, insert: '`\n' + m[1] + '```' },
    selection: { anchor: from + 1 },
  });
  // Offer the language list straight away.
  setTimeout(() => startCompletion(view));
  return true;
});

// ── Smart paste: URL over a selection becomes a link ───────────────────────

const pasteLink = EditorView.domEventHandlers({
  paste(e, view) {
    const text = e.clipboardData?.getData('text/plain')?.trim() ?? '';
    const sel = view.state.selection.main;
    if (sel.empty || !/^https?:\/\/\S+$/.test(text)) return false;
    const label = view.state.sliceDoc(sel.from, sel.to);
    if (/^https?:\/\//.test(label)) return false;
    e.preventDefault();
    view.dispatch({ changes: { from: sel.from, to: sel.to, insert: `[${label}](${text})` } });
    return true;
  },
});

// ── Mermaid blocks: parse errors on the right line, live preview ───────────

interface Fence { from: number; code: string; firstLine: number; lastLine: number }

/** ```mermaid blocks in the document (or just the one containing `pos`). */
function mermaidFences(state: EditorState, pos?: number): Fence[] {
  const tree = ensureSyntaxTree(state, state.doc.length, 200) ?? syntaxTree(state);
  const out: Fence[] = [];
  tree.iterate({
    from: pos ?? 0,
    to: pos ?? state.doc.length,
    enter: (n) => {
      if (n.name !== 'FencedCode') return;
      const info = n.node.getChild('CodeInfo');
      if (info && /^mermaid\b/i.test(state.sliceDoc(info.from, info.to))) {
        const text = n.node.getChild('CodeText');
        const start = state.doc.lineAt(n.from).number + 1;
        out.push({
          from: n.from,
          code: text ? state.sliceDoc(text.from, text.to) : '',
          firstLine: start,
          lastLine: Math.max(start, state.doc.lineAt(n.to).number - 1),
        });
      }
      return false;
    },
  });
  return out;
}

const mermaidLinter = linter(async (view) => {
  const out: Diagnostic[] = [];
  for (const f of mermaidFences(view.state)) {
    if (!f.code.trim()) continue;
    const err = await checkMermaid(f.code);
    if (!err) continue;
    const n = err.line ? Math.min(f.firstLine + err.line - 1, f.lastLine) : f.firstLine;
    const line = view.state.doc.line(Math.min(n, view.state.doc.lines));
    out.push({ from: line.from, to: line.to, severity: 'error', source: 'mermaid', message: cleanMermaidMessage(err.message) });
  }
  return out;
}, { delay: 600 });

function LivePreview({ fence, theme, onClose }: { fence: Fence; theme: Theme; onClose: () => void }) {
  const [min, setMin] = useState(false);
  return (
    <div className={`md-live${min ? ' min' : ''}`}>
      <div className="md-live-hd">
        <button className="md-live-title" onClick={() => setMin((v) => !v)} title={min ? 'Show preview' : 'Minimize'}>
          {min ? '▸' : '▾'} ◇ Live preview <span>· lines {fence.firstLine}–{fence.lastLine}</span>
        </button>
        <button className="md-live-x" onClick={onClose} title="Hide for this diagram">✕</button>
      </div>
      {!min && <div className="md-live-body"><MermaidPreview code={fence.code} theme={theme} /></div>}
    </div>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

function headingLines(state: EditorState): number[] {
  const out: number[] = [];
  syntaxTree(state).iterate({
    enter: (n) => {
      if (/^(ATXHeading|SetextHeading)\d$/.test(n.name)) { out.push(n.from); return false; }
      if (n.name === 'FencedCode') return false;
    },
  });
  return out;
}

export interface EditorStats { line: number; col: number; sel: number; words: number; lines: number; errors: number }
type Stats = EditorStats;

function statsOf(state: EditorState): Stats {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  const sel = state.selection.ranges.reduce((a, r) => a + (r.to - r.from), 0);
  return {
    line: line.number, col: head - line.from + 1, sel,
    words: (state.doc.toString().match(/\S+/g) || []).length,
    lines: state.doc.lines,
    errors: diagnosticCount(state),
  };
}

export default function MdEditor({
  value, onChange, onHeading, onStats, toolbarHost, theme, ref,
}: {
  value: string;
  theme: Theme;
  onChange: (text: string) => void;
  /** Called with the index of the heading the cursor is under (-1 before the first). */
  onHeading?: (index: number) => void;
  /** Cursor and document stats; when given, the editor shows no status line of its own. */
  onStats?: (s: EditorStats) => void;
  /** Render the formatting toolbar here instead of above the editor. */
  toolbarHost?: HTMLElement | null;
  ref?: Ref<MdEditorHandle>;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const cb = useRef({ onChange, onHeading, onStats });
  const [stats, setStats] = useState<Stats>({ line: 1, col: 1, sel: 0, words: 0, lines: 1, errors: 0 });
  const [fence, setFence] = useState<Fence | null>(null);
  const [hiddenFence, setHiddenFence] = useState<number | null>(null);

  useEffect(() => { cb.current = { onChange, onHeading, onStats }; });
  useEffect(() => { cb.current.onStats?.(stats); }, [stats]);

  useEffect(() => {
    let timer = 0;
    let fenceTimer = 0;
    let lastHeading = -2;
    const view = new EditorView({
      parent: hostRef.current!,
      state: EditorState.create({
        doc: value,
        extensions: [
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter({ openText: '▾', closedText: '▸' }),
          history(),
          drawSelection(),
          dropCursor(),
          EditorState.allowMultipleSelections.of(true),
          rectangularSelection(),
          crosshairCursor(),
          indentOnInput(),
          bracketMatching(),
          closeBrackets(),
          highlightActiveLine(),
          highlightSelectionMatches(),
          search({ top: true }),
          EditorView.lineWrapping,
          placeholder('Start writing Markdown… type / for blocks and diagrams'),
          markdown({ base: markdownLanguage, codeLanguages: languages, addKeymap: false }),
          markdownLanguage.data.of({ closeBrackets: { brackets: ['(', '[', '{', '"'] } }),
          autocompletion({ override: [mdCompletions], icons: false, activateOnTyping: true }),
          syntaxHighlighting(mdHighlight),
          editorTheme,
          pasteLink,
          autoCloseFence,
          mermaidLinter,
          lintGutter(),
          keymap.of([
            ...formatKeymap,
            ...markdownKeymap,
            ...closeBracketsKeymap,
            ...completionKeymap,
            ...searchKeymap,
            ...foldKeymap,
            ...historyKeymap,
            indentWithTab,
            ...defaultKeymap,
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              // Debounce so the preview (and mermaid) doesn't re-render on every keystroke.
              clearTimeout(timer);
              timer = window.setTimeout(() => cb.current.onChange(u.state.doc.toString()), 250);
            }
            if (u.docChanged || u.selectionSet || u.transactions.some((tr) => tr.effects.length)) setStats(statsOf(u.state));
            if (u.docChanged || u.selectionSet) {
              const head = u.state.selection.main.head;
              const idx = headingLines(u.state).filter((p) => p <= head).length - 1;
              if (idx !== lastHeading && u.selectionSet) { lastHeading = idx; cb.current.onHeading?.(idx); }
              // Live diagram preview while the cursor is inside a mermaid block.
              clearTimeout(fenceTimer);
              fenceTimer = window.setTimeout(() => setFence(mermaidFences(u.state, head)[0] ?? null), 350);
            }
          }),
        ],
      }),
    });
    viewRef.current = view;
    setStats(statsOf(view.state));
    view.focus();
    return () => {
      // Flush a pending edit so nothing typed is lost when the editor closes.
      if (timer) { clearTimeout(timer); cb.current.onChange(view.state.doc.toString()); }
      clearTimeout(fenceTimer);
      view.destroy();
      viewRef.current = null;
    };
    // The editor owns its document after mount; `value` is only the initial content.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useImperativeHandle(ref, () => ({
    revealHeading: (index: number) => {
      const view = viewRef.current;
      if (!view) return;
      const pos = headingLines(view.state)[index];
      if (pos === undefined) return;
      view.dispatch({ selection: { anchor: pos }, effects: EditorView.scrollIntoView(pos, { y: 'start', yMargin: 12 }) });
    },
  }), []);

  const run = (fn: (v: EditorView) => boolean) => () => { if (viewRef.current) fn(viewRef.current); };

  const tools: ([LucideIcon, string, (v: EditorView) => boolean] | null)[] = [
    [Bold, 'Bold (Ctrl+B)', (v) => wrap(v, '**')],
    [Italic, 'Italic (Ctrl+I)', (v) => wrap(v, '*')],
    [Strikethrough, 'Strikethrough (Ctrl+Shift+X)', (v) => wrap(v, '~~')],
    [Code, 'Inline code (Ctrl+E)', (v) => wrap(v, '`', '`', 'code')],
    null,
    [Heading1, 'Heading 1 (Ctrl+Alt+1)', heading(1)],
    [Heading2, 'Heading 2 (Ctrl+Alt+2)', heading(2)],
    [Heading3, 'Heading 3 (Ctrl+Alt+3)', heading(3)],
    null,
    [List, 'Bullet list (Ctrl+Shift+8)', (v) => linePrefix(v, '- ', /^\s*[-*+]\s+(\[[ xX]\]\s+)?/)],
    [ListOrdered, 'Numbered list (Ctrl+Shift+7)', (v) => linePrefix(v, (i) => `${i + 1}. `, /^\s*\d+[.)]\s+/)],
    [ListChecks, 'Task list (Ctrl+Shift+C)', (v) => linePrefix(v, '- [ ] ', /^\s*[-*+]\s+\[[ xX]\]\s+/)],
    [Quote, 'Quote (Ctrl+Shift+.)', (v) => linePrefix(v, '> ', /^>\s?/)],
    null,
    [Link, 'Link (Ctrl+K)', (v) => insertLink(v)],
    [Image, 'Image', (v) => insertLink(v, true)],
    [Table, 'Table', (v) => insertBlock(v, '| Column 1 | Column 2 | Column 3 |\n| -------- | -------- | -------- |\n|          |          |          |', 2)],
    [TableProperties, 'Format table at cursor (Ctrl+Alt+T)', formatTable],
    [Braces, 'Code block', (v) => insertBlock(v, '```\n\n```', 3)],
    [Workflow, 'Mermaid diagram', (v) => insertBlock(v, '```mermaid\nflowchart LR\n    A[Start] --> B[End]\n```', 30)],
    [Minus, 'Horizontal rule', (v) => insertBlock(v, '---')],
    null,
    [Undo2, 'Undo (Ctrl+Z)', undo],
    [Redo2, 'Redo (Ctrl+Shift+Z)', redo],
    [Search, 'Find / replace (Ctrl+F)', openSearchPanel],
  ];

  const toolbar = (
        <div className="md-toolbar" role="toolbar" aria-label="Formatting">
          {tools.map((tool, i) =>
            tool ? (
              <button
                key={i}
                className="md-tool"
                title={tool[1]}
                aria-label={tool[1]}
                onMouseDown={(e) => e.preventDefault()}
                onClick={run(tool[2])}
              >
                {(() => { const Icon = tool[0]; return <Icon size={15} strokeWidth={1.75} aria-hidden />; })()}
              </button>
            ) : (
              <span key={i} className="md-tool-sep" />
            ),
          )}
        </div>
  );

  return (
    <div className="md-editor">
      {toolbarHost ? createPortal(toolbar, toolbarHost) : toolbar}
      <div className="md-cm" ref={hostRef} />
      {fence && fence.code.trim() && hiddenFence !== fence.from && (
        <LivePreview fence={fence} theme={theme} onClose={() => setHiddenFence(fence.from)} />
      )}
      {!onStats && <div className="md-editor-status">
        <span>Ln {stats.line}, Col {stats.col}</span>
        {stats.sel > 0 && <span>{stats.sel} selected</span>}
        <span>{stats.words.toLocaleString()} words</span>
        <span className="md-editor-hint">Type <kbd>/</kbd> for blocks &amp; diagrams</span>
      </div>}
    </div>
  );
}
