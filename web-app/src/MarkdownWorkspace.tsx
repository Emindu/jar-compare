import { useEffect, useRef, useState } from 'react';
import MarkdownViewer from './Markdown';
import welcomeMd from './samples/welcome.md?raw';
import ohlcMd from './samples/ohlc-architecture.md?raw';
import galleryMd from './samples/mermaid-gallery.md?raw';

// The Markdown tab: a document workspace around the viewer/editor. It owns the
// current document (name + text), restores the last draft from this browser,
// and handles New / Open / Samples and dropping a file anywhere on the page.

const SAMPLES = [
  { name: 'welcome.md', title: 'Welcome guide', text: welcomeMd },
  { name: 'ohlc-architecture.md', title: 'Architecture doc (OHLC history)', text: ohlcMd },
  { name: 'mermaid-gallery.md', title: 'Mermaid diagram gallery', text: galleryMd },
];

const DRAFT_KEY = 'jar-compare.md-draft';

interface Doc { name: string; text: string }

/** The last draft from this browser, if any (storage can be unavailable). */
function loadDraft(): Doc | null {
  try {
    const raw = localStorage.getItem(DRAFT_KEY);
    const d = raw ? (JSON.parse(raw) as Doc) : null;
    return d && typeof d.text === 'string' && typeof d.name === 'string' ? d : null;
  } catch {
    return null;
  }
}

function saveDraft(doc: Doc): boolean {
  try {
    localStorage.setItem(DRAFT_KEY, JSON.stringify(doc));
    return true;
  } catch {
    return false;
  }
}

const withExt = (name: string) => {
  const n = name.trim() || 'Untitled';
  return /\.(md|markdown|mdx|txt)$/i.test(n) ? n : `${n}.md`;
};

export default function MarkdownWorkspace({ theme }: { theme: 'light' | 'dark' }) {
  const [doc, setDoc] = useState<Doc>(() => loadDraft() ?? { name: SAMPLES[0].name, text: SAMPLES[0].text });
  const [docKey, setDocKey] = useState(0); // bumps when a different document is opened
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'off'>('saved');
  const [samplesOpen, setSamplesOpen] = useState(false);
  const [dragging, setDragging] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  // Autosave (debounced) to this browser.
  useEffect(() => {
    const t = setTimeout(() => setSaved(saveDraft(doc) ? 'saved' : 'off'), 400);
    return () => clearTimeout(t);
  }, [doc]);

  const update = (next: Doc) => { setSaved('saving'); setDoc(next); };

  const open = (next: Doc) => {
    update(next);
    setDocKey((k) => k + 1);
    setSamplesOpen(false);
  };

  const newDoc = () => {
    if (doc.text.trim() && !SAMPLES.some((s) => s.text === doc.text)
      && !window.confirm('Start a new document? The current draft will be replaced (download it first to keep a copy).')) return;
    open({ name: 'Untitled.md', text: '# Untitled\n\n' });
  };

  const openFile = async (f: File | null | undefined) => {
    if (!f) return;
    open({ name: f.name, text: await f.text() });
  };

  const commitName = () => {
    if (nameDraft !== null) update({ ...doc, name: withExt(nameDraft) });
    setNameDraft(null);
  };

  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  const controls = (
    <>
      <input
        className="md-doc-name"
        value={nameDraft ?? doc.name}
        onChange={(e) => setNameDraft(e.target.value)}
        onFocus={(e) => e.target.select()}
        onBlur={commitName}
        onKeyDown={(e) => {
          if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
          if (e.key === 'Escape') { setNameDraft(null); (e.target as HTMLInputElement).blur(); }
        }}
        spellCheck={false}
        aria-label="Document name"
        title="Rename"
        size={Math.max(8, (nameDraft ?? doc.name).length)}
      />
      <span className={`md-save md-save-${saved}`} title={saved === 'off' ? 'This browser blocks storage; download to keep your work' : 'Drafts are kept in this browser only'}>
        {saved === 'saved' ? 'Saved in this browser' : saved === 'saving' ? 'Saving…' : 'Not saved'}
      </span>
      <span className="md-docbar-sep" />
      <button className="file-action-btn" onClick={newDoc}>New</button>
      <button className="file-action-btn" onClick={() => fileRef.current?.click()}>Open…</button>
      <span className="dg-export">
        <button className="file-action-btn" onClick={() => setSamplesOpen((v) => !v)} aria-expanded={samplesOpen}>Samples ▾</button>
        {samplesOpen && (
          <span className="dg-menu md-samples-menu" onMouseLeave={() => setSamplesOpen(false)}>
            {SAMPLES.map((s) => (
              <button key={s.name} onClick={() => open({ name: s.name, text: s.text })}>{s.title}</button>
            ))}
          </span>
        )}
      </span>
      <input
        ref={fileRef}
        type="file"
        accept=".md,.markdown,.mdx,.txt,text/markdown"
        hidden
        onChange={(e) => { openFile(e.target.files?.[0]); e.target.value = ''; }}
      />
    </>
  );

  return (
    <div
      className="md-workspace"
      onDragEnter={(e) => { if (hasFiles(e)) { dragDepth.current++; setDragging(true); } }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={() => { if (--dragDepth.current <= 0) { dragDepth.current = 0; setDragging(false); } }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        openFile(e.dataTransfer.files?.[0]);
      }}
    >
      <MarkdownViewer
        key={docKey}
        text={doc.text}
        name={doc.name}
        theme={theme}
        onChange={(text) => update({ ...doc, text })}
        docControls={controls}
      />
      {dragging && (
        <div className="md-drop-overlay">
          <div className="md-drop-card">
            <strong>Drop to open</strong>
            <small>.md, .markdown or .txt</small>
          </div>
        </div>
      )}
    </div>
  );
}
