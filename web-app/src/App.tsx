import React, { useState, useEffect } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { CheckCircle2 } from 'lucide-react';
import './index.css';

// Type definitions
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

export default function App() {
  const [jar1File, setJar1File] = useState<File | null>(null);
  const [jar2File, setJar2File] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<string | null>(null);
  const [fileContent1, setFileContent1] = useState<string>('');
  const [fileContent2, setFileContent2] = useState<string>('');

  const [dragActive1, setDragActive1] = useState(false);
  const [dragActive2, setDragActive2] = useState(false);
  const [progressText, setProgressText] = useState<string>('');

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const saved = localStorage.getItem('theme');
    if (saved === 'light' || saved === 'dark') return saved;
    if (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches) {
      return 'light';
    }
    return 'dark';
  });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => t === 'dark' ? 'light' : 'dark');

  const handleDrag = (e: React.DragEvent, setDragActive: (val: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.type === "dragenter" || e.type === "dragover") {
      setDragActive(true);
    } else if (e.type === "dragleave") {
      setDragActive(false);
    }
  };

  const handleDrop = (e: React.DragEvent, setFile: (f: File | null) => void, setDragActive: (val: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    setDragActive(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const file = e.dataTransfer.files[0];
      if (file.name.endsWith('.jar')) {
        setFile(file);
      } else {
        alert('Please drop a valid .jar file');
      }
    }
  };

  // Initialize CheerpJ
  useEffect(() => {
    const initCheerpJ = async () => {
      try {
        if (typeof window.cheerpjInit !== 'undefined') {
          if (!window.__cheerpjInitializing) {
            window.__cheerpjInitializing = true;
            await window.cheerpjInit();
            console.log('CheerpJ initialized');
          }
        }
      } catch (e) {
        console.error('Failed to initialize CheerpJ', e);
      }
    };
    initCheerpJ();
  }, []);

  const handleProcess = async () => {
    if (!jar1File || !jar2File) return;
    setIsProcessing(true);
    setProgressText('Preparing environments...');
    try {
      const buffer1 = await jar1File.arrayBuffer();
      const buffer2 = await jar2File.arrayBuffer();

      // Ensure CheerpJ is ready
      if (typeof window.cheerpjInit !== 'undefined' && !window.__cheerpjInitializing) {
         window.__cheerpjInitializing = true;
         await window.cheerpjInit();
      }

      // Write files to virtual filesystem
      window.cheerpOSAddStringFile("/str/jar1.jar", new Uint8Array(buffer1));
      window.cheerpOSAddStringFile("/str/jar2.jar", new Uint8Array(buffer2));

      // Run Java Comparison Logic
      const jsonResult = await new Promise<string>((resolve, reject) => {
        let capturedJson = "";
        let isCapturing = false;
        
        const originalLog = console.log;
        console.log = function(...args) {
          if (typeof args[0] === 'string' && args[0].includes('JSON_RESULT_START')) {
            isCapturing = true;
            return;
          }
          if (typeof args[0] === 'string' && args[0].includes('JSON_RESULT_END')) {
            isCapturing = false;
            return;
          }
          if (typeof args[0] === 'string' && args[0].startsWith('PROGRESS_MSG:')) {
            setProgressText(args[0].substring(13));
            return;
          }
          if (isCapturing) {
            capturedJson += args[0] + (args[1] || "") + (args[2] || "");
            return;
          }
          originalLog.apply(console, args);
        };

        window.cheerpjRunMain("com.jarcompare.WebJarComparer", "/app/webcomparer.jar", "/str/jar1.jar", "/str/jar2.jar")
          .then((exitCode) => {
            console.log = originalLog;
            if (exitCode !== 0 && !capturedJson) {
              reject(new Error("Java process failed with exit code " + exitCode));
            } else {
              resolve(capturedJson);
            }
          })
          .catch(err => {
            console.log = originalLog;
            reject(err);
          });
      });

      const parsed: DiffResult = JSON.parse(jsonResult);
      
      parsed.identicalSourceClasses = [];
      parsed.nestedChanges = [];
      
      const filterNested = (arr: string[] | undefined) => {
        if (!arr) return [];
        const nonNested = [];
        for (const cls of arr) {
          if (cls.includes(' -> ')) {
            parsed.nestedChanges.push(cls);
          } else {
            nonNested.push(cls);
          }
        }
        return nonNested;
      };

      parsed.added = filterNested(parsed.added);
      parsed.removed = filterNested(parsed.removed);
      parsed.modified = filterNested(parsed.modified);
      
      const nonNestedClasses = filterNested(parsed.modifiedClasses);
      const actualModifiedClasses = [];
      
      for (const cls of nonNestedClasses) {
        const c1 = parsed.contents[cls]?.content1 || '';
        const c2 = parsed.contents[cls]?.content2 || '';
        if (c1 === c2) {
          parsed.identicalSourceClasses.push(cls);
        } else {
          actualModifiedClasses.push(cls);
        }
      }
      parsed.modifiedClasses = actualModifiedClasses;
      
      setDiffResult(parsed);
      setSelectedFile(null);
      setSelectedType(null);
    } catch (e) {
      console.error(e);
      alert("Error processing jars: " + e);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  const handleSelectFile = (path: string, type: 'added' | 'removed' | 'modified' | 'modifiedClasses' | 'identicalSourceClasses' | 'nestedChanges') => {
    setSelectedFile(path);
    setSelectedType(type);
    
    if (diffResult && diffResult.contents[path]) {
      const contents = diffResult.contents[path];
      setFileContent1(contents.content1 || '');
      setFileContent2(contents.content2 || '');
    } else {
      setFileContent1('');
      setFileContent2('');
    }
  };

  return (
    <div className="container">
      <header className="header" style={{ position: 'relative' }}>
        <h1>Client-Side JAR Comparer</h1>
        <p>Runs your Java application entirely in the browser using WebAssembly.</p>
        <button 
          onClick={toggleTheme} 
          style={{ position: 'absolute', right: 0, top: '1rem', background: 'var(--panel-bg)', border: '1px solid var(--border-color)', borderRadius: '6px', padding: '0.5rem 0.75rem', color: 'var(--text-main)', cursor: 'pointer', fontFamily: 'var(--font-sans)', fontSize: '0.85rem' }}
        >
          {theme === 'dark' ? '☀️ Light Mode' : '🌙 Dark Mode'}
        </button>
      </header>
      
      <div className="upload-section">
        <div 
          className={`file-input dropzone ${dragActive1 ? 'drag-active' : ''} ${jar1File ? 'has-file' : ''}`}
          onDragEnter={e => handleDrag(e, setDragActive1)}
          onDragOver={e => handleDrag(e, setDragActive1)}
          onDragLeave={e => handleDrag(e, setDragActive1)}
          onDrop={e => handleDrop(e, setJar1File, setDragActive1)}
        >
          <label>
            <span>Original JAR (JAR 1)</span>
            <span className="file-name">{jar1File ? jar1File.name : 'Drag & Drop or Click to Browse'}</span>
            <input type="file" accept=".jar" onChange={e => setJar1File(e.target.files?.[0] || null)} />
          </label>
        </div>
        <div 
          className={`file-input dropzone ${dragActive2 ? 'drag-active' : ''} ${jar2File ? 'has-file' : ''}`}
          onDragEnter={e => handleDrag(e, setDragActive2)}
          onDragOver={e => handleDrag(e, setDragActive2)}
          onDragLeave={e => handleDrag(e, setDragActive2)}
          onDrop={e => handleDrop(e, setJar2File, setDragActive2)}
        >
          <label>
            <span>Updated JAR (JAR 2)</span>
            <span className="file-name">{jar2File ? jar2File.name : 'Drag & Drop or Click to Browse'}</span>
            <input type="file" accept=".jar" onChange={e => setJar2File(e.target.files?.[0] || null)} />
          </label>
        </div>
        <button 
          className="process-btn" 
          disabled={!jar1File || !jar2File || isProcessing}
          onClick={handleProcess}
        >
          {isProcessing ? 'Processing...' : 'Compare JARs'}
        </button>
        {isProcessing && progressText && (
          <div className="progress-container" style={{
            position: 'absolute',
            bottom: '-2.5rem',
            left: 0,
            right: 0,
            textAlign: 'center',
            fontSize: '0.85rem',
            color: 'var(--accent)',
            fontFamily: 'var(--font-mono)'
          }}>
            {progressText}
          </div>
        )}
      </div>

      {diffResult && (
        <div className="results-container">
          <div className="sidebar">
            <h3>Files Changed</h3>
            
            {diffResult.nestedChanges && diffResult.nestedChanges.length > 0 && (
              <div className="file-group">
                <h4 className="group-title nested-title">Nested JAR Changes ({diffResult.nestedChanges.length})</h4>
                <ul>
                  {diffResult.nestedChanges.map(path => {
                    const displayName = path.includes(' -> ') ? path.substring(path.indexOf(' -> ') + 4).split('/').pop() : path.split('/').pop();
                    return (
                      <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'nestedChanges')} title={path}>
                        {displayName}
                        <span style={{display: 'block', fontSize: '0.7rem', color: '#6b7280', marginTop: '2px'}}>
                          {path.split(' -> ')[0].split('/').pop()}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </div>
            )}
            
            {diffResult.modifiedClasses && diffResult.modifiedClasses.length > 0 && (
              <div className="file-group">
                <h4 className="group-title modified-classes-title">Modified Classes ({diffResult.modifiedClasses.length})</h4>
                <ul>
                  {diffResult.modifiedClasses.map(path => (
                    <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'modifiedClasses')}>
                      {path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            
            {diffResult.identicalSourceClasses && diffResult.identicalSourceClasses.length > 0 && (
              <div className="file-group">
                <h4 className="group-title identical-title">Identical Source ({diffResult.identicalSourceClasses.length})</h4>
                <ul>
                  {diffResult.identicalSourceClasses.map(path => (
                    <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'identicalSourceClasses')}>
                      {path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            
            {diffResult.modified && diffResult.modified.length > 0 && (
              <div className="file-group">
                <h4 className="group-title modified-title">Other Modified Files ({diffResult.modified.length})</h4>
                <ul>
                  {diffResult.modified.map(path => (
                    <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'modified')}>
                      {path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {diffResult.added && diffResult.added.length > 0 && (
              <div className="file-group">
                <h4 className="group-title added-title">Added Files ({diffResult.added.length})</h4>
                <ul>
                  {diffResult.added.map(path => (
                    <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'added')}>
                      {path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            )}

            {diffResult.removed && diffResult.removed.length > 0 && (
              <div className="file-group">
                <h4 className="group-title removed-title">Removed Files ({diffResult.removed.length})</h4>
                <ul>
                  {diffResult.removed.map(path => (
                    <li key={path} className={selectedFile === path ? 'selected' : ''} onClick={() => handleSelectFile(path, 'removed')}>
                      {path.split('/').pop()}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            
          </div>
          <div className="main-content">
            {selectedFile ? (
              <div className="diff-view">
                <div className="diff-header">
                  <h4>{selectedFile}</h4>
                </div>
                {selectedType === 'identicalSourceClasses' && (
                  <div className="alert-identical">
                    <strong>Decompiled Java source is exactly identical!</strong>
                    <p>The .class binary differs likely due to changes in comments, line numbers, or compiler version/flags.</p>
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
              <div className="empty-state">
                <CheckCircle2 size={48} className="success-icon" />
                <p>Comparison complete. Select a file from the sidebar to view differences.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
