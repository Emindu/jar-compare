import { useEffect, useMemo, useRef, useState } from 'react';
import { marked, type Token, type Tokens } from 'marked';
import DOMPurify from 'dompurify';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

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

type Theme = 'light' | 'dark';

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

// ── Mermaid ────────────────────────────────────────────────────────────────

type MermaidApi = typeof import('mermaid').default;
let mermaidPromise: Promise<MermaidApi> | null = null;
let mermaidTheme: Theme | null = null;
let renderQueue: Promise<unknown> = Promise.resolve();
let renderSeq = 0;

function loadMermaid(): Promise<MermaidApi> {
  if (!mermaidPromise) mermaidPromise = import('mermaid').then((m) => m.default);
  return mermaidPromise;
}

/** Renders serially: mermaid keeps global state and doesn't like concurrent renders. */
function renderMermaid(src: string, theme: Theme): Promise<string> {
  const job = renderQueue.then(async () => {
    const mermaid = await loadMermaid();
    if (mermaidTheme !== theme) {
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: 'strict',
        theme: theme === 'dark' ? 'dark' : 'default',
        fontFamily: 'var(--font-sans)',
      });
      mermaidTheme = theme;
    }
    const { svg } = await mermaid.render(`mmd-${++renderSeq}`, src);
    return svg;
  });
  renderQueue = job.catch(() => undefined);
  return job;
}

function MermaidBlock({ code, theme, onExpand }: { code: string; theme: Theme; onExpand: (svg: string) => void }) {
  const [svg, setSvg] = useState('');
  const [error, setError] = useState('');
  const [showSource, setShowSource] = useState(false);

  useEffect(() => {
    let alive = true;
    renderMermaid(code, theme)
      .then((s) => { if (alive) { setSvg(s); setError(''); } })
      .catch((e) => { if (alive) { setSvg(''); setError(String(e?.message || e)); } });
    return () => { alive = false; };
  }, [code, theme]);

  return (
    <figure className="md-diagram">
      <div className="md-diagram-bar">
        <span className="md-diagram-kind">◇ {code.trim().split(/\s/)[0] || 'diagram'}</span>
        <span className="md-diagram-actions">
          <button className="file-action-btn" onClick={() => setShowSource((v) => !v)}>
            {showSource ? 'Diagram' : 'Source'}
          </button>
          <button className="file-action-btn" onClick={() => navigator.clipboard?.writeText(code)}>Copy</button>
          {svg && <button className="file-action-btn" onClick={() => onExpand(svg)}>⤢ Expand</button>}
        </span>
      </div>
      {showSource ? (
        <pre className="md-diagram-src">{code}</pre>
      ) : error ? (
        <div className="md-diagram-error">
          <strong>Diagram error</strong>
          <pre>{error}</pre>
        </div>
      ) : svg ? (
        <div className="md-diagram-svg" onDoubleClick={() => onExpand(svg)} dangerouslySetInnerHTML={{ __html: svg }} />
      ) : (
        <div className="md-diagram-loading">Rendering diagram…</div>
      )}
    </figure>
  );
}

function DiagramModal({ svg, onClose }: { svg: string; onClose: () => void }) {
  // Open at fit-to-width, but never so small that labels become unreadable.
  const [zoom, setZoom] = useState(() => {
    const m = /viewBox="[\d.-]+ [\d.-]+ ([\d.]+)/.exec(svg);
    const w = m ? parseFloat(m[1]) : 0;
    return w ? Math.max(0.5, Math.min(1, (window.innerWidth * 0.94 - 96) / w)) : 1;
  });
  const hostRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; l: number; t: number } | null>(null);

  const fitZoom = () => {
    const vb = hostRef.current?.querySelector('svg')?.viewBox?.baseVal;
    const avail = (bodyRef.current?.clientWidth ?? 0) - 48;
    return vb?.width && avail > 0 ? Math.min(1, avail / vb.width) : 1;
  };

  // Mermaid emits width="100%" + a max-width style, so it always shrinks to fit.
  // Size it from its viewBox instead so 100% means the diagram's natural size.
  useEffect(() => {
    const el = hostRef.current?.querySelector('svg');
    const vb = el?.viewBox?.baseVal;
    if (!el || !vb || !vb.width) return;
    el.style.maxWidth = 'none';
    el.setAttribute('width', String(vb.width * zoom));
    el.setAttribute('height', String(vb.height * zoom));
  }, [svg, zoom]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="qo-overlay md-modal-overlay" onClick={onClose}>
      <div className="md-modal" onClick={(e) => e.stopPropagation()}>
        <div className="md-diagram-bar">
          <span className="md-diagram-kind">{Math.round(zoom * 100)}%</span>
          <span className="md-diagram-actions">
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.max(0.25, z / 1.25))}>−</button>
            <button className="file-action-btn" onClick={() => setZoom(fitZoom())}>Fit</button>
            <button className="file-action-btn" onClick={() => setZoom(1)}>100%</button>
            <button className="file-action-btn" onClick={() => setZoom((z) => Math.min(6, z * 1.25))}>+</button>
            <button className="file-action-btn" onClick={onClose}>✕ Close</button>
          </span>
        </div>
        <div
          className="md-modal-body"
          ref={bodyRef}
          onMouseDown={(e) => {
            const b = bodyRef.current;
            if (b) drag.current = { x: e.clientX, y: e.clientY, l: b.scrollLeft, t: b.scrollTop };
          }}
          onMouseMove={(e) => {
            const b = bodyRef.current, d = drag.current;
            if (!b || !d) return;
            b.scrollLeft = d.l - (e.clientX - d.x);
            b.scrollTop = d.t - (e.clientY - d.y);
          }}
          onMouseUp={() => { drag.current = null; }}
          onMouseLeave={() => { drag.current = null; }}
          onWheel={(e) => {
            if (!e.ctrlKey && !e.metaKey) return;
            e.preventDefault();
            setZoom((z) => Math.min(6, Math.max(0.25, z * (e.deltaY < 0 ? 1.1 : 1 / 1.1))));
          }}
        >
          <div className="md-modal-svg" ref={hostRef} dangerouslySetInnerHTML={{ __html: svg }} />
        </div>
      </div>
    </div>
  );
}

// ── Body rendering ─────────────────────────────────────────────────────────

const LANG_ALIAS: Record<string, string> = {
  sh: 'bash', shell: 'bash', zsh: 'bash', js: 'javascript', ts: 'javascript', typescript: 'javascript',
  xml: 'markup', html: 'markup', yml: 'yaml', kt: 'kotlin',
};

function Body({ tokens, theme, onExpand }: { tokens: Token[]; theme: Theme; onExpand: (svg: string) => void }) {
  // Group consecutive non-code tokens into one HTML chunk; code fences become components.
  const parts = useMemo(() => {
    const out: ({ kind: 'html'; html: string } | { kind: 'mermaid' | 'code'; code: string; lang: string })[] = [];
    let run: Token[] = [];
    const flush = () => {
      if (!run.length) return;
      const list = Object.assign([...run], { links: {} }) as Token[] & { links: Record<string, never> };
      out.push({ kind: 'html', html: DOMPurify.sanitize(marked.parser(list, { gfm: true })) });
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
          <div key={i} className="md-html" dangerouslySetInnerHTML={{ __html: p.html }} />
        ) : p.kind === 'mermaid' ? (
          <MermaidBlock key={i} code={p.code} theme={theme} onExpand={onExpand} />
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
  sec, theme, collapsed, toggle, onExpand,
}: {
  sec: MdSection;
  theme: Theme;
  collapsed: Set<string>;
  toggle: (id: string) => void;
  onExpand: (svg: string) => void;
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
          <Body tokens={sec.body} theme={theme} onExpand={onExpand} />
          {sec.children.map((c) => (
            <Section key={c.id} sec={c} theme={theme} collapsed={collapsed} toggle={toggle} onExpand={onExpand} />
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
  const [editing, setEditing] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
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
  }, [flat, collapsed, editing]);

  const goTo = (id: string) => {
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
    requestAnimationFrame(() => {
      document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  // In-document anchor links scroll inside the viewer instead of changing the URL.
  const onDocClick = (e: React.MouseEvent) => {
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
            <span>Diagrams: <strong>Expand</strong> or double-click to zoom</span>
          </div>
        </aside>

        <div className="diff-panel">
          <div className="diff-panel-hd">
            <span className="diff-crumb">{flat.find((s) => s.id === active)?.title || flat[0]?.title || 'Document'}</span>
            <div className="file-actions">
              <button className={`file-action-btn${editing ? ' active' : ''}`} onClick={() => setEditing((v) => !v)}>
                {editing ? '✓ Done editing' : '✎ Edit'}
              </button>
              <button className="file-action-btn" onClick={download}>⇣ .md</button>
              <button className="file-action-btn" onClick={() => window.print()}>⎙ Print</button>
            </div>
          </div>
          <div className={`md-split${editing ? ' editing' : ''}`}>
            {editing && (
              <textarea
                className="md-editor"
                value={text}
                onChange={(e) => onChange(e.target.value)}
                spellCheck={false}
              />
            )}
            <div className="diff-body md-doc-scroll" ref={docRef} onClick={onDocClick}>
              <article className="md-doc">
                <Body tokens={root.body} theme={theme} onExpand={setExpanded} />
                {root.children.map((c) => (
                  <Section key={c.id} sec={c} theme={theme} collapsed={collapsed} toggle={toggle} onExpand={setExpanded} />
                ))}
              </article>
            </div>
          </div>
        </div>
      </div>

      {expanded && <DiagramModal key={expanded} svg={expanded} onClose={() => setExpanded(null)} />}
    </>
  );
}
