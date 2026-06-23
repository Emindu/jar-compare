import React, { useState, useEffect } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import JSZip from 'jszip';
import './index.css';

interface FileContent {
  content1?: string;
  content2?: string;
}

interface DiffResult {
  added: string[];
  removed: string[];
  modified: string[];
  modifiedClasses: string[];
  identicalSourceClasses: string[];
  nestedChanges: string[];
  contents: Record<string, FileContent>;
}

interface DecompiledFile {
  encoding: 'utf8' | 'base64';
  content: string;
}

interface CheerpJGlobal {
  cheerpjInit: (options?: any) => Promise<void>;
  cheerpjRunMain: (className: string, classPath: string, ...args: string[]) => Promise<number>;
  cheerpOSAddStringFile: (path: string, content: string | Uint8Array) => void;
  __cheerpjInitializing?: boolean;
}

declare const window: Window & typeof globalThis & CheerpJGlobal;

type Mode = 'compare' | 'decompile';

type FileStatus = 'modifiedClasses' | 'modified' | 'added' | 'removed' | 'identicalSourceClasses' | 'nestedChanges';

const STATUS_META: Record<FileStatus, { badge: string; cls: string; label: string }> = {
  modifiedClasses:        { badge: 'M', cls: 'modified-class', label: 'Modified Class' },
  modified:               { badge: 'M', cls: 'modified',       label: 'Modified'        },
  added:                  { badge: 'A', cls: 'added',          label: 'Added'           },
  removed:                { badge: 'R', cls: 'removed',        label: 'Removed'         },
  identicalSourceClasses: { badge: '~', cls: 'identical',      label: 'Identical Source'},
  nestedChanges:          { badge: 'N', cls: 'nested',         label: 'Nested JAR'      },
};

const JAR_PATH = '/app' + import.meta.env.BASE_URL + 'webcomparer.jar';

export default function App() {
  const [mode, setMode] = useState<Mode>('compare');

  // shared
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'light';
  });

  // compare state
  const [jar1File, setJar1File] = useState<File | null>(null);
  const [jar2File, setJar2File] = useState<File | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<FileStatus | null>(null);
  const [fileContent1, setFileContent1] = useState('');
  const [fileContent2, setFileContent2] = useState('');
  const [dragActive1, setDragActive1] = useState(false);
  const [dragActive2, setDragActive2] = useState(false);

  // decompile state
  const [srcJar, setSrcJar] = useState<File | null>(null);
  const [dragActiveD, setDragActiveD] = useState(false);
  const [decompiled, setDecompiled] = useState<Record<string, DecompiledFile> | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const resetAll = () => {
    setDiffResult(null);
    setJar1File(null);
    setJar2File(null);
    setSelectedFile(null);
    setSelectedType(null);
    setDecompiled(null);
    setSrcJar(null);
    setSelectedSource(null);
    setProgressText('');
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    resetAll();
  };

  const handleDrag = (e: React.DragEvent, set: (v: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    set(e.type === 'dragenter' || e.type === 'dragover');
  };

  const handleDrop = (e: React.DragEvent, setFile: (f: File | null) => void, setActive: (v: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      if (file.name.endsWith('.jar')) setFile(file);
      else alert('Please drop a valid .jar file');
    }
  };

  useEffect(() => {
    const init = async () => {
      try {
        if (typeof window.cheerpjInit !== 'undefined' && !window.__cheerpjInitializing) {
          window.__cheerpjInitializing = true;
          await window.cheerpjInit();
        }
      } catch (e) {
        console.error('Failed to initialize CheerpJ', e);
      }
    };
    init();
  }, []);

  // Run a Java main class and capture the JSON it prints between markers.
  const runJava = (className: string, ...args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      let capturedJson = '';
      let isCapturing = false;
      const originalLog = console.log;
      console.log = function (...a) {
        if (typeof a[0] === 'string' && a[0].includes('JSON_RESULT_START')) { isCapturing = true; return; }
        if (typeof a[0] === 'string' && a[0].includes('JSON_RESULT_END'))   { isCapturing = false; return; }
        if (typeof a[0] === 'string' && a[0].startsWith('PROGRESS_MSG:'))   { setProgressText(a[0].substring(13)); return; }
        if (isCapturing) { capturedJson += a[0] + (a[1] || '') + (a[2] || ''); return; }
        originalLog.apply(console, a);
      };
      window.cheerpjRunMain(className, JAR_PATH, ...args)
        .then(code => {
          console.log = originalLog;
          if (code !== 0 && !capturedJson) reject(new Error('Java process failed with exit code ' + code));
          else resolve(capturedJson);
        })
        .catch(err => { console.log = originalLog; reject(err); });
    });

  const ensureCheerpJ = async () => {
    if (typeof window.cheerpjInit !== 'undefined' && !window.__cheerpjInitializing) {
      window.__cheerpjInitializing = true;
      await window.cheerpjInit();
    }
  };

  const handleCompare = async () => {
    if (!jar1File || !jar2File) return;
    setIsProcessing(true);
    setProgressText('Preparing environments...');
    try {
      const b1 = await jar1File.arrayBuffer();
      const b2 = await jar2File.arrayBuffer();
      await ensureCheerpJ();
      window.cheerpOSAddStringFile('/str/jar1.jar', new Uint8Array(b1));
      window.cheerpOSAddStringFile('/str/jar2.jar', new Uint8Array(b2));

      const jsonResult = await runJava('com.jarcompare.WebJarComparer', '/str/jar1.jar', '/str/jar2.jar');
      const parsed: DiffResult = JSON.parse(jsonResult);
      parsed.identicalSourceClasses = [];
      parsed.nestedChanges = [];

      const filterNested = (arr: string[] | undefined) => {
        if (!arr) return [];
        const out: string[] = [];
        for (const s of arr) {
          if (s.includes(' -> ')) parsed.nestedChanges.push(s);
          else out.push(s);
        }
        return out;
      };

      parsed.added    = filterNested(parsed.added);
      parsed.removed  = filterNested(parsed.removed);
      parsed.modified = filterNested(parsed.modified);

      const nonNested = filterNested(parsed.modifiedClasses);
      const actual: string[] = [];
      for (const cls of nonNested) {
        const c1 = parsed.contents[cls]?.content1 || '';
        const c2 = parsed.contents[cls]?.content2 || '';
        if (c1 === c2) parsed.identicalSourceClasses.push(cls);
        else actual.push(cls);
      }
      parsed.modifiedClasses = actual;

      setDiffResult(parsed);
      setSelectedFile(null);
      setSelectedType(null);
    } catch (e) {
      console.error(e);
      alert('Error processing jars: ' + e);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  const handleDecompile = async () => {
    if (!srcJar) return;
    setIsProcessing(true);
    setProgressText('Preparing environment...');
    try {
      const buf = await srcJar.arrayBuffer();
      await ensureCheerpJ();
      window.cheerpOSAddStringFile('/str/input.jar', new Uint8Array(buf));

      const jsonResult = await runJava('com.jarcompare.WebJarDecompiler', '/str/input.jar');
      const parsed = JSON.parse(jsonResult) as { files: Record<string, DecompiledFile> };
      const files = parsed.files || {};
      setDecompiled(files);
      // auto-select first .java source for instant feedback
      const firstJava = Object.keys(files).sort().find(p => p.endsWith('.java'));
      setSelectedSource(firstJava || Object.keys(files).sort()[0] || null);
    } catch (e) {
      console.error(e);
      alert('Error decompiling jar: ' + e);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  const downloadZip = async () => {
    if (!decompiled || !srcJar) return;
    const zip = new JSZip();
    for (const [path, f] of Object.entries(decompiled)) {
      if (f.encoding === 'base64') zip.file(path, f.content, { base64: true });
      else zip.file(path, f.content);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = srcJar.name.replace(/\.jar$/i, '') + '-sources.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const handleSelectFile = (path: string, type: FileStatus) => {
    setSelectedFile(path);
    setSelectedType(type);
    const c = diffResult?.contents[path];
    setFileContent1(c?.content1 || '');
    setFileContent2(c?.content2 || '');
  };

  const stats = diffResult
    ? {
        modifiedClasses: diffResult.modifiedClasses.length,
        modified:        diffResult.modified.length,
        added:           diffResult.added.length,
        removed:         diffResult.removed.length,
        identical:       diffResult.identicalSourceClasses.length,
        nested:          diffResult.nestedChanges.length,
        get total() {
          return this.modifiedClasses + this.modified + this.added + this.removed + this.identical + this.nested;
        },
      }
    : null;

  const breadcrumb = (path: string) => {
    if (path.includes(' -> ')) {
      const [outer, inner] = path.split(' -> ');
      return `${outer.split('/').pop()} → ${inner.split('/').pop()}`;
    }
    return path.replace(/\//g, ' / ');
  };

  const renderSection = (files: string[], type: FileStatus, sectionLabel: string) => {
    if (!files.length) return null;
    const { badge, cls } = STATUS_META[type];
    return (
      <div className="file-section" key={type}>
        <div className="file-section-label">
          <span className={`status-dot dot-${cls}`} />
          {sectionLabel}
          <span className="file-section-count">{files.length}</span>
        </div>
        {files.map(path => {
          const name = path.includes(' -> ')
            ? path.substring(path.indexOf(' -> ') + 4).split('/').pop()
            : path.split('/').pop();
          return (
            <button
              key={path}
              className={`file-row${selectedFile === path ? ' selected' : ''}`}
              onClick={() => handleSelectFile(path, type)}
              title={path}
            >
              <span className={`file-badge badge-${cls}`}>{badge}</span>
              <span className="file-row-name">{name}</span>
            </button>
          );
        })}
      </div>
    );
  };

  // decompile-results derived lists
  const decompiledPaths = decompiled ? Object.keys(decompiled).sort() : [];
  const javaPaths = decompiledPaths.filter(p => p.endsWith('.java'));
  const resourcePaths = decompiledPaths.filter(p => !p.endsWith('.java'));
  const selectedDecompiledFile = selectedSource && decompiled ? decompiled[selectedSource] : null;

  const renderSourceSection = (paths: string[], label: string, badge: string, cls: string) => {
    if (!paths.length) return null;
    return (
      <div className="file-section">
        <div className="file-section-label">
          <span className={`status-dot dot-${cls}`} />
          {label}
          <span className="file-section-count">{paths.length}</span>
        </div>
        {paths.map(path => (
          <button
            key={path}
            className={`file-row${selectedSource === path ? ' selected' : ''}`}
            onClick={() => setSelectedSource(path)}
            title={path}
          >
            <span className={`file-badge badge-${cls}`}>{badge}</span>
            <span className="file-row-name">{path.split('/').pop()}</span>
          </button>
        ))}
      </div>
    );
  };

  const hasResults = !!diffResult || !!decompiled;

  return (
    <div className={`app${hasResults ? ' has-results' : ''}`}>
      {/* ── Navbar ───────────────────────────────── */}
      <nav className="navbar">
        <div className="navbar-left">
          <span className="navbar-logo">⬡</span>
          <span className="navbar-title">jar-compare</span>

          {!hasResults && (
            <div className="mode-tabs">
              <button className={`mode-tab${mode === 'compare' ? ' active' : ''}`} onClick={() => switchMode('compare')}>Compare</button>
              <button className={`mode-tab${mode === 'decompile' ? ' active' : ''}`} onClick={() => switchMode('decompile')}>Decompile</button>
            </div>
          )}

          {diffResult && jar1File && jar2File && (
            <div className="navbar-jars">
              <span className="jar-pill">{jar1File.name}</span>
              <span className="jar-arrow">→</span>
              <span className="jar-pill">{jar2File.name}</span>
            </div>
          )}
          {decompiled && srcJar && (
            <div className="navbar-jars">
              <span className="jar-pill">{srcJar.name}</span>
              <span className="jar-arrow">⇣ sources</span>
            </div>
          )}
        </div>

        <div className="navbar-right">
          {decompiled && (
            <button className="btn btn-primary btn-sm" onClick={downloadZip}>⇣ Download .zip</button>
          )}
          {hasResults && (
            <button className="btn btn-ghost" onClick={resetAll}>
              {mode === 'compare' ? 'New comparison' : 'New file'}
            </button>
          )}
          <button className="btn btn-icon" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </nav>

      {/* ── Upload page: COMPARE ─────────────────── */}
      {mode === 'compare' && !diffResult && (
        <main className="upload-page">
          <div className="upload-card">
            <div className="upload-heading">
              <h1 className="upload-title">Compare JAR files</h1>
              <p className="upload-sub">Side-by-side diff of classes, resources &amp; nested JARs — runs entirely in your browser</p>
            </div>

            <div className="dropzone-row">
              <div
                className={`dropzone${dragActive1 ? ' drag-active' : ''}${jar1File ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActive1)}
                onDragOver={e  => handleDrag(e, setDragActive1)}
                onDragLeave={e => handleDrag(e, setDragActive1)}
                onDrop={e => handleDrop(e, setJar1File, setDragActive1)}
              >
                <label>
                  <span className="dz-label">Original JAR</span>
                  <span className={`dz-file${jar1File ? ' dz-file--set' : ''}`}>
                    {jar1File ? jar1File.name : 'Drop .jar or click to browse'}
                  </span>
                  {jar1File && <span className="dz-meta">{(jar1File.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar" onChange={e => setJar1File(e.target.files?.[0] || null)} />
                </label>
              </div>

              <div className="dz-divider">→</div>

              <div
                className={`dropzone${dragActive2 ? ' drag-active' : ''}${jar2File ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActive2)}
                onDragOver={e  => handleDrag(e, setDragActive2)}
                onDragLeave={e => handleDrag(e, setDragActive2)}
                onDrop={e => handleDrop(e, setJar2File, setDragActive2)}
              >
                <label>
                  <span className="dz-label">New JAR</span>
                  <span className={`dz-file${jar2File ? ' dz-file--set' : ''}`}>
                    {jar2File ? jar2File.name : 'Drop .jar or click to browse'}
                  </span>
                  {jar2File && <span className="dz-meta">{(jar2File.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar" onChange={e => setJar2File(e.target.files?.[0] || null)} />
                </label>
              </div>
            </div>

            <div className="upload-actions">
              <button className="btn btn-primary" disabled={!jar1File || !jar2File || isProcessing} onClick={handleCompare}>
                {isProcessing ? 'Analyzing…' : 'Compare JARs'}
              </button>
            </div>

            {isProcessing && (
              <div className="progress-wrap">
                <div className="progress-track"><div className="progress-bar" /></div>
                <div className="progress-text">{progressText || 'Working…'}</div>
              </div>
            )}
          </div>
        </main>
      )}

      {/* ── Upload page: DECOMPILE ───────────────── */}
      {mode === 'decompile' && !decompiled && (
        <main className="upload-page">
          <div className="upload-card">
            <div className="upload-heading">
              <h1 className="upload-title">Decompile a JAR</h1>
              <p className="upload-sub">De-archive &amp; decompile bytecode back to Java source, then download it — all in your browser</p>
            </div>

            <div className="dropzone-row">
              <div
                className={`dropzone dropzone--single${dragActiveD ? ' drag-active' : ''}${srcJar ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActiveD)}
                onDragOver={e  => handleDrag(e, setDragActiveD)}
                onDragLeave={e => handleDrag(e, setDragActiveD)}
                onDrop={e => handleDrop(e, setSrcJar, setDragActiveD)}
              >
                <label>
                  <span className="dz-label">JAR to decompile</span>
                  <span className={`dz-file${srcJar ? ' dz-file--set' : ''}`}>
                    {srcJar ? srcJar.name : 'Drop .jar or click to browse'}
                  </span>
                  {srcJar && <span className="dz-meta">{(srcJar.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar" onChange={e => setSrcJar(e.target.files?.[0] || null)} />
                </label>
              </div>
            </div>

            <div className="upload-actions">
              <button className="btn btn-primary" disabled={!srcJar || isProcessing} onClick={handleDecompile}>
                {isProcessing ? 'Decompiling…' : 'Decompile & Extract'}
              </button>
            </div>

            {isProcessing && (
              <div className="progress-wrap">
                <div className="progress-track"><div className="progress-bar" /></div>
                <div className="progress-text">{progressText || 'Working…'}</div>
              </div>
            )}
          </div>
        </main>
      )}

      {/* ── Results: COMPARE ─────────────────────── */}
      {diffResult && stats && (
        <>
          <div className="stats-bar">
            <span className="stats-total">{stats.total} files changed</span>
            {stats.modifiedClasses > 0 && <span className="stat stat-modified-class">{stats.modifiedClasses} modified classes</span>}
            {stats.modified       > 0 && <span className="stat stat-modified">{stats.modified} modified</span>}
            {stats.added          > 0 && <span className="stat stat-added">+{stats.added} added</span>}
            {stats.removed        > 0 && <span className="stat stat-removed">−{stats.removed} removed</span>}
            {stats.identical      > 0 && <span className="stat stat-identical">{stats.identical} identical source</span>}
            {stats.nested         > 0 && <span className="stat stat-nested">{stats.nested} nested</span>}
          </div>

          <div className="workspace">
            <aside className="file-panel">
              <div className="file-panel-hd">Files changed</div>
              <div className="file-list">
                {renderSection(diffResult.modifiedClasses,        'modifiedClasses',        'Modified Classes')}
                {renderSection(diffResult.modified,               'modified',               'Modified'        )}
                {renderSection(diffResult.added,                  'added',                  'Added'           )}
                {renderSection(diffResult.removed,                'removed',                'Removed'         )}
                {renderSection(diffResult.identicalSourceClasses, 'identicalSourceClasses', 'Identical Source')}
                {renderSection(diffResult.nestedChanges,          'nestedChanges',          'Nested JAR'      )}
              </div>
            </aside>

            <div className="diff-panel">
              {selectedFile && selectedType ? (
                <div className="diff-view">
                  <div className="diff-panel-hd">
                    <span className="diff-crumb">{breadcrumb(selectedFile)}</span>
                    <span className={`diff-type-badge badge-${STATUS_META[selectedType].cls}`}>
                      {STATUS_META[selectedType].label}
                    </span>
                  </div>
                  {selectedType === 'identicalSourceClasses' && (
                    <div className="alert-banner">
                      <strong>Decompiled source is identical</strong> — binary differs due to compiler version, line numbers, or debug info.
                    </div>
                  )}
                  <div className="diff-body">
                    <ReactDiffViewer
                      oldValue={fileContent1}
                      newValue={fileContent2}
                      splitView={true}
                      useDarkTheme={theme === 'dark'}
                      leftTitle={jar1File?.name}
                      rightTitle={jar2File?.name}
                    />
                  </div>
                </div>
              ) : (
                <div className="diff-empty">
                  <span className="diff-empty-icon">⬡</span>
                  <p>Select a file to view the diff</p>
                  <p className="diff-empty-sub">{stats.total} files · {jar1File?.name} → {jar2File?.name}</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {/* ── Results: DECOMPILE ───────────────────── */}
      {decompiled && (
        <>
          <div className="stats-bar">
            <span className="stats-total">{decompiledPaths.length} files extracted</span>
            {javaPaths.length     > 0 && <span className="stat stat-added">{javaPaths.length} sources (.java)</span>}
            {resourcePaths.length > 0 && <span className="stat stat-nested">{resourcePaths.length} resources</span>}
          </div>

          <div className="workspace">
            <aside className="file-panel">
              <div className="file-panel-hd">Extracted files</div>
              <div className="file-list">
                {renderSourceSection(javaPaths, 'Sources', 'J', 'added')}
                {renderSourceSection(resourcePaths, 'Resources', 'R', 'nested')}
              </div>
            </aside>

            <div className="diff-panel">
              {selectedSource && selectedDecompiledFile ? (
                <div className="diff-view">
                  <div className="diff-panel-hd">
                    <span className="diff-crumb">{selectedSource.replace(/\//g, ' / ')}</span>
                    <span className={`diff-type-badge badge-${selectedSource.endsWith('.java') ? 'added' : 'nested'}`}>
                      {selectedSource.endsWith('.java') ? 'Java source' : 'Resource'}
                    </span>
                  </div>
                  <div className="diff-body">
                    {selectedDecompiledFile.encoding === 'base64' ? (
                      <div className="diff-empty">
                        <span className="diff-empty-icon">▢</span>
                        <p>Binary file — not previewable</p>
                        <p className="diff-empty-sub">Included in the downloaded archive</p>
                      </div>
                    ) : (
                      <pre className="source-view">{selectedDecompiledFile.content}</pre>
                    )}
                  </div>
                </div>
              ) : (
                <div className="diff-empty">
                  <span className="diff-empty-icon">⬡</span>
                  <p>Select a file to view its source</p>
                  <p className="diff-empty-sub">{decompiledPaths.length} files · use “Download .zip” for everything</p>
                </div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  );
}
