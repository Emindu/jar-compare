import { useEffect, useRef, useState } from 'react';
import { ChevronDown } from 'lucide-react';
import MarkdownViewer, { type DocStats } from './Markdown';
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

export interface MdStatus {
  name: string;
  /** Changed since it was opened or last saved as .md. */
  dirty: boolean;
  saved: 'saved' | 'saving' | 'off';
  stats: DocStats | null;
}
export interface MdActions { save: () => void; exportHtml: () => void }

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

export default function MarkdownWorkspace({
  theme, incoming, onOpen, onStatus, actionsRef,
}: {
  theme: 'light' | 'dark';
  /** A document handed over from elsewhere (e.g. dropped on Home); remount to open another. */
  incoming?: Doc | null;
  /** Called when a file is opened, so it can be listed as recent. */
  onOpen?: (name: string) => void;
  /** Name, save state and stats, for the title and status bars. */
  onStatus?: (s: MdStatus) => void;
  /** Receives Save .md / Export HTML for the title bar. */
  actionsRef?: { current: MdActions | null };
}) {
  const [doc, setDoc] = useState<Doc>(() =>
    incoming ? { name: incoming.name, text: incoming.text } : loadDraft() ?? { name: SAMPLES[0].name, text: SAMPLES[0].text });
  const [docKey, setDocKey] = useState(0); // bumps when a different document is opened
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  const [saved, setSaved] = useState<'saved' | 'saving' | 'off'>('saved');
  const [baseline, setBaseline] = useState(doc.text);
  const [stats, setStats] = useState<DocStats | null>(null);
  const exportHtml = useRef<(() => void) | null>(null);
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

  const dirty = doc.text !== baseline;
  useEffect(() => { onStatus?.({ name: doc.name, dirty, saved, stats }); }, [onStatus, doc.name, dirty, saved, stats]);

  // Save .md downloads the document; Ctrl/⌘S does the same.
  useEffect(() => {
    const save = () => {
      const url = URL.createObjectURL(new Blob([doc.text], { type: 'text/markdown' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = doc.name;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setBaseline(doc.text);
    };
    if (actionsRef) actionsRef.current = { save, exportHtml: () => exportHtml.current?.() };
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      if (actionsRef) actionsRef.current = null;
    };
  }, [actionsRef, doc]);

  const open = (next: Doc) => {
    update(next);
    setBaseline(next.text);
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
    onOpen?.(f.name);
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
      <span className="md-docbar-sep" />
      <button className="wb-btn" onClick={newDoc}>New</button>
      <button className="wb-btn" onClick={() => fileRef.current?.click()}>Open…</button>
      <span className="dg-export">
        <button className="wb-btn" onClick={() => setSamplesOpen((v) => !v)} aria-expanded={samplesOpen}>Samples <ChevronDown size={13} aria-hidden /></button>
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
        onStats={setStats}
        exportRef={exportHtml}
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
