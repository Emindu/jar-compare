import { lazy, Suspense, useEffect, useMemo, useRef, useState } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { MdEditorHandle } from './MdEditor';
import { MermaidBlock } from './Diagram';
import { DiagramLinks, type DiagramEntry, type DiagramLinkApi } from './diagramLinks';

type Theme = 'light' | 'dark';

// CodeMirror is sizeable; only load it when the editor is opened.
const MdEditor = lazy(() => import('./MdEditor'));

// Markdown results view: an outline of the document's sections (left) and the
// rendered document (right). The document is split into a tree of sections by
// heading, each section can be collapsed, and ```mermaid fences are rendered as
// diagrams (mermaid is loaded lazily, only when a document contains one).

interface MdSection {
  id: string;
  depth: number;
  title: string; // plain text
  titleHtml: string; // inline-rendered heading
  body: Token[]; // tokens up to the first child heading
  children: MdSection[];
  diagrams: number; // mermaid blocks directly in this section
}

// ── Parsing ────────────────────────────────────────────────────────────────

function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s-]/gu, '')
    .replace(/\s+/g, '-');
}

function plainText(html: string): string {
  const d = document.createElement('div');
  d.innerHTML = DOMPurify.sanitize(html);
  return d.textContent || '';
}

function isMermaid(t: Token): t is Tokens.Code {
  return t.type === 'code' && /^mermaid\b/i.test((t as Tokens.Code).lang || '');
}

/** Split markdown into a section tree. Content before the first heading goes in a root "preamble" section. */
function parseSections(md: string): { root: MdSection; flat: MdSection[] } {
  const tokens = marked.lexer(md, { gfm: true });
  const root: MdSection = { id: '', depth: 0, title: '', titleHtml: '', body: [], children: [], diagrams: 0 };
  const flat: MdSection[] = [];
  const stack: MdSection[] = [root];
  const used = new Map<string, number>();

  for (const t of tokens) {
    if (t.type === 'heading') {
      const h = t as Tokens.Heading;
      const titleHtml = DOMPurify.sanitize(marked.parseInline(h.text, { gfm: true }) as string);
      const title = plainText(titleHtml);
      let id = slugify(title) || 'section';
      const n = used.get(id) ?? 0;
      used.set(id, n + 1);
      if (n > 0) id = `${id}-${n}`;
      const sec: MdSection = { id, depth: h.depth, title, titleHtml, body: [], children: [], diagrams: 0 };
      while (stack.length > 1 && stack[stack.length - 1].depth >= h.depth) stack.pop();
      stack[stack.length - 1].children.push(sec);
      stack.push(sec);
      flat.push(sec);
    } else {
      const cur = stack[stack.length - 1];
      cur.body.push(t);
      if (isMermaid(t)) cur.diagrams++;
    }
  }
  return { root, flat };
}

function countDiagrams(s: MdSection): number {
  return s.children.reduce((a, c) => a + countDiagrams(c), s.diagrams);
}

// ── Body rendering ─────────────────────────────────────────────────────────

const LANG_ALIAS: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', js: 'javascript', ts: 'javascript', typescript: 'javascript',
  xml: 'markup', html: 'markup', yml: 'yaml', kt: 'kotlin',
};

function Body({ tokens, theme, name }: { tokens: Token[]; theme: Theme; name: string }) {
  // Group consecutive non-code tokens into one HTML chunk; code fences become components.
  const parts = useMemo(() => {
    const out: ({ kind: 'html'; html: { __html: string } } | { kind: 'mermaid' | 'code'; code: string; lang: string })[] = [];
    let run: Token[] = [];
    const flush = () => {
      if (!run.length) return;
      const list = Object.assign([...run], { links: {} }) as Token[] & { links: Record<string, never> };
      // Stable objects so re-renders don't reset innerHTML (and the link marks on `code`).
      out.push({ kind: 'html', html: { __html: DOMPurify.sanitize(marked.parser(list, { gfm: true })) } });
      run = [];
    };
    for (const t of tokens) {
      if (t.type === 'code') {
        flush();
        const c = t as Tokens.Code;
        const lang = (c.lang || '').split(/\s/)[0].toLowerCase();
        out.push({ kind: isMermaid(t) ? 'mermaid' : 'code', code: c.text, lang: LANG_ALIAS[lang] || lang });
      } else if (t.type !== 'space') {
        run.push(t);
      }
    }
    flush();
    return out;
  }, [tokens]);

  return (
    <>
      {parts.map((p, i) =>
        p.kind === 'html' ? (
          <div key={i} className="md-html" dangerouslySetInnerHTML={p.html} />
        ) : p.kind === 'mermaid' ? (
          <MermaidBlock key={i} code={p.code} theme={theme} name={`${name}-diagram-${i + 1}`} />
        ) : (
          <div key={i} className="md-code">
            {p.lang && <span className="md-code-lang">{p.lang}</span>}
            <SyntaxHighlighter
              language={p.lang || 'text'}
              style={theme === 'dark' ? oneDark : oneLight}
              customStyle={{ margin: 0, background: 'transparent', padding: '0.85rem 1rem', fontSize: '0.82rem' }}
              codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
            >
              {p.code}
            </SyntaxHighlighter>
          </div>
        ),
      )}
    </>
  );
}

function Section({
  sec, theme, collapsed, toggle,
}: {
  sec: MdSection;
  theme: Theme;
  collapsed: Set<string>;
  toggle: (id: string) => void;
}) {
  const isCollapsed = collapsed.has(sec.id);
  const level = Math.min(Math.max(sec.depth, 1), 6);
  const H = `h${level}` as 'h1';
  const diagrams = countDiagrams(sec);
  return (
    <section className={`md-section md-depth-${level}${isCollapsed ? ' collapsed' : ''}`} data-sec={sec.id}>
      <H id={sec.id} className="md-heading">
        <button className="md-caret" onClick={() => toggle(sec.id)} title={isCollapsed ? 'Expand section' : 'Collapse section'}>
          {isCollapsed ? '▸' : '▾'}
        </button>
        <span dangerouslySetInnerHTML={{ __html: sec.titleHtml }} />
        <a className="md-anchor" href={`#${sec.id}`} aria-label="Link to section">#</a>
        {isCollapsed && (diagrams > 0 || sec.children.length > 0) && (
          <span className="md-collapsed-hint">
            {sec.children.length > 0 && `${sec.children.length} subsection${sec.children.length > 1 ? 's' : ''}`}
            {sec.children.length > 0 && diagrams > 0 && ' · '}
            {diagrams > 0 && `${diagrams} diagram${diagrams > 1 ? 's' : ''}`}
          </span>
        )}
      </H>
      {!isCollapsed && (
        <div className="md-section-body">
          <Body tokens={sec.body} theme={theme} name={sec.id} />
          {sec.children.map((c) => (
            <Section key={c.id} sec={c} theme={theme} collapsed={collapsed} toggle={toggle} />
          ))}
        </div>
      )}
    </section>
  );
}

// ── Viewer ─────────────────────────────────────────────────────────────────

export default function MarkdownViewer({
  text, theme, onChange,
}: {
  text: string;
  theme: Theme;
  onChange: (t: string) => void;
}) {
  const { root, flat } = useMemo(() => parseSections(text), [text]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [active, setActive] = useState('');
  const [filter, setFilter] = useState('');
  const [view, setView] = useState<'preview' | 'split' | 'editor'>('preview');
  const editing = view !== 'preview';
  const showPreview = view !== 'editor';
  const editorRef = useRef<MdEditorHandle>(null);

  // Links between `code` mentions in the text and items in rendered diagrams.
  const registry = useRef(new Set<DiagramEntry>());
  const [regVersion, setRegVersion] = useState(0);
  const [activeSel, setActiveSel] = useState<{ entry: DiagramEntry; key: string } | null>(null);
  const xrefs = useRef(new WeakMap<Element, { entry: DiagramEntry; keys: string[] }[]>());
  const links = useMemo<DiagramLinkApi>(() => ({
    register: (e) => {
      registry.current.add(e);
      setRegVersion((v) => v + 1);
      return () => { registry.current.delete(e); setRegVersion((v) => v + 1); };
    },
    onSelect: (e, key) => setActiveSel((prev) => (key ? { entry: e, key } : prev?.entry === e ? null : prev)),
  }), []);
  const docRef = useRef<HTMLDivElement>(null);

  const totalDiagrams = useMemo(() => countDiagrams(root), [root]);
  const words = useMemo(() => (text.match(/\S+/g) || []).length, [text]);

  const toggle = (id: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });

  // Track the section at the top of the viewport for outline highlighting.
  useEffect(() => {
    const el = docRef.current;
    if (!el) return;
    const onScroll = () => {
      const top = el.getBoundingClientRect().top + 24;
      let cur = '';
      for (const h of el.querySelectorAll<HTMLElement>('.md-heading')) {
        if (h.getBoundingClientRect().top <= top) cur = h.id; else break;
      }
      setActive(cur);
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, [flat, collapsed, view]);

  // Mark inline `code` that names something drawn in a diagram.
  useEffect(() => {
    const doc = docRef.current;
    if (!doc) return;
    const entries = [...registry.current];
    doc.querySelectorAll('.md-html code').forEach((c) => {
      if (c.closest('pre')) return;
      const text = c.textContent || '';
      const matches = entries.map((entry) => ({ entry, keys: entry.find(text) })).filter((m) => m.keys.length);
      c.classList.toggle('md-xref', matches.length > 0);
      c.classList.toggle('md-xref-active', !!activeSel && matches.some((m) => m.entry === activeSel.entry && m.keys.includes(activeSel.key)));
      if (matches.length) {
        xrefs.current.set(c, matches);
        c.setAttribute('title', 'Shown in a diagram · hover to highlight, click to locate');
      } else {
        xrefs.current.delete(c);
        c.removeAttribute('title');
      }
    });
  }, [regVersion, root, collapsed, view, activeSel]);

  const xrefAt = (t: EventTarget) => {
    const c = (t as Element).closest?.('code.md-xref');
    return c ? xrefs.current.get(c) ?? null : null;
  };
  const onDocOver = (e: React.MouseEvent) => xrefAt(e.target)?.forEach((m) => m.entry.preview(m.keys));
  const onDocOut = (e: React.MouseEvent) => xrefAt(e.target)?.forEach((m) => m.entry.preview(null));

  const goTo = (id: string, fromEditor = false) => {
    // Expand any collapsed ancestor so the target is visible.
    const idx = flat.findIndex((s) => s.id === id);
    if (idx < 0) return;
    const chain: string[] = [];
    let depth = flat[idx].depth;
    for (let i = idx - 1; i >= 0; i--) {
      if (flat[i].depth < depth) { chain.push(flat[i].id); depth = flat[i].depth; }
    }
    if (chain.some((c) => collapsed.has(c)) || collapsed.has(id)) {
      setCollapsed((prev) => {
        const next = new Set(prev);
        chain.forEach((c) => next.delete(c));
        return next;
      });
    }
    if (!fromEditor) editorRef.current?.revealHeading(idx);
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // Editor cursor moved into another section → follow it in the preview.
  const onEditorHeading = (idx: number) => {
    if (idx >= 0 && flat[idx]) goTo(flat[idx].id, true);
    else docRef.current?.scrollTo({ top: 0, behavior: 'smooth' });
  };

  // In-document anchor links scroll inside the viewer instead of changing the URL.
  const onDocClick = (e: React.MouseEvent) => {
    const xref = xrefAt(e.target);
    if (xref) {
      const { entry, keys } = xref[0];
      entry.select(keys[0]);
      entry.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      entry.el.classList.remove('md-diagram-flash');
      void entry.el.offsetWidth; // restart the animation
      entry.el.classList.add('md-diagram-flash');
      return;
    }
    const a = (e.target as HTMLElement).closest('a');
    const href = a?.getAttribute('href');
    if (a && href?.startsWith('#')) {
      e.preventDefault();
      goTo(decodeURIComponent(href.slice(1)));
    } else if (a && href) {
      a.setAttribute('target', '_blank');
      a.setAttribute('rel', 'noopener noreferrer');
    }
  };

  const q = filter.trim().toLowerCase();
  const outline = q ? flat.filter((s) => s.title.toLowerCase().includes(q)) : flat;
  const minDepth = flat.reduce((m, s) => Math.min(m, s.depth), 6);

  const download = () => {
    const blob = new Blob([text], { type: 'text/markdown' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${slugify(flat[0]?.title || 'document') || 'document'}.md`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="stats-bar">
        <span className="stats-total">{flat.length} sections</span>
        <span className="stat stat-added">{totalDiagrams} diagrams</span>
        <span className="stat stat-nested">{words.toLocaleString()} words</span>
        <span className="stat stat-modified">{text.split('\n').length} lines</span>
      </div>

      <div className="workspace">
        <aside className="file-panel md-outline-panel">
          <div className="file-panel-hd">Outline</div>
          <div className="md-outline-tools">
            <input
              className="flame-search md-outline-filter"
              placeholder="Filter sections…"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              spellCheck={false}
            />
            <button className="file-action-btn" onClick={() => setCollapsed(new Set())} title="Expand all">⊞</button>
            <button
              className="file-action-btn"
              onClick={() => setCollapsed(new Set(flat.filter((s) => s.children.length || s.body.length).map((s) => s.id)))}
              title="Collapse all"
            >⊟</button>
          </div>
          <div className="file-list">
            {outline.length === 0 && <div className="md-outline-empty">No headings</div>}
            {outline.map((s) => (
              <button
                key={s.id}
                className={`md-outline-row${active === s.id ? ' selected' : ''}${collapsed.has(s.id) ? ' is-collapsed' : ''}`}
                style={{ paddingLeft: `${0.8 + (s.depth - minDepth) * 0.85}rem` }}
                onClick={() => goTo(s.id)}
                title={s.title}
              >
                <span className="md-outline-title">{s.title}</span>
                {s.diagrams > 0 && <span className="md-outline-badge" title="Diagrams">◇{s.diagrams > 1 ? s.diagrams : ''}</span>}
              </button>
            ))}
          </div>
          <div className="panel-hints">
            <span>Click a heading’s ▾ to collapse a section</span>
            <span>Diagrams: click a node to trace it · double-click to zoom</span>
            <span>Underlined <code>code</code> is in a diagram: hover or click it</span>
          </div>
        </aside>

        <div className="diff-panel">
          <div className="diff-panel-hd">
            <span className="diff-crumb">{flat.find((s) => s.id === active)?.title || flat[0]?.title || 'Document'}</span>
            <div className="file-actions">
              <div className="md-view-switch" role="group" aria-label="View">
                {(['preview', 'split', 'editor'] as const).map((v) => (
                  <button key={v} className={`file-action-btn${view === v ? ' active' : ''}`} onClick={() => setView(v)}>
                    {v === 'preview' ? '👁 Preview' : v === 'split' ? '◫ Split' : '✎ Editor'}
                  </button>
                ))}
              </div>
              <button className="file-action-btn" onClick={download}>⇣ .md</button>
              <button className="file-action-btn" onClick={() => window.print()}>⎙ Print</button>
            </div>
          </div>
          <div className={`md-split md-view-${view}`}>
            {editing && (
              <Suspense fallback={<div className="md-editor md-diagram-loading">Loading editor…</div>}>
                <MdEditor ref={editorRef} value={text} onChange={onChange} onHeading={onEditorHeading} />
              </Suspense>
            )}
            {showPreview && <div className="diff-body md-doc-scroll" ref={docRef} onClick={onDocClick} onMouseOver={onDocOver} onMouseOut={onDocOut}>
              <DiagramLinks.Provider value={links}>
              <article className="md-doc">
                <Body tokens={root.body} theme={theme} name="document" />
                {root.children.map((c) => (
                  <Section key={c.id} sec={c} theme={theme} collapsed={collapsed} toggle={toggle} />
                ))}
              </article>
              </DiagramLinks.Provider>
            </div>}
          </div>
        </div>
      </div>

    </>
  );
}
