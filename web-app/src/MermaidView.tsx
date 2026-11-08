// The Diagram tool: a Mermaid-only editor. Paste ( or write ) mermaid code on
// the left, see the drawing live on the right — and every visual editor built
// for the Markdown workspace works here too: edit the drawing by hand, and
// the changes are written back into the code.

import { useEffect, useMemo, useRef, useState } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { FileDown, FolderOpen, RotateCcw } from 'lucide-react';
import { DiagramEdit, type DiagramEditApi } from './diagramLinks';
import { MermaidBlock } from './Diagram';
import type { Theme } from './mermaidSource';

const STARTER = `flowchart TD
    Start[Paste your Mermaid code here] --> Check{Looks right?}
    Check -->|yes| Edit[Click Edit — then drag, rename and connect by hand]
    Check -->|no| Fix[Edit the code on the left]
`;

const DRAFT_KEY = 'jar-compare.mermaid-draft';

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '0.82rem', backgroundColor: 'transparent' },
  '.cm-scroller': { fontFamily: 'var(--font-mono)', lineHeight: '1.6' },
  '.cm-content': { padding: '10px 4px 40vh 0', caretColor: 'var(--accent)' },
  '.cm-gutters': { backgroundColor: 'transparent', border: 'none', color: 'var(--text-faint)' },
  '.cm-activeLine': { backgroundColor: 'color-mix(in srgb, var(--raised) 55%, transparent)' },
  '.cm-activeLineGutter': { backgroundColor: 'transparent', color: 'var(--text-muted)' },
  '&.cm-focused': { outline: 'none' },
});

type Layout = 'split' | 'code' | 'preview';

export default function MermaidView({ theme, incoming }: {
  theme: Theme;
  incoming: { id: number; name: string; text: string } | null;
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(incoming?.name ?? 'diagram.mmd');
  const [layout, setLayout] = useState<Layout>('split');
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const [code, setCode] = useState('');
  const [, setDirty] = useState(false);

  // The code editor keeps the single source of truth; React mirrors it for re-render.
  useEffect(() => {
    if (!hostRef.current) return;
    const initial = incoming?.text ?? (() => { try { return localStorage.getItem(DRAFT_KEY) ?? STARTER; } catch { return STARTER; } })();
    const view = new EditorView({
      state: EditorState.create({
        doc: initial,
        extensions: [
          lineNumbers(),
          history(),
          keymap.of([...defaultKeymap, ...historyKeymap]),
          editorTheme,
          EditorView.lineWrapping,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              setCode(u.state.doc.toString());
              setDirty(true);
            }
          }),
        ],
      }),
      parent: hostRef.current,
    });
    viewRef.current = view;
    setCode(view.state.doc.toString());
    return () => { view.destroy(); viewRef.current = null; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The draft survives reloads, like the Markdown one.
  useEffect(() => {
    const t = setTimeout(() => { try { localStorage.setItem(DRAFT_KEY, code); } catch { /* storage unavailable */ } }, 400);
    return () => clearTimeout(t);
  }, [code]);

  const readFile = async (file: File) => {
    const text = await file.text();
    setName(file.name);
    viewRef.current?.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: text } });
  };

  const saveFile = () => {
    const text = viewRef.current?.state.doc.toString() ?? code;
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
    a.download = name.replace(/\.[^.]*$/, '') + '.mmd';
    a.click();
    URL.revokeObjectURL(a.href);
    setDirty(false);
  };

  const newDiagram = () => {
    viewRef.current?.dispatch({ changes: { from: 0, to: viewRef.current.state.doc.length, insert: STARTER } });
    setName('diagram.mmd');
    setDirty(false);
  };

  // Saving a visual edit writes the whole new source back through the editor.
  const diagramEdit = useMemo<DiagramEditApi>(() => ({
    replace: (oldCode, newCode) => {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() !== oldCode) return false;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: newCode } });
      return true;
    },
  }), []);

  return (
    <DiagramEdit.Provider value={diagramEdit}>
      <div className="mm">
        <header className="mm-bar">
          <span className="mm-name" title={name}>{name}</span>
          <span className="mm-actions">
            <button className="wb-btn" onClick={() => fileRef.current?.click()}><FolderOpen size={13} /> Open…</button>
            <button className="wb-btn" onClick={saveFile}><FileDown size={13} /> Save .mmd</button>
            <button className="wb-btn" onClick={newDiagram}><RotateCcw size={13} /> New</button>
          </span>
          <span className="mm-seg" role="group" aria-label="Layout">
            {(['code', 'split', 'preview'] as Layout[]).map((l) => (
              <button key={l} className={layout === l ? 'is-on' : ''} onClick={() => setLayout(l)} aria-pressed={layout === l}>
                {l === 'code' ? 'Code' : l === 'split' ? 'Split' : 'Preview'}
              </button>
            ))}
          </span>
        </header>
        <div className={`mm-body is-${layout}`}>
          <section className="mm-code" aria-label="Mermaid source">
            <div ref={hostRef} className="mm-ed" />
            <input ref={fileRef} type="file" accept=".mmd,.mermaid,.txt,.md" hidden onChange={(e) => { if (e.target.files?.[0]) void readFile(e.target.files[0]); e.target.value = ''; }} />
          </section>
          <section className="mm-view" aria-label="Diagram">
            {code.trim() ? <MermaidBlock code={code} theme={theme} name={name} /> : <p className="mm-empty">Paste mermaid code to see the drawing.</p>}
          </section>
        </div>
      </div>
    </DiagramEdit.Provider>
  );
}
