import React, { useState, useEffect, useMemo, useRef } from 'react';
import ReactDiffViewer from 'react-diff-viewer-continued';
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneLight, oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import java from 'react-syntax-highlighter/dist/esm/languages/prism/java';
import kotlin from 'react-syntax-highlighter/dist/esm/languages/prism/kotlin';
import groovy from 'react-syntax-highlighter/dist/esm/languages/prism/groovy';
import scala from 'react-syntax-highlighter/dist/esm/languages/prism/scala';
import markup from 'react-syntax-highlighter/dist/esm/languages/prism/markup';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import properties from 'react-syntax-highlighter/dist/esm/languages/prism/properties';
import sql from 'react-syntax-highlighter/dist/esm/languages/prism/sql';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import css from 'react-syntax-highlighter/dist/esm/languages/prism/css';
import JSZip from 'jszip';
import { parseJfr, type JfrResult } from './jfr';
import Profiler from './Profiler';
import './index.css';

SyntaxHighlighter.registerLanguage('java', java);
SyntaxHighlighter.registerLanguage('kotlin', kotlin);
SyntaxHighlighter.registerLanguage('groovy', groovy);
SyntaxHighlighter.registerLanguage('scala', scala);
SyntaxHighlighter.registerLanguage('markup', markup);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('properties', properties);
SyntaxHighlighter.registerLanguage('sql', sql);
SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('css', css);

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

interface JarMeta {
  javaVersion?: string;
  buildDate?: string;
  buildJdk?: string;
  mainClass?: string;
  implementationVersion?: string;
  implementationVendor?: string;
  specificationVersion?: string;
  maven?: string;
  classCount?: number;
  packageCount?: number;
  resourceCount?: number;
  totalSize?: number;
  multiRelease?: boolean;
  signed?: boolean;
}

interface CheerpJGlobal {
  cheerpjInit: (options?: any) => Promise<void>;
  cheerpjRunMain: (className: string, classPath: string, ...args: string[]) => Promise<number>;
  cheerpOSAddStringFile: (path: string, content: string | Uint8Array) => void;
  __cheerpjInitializing?: boolean;
}

declare const window: Window & typeof globalThis & CheerpJGlobal;

type Mode = 'compare' | 'decompile' | 'profile';

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

// ── Package/path tree for the decompile sidebar ───────────────────────────
interface TreeNode {
  name: string;
  path: string;                  // full path (folders included)
  isFile: boolean;
  children: Map<string, TreeNode>;
}

function buildTree(paths: string[]): TreeNode {
  const root: TreeNode = { name: '', path: '', isFile: false, children: new Map() };
  for (const p of paths) {
    const parts = p.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isLast = i === parts.length - 1;
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, path: parts.slice(0, i + 1).join('/'), isFile: isLast, children: new Map() };
        node.children.set(part, child);
      }
      node = child;
    });
  }
  return root;
}

// Map a file path to a Prism language id for syntax highlighting.
function langForPath(p: string): string {
  const ext = p.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'java':                       return 'java';
    case 'kt':                         return 'kotlin';
    case 'groovy': case 'gradle':      return 'groovy';
    case 'scala':                      return 'scala';
    case 'xml': case 'xsd': case 'wsdl': case 'pom': case 'tld': return 'markup';
    case 'html': case 'htm':           return 'markup';
    case 'json':                       return 'json';
    case 'yml': case 'yaml':           return 'yaml';
    case 'properties':                 return 'properties';
    case 'sql':                        return 'sql';
    case 'sh':                         return 'bash';
    case 'js':                         return 'javascript';
    case 'css':                        return 'css';
    default:                           return 'text';
  }
}

// Extract an outline (classes / methods / fields) from decompiled Java source.
// Heuristic: works on CFR's 4-space-indented output.
function parseOutline(content: string): { kind: 'class' | 'method' | 'field'; name: string; line: number }[] {
  const out: { kind: 'class' | 'method' | 'field'; name: string; line: number }[] = [];
  if (!content) return out;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    let m = ln.match(/^(?:public |private |protected |final |abstract |static |sealed )*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/);
    if (m) { out.push({ kind: 'class', name: m[2], line: i + 1 }); continue; }
    if (!/^ {4}\S/.test(ln)) continue;
    m = ln.match(/(?:^| )([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*(?:throws [\w$., ]+)?\s*[{;]/);
    if (m && !['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized'].includes(m[1])) {
      out.push({ kind: 'method', name: m[1], line: i + 1 });
      continue;
    }
    m = ln.match(/^ {4}(?:public |private |protected |static |final |volatile |transient )*[\w$.<>\[\], ]+\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/);
    if (m) out.push({ kind: 'field', name: m[1], line: i + 1 });
  }
  return out;
}

// Lightweight fuzzy subsequence scorer for Quick Open. Returns null if the
// query isn't a subsequence of the target; higher score = better match.
function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, streak = 0, last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak = i === last + 1 ? streak + 1 : 0;
      score += 1 + streak;
      if (i === 0 || /[^A-Za-z0-9]/.test(t[i - 1])) score += 2; // word-boundary bonus
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}

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
  const [decompiledMeta, setDecompiledMeta] = useState<JarMeta | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [sourceQuery, setSourceQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [modDown, setModDown] = useState(false); // Ctrl/Cmd held → nav affordance
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);

  // profile (JFR) state
  const [jfrFile, setJfrFile] = useState<File | null>(null);
  const [dragActiveP, setDragActiveP] = useState(false);
  const [jfrResult, setJfrResult] = useState<JfrResult | null>(null);

  // IDE navigation: history, quick-open, outline, toast
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const navRef = useRef(nav);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [quickIndex, setQuickIndex] = useState(0);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const toastTimer = useRef<number | null>(null);
  const navHoverElRef = useRef<HTMLElement | null>(null);
  const pendingFlashRef = useRef<number | null>(null);

  const toggleDir = (path: string) =>
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  useEffect(() => {
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('theme', theme);
  }, [theme]);

  const toggleTheme = () => setTheme(t => (t === 'dark' ? 'light' : 'dark'));

  // Track Ctrl/Cmd for the "click a class to jump" affordance in decompiled source.
  useEffect(() => {
    const down = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') setModDown(true); };
    const up = (e: KeyboardEvent) => { if (e.key === 'Control' || e.key === 'Meta') setModDown(false); };
    const clear = () => setModDown(false);
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', clear);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', clear);
    };
  }, []);

  // Reset scroll to the top whenever the viewed source file changes.
  useEffect(() => {
    if (sourceScrollRef.current) sourceScrollRef.current.scrollTop = 0;
    clearNavHover();
    // Perform a pending flash once the new file has rendered.
    if (pendingFlashRef.current != null) {
      const line = pendingFlashRef.current;
      pendingFlashRef.current = null;
      const t = window.setTimeout(() => flashLine(line), 40);
      return () => clearTimeout(t);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSource]);

  useEffect(() => { navRef.current = nav; }, [nav]);
  useEffect(() => { if (!modDown) clearNavHover(); }, [modDown]);

  // ── Navigation history (open file + Back/Forward) ──
  const openFile = (path: string | null) => {
    setSelectedSource(path);
    if (!path) return;
    const { stack, index } = navRef.current;
    if (stack[index] === path) return;
    const next = stack.slice(0, index + 1);
    next.push(path);
    const newNav = { stack: next, index: next.length - 1 };
    navRef.current = newNav;
    setNav(newNav);
  };

  const navBack = () => {
    const { stack, index } = navRef.current;
    if (index <= 0) return;
    const ni = index - 1;
    const newNav = { stack, index: ni };
    navRef.current = newNav;
    setNav(newNav);
    setSelectedSource(stack[ni]);
  };

  const navForward = () => {
    const { stack, index } = navRef.current;
    if (index >= stack.length - 1) return;
    const ni = index + 1;
    const newNav = { stack, index: ni };
    navRef.current = newNav;
    setNav(newNav);
    setSelectedSource(stack[ni]);
  };

  const LINE_ID = (n: number) => `srcln-${n}`;
  const flashLine = (line: number) => {
    const el = document.getElementById(LINE_ID(line));
    if (!el) return;
    el.scrollIntoView({ block: 'center' });
    el.classList.add('line-flash');
    window.setTimeout(() => el.classList.remove('line-flash'), 1200);
  };

  const showToast = (msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2200);
  };

  const clearNavHover = () => {
    if (navHoverElRef.current) {
      navHoverElRef.current.classList.remove('nav-link');
      navHoverElRef.current = null;
    }
  };

  // Global keyboard shortcuts: Quick Open, Back/Forward, Escape.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && (e.key === 'p' || e.key === 'P')) {
        if (decompiled) { e.preventDefault(); setQuickOpen(o => !o); setQuickQuery(''); setQuickIndex(0); }
        return;
      }
      if (e.key === 'Escape') { setQuickOpen(false); setOutlineOpen(false); return; }
      if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); navBack(); return; }
      if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); navForward(); return; }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decompiled]);

  // Mouse back/forward buttons.
  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      if (e.button === 3) { e.preventDefault(); navBack(); }
      else if (e.button === 4) { e.preventDefault(); navForward(); }
    };
    window.addEventListener('mousedown', onDown);
    return () => window.removeEventListener('mousedown', onDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetAll = () => {
    setDiffResult(null);
    setJar1File(null);
    setJar2File(null);
    setSelectedFile(null);
    setSelectedType(null);
    setDecompiled(null);
    setDecompiledMeta(null);
    setSrcJar(null);
    setSelectedSource(null);
    setCollapsedDirs(new Set());
    setSourceQuery('');
    setJfrFile(null);
    setJfrResult(null);
    setProgressText('');
    navRef.current = { stack: [], index: -1 };
    setNav({ stack: [], index: -1 });
    setQuickOpen(false);
    setOutlineOpen(false);
    setToast(null);
  };

  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    resetAll();
  };

  // Back to the landing screen (clears results and returns to the default mode).
  const goHome = () => {
    resetAll();
    setMode('compare');
  };

  const handleDrag = (e: React.DragEvent, set: (v: boolean) => void) => {
    e.preventDefault();
    e.stopPropagation();
    set(e.type === 'dragenter' || e.type === 'dragover');
  };

  const handleDrop = (
    e: React.DragEvent,
    setFile: (f: File | null) => void,
    setActive: (v: boolean) => void,
    exts: string | string[] = '.jar',
  ) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(false);
    const file = e.dataTransfer.files?.[0];
    if (file) {
      const name = file.name.toLowerCase();
      const ok = Array.isArray(exts) ? exts.some(x => name.endsWith(x)) : name.endsWith(exts);
      if (ok) setFile(file);
      else alert(`Please drop a valid ${Array.isArray(exts) ? exts.join(' or ') : exts} file`);
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
      const parsed = JSON.parse(jsonResult) as { files: Record<string, DecompiledFile>; meta?: JarMeta };
      const files = parsed.files || {};
      setDecompiled(files);
      setDecompiledMeta(parsed.meta || null);
      // fresh navigation history for the new jar
      navRef.current = { stack: [], index: -1 };
      setNav({ stack: [], index: -1 });
      // auto-select first .java source for instant feedback
      const firstJava = Object.keys(files).sort().find(p => p.endsWith('.java'));
      openFile(firstJava || Object.keys(files).sort()[0] || null);
    } catch (e) {
      console.error(e);
      alert('Error decompiling jar: ' + e);
    } finally {
      setIsProcessing(false);
      setProgressText('');
    }
  };

  const handleProfile = async () => {
    if (!jfrFile) return;
    setIsProcessing(true);
    setProgressText('Parsing recording…');
    try {
      // JFR parsing is pure client-side data work — no CheerpJ/JVM needed.
      const buf = await jfrFile.arrayBuffer();
      const result = parseJfr(buf);
      setJfrResult(result);
    } catch (e) {
      console.error(e);
      alert('Could not parse this .jfr file: ' + e);
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
    a.download = srcJar.name.replace(/\.(jar|war|ear)$/i, '') + '-sources.zip';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  // ── Single decompiled-file actions ──────────────────────────────────────
  const mimeForPath = (p: string): string => {
    const ext = p.split('.').pop()?.toLowerCase();
    switch (ext) {
      case 'java': case 'kt': case 'scala': case 'groovy': case 'properties':
      case 'txt': case 'md': return 'text/plain;charset=utf-8';
      case 'xml': case 'xsd': case 'wsdl': case 'pom': return 'application/xml;charset=utf-8';
      case 'html': case 'htm': return 'text/html;charset=utf-8';
      case 'json': return 'application/json;charset=utf-8';
      case 'css': return 'text/css;charset=utf-8';
      case 'js': return 'text/javascript;charset=utf-8';
      default: return 'application/octet-stream';
    }
  };

  const fileToBlob = (path: string, f: DecompiledFile): Blob => {
    if (f.encoding === 'base64') {
      const bin = atob(f.content);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return new Blob([bytes], { type: mimeForPath(path) });
    }
    return new Blob([f.content], { type: mimeForPath(path) });
  };

  const copySource = async (content: string) => {
    try {
      await navigator.clipboard.writeText(content);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      alert('Copy failed — your browser blocked clipboard access.');
    }
  };

  const downloadSingle = (path: string, f: DecompiledFile) => {
    const url = URL.createObjectURL(fileToBlob(path, f));
    const a = document.createElement('a');
    a.href = url;
    a.download = path.split('/').pop() || 'file';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  const openInNewTab = (path: string, f: DecompiledFile) => {
    // Java/text open nicer as plain text so the browser shows source, not downloads.
    const blob = f.encoding === 'utf8'
      ? new Blob([f.content], { type: 'text/plain;charset=utf-8' })
      : fileToBlob(path, f);
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank', 'noopener,noreferrer');
    // Revoke later so the new tab has time to load.
    setTimeout(() => URL.revokeObjectURL(url), 60000);
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

  // JAR metadata → bottom info bar
  const fmtSize = (n: number) =>
    n >= 1048576 ? (n / 1048576).toFixed(1) + ' MB'
    : n >= 1024 ? (n / 1024).toFixed(1) + ' KB'
    : n + ' B';

  const metaItems: { label: string; value: string }[] = [];
  if (decompiledMeta) {
    const m = decompiledMeta;
    if (m.javaVersion)           metaItems.push({ label: '☕ Java', value: m.javaVersion });
    if (m.multiRelease)          metaItems.push({ label: 'Multi-Release', value: 'yes' });
    if (m.buildDate)             metaItems.push({ label: 'Built', value: m.buildDate });
    if (m.buildJdk)              metaItems.push({ label: 'Build JDK', value: m.buildJdk });
    if (m.mainClass)             metaItems.push({ label: 'Main-Class', value: m.mainClass });
    if (m.maven)                 metaItems.push({ label: 'Maven', value: m.maven });
    if (m.implementationVersion) metaItems.push({ label: 'Impl. version', value: m.implementationVersion });
    if (m.implementationVendor)  metaItems.push({ label: 'Vendor', value: m.implementationVendor });
    if (m.specificationVersion)  metaItems.push({ label: 'Spec. version', value: m.specificationVersion });
    if (typeof m.classCount === 'number')    metaItems.push({ label: 'Classes', value: String(m.classCount) });
    if (typeof m.packageCount === 'number')  metaItems.push({ label: 'Packages', value: String(m.packageCount) });
    if (typeof m.resourceCount === 'number') metaItems.push({ label: 'Resources', value: String(m.resourceCount) });
    if (typeof m.totalSize === 'number')     metaItems.push({ label: 'Size', value: fmtSize(m.totalSize) });
    if (m.signed)                metaItems.push({ label: 'Signed', value: 'yes' });
  }
  const selectedDecompiledFile = selectedSource && decompiled ? decompiled[selectedSource] : null;

  // Index of local decompiled classes: simple name -> paths, plus a set of all
  // .java paths. Used to resolve Ctrl/Cmd-click "go to class" navigation.
  const classIndex = useMemo(() => {
    const bySimple = new Map<string, string[]>();
    const all = new Set<string>();
    if (decompiled) {
      for (const p of Object.keys(decompiled)) {
        if (!p.endsWith('.java')) continue;
        all.add(p);
        const simple = (p.split('/').pop() || '').replace(/\.java$/, '');
        const arr = bySimple.get(simple);
        if (arr) arr.push(p);
        else bySimple.set(simple, [p]);
      }
    }
    return { bySimple, all };
  }, [decompiled]);

  // Resolve a simple class name to a local decompiled file, using (in order)
  // explicit imports, the current package, then wildcard imports. Returns null
  // if it can't be resolved unambiguously to a local class.
  const resolveClass = (name: string, currentPath: string): string | null => {
    if (!decompiled || !/^[A-Za-z_$][\w$]*$/.test(name)) return null;
    const candidates = classIndex.bySimple.get(name);
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    const content = decompiled[currentPath]?.content || '';
    const pkgDir = currentPath.includes('/') ? currentPath.slice(0, currentPath.lastIndexOf('/')) : '';
    const wildcards: string[] = [];
    const importRe = /import\s+(?:static\s+)?([\w.]+)\s*;/g;
    let m: RegExpExecArray | null;
    while ((m = importRe.exec(content))) {
      const seg = m[1].split('.');
      const last = seg[seg.length - 1];
      if (last === '*') { wildcards.push(seg.slice(0, -1).join('/')); continue; }
      if (last === name) {
        const path = m[1].replace(/\./g, '/') + '.java';
        if (classIndex.all.has(path)) return path;
      }
    }
    const samePkg = pkgDir ? `${pkgDir}/${name}.java` : `${name}.java`;
    if (classIndex.all.has(samePkg)) return samePkg;
    for (const w of wildcards) {
      const path = `${w}/${name}.java`;
      if (classIndex.all.has(path)) return path;
    }
    return null; // ambiguous — don't guess
  };

  // Parse the current file into an outline. Used by the structure popup and
  // for same-file member jumps.
  const outline = useMemo(() => {
    if (!selectedSource || !selectedSource.endsWith('.java')) return [] as ReturnType<typeof parseOutline>;
    const content = (decompiled && decompiled[selectedSource]?.encoding === 'utf8')
      ? decompiled[selectedSource].content : '';
    return parseOutline(content);
  }, [selectedSource, decompiled]);

  // Resolve a method/function name to a file + line. Checks the current file
  // outline first, then all other local Java files.
  const resolveMethod = (name: string): { path: string; line: number } | null => {
    if (!decompiled || !selectedSource) return null;
    const local = outline.find(o => o.name === name && o.kind === 'method');
    if (local) return { path: selectedSource, line: local.line };
    for (const path of classIndex.all) {
      if (path === selectedSource) continue;
      const f = decompiled[path];
      if (!f || f.encoding !== 'utf8') continue;
      const members = parseOutline(f.content);
      const match = members.find(o => o.name === name && o.kind === 'method');
      if (match) return { path, line: match.line };
    }
    return null;
  };

  const onSourceClick = (e: React.MouseEvent) => {
    if (!(e.ctrlKey || e.metaKey) || !selectedSource) return;
    const raw = e.target as HTMLElement;
    // Walk up to the nearest Prism token span so we reliably pick up the text.
    const tok = raw.closest?.('.token') as HTMLElement | null;
    const text = ((tok || raw).textContent || '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(text)) return;
    e.preventDefault();

    // 1. Navigate to a local class.
    const dest = resolveClass(text, selectedSource);
    if (dest && dest !== selectedSource) {
      const tgt = decompiled?.[dest]?.content || '';
      const idx = tgt.split('\n').findIndex(l =>
        new RegExp(`\\b(?:class|interface|enum|record)\\s+${text}\\b`).test(l));
      pendingFlashRef.current = idx >= 0 ? idx + 1 : 1;
      openFile(dest);
      return;
    }

    // 2. Same-file member jump (method or field).
    const mem = outline.find(o => o.name === text && o.kind !== 'class')
             || outline.find(o => o.name === text);
    if (mem) { flashLine(mem.line); return; }

    // 3. Cross-file method navigation.
    const resolved = resolveMethod(text);
    if (resolved) {
      if (resolved.path !== selectedSource) {
        pendingFlashRef.current = resolved.line;
        openFile(resolved.path);
      } else {
        flashLine(resolved.line);
      }
      return;
    }

    showToast(`No definition found for “${text}”`);
  };

  const onSourceMouseMove = (e: React.MouseEvent) => {
    if (!modDown || !selectedSource || !selectedSource.endsWith('.java')) { clearNavHover(); return; }
    const raw = e.target as HTMLElement;
    // Walk up to the nearest Prism token span. Prism can nest spans inside
    // class-name / function tokens, so e.target may be a child, not the token.
    const t = raw.closest?.('.token') as HTMLElement | null;
    if (!t) { clearNavHover(); return; }
    if (t === navHoverElRef.current) return;
    clearNavHover();
    const text = (t.textContent || '').trim();
    if (!/^[A-Za-z_$][\w$]*$/.test(text)) return;
    if (t.classList.contains('class-name') && resolveClass(text, selectedSource)) {
      t.classList.add('nav-link');
      navHoverElRef.current = t;
    } else if (t.classList.contains('function') && resolveMethod(text)) {
      t.classList.add('nav-link');
      navHoverElRef.current = t;
    }
  };

  // Quick Open (Ctrl/Cmd+P) fuzzy results over all decompiled files.
  const quickResults = useMemo(() => {
    if (!decompiled) return [] as { path: string }[];
    const paths = Object.keys(decompiled);
    const q = quickQuery.trim();
    if (!q) {
      return paths.filter(p => p.endsWith('.java')).sort().slice(0, 60).map(path => ({ path }));
    }
    const scored: { path: string; score: number }[] = [];
    for (const p of paths) {
      const name = p.split('/').pop() || p;
      const sName = fuzzyScore(q, name);
      const sPath = fuzzyScore(q, p);
      const score = Math.max(sName != null ? sName + 5 : -1, sPath != null ? sPath : -1);
      if (score >= 0) scored.push({ path: p, score });
    }
    scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
    return scored.slice(0, 60);
  }, [quickQuery, decompiled]);

  const onQuickKey = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setQuickIndex(i => Math.min(i + 1, quickResults.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setQuickIndex(i => Math.max(i - 1, 0)); }
    else if (e.key === 'Enter') {
      e.preventDefault();
      const r = quickResults[Math.min(quickIndex, quickResults.length - 1)];
      if (r) { openFile(r.path); setQuickOpen(false); }
    } else if (e.key === 'Escape') {
      setQuickOpen(false);
    }
  };

  // Breadcrumb: clicking a package segment reveals/expands it in the tree.
  const revealDir = (dir: string) => {
    setSourceQuery('');
    setCollapsedDirs(prev => {
      const next = new Set(prev);
      const parts = dir.split('/');
      for (let i = 0; i < parts.length; i++) next.delete(parts.slice(0, i + 1).join('/'));
      return next;
    });
  };

  const renderBreadcrumb = (path: string) => {
    const parts = path.split('/');
    return parts.map((seg, i) => {
      if (i === parts.length - 1) return <span key={i} className="crumb-seg crumb-current">{seg}</span>;
      const dir = parts.slice(0, i + 1).join('/');
      return (
        <React.Fragment key={i}>
          <button className="crumb-seg" onClick={() => revealDir(dir)} title={`Reveal ${dir} in tree`}>{seg}</button>
          <span className="crumb-sep">/</span>
        </React.Fragment>
      );
    });
  };

  const canBack = nav.index > 0;
  const canForward = nav.index < nav.stack.length - 1;

  const decompiledTree = useMemo(
    () => (decompiledPaths.length ? buildTree(decompiledPaths) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [decompiled],
  );

  // Search decompiled files. Results are split into class/file-name matches
  // (a file whose name — i.e. the Java class name — matches the query) and
  // content matches (the query appears inside the file). Case-insensitive.
  const searchResults = useMemo(() => {
    const q = sourceQuery.trim().toLowerCase();
    if (!q || !decompiled) return null;
    const classes: { path: string; count: number }[] = [];
    const contents: { path: string; count: number }[] = [];
    for (const path of Object.keys(decompiled).sort()) {
      const f = decompiled[path];
      const base = (path.split('/').pop() || '').toLowerCase();
      const stem = base.replace(/\.[^.]+$/, ''); // class/file name without extension
      const nameMatch = stem.includes(q) || base.includes(q);
      let count = 0;
      if (f.encoding === 'utf8') {
        const hay = f.content.toLowerCase();
        let idx = hay.indexOf(q);
        while (idx !== -1) { count++; idx = hay.indexOf(q, idx + q.length); }
      }
      if (nameMatch) classes.push({ path, count });
      else if (count > 0) contents.push({ path, count });
    }
    // Java sources first among name matches, then alphabetical.
    classes.sort((a, b) => {
      const aj = a.path.endsWith('.java') ? 0 : 1;
      const bj = b.path.endsWith('.java') ? 0 : 1;
      return aj - bj || a.path.localeCompare(b.path);
    });
    contents.sort((a, b) => b.count - a.count || a.path.localeCompare(b.path));
    return { classes, contents, total: classes.length + contents.length };
  }, [sourceQuery, decompiled]);

  const renderResultRow = ({ path, count }: { path: string; count: number }) => (
    <button
      key={path}
      className={`file-row${selectedSource === path ? ' selected' : ''}`}
      onClick={() => openFile(path)}
      title={path}
    >
      <span className={`file-badge badge-${path.endsWith('.java') ? 'added' : 'nested'}`}>
        {path.endsWith('.java') ? 'J' : 'R'}
      </span>
      <span className="search-row-text">
        <span className="file-row-name">{path.split('/').pop()}</span>
        <span className="search-row-path">{path}</span>
      </span>
      {count > 0 && <span className="search-count">{count}</span>}
    </button>
  );

  // Recursively render a package/path tree. Single-child package chains are
  // collapsed (e.g. com/example/util → com.example.util) like an IDE.
  const renderTree = (node: TreeNode, depth: number): React.ReactNode[] => {
    const children = [...node.children.values()].sort((a, b) => {
      if (a.isFile !== b.isFile) return a.isFile ? 1 : -1; // folders first
      return a.name.localeCompare(b.name);
    });

    return children.map(child => {
      if (!child.isFile) {
        let label = child.name;
        let folder = child;
        while (folder.children.size === 1) {
          const only = [...folder.children.values()][0];
          if (only.isFile) break;
          label += '.' + only.name;
          folder = only;
        }
        const collapsed = collapsedDirs.has(folder.path);
        return (
          <div key={folder.path}>
            <button
              className="tree-row tree-dir"
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => toggleDir(folder.path)}
              title={folder.path}
            >
              <span className="tree-caret">{collapsed ? '▸' : '▾'}</span>
              <span className="tree-icon">🗀</span>
              <span className="tree-name">{label}</span>
            </button>
            {!collapsed && renderTree(folder, depth + 1)}
          </div>
        );
      }
      const isJava = child.path.endsWith('.java');
      return (
        <button
          key={child.path}
          className={`tree-row tree-file${selectedSource === child.path ? ' selected' : ''}`}
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => openFile(child.path)}
          title={child.path}
        >
          <span className={`file-badge badge-${isJava ? 'added' : 'nested'}`}>{isJava ? 'J' : 'R'}</span>
          <span className="tree-name">{child.name}</span>
        </button>
      );
    });
  };

  const hasResults = !!diffResult || !!decompiled || !!jfrResult;

  return (
    <div className={`app${hasResults ? ' has-results' : ''}`}>
      {/* ── Navbar ───────────────────────────────── */}
      <nav className="navbar">
        <div className="navbar-left">
          <button className="navbar-brand" onClick={goHome} title="Back to home">
            <span className="navbar-logo">⬡</span>
            <span className="navbar-title">jar-compare</span>
          </button>

          {!hasResults && (
            <div className="mode-tabs">
              <button className={`mode-tab${mode === 'compare' ? ' active' : ''}`} onClick={() => switchMode('compare')}>Compare</button>
              <button className={`mode-tab${mode === 'decompile' ? ' active' : ''}`} onClick={() => switchMode('decompile')}>Decompile</button>
              <button className={`mode-tab${mode === 'profile' ? ' active' : ''}`} onClick={() => switchMode('profile')}>Profile</button>
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
          {jfrResult && jfrFile && (
            <div className="navbar-jars">
              <span className="jar-pill">{jfrFile.name}</span>
              <span className="jar-arrow">📊 profile</span>
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
          {hasResults && (
            <button className="btn btn-icon" onClick={goHome} title="Home">⌂</button>
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
              <h1 className="upload-title">Compare JAR / WAR / EAR files</h1>
              <p className="upload-sub">Side-by-side diff of classes, resources &amp; nested JARs — runs entirely in your browser</p>
            </div>

            <div className="dropzone-row">
              <div
                className={`dropzone${dragActive1 ? ' drag-active' : ''}${jar1File ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActive1)}
                onDragOver={e  => handleDrag(e, setDragActive1)}
                onDragLeave={e => handleDrag(e, setDragActive1)}
                onDrop={e => handleDrop(e, setJar1File, setDragActive1, ['.jar', '.war', '.ear'])}
              >
                <label>
                  <span className="dz-label">Original JAR / WAR / EAR</span>
                  <span className={`dz-file${jar1File ? ' dz-file--set' : ''}`}>
                    {jar1File ? jar1File.name : 'Drop .jar/.war/.ear or click to browse'}
                  </span>
                  {jar1File && <span className="dz-meta">{(jar1File.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar,.war,.ear" onChange={e => setJar1File(e.target.files?.[0] || null)} />
                </label>
              </div>

              <div className="dz-divider">→</div>

              <div
                className={`dropzone${dragActive2 ? ' drag-active' : ''}${jar2File ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActive2)}
                onDragOver={e  => handleDrag(e, setDragActive2)}
                onDragLeave={e => handleDrag(e, setDragActive2)}
                onDrop={e => handleDrop(e, setJar2File, setDragActive2, ['.jar', '.war', '.ear'])}
              >
                <label>
                  <span className="dz-label">New JAR / WAR / EAR</span>
                  <span className={`dz-file${jar2File ? ' dz-file--set' : ''}`}>
                    {jar2File ? jar2File.name : 'Drop .jar/.war/.ear or click to browse'}
                  </span>
                  {jar2File && <span className="dz-meta">{(jar2File.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar,.war,.ear" onChange={e => setJar2File(e.target.files?.[0] || null)} />
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
              <h1 className="upload-title">Decompile a JAR / WAR / EAR</h1>
              <p className="upload-sub">De-archive &amp; decompile bytecode back to Java source, then download it — all in your browser</p>
            </div>

            <div className="dropzone-row">
              <div
                className={`dropzone dropzone--single${dragActiveD ? ' drag-active' : ''}${srcJar ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActiveD)}
                onDragOver={e  => handleDrag(e, setDragActiveD)}
                onDragLeave={e => handleDrag(e, setDragActiveD)}
                onDrop={e => handleDrop(e, setSrcJar, setDragActiveD, ['.jar', '.war', '.ear'])}
              >
                <label>
                  <span className="dz-label">JAR / WAR / EAR to decompile</span>
                  <span className={`dz-file${srcJar ? ' dz-file--set' : ''}`}>
                    {srcJar ? srcJar.name : 'Drop .jar/.war/.ear or click to browse'}
                  </span>
                  {srcJar && <span className="dz-meta">{(srcJar.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jar,.war,.ear" onChange={e => setSrcJar(e.target.files?.[0] || null)} />
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

      {/* ── Upload page: PROFILE (JFR) ───────────── */}
      {mode === 'profile' && !jfrResult && (
        <main className="upload-page">
          <div className="upload-card">
            <div className="upload-heading">
              <h1 className="upload-title">Analyze a JFR recording</h1>
              <p className="upload-sub">Open a Java Flight Recorder <code>.jfr</code> file and explore a flame graph &amp; hot methods — parsed entirely in your browser</p>
            </div>

            <div className="dropzone-row">
              <div
                className={`dropzone dropzone--single${dragActiveP ? ' drag-active' : ''}${jfrFile ? ' has-file' : ''}`}
                onDragEnter={e => handleDrag(e, setDragActiveP)}
                onDragOver={e  => handleDrag(e, setDragActiveP)}
                onDragLeave={e => handleDrag(e, setDragActiveP)}
                onDrop={e => handleDrop(e, setJfrFile, setDragActiveP, '.jfr')}
              >
                <label>
                  <span className="dz-label">JFR recording</span>
                  <span className={`dz-file${jfrFile ? ' dz-file--set' : ''}`}>
                    {jfrFile ? jfrFile.name : 'Drop .jfr or click to browse'}
                  </span>
                  {jfrFile && <span className="dz-meta">{(jfrFile.size / 1024 / 1024).toFixed(1)} MB</span>}
                  <input type="file" accept=".jfr" onChange={e => setJfrFile(e.target.files?.[0] || null)} />
                </label>
              </div>
            </div>

            <div className="upload-actions">
              <button className="btn btn-primary" disabled={!jfrFile || isProcessing} onClick={handleProfile}>
                {isProcessing ? 'Parsing…' : 'Analyze recording'}
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

      {/* ── Landing usage / SEO content (shown on the home screen) ── */}
      {!hasResults && (
        <>
          <section className="landing" aria-label="About JAR Compare">
            <div className="landing-inner">

              <div className="lc-block">
                <h2 className="lc-h2">How to compare two JAR files</h2>
                <ol className="steps">
                  <li>
                    <span className="step-n">1</span>
                    <div>
                      <strong>Choose two JARs</strong>
                      <p>Drag &amp; drop your original and updated <code>.jar</code> files into the two drop zones, or click to browse.</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-n">2</span>
                    <div>
                      <strong>Run the comparison</strong>
                      <p>Hit <em>Compare JARs</em>. Every entry is hashed and matched to find added, removed and modified files — including JARs nested inside JARs.</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-n">3</span>
                    <div>
                      <strong>Review the diff</strong>
                      <p>Changed classes are decompiled and shown as a side-by-side Java source diff, so you see real code changes — not just bytecode.</p>
                    </div>
                  </li>
                </ol>
              </div>

              <div className="lc-block">
                <h2 className="lc-h2">How to decompile a JAR file</h2>
                <ol className="steps">
                  <li>
                    <span className="step-n">1</span>
                    <div>
                      <strong>Switch to Decompile</strong>
                      <p>Pick the <em>Decompile</em> tab and drop in a single <code>.jar</code> file.</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-n">2</span>
                    <div>
                      <strong>Decompile &amp; extract</strong>
                      <p>The whole archive is decompiled to readable Java source with the CFR decompiler, and every resource is extracted.</p>
                    </div>
                  </li>
                  <li>
                    <span className="step-n">3</span>
                    <div>
                      <strong>Browse &amp; download</strong>
                      <p>Explore sources in a package tree with syntax highlighting, then download everything as a <code>.zip</code>.</p>
                    </div>
                  </li>
                </ol>
              </div>

              <div className="lc-block">
                <h2 className="lc-h2">Features</h2>
                <div className="feature-grid">
                  <div className="feature-card"><h3>📦 Compare JAR files</h3><p>Class-by-class diff of two Java JARs with added / removed / modified detection.</p></div>
                  <div className="feature-card"><h3>🔍 Source-level diffs</h3><p>Changed <code>.class</code> files are decompiled so you read Java, not bytecode.</p></div>
                  <div className="feature-card"><h3>🪆 Nested JARs</h3><p>Recurses into JARs packaged inside JARs, like Spring Boot fat JARs.</p></div>
                  <div className="feature-card"><h3>🧩 Decompile to source</h3><p>Turn any JAR back into a browsable, downloadable Java source tree.</p></div>
                  <div className="feature-card"><h3>📊 JFR flame graphs</h3><p>Open a Java Flight Recorder <code>.jfr</code> file and explore CPU hot methods as an interactive flame graph.</p></div>
                  <div className="feature-card"><h3>🔒 100% private</h3><p>Your JARs never leave your machine — everything runs in the browser.</p></div>
                  <div className="feature-card"><h3>⚡ No install, free</h3><p>No account, no upload, no setup. Open the page and go.</p></div>
                </div>
              </div>

              <div className="lc-block">
                <h2 className="lc-h2">Runs entirely in your browser</h2>
                <p className="lc-prose">
                  JAR Compare runs a real Java Virtual Machine compiled to <strong>WebAssembly</strong> (via CheerpJ)
                  right inside your browser tab. That means your <code>.jar</code> files are <strong>never uploaded</strong> to
                  a server — comparison and decompilation happen locally, keeping proprietary code private. Decompilation is
                  powered by the <strong>CFR</strong> decompiler, the same engine used in the diff view.
                </p>
              </div>

              <div className="lc-block">
                <h2 className="lc-h2">Frequently asked questions</h2>
                <div className="faq">
                  <details>
                    <summary>Is JAR Compare free?</summary>
                    <p>Yes — it's completely free, with no account or sign-up required.</p>
                  </details>
                  <details>
                    <summary>Are my JAR files uploaded anywhere?</summary>
                    <p>No. All processing happens in your browser using WebAssembly. Your files never leave your device.</p>
                  </details>
                  <details>
                    <summary>Can it compare Spring Boot or fat/uber JARs?</summary>
                    <p>Yes. JAR Compare recurses into nested JARs (e.g. <code>BOOT-INF/lib</code>) and diffs their contents too.</p>
                  </details>
                  <details>
                    <summary>How does it show source diffs from compiled classes?</summary>
                    <p>Changed <code>.class</code> files are decompiled to Java with CFR, then shown as a side-by-side source diff.</p>
                  </details>
                  <details>
                    <summary>Can I download the decompiled source?</summary>
                    <p>Yes. In Decompile mode you can browse the package tree and download the full source as a <code>.zip</code>.</p>
                  </details>
                </div>
              </div>

            </div>
          </section>

          <footer className="site-footer">
            <span>JAR Compare — compare &amp; decompile Java JAR files, free and in your browser.</span>
            <a href="https://github.com/Emindu/jar-compare" target="_blank" rel="noopener noreferrer">View on GitHub ↗</a>
          </footer>
        </>
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
              <div className="file-search">
                <input
                  type="text"
                  className="file-search-input"
                  placeholder="Search class name or contents…"
                  value={sourceQuery}
                  onChange={e => setSourceQuery(e.target.value)}
                  spellCheck={false}
                  autoComplete="off"
                />
                {sourceQuery && (
                  <button className="file-search-clear" onClick={() => setSourceQuery('')} title="Clear search">✕</button>
                )}
              </div>
              {searchResults ? (
                <div className="file-list">
                  {searchResults.total === 0 && (
                    <div className="search-empty">No matches.</div>
                  )}
                  {searchResults.classes.length > 0 && (
                    <>
                      <div className="file-section-label search-summary">
                        Class &amp; file names
                        <span className="file-section-count">{searchResults.classes.length}</span>
                      </div>
                      {searchResults.classes.map(renderResultRow)}
                    </>
                  )}
                  {searchResults.contents.length > 0 && (
                    <>
                      <div className="file-section-label search-summary">
                        In file contents
                        <span className="file-section-count">{searchResults.contents.length}</span>
                      </div>
                      {searchResults.contents.map(renderResultRow)}
                    </>
                  )}
                </div>
              ) : (
                <div className="file-list file-tree">
                  {decompiledTree && renderTree(decompiledTree, 0)}
                </div>
              )}
              <div className="panel-hints">
                <span><kbd>⌘</kbd>/<kbd>Ctrl</kbd>+<kbd>P</kbd> go to class</span>
                <span><kbd>⌘</kbd>/<kbd>Ctrl</kbd>-click a class to jump</span>
                <span><kbd>Alt</kbd>+<kbd>←</kbd>/<kbd>→</kbd> back / forward</span>
              </div>
            </aside>

            <div className="diff-panel">
              {selectedSource && selectedDecompiledFile ? (
                <div className="diff-view">
                  <div className="diff-panel-hd">
                    <div className="nav-controls">
                      <button className="nav-btn" disabled={!canBack} onClick={navBack} title="Back (Alt+←)">◀</button>
                      <button className="nav-btn" disabled={!canForward} onClick={navForward} title="Forward (Alt+→)">▶</button>
                    </div>
                    <span className="diff-crumb">{renderBreadcrumb(selectedSource)}</span>
                    <div className="file-actions">
                      {selectedSource.endsWith('.java') && (
                        <div className="outline-anchor">
                          <button
                            className={`file-action-btn${outlineOpen ? ' active' : ''}`}
                            onClick={() => setOutlineOpen(o => !o)}
                            title="Outline / structure"
                          >
                            ☰ Outline
                          </button>
                          {outlineOpen && (
                            <div className="outline-pop">
                              <div className="outline-hd">Structure</div>
                              <div className="outline-list">
                                {outline.length === 0 && <div className="outline-empty">No members found</div>}
                                {outline.map((o, i) => (
                                  <button
                                    key={`${o.name}-${o.line}-${i}`}
                                    className={`outline-row kind-${o.kind}`}
                                    onClick={() => { flashLine(o.line); setOutlineOpen(false); }}
                                  >
                                    <span className="outline-icon">{o.kind === 'method' ? 'ƒ' : o.kind === 'field' ? '▪' : '◆'}</span>
                                    <span className="outline-name">{o.name}</span>
                                    <span className="outline-line">{o.line}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                      <span className={`diff-type-badge badge-${selectedSource.endsWith('.java') ? 'added' : 'nested'}`}>
                        {selectedSource.endsWith('.java') ? 'Java source' : 'Resource'}
                      </span>
                      {selectedDecompiledFile.encoding === 'utf8' && (
                        <button
                          className="file-action-btn"
                          onClick={() => copySource(selectedDecompiledFile.content)}
                          title="Copy to clipboard"
                        >
                          {copied ? '✓ Copied' : '⧉ Copy'}
                        </button>
                      )}
                      <button
                        className="file-action-btn"
                        onClick={() => downloadSingle(selectedSource, selectedDecompiledFile)}
                        title="Download this file"
                      >
                        ⇣ Download
                      </button>
                      <button
                        className="file-action-btn"
                        onClick={() => openInNewTab(selectedSource, selectedDecompiledFile)}
                        title="Open in new tab"
                      >
                        ↗ Open
                      </button>
                    </div>
                  </div>
                  <div className="diff-body" ref={sourceScrollRef}>
                    {selectedDecompiledFile.encoding === 'base64' ? (
                      <div className="diff-empty">
                        <span className="diff-empty-icon">▢</span>
                        <p>Binary file — not previewable</p>
                        <p className="diff-empty-sub">Included in the downloaded archive</p>
                      </div>
                    ) : (
                      <div
                        className={`source-nav${modDown && selectedSource.endsWith('.java') ? ' mod-down' : ''}`}
                        onClick={onSourceClick}
                        onMouseMove={onSourceMouseMove}
                        onMouseLeave={clearNavHover}
                      >
                        <SyntaxHighlighter
                          language={langForPath(selectedSource)}
                          style={theme === 'dark' ? oneDark : oneLight}
                          showLineNumbers
                          wrapLongLines={false}
                          wrapLines
                          lineProps={(n: number) => ({ id: LINE_ID(n) })}
                          customStyle={{
                            margin: 0,
                            background: 'transparent',
                            padding: '1rem 1.25rem',
                            fontSize: '0.82rem',
                          }}
                          codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
                          lineNumberStyle={{ color: 'var(--text-muted)', opacity: 0.5, minWidth: '2.5em' }}
                        >
                          {selectedDecompiledFile.content}
                        </SyntaxHighlighter>
                      </div>
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

          {metaItems.length > 0 && (
            <div className="meta-bar" aria-label="JAR metadata">
              {metaItems.map(it => (
                <span className="meta-item" key={it.label}>
                  <span className="meta-label">{it.label}</span>
                  <span className="meta-value">{it.value}</span>
                </span>
              ))}
            </div>
          )}
        </>
      )}

      {/* ── Results: PROFILE (JFR) ───────────────── */}
      {jfrResult && <Profiler result={jfrResult} />}

      {/* ── Quick Open (Ctrl/Cmd+P) ── */}
      {quickOpen && (
        <div className="qo-overlay" onClick={() => setQuickOpen(false)}>
          <div className="qo-modal" onClick={e => e.stopPropagation()}>
            <input
              autoFocus
              className="qo-input"
              placeholder="Go to class…"
              value={quickQuery}
              onChange={e => { setQuickQuery(e.target.value); setQuickIndex(0); }}
              onKeyDown={onQuickKey}
              spellCheck={false}
            />
            <div className="qo-list">
              {quickResults.length === 0 && <div className="qo-empty">No matching files</div>}
              {quickResults.map((r, i) => (
                <button
                  key={r.path}
                  className={`qo-row${i === Math.min(quickIndex, quickResults.length - 1) ? ' active' : ''}`}
                  onMouseEnter={() => setQuickIndex(i)}
                  onClick={() => { openFile(r.path); setQuickOpen(false); }}
                >
                  <span className={`file-badge badge-${r.path.endsWith('.java') ? 'added' : 'nested'}`}>
                    {r.path.endsWith('.java') ? 'J' : 'R'}
                  </span>
                  <span className="qo-name">{r.path.split('/').pop()}</span>
                  <span className="qo-path">{r.path}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {toast && <div className="nav-toast">{toast}</div>}
    </div>
  );
}
