import { useRef, useState } from 'react';
import { ArrowUpToLine } from 'lucide-react';
import { TOOLS, MOD, type Tool, type JvmState } from './shell';
import { timeAgo, type RecentItem, type RecentKind } from './recent';

// The Home launcher: drop files anywhere to route them to the right tool by
// extension, pick a tool, see what you opened recently (names only), the
// keyboard shortcuts, and the state of the in-browser engine.

const GLYPH: Record<RecentKind, string> = { compare: '±', decompile: '{}', profile: '▲', markdown: '#' };

const BLURB: Record<RecentKind, { text: string; exts: string }> = {
  compare: { text: 'Diff two builds class by class, with decompiled source side by side', exts: 'jar war ear' },
  decompile: { text: 'Turn bytecode back into Java, browse it, download sources.zip', exts: 'jar war ear' },
  profile: { text: 'Hot methods and a flame graph from a Flight Recorder file', exts: 'jfr' },
  markdown: { text: 'Write docs with live Mermaid diagrams you can trace and export', exts: 'md' },
};

export interface Shortcut { label: string; keys: string[] }

export default function Home({
  onFiles, onTool, recent, onClearRecent, jvm, shortcuts,
}: {
  /** Route dropped or picked files; returns an error message when nothing matched. */
  onFiles: (files: File[]) => string | null;
  onTool: (t: Tool) => void;
  recent: RecentItem[];
  onClearRecent: () => void;
  jvm: JvmState;
  shortcuts: Shortcut[];
}) {
  const [over, setOver] = useState(false);
  const [error, setError] = useState('');
  const depth = useRef(0);
  const pick = useRef<HTMLInputElement>(null);

  const take = (files: File[]) => {
    if (!files.length) return;
    setError(onFiles(files) ?? '');
  };
  const hasFiles = (e: React.DragEvent) => [...e.dataTransfer.types].includes('Files');

  const runtime = jvm === 'ready' ? 'ready' : jvm === 'loading' ? 'starting…' : jvm === 'error' ? 'failed to start' : 'not loaded';

  return (
    <div
      className={`home${over ? ' is-over' : ''}`}
      onDragEnter={(e) => { if (hasFiles(e)) { depth.current++; setOver(true); } }}
      onDragOver={(e) => { if (hasFiles(e)) e.preventDefault(); }}
      onDragLeave={() => { if (--depth.current <= 0) { depth.current = 0; setOver(false); } }}
      onDrop={(e) => {
        if (!hasFiles(e)) return;
        e.preventDefault();
        depth.current = 0;
        setOver(false);
        take([...e.dataTransfer.files]);
      }}
    >
      <div className="home-grid">
        <section className="home-main">
          <p className="home-path">~/workbench</p>
          <h1 className="home-title">Inspect Java builds without leaving the browser.</h1>
          <p className="home-lede">
            Diff two archives, decompile one, profile a flight recording, or write docs with live diagrams.
            A WebAssembly JVM runs in this tab, so your files are never uploaded.
          </p>

          <button className="home-drop" onClick={() => pick.current?.click()}>
            <span className="home-drop-icon" aria-hidden><ArrowUpToLine size={16} /></span>
            <span className="home-drop-head">
              <strong>Drop files anywhere on the page</strong>
              <span>Routed by extension, or press <kbd>{MOD}O</kbd> to browse</span>
            </span>
            <span className="home-drop-routes">
              <span>2 × .jar/.war/.ear <i>→</i> compare</span>
              <span>1 × .jar/.war/.ear <i>→</i> decompile</span>
              <span>.jfr <i>→</i> profile</span>
              <span>.md <i>→</i> markdown</span>
            </span>
            {error && <span className="home-drop-error" role="alert">{error}</span>}
          </button>
          <input
            ref={pick}
            id="home-file-input"
            type="file"
            multiple
            accept=".jar,.war,.ear,.jfr,.md,.markdown"
            hidden
            onChange={(e) => { take([...(e.target.files ?? [])]); e.target.value = ''; }}
          />

          <h2 className="wb-label home-tools-label">Tools</h2>
          <ul className="home-tools">
            {TOOLS.map((t) => (
              <li key={t.id}>
                <button className="home-tool" onClick={() => onTool(t.id)}>
                  <span className={`home-glyph glyph-${t.id}`} aria-hidden>{GLYPH[t.id]}</span>
                  <span className="home-tool-text">
                    <strong>{t.name}</strong>
                    <span>{BLURB[t.id].text}</span>
                  </span>
                  <span className="home-tool-exts">{BLURB[t.id].exts}</span>
                  <kbd>{t.key}</kbd>
                </button>
              </li>
            ))}
          </ul>
        </section>

        <aside className="home-side">
          <section className="wb-card">
            <header className="wb-card-hd">
              <h2 className="wb-label">Recent</h2>
              {recent.length > 0 && <button className="wb-link-btn" onClick={onClearRecent}>Clear</button>}
            </header>
            {recent.length ? (
              <ul className="home-recent">
                {recent.map((r) => (
                  <li key={`${r.kind}:${r.label}`}>
                    <button onClick={() => onTool(r.kind)} title={`Open ${r.kind}`}>
                      <span className={`home-glyph glyph-${r.kind}`} aria-hidden>{GLYPH[r.kind]}</span>
                      <span className="home-recent-name">{r.label}</span>
                      <span className="home-recent-at">{timeAgo(r.at)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="home-empty">Nothing yet. Files you open show up here by name.</p>
            )}
            <p className="home-note">Only names are remembered, in this browser. Re-drop the files to reopen.</p>
          </section>

          <section className="wb-card">
            <header className="wb-card-hd"><h2 className="wb-label">Keyboard</h2></header>
            <dl className="home-keys">
              {shortcuts.map((s) => (
                <div key={s.label}>
                  <dt>{s.label}</dt>
                  <dd>{s.keys.map((k) => <kbd key={k}>{k}</kbd>)}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section className="wb-card">
            <header className="wb-card-hd"><h2 className="wb-label">Engine</h2></header>
            <dl className="home-engine">
              <div><dt>Runtime</dt><dd className={`is-${jvm}`}>CheerpJ 4.3 · {runtime}</dd></div>
              <div><dt>Engine</dt><dd>webcomparer.jar</dd></div>
              <div><dt>Decompiler</dt><dd>CFR</dd></div>
              <div><dt>Network</dt><dd>runtime download only</dd></div>
            </dl>
          </section>
        </aside>
      </div>

      {over && (
        <div className="home-overlay" aria-hidden>
          <div><ArrowUpToLine size={22} /><strong>Drop to open</strong><span>routed by extension</span></div>
        </div>
      )}
    </div>
  );
}
