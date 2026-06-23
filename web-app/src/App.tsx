import React, { useState, useEffect } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
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

interface CheerpJGlobal {
  cheerpjInit: (options?: any) => Promise<void>;
  cheerpjRunMain: (className: string, classPath: string, ...args: string[]) => Promise<number>;
  cheerpOSAddStringFile: (path: string, content: string | Uint8Array) => void;
  __cheerpjInitializing?: boolean;
}

declare const window: Window & typeof globalThis & CheerpJGlobal;

type FileStatus = 'modifiedClasses' | 'modified' | 'added' | 'removed' | 'identicalSourceClasses' | 'nestedChanges';

const STATUS_META: Record<FileStatus, { badge: string; cls: string; label: string }> = {
  modifiedClasses:        { badge: 'M', cls: 'modified-class', label: 'Modified Class' },
  modified:               { badge: 'M', cls: 'modified',       label: 'Modified'        },
  added:                  { badge: 'A', cls: 'added',          label: 'Added'           },
  removed:                { badge: 'R', cls: 'removed',        label: 'Removed'         },
  identicalSourceClasses: { badge: '~', cls: 'identical',      label: 'Identical Source'},
  nestedChanges:          { badge: 'N', cls: 'nested',         label: 'Nested JAR'      },
};

export default function App() {
  const [jar1File, setJar1File] = useState<File | null>(null);
  const [jar2File, setJar2File] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);

  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<FileStatus | null>(null);
  const [fileContent1, setFileContent1] = useState('');
  const [fileContent2, setFileContent2] = useState('');

  const [dragActive1, setDragActive1] = useState(false);
  const [dragActive2, setDragActive2] = useState(false);
  const [progressText, setProgressText] = useState('');

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    return 'light';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  const resetComparison = () => {
    setDiffResult(null);
    setJar1File(null);
    setJar2File(null);
    setSelectedFile(null);
    setSelectedType(null);
    setProgressText('');
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

  const handleProcess = async () => {
    if (!jar1File || !jar2File) return;
    setIsProcessing(true);
    setProgressText('Preparing environments...');
    try {
      const buffer1 = await jar1File.arrayBuffer();
      const buffer2 = await jar2File.arrayBuffer();

      if (typeof window.cheerpjInit !== 'undefined' && !window.__cheerpjInitializing) {
        window.__cheerpjInitializing = true;
        await window.cheerpjInit();
      }

      window.cheerpOSAddStringFile('/str/jar1.jar', new Uint8Array(buffer1));
      window.cheerpOSAddStringFile('/str/jar2.jar', new Uint8Array(buffer2));

      const jsonResult = await new Promise<string>((resolve, reject) => {
        let capturedJson = '';
        let isCapturing = false;
        const originalLog = console.log;
        console.log = function (...args) {
          if (typeof args[0] === 'string' && args[0].includes('JSON_RESULT_START')) { isCapturing = true; return; }
          if (typeof args[0] === 'string' && args[0].includes('JSON_RESULT_END'))   { isCapturing = false; return; }
          if (typeof args[0] === 'string' && args[0].startsWith('PROGRESS_MSG:'))   { setProgressText(args[0].substring(13)); return; }
          if (isCapturing) { capturedJson += args[0] + (args[1] || '') + (args[2] || ''); return; }
          originalLog.apply(console, args);
        };

        const jarPath = '/app' + import.meta.env.BASE_URL + 'webcomparer.jar';
        window.cheerpjRunMain('com.jarcompare.WebJarComparer', jarPath, '/str/jar1.jar', '/str/jar2.jar')
          .then(code => {
            console.log = originalLog;
            if (code !== 0 && !capturedJson) reject(new Error('Java process failed with exit code ' + code));
            else resolve(capturedJson);
          })
          .catch(err => { console.log = originalLog; reject(err); });
      });

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

  return (
    <div className={`app${diffResult ? ' has-results' : ''}`}>
      {/* ── Navbar ───────────────────────────────── */}
      <nav className="navbar">
        <div className="navbar-left">
          <span className="navbar-logo">⬡</span>
          <span className="navbar-title">jar-compare</span>
          {diffResult && jar1File && jar2File && (
            <div className="navbar-jars">
              <span className="jar-pill">{jar1File.name}</span>
              <span className="jar-arrow">→</span>
              <span className="jar-pill">{jar2File.name}</span>
            </div>
          )}
        </div>
        <div className="navbar-right">
          {diffResult && (
            <button className="btn btn-ghost" onClick={resetComparison}>
              New comparison
            </button>
          )}
          <button className="btn btn-icon" onClick={toggleTheme} title="Toggle theme">
            {theme === 'dark' ? '☀' : '☾'}
          </button>
        </div>
      </nav>

      {/* ── Upload page ──────────────────────────── */}
      {!diffResult && (
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
              <button
                className="btn btn-primary"
                disabled={!jar1File || !jar2File || isProcessing}
                onClick={handleProcess}
              >
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

      {/* ── Results ──────────────────────────────── */}
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
            {/* File panel */}
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

            {/* Diff panel */}
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
    </div>
  );
}
