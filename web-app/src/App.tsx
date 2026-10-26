import React, { useState, useEffect, useMemo, useRef } from 'react';
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
import MarkdownWorkspace from './MarkdownWorkspace';
import Intake from './Intake';
import CompareView, { type CompareStatus } from './CompareView';
import { type DiffResult } from './diffModel';
import { kindOf, letterFor, packageOf, parseOutline, parseManifest, splitArchive, type SourceKind } from './decompileModel';
import { ArrowLeft, ArrowRight, GitCompare, FileDown, ClipboardCopy } from 'lucide-react';
import Home from './Home';
import { TitleBar, ActivityBar, StatusBar, ThemeButton } from './Workbench';
import { MOD, TOOLS, type Tool, type JvmState } from './shell';
import { loadRecent, addRecent, clearRecent, type RecentItem } from './recent';
import { Download, RotateCcw, ExternalLink, Search, X } from 'lucide-react';
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

type Mode = Tool;

// One shared CheerpJ initialization: callers that arrive while it is still
// starting wait for the same promise instead of racing ahead of it.
let jvmInit: Promise<void> | null = null;
function startJvm(): Promise<void> {
  if (!jvmInit) {
    window.__cheerpjInitializing = true;
    jvmInit = window.cheerpjInit().catch(e => { jvmInit = null; throw e; });
  }
  return jvmInit;
}

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

// A path that points at a nested Java archive (jar/war/ear) we can drill into.
function isArchivePath(p: string): boolean {
  return /\.(jar|war|ear)$/i.test(p);
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

// Merge a nested archive's sub-comparison into the parent diff. Every sub-path
// is prefixed with `pfx` (e.g. "BOOT-INF/lib/foo.jar -> "); modified classes are
// split into real source changes vs. identical-decompiled-source, matching the
// top-level handleCompare logic.
function mergeNestedDiff(prev: DiffResult, pfx: string, sub: DiffResult): DiffResult {
  const contents = { ...prev.contents };
  for (const [k, v] of Object.entries(sub.contents || {})) contents[pfx + k] = v;

  const modClasses: string[] = [];
  const identical: string[] = [];
  for (const cls of sub.modifiedClasses || []) {
    const c = sub.contents?.[cls];
    if (c && (c.content1 || '') === (c.content2 || '')) identical.push(pfx + cls);
    else modClasses.push(pfx + cls);
  }

  return {
    added:                  [...prev.added, ...(sub.added || []).map(s => pfx + s)],
    removed:                [...prev.removed, ...(sub.removed || []).map(s => pfx + s)],
    modified:               [...prev.modified, ...(sub.modified || []).map(s => pfx + s)],
    modifiedClasses:        [...prev.modifiedClasses, ...modClasses],
    identicalSourceClasses: [...prev.identicalSourceClasses, ...identical],
    nestedChanges:          prev.nestedChanges,
    modifiedNested:         [...prev.modifiedNested, ...(sub.modifiedNested || []).map(s => pfx + s)],
    contents,
  };
}

// Timestamps for measuring a job (kept outside the component; jobs run in handlers).
const now = () => performance.now();

const allChanged = (d: DiffResult) =>
  d.modifiedClasses.length + d.modified.length + d.added.length + d.removed.length
  + d.identicalSourceClasses.length + d.nestedChanges.length + d.modifiedNested.length;

export default function App() {
  const [mode, setMode] = useState<Mode>('home');
  const [jvm, setJvm] = useState<JvmState>(() => (typeof window.cheerpjInit === 'undefined' ? 'unavailable' : 'loading'));
  const [busyTool, setBusyTool] = useState<Tool | null>(null);
  const [jobError, setJobError] = useState<{ tool: Tool; message: string } | null>(null);
  const [recent, setRecent] = useState<RecentItem[]>(loadRecent);
  const [compareMs, setCompareMs] = useState<number | null>(null);
  const [decompileMs, setDecompileMs] = useState<number | null>(null);
  const [explorerView, setExplorerView] = useState<'packages' | 'files'>('packages');
  const [srcTabs, setSrcTabs] = useState<string[]>([]);
  const explorerFilterRef = useRef<HTMLInputElement>(null);
  const [compareStatus, setCompareStatus] = useState<CompareStatus | null>(null);
  const [mdIncoming, setMdIncoming] = useState<{ id: number; name: string; text: string } | null>(null);
  const openPicker = useRef<HTMLInputElement>(null);
  const remember = (kind: Exclude<Tool, 'home'>, label: string) => setRecent(addRecent(kind, label));

  // shared
  const [isProcessing, setIsProcessing] = useState(false);
  const [progressText, setProgressText] = useState('');
  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    try {
      const saved = localStorage.getItem('theme');
      if (saved === 'light' || saved === 'dark') return saved;
    } catch { /* storage unavailable */ }
    return window.matchMedia?.('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
  });

  // compare state
  const [jar1File, setJar1File] = useState<File | null>(null);
  const [jar2File, setJar2File] = useState<File | null>(null);
  const [diffResult, setDiffResult] = useState<DiffResult | null>(null);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [expandingNested, setExpandingNested] = useState<string | null>(null); // nested archive being compared
  const [expandedNested, setExpandedNested] = useState<Set<string>>(new Set()); // nested archives already drilled into

  // decompile state
  const [srcJar, setSrcJar] = useState<File | null>(null);
  const [decompiled, setDecompiled] = useState<Record<string, DecompiledFile> | null>(null);
  const [decompiledMeta, setDecompiledMeta] = useState<JarMeta | null>(null);
  const [selectedSource, setSelectedSource] = useState<string | null>(null);
  const [collapsedDirs, setCollapsedDirs] = useState<Set<string>>(new Set());
  const [sourceQuery, setSourceQuery] = useState('');
  const [copied, setCopied] = useState(false);
  const [modDown, setModDown] = useState(false); // Ctrl/Cmd held → nav affordance
  const [expandingArchive, setExpandingArchive] = useState<string | null>(null); // nested jar being decompiled
  const nestedSeq = useRef(0); // unique CheerpJ temp-file names for nested jars
  const sourceScrollRef = useRef<HTMLDivElement | null>(null);

  // profile (JFR) state
  const [jfrFile, setJfrFile] = useState<File | null>(null);
  const [jfrResult, setJfrResult] = useState<JfrResult | null>(null);

  // IDE navigation: history, quick-open, outline, toast
  const [nav, setNav] = useState<{ stack: string[]; index: number }>({ stack: [], index: -1 });
  const navRef = useRef(nav);
  const [quickOpen, setQuickOpen] = useState(false);
  const [quickQuery, setQuickQuery] = useState('');
  const [quickIndex, setQuickIndex] = useState(0);
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
    try { localStorage.setItem('theme', theme); } catch { /* storage unavailable */ }
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
    setSrcTabs(tabs => (tabs.includes(path) ? tabs : [...tabs, path]));
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
      if (e.key === 'Escape') { setQuickOpen(false); return; }
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

  const resetCompare = () => {
    setDiffResult(null);
    setJar1File(null);
    setJar2File(null);
    setSelectedFile(null);
    setExpandingNested(null);
    setExpandedNested(new Set());
  };

  const resetCompareResults = () => {
    setDiffResult(null);
    setSelectedFile(null);
    setExpandingNested(null);
    setExpandedNested(new Set());
  };

  const resetDecompile = () => {
    setDecompiled(null);
    setDecompiledMeta(null);
    setSrcJar(null);
    setSelectedSource(null);
    setSrcTabs([]);
    setCollapsedDirs(new Set());
    setExpandingArchive(null);
    setSourceQuery('');
    navRef.current = { stack: [], index: -1 };
    setNav({ stack: [], index: -1 });
    setQuickOpen(false);
  };

  const resetProfile = () => {
    setJfrFile(null);
    setJfrResult(null);
  };

  // Tools keep their state when you switch between them; each has its own "New".
  const switchMode = (m: Mode) => {
    if (m === mode) return;
    setMode(m);
    setToast(null);
  };

  /** Send files to the right tool by extension; returns an error message if none apply. */
  const routeFiles = (files: File[]): string | null => {
    const is = (f: File, re: RegExp) => re.test(f.name.toLowerCase());
    const archives = files.filter(f => is(f, /\.(jar|war|ear)$/));
    const jfr = files.find(f => is(f, /\.jfr$/));
    const md = files.find(f => is(f, /\.(md|markdown)$/));
    setJobError(null);
    if (archives.length >= 2) {
      setJar1File(archives[0]);
      setJar2File(archives[1]);
      setMode('compare');
      handleCompare(archives[0], archives[1]);
    } else if (archives.length === 1) {
      setSrcJar(archives[0]);
      setMode('decompile');
      handleDecompile(archives[0]);
    } else if (jfr) {
      setJfrFile(jfr);
      setMode('profile');
      handleProfile(jfr);
    } else if (md) {
      md.text().then(text => {
        setMdIncoming({ id: Date.now(), name: md.name, text });
        remember('markdown', md.name);
        setMode('markdown');
      });
    } else {
      return `${files.length === 1 ? files[0].name : `None of these ${files.length} files`} can't be opened here. Use .jar, .war, .ear, .jfr or .md.`;
    }
    return null;
  };

  // Start the JVM in the background so it is warm by the time a file arrives.
  useEffect(() => {
    if (typeof window.cheerpjInit === 'undefined') return;
    startJvm()
      .then(() => setJvm('ready'))
      .catch(e => { console.error('Failed to initialize CheerpJ', e); setJvm('error'); });
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
    if (typeof window.cheerpjInit === 'undefined') {
      setJvm('unavailable');
      throw new Error('the in-browser Java runtime did not load. It is downloaded once from cjrtnc.leaningtech.com; check your connection or content blocker, then reload');
    }
    try {
      await startJvm(); // waits for an initialization already in progress
      setJvm('ready');
    } catch (e) {
      setJvm('error');
      throw e;
    }
  };

  const handleCompare = async (jarA: File | null = jar1File, jarB: File | null = jar2File) => {
    if (!jarA || !jarB) return;
    setIsProcessing(true);
    setBusyTool('compare');
    setJobError(null);
    const started = now();
    setProgressText('Preparing environments...');
    try {
      const b1 = await jarA.arrayBuffer();
      const b2 = await jarB.arrayBuffer();
      await ensureCheerpJ();
      window.cheerpOSAddStringFile('/str/jar1.jar', new Uint8Array(b1));
      window.cheerpOSAddStringFile('/str/jar2.jar', new Uint8Array(b2));

      const jsonResult = await runJava('com.jarcompare.WebJarComparer', '/str/jar1.jar', '/str/jar2.jar');
      const parsed: DiffResult = JSON.parse(jsonResult);
      parsed.identicalSourceClasses = [];
      parsed.nestedChanges = [];
      parsed.modifiedNested = parsed.modifiedNested || [];

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
      remember('compare', `${jarA.name} → ${jarB.name}`);
      setCompareMs(now() - started);
    } catch (e) {
      console.error(e);
      setJobError({ tool: 'compare', message: `could not compare these archives: ${e instanceof Error ? e.message : e}` });
    } finally {
      setIsProcessing(false);
      setBusyTool(null);
      setProgressText('');
    }
  };

  // Walk a nested-archive path (segments joined by " -> ") into a jar file and
  // return the innermost archive's raw bytes, using JSZip in the browser.
  const extractNestedArchive = async (file: File, chain: string[]): Promise<Uint8Array | null> => {
    let data: Uint8Array<ArrayBufferLike> = new Uint8Array(await file.arrayBuffer());
    for (const seg of chain) {
      const zip = await JSZip.loadAsync(data);
      const entry = zip.file(seg);
      if (!entry) return null;
      data = await entry.async('uint8array');
    }
    return data;
  };

  // Drill into a changed nested archive: extract both sides from the original
  // jars, re-run the comparer on them, and merge the sub-diff back into the
  // results (paths prefixed with the archive path). Mirrors the Decompile-tab
  // nested-jar feature, but produces an inline diff instead of a single view.
  const compareNested = async (path: string) => {
    if (!diffResult || !jar1File || !jar2File || expandingNested) return;
    if (expandedNested.has(path)) {                    // already merged — jump to first change
      const first = diffResult.modifiedClasses.find(p => p.startsWith(path + ' -> '))
                 || diffResult.modified.find(p => p.startsWith(path + ' -> '))
                 || diffResult.added.find(p => p.startsWith(path + ' -> '))
                 || diffResult.removed.find(p => p.startsWith(path + ' -> '));
      if (first) setSelectedFile(first);
      return;
    }

    const chain = path.split(' -> ');
    const label = (chain[chain.length - 1].split('/').pop()) || 'archive';
    setExpandingNested(path);
    setProgressText(`Comparing ${label} …`);
    try {
      const [a, b] = await Promise.all([
        extractNestedArchive(jar1File, chain),
        extractNestedArchive(jar2File, chain),
      ]);
      if (!a || !b) { showToast(`Could not extract ${label} from both jars`); return; }

      await ensureCheerpJ();
      const id = nestedSeq.current++;
      const p1 = `/str/cmp1-${id}.jar`, p2 = `/str/cmp2-${id}.jar`;
      window.cheerpOSAddStringFile(p1, a);
      window.cheerpOSAddStringFile(p2, b);

      const jsonResult = await runJava('com.jarcompare.WebJarComparer', p1, p2);
      const sub = JSON.parse(jsonResult) as DiffResult;

      const pfx = path + ' -> ';
      const merged = mergeNestedDiff(diffResult, pfx, sub);
      setDiffResult(merged);
      setExpandedNested(prev => new Set(prev).add(path));

      // Auto-open the first change from this archive. Select from `merged`
      // directly — diffResult state won't have updated yet this tick.
      const first = merged.modifiedClasses.find(p => p.startsWith(pfx))
                 || merged.modified.find(p => p.startsWith(pfx))
                 || merged.added.find(p => p.startsWith(pfx))
                 || merged.removed.find(p => p.startsWith(pfx));
      if (first) setSelectedFile(first);

      const changed = (sub.modifiedClasses?.length || 0) + (sub.modified?.length || 0)
                    + (sub.added?.length || 0) + (sub.removed?.length || 0);
      showToast(changed ? `${label}: ${changed} change${changed === 1 ? '' : 's'}` : `${label}: no source changes`);
    } catch (e) {
      console.error(e);
      showToast(`Could not compare ${label}`);
    } finally {
      setExpandingNested(null);
      setProgressText('');
    }
  };

  const handleDecompile = async (jar: File | null = srcJar) => {
    if (!jar) return;
    setIsProcessing(true);
    setBusyTool('decompile');
    setJobError(null);
    setSrcTabs([]);
    const started = now();
    setProgressText('Preparing environment...');
    try {
      const buf = await jar.arrayBuffer();
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
      remember('decompile', jar.name);
      setDecompileMs(now() - started);
    } catch (e) {
      console.error(e);
      setJobError({ tool: 'decompile', message: `could not decompile this archive: ${e instanceof Error ? e.message : e}` });
    } finally {
      setIsProcessing(false);
      setBusyTool(null);
      setProgressText('');
    }
  };

  // Decode a base64 string to raw bytes (for feeding a nested jar back to CheerpJ).
  const base64ToBytes = (b64: string): Uint8Array => {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
  };

  // Drill into a nested jar/war/ear: decompile it with the same Java workflow and
  // merge the results back into the tree, keyed under the archive's own path so
  // its contents render as an expandable node beneath it.
  const decompileNested = async (path: string) => {
    if (!decompiled || expandingArchive) return;
    const f = decompiled[path];
    if (!f) return;

    // Already expanded? Just make sure it's revealed.
    const prefix = path + '/';
    if (Object.keys(decompiled).some(k => k.startsWith(prefix))) {
      setCollapsedDirs(prev => { const n = new Set(prev); n.delete(path); return n; });
      return;
    }
    if (f.encoding !== 'base64') { showToast('Not a binary archive'); return; }

    const label = path.split('/').pop() || 'archive';
    setExpandingArchive(path);
    setProgressText(`Decompiling ${label} …`);
    try {
      const bytes = base64ToBytes(f.content);
      await ensureCheerpJ();
      const tmp = `/str/nested-${nestedSeq.current++}.jar`;
      window.cheerpOSAddStringFile(tmp, bytes);

      const jsonResult = await runJava('com.jarcompare.WebJarDecompiler', tmp);
      const parsed = JSON.parse(jsonResult) as { files: Record<string, DecompiledFile> };
      const inner = parsed.files || {};
      const count = Object.keys(inner).length;
      if (count === 0) { showToast(`Nothing to decompile in ${label}`); return; }

      setDecompiled(prev => {
        const next = { ...(prev || {}) };
        for (const [ip, ifile] of Object.entries(inner)) next[prefix + ip] = ifile;
        return next;
      });
      setCollapsedDirs(prev => { const n = new Set(prev); n.delete(path); return n; });

      // Open the first source of the nested archive for instant feedback.
      const firstJava = Object.keys(inner).sort().find(p => p.endsWith('.java'));
      const firstAny = firstJava || Object.keys(inner).sort()[0];
      if (firstAny) openFile(prefix + firstAny);
      showToast(`Decompiled ${count} files from ${label}`);
    } catch (e) {
      console.error(e);
      showToast(`Could not decompile ${label}`);
    } finally {
      setExpandingArchive(null);
      setProgressText('');
    }
  };

  const handleProfile = async (recording: File | null = jfrFile) => {
    if (!recording) return;
    setIsProcessing(true);
    setBusyTool('profile');
    setJobError(null);
    setProgressText('Parsing recording…');
    try {
      // JFR parsing is pure client-side data work — no CheerpJ/JVM needed.
      const buf = await recording.arrayBuffer();
      const result = parseJfr(buf);
      setJfrResult(result);
      remember('profile', recording.name);
    } catch (e) {
      console.error(e);
      setJobError({ tool: 'profile', message: `could not read this recording: ${e instanceof Error ? e.message : e}` });
    } finally {
      setIsProcessing(false);
      setBusyTool(null);
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
    if (m.javaVersion)           metaItems.push({ label: 'Java', value: m.javaVersion });
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

  // What each Java source declares (class, interface, record, enum, annotation).
  const sourceKinds = useMemo(() => {
    const m = new Map<string, SourceKind>();
    if (!decompiled) return m;
    for (const [path, f] of Object.entries(decompiled)) {
      if (path.endsWith('.java') && f.encoding === 'utf8') {
        const k = kindOf(f.content);
        if (k) m.set(path, k.kind);
      }
    }
    return m;
  }, [decompiled]);

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
          <button className="crumb-seg" onClick={() => { setExplorerView('files'); revealDir(dir); }} title={`Reveal ${dir} in the file tree`}>{seg}</button>
          <span className="crumb-sep">›</span>
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
      <span className={`dv-letter ${letterFor(path, sourceKinds.get(path)).tone}`}>{letterFor(path, sourceKinds.get(path)).letter}</span>
      <span className="search-row-text">
        <span className="file-row-name">{path.split('/').pop()}</span>
        <span className="search-row-path">{path}</span>
      </span>
      {count > 0 && <span className="search-count">{count}</span>}
    </button>
  );


  // Inspector data for the open source.
  const selectedText = selectedDecompiledFile?.encoding === 'utf8' ? selectedDecompiledFile.content : '';
  const classInfo = useMemo(() => {
    if (!selectedSource?.endsWith('.java') || !selectedText) return null;
    const k = kindOf(selectedText);
    return { kind: k?.kind ?? 'class', header: k?.header ?? '', name: k?.name ?? '', lines: selectedText.split('\n').length, size: selectedText.length };
  }, [selectedSource, selectedText]);
  const referencedBy = useMemo(() => {
    if (!decompiled || !classInfo?.name) return [];
    const re = new RegExp(`\\b${classInfo.name.replace(/\$/g, '\\$')}\\b`);
    const out: string[] = [];
    for (const [path, f] of Object.entries(decompiled)) {
      if (path === selectedSource || !path.endsWith('.java') || f.encoding !== 'utf8') continue;
      if (re.test(f.content)) out.push(path);
      if (out.length >= 12) break;
    }
    return out.sort();
  }, [decompiled, classInfo, selectedSource]);
  const manifest = useMemo(() => {
    const f = decompiled?.['META-INF/MANIFEST.MF'];
    return f && f.encoding === 'utf8' ? parseManifest(f.content).filter(e => e.key !== 'Manifest-Version' && e.key !== 'Created-By') : [];
  }, [decompiled]);

  // Packages view: sources grouped by package, then resources, nested archives and META-INF.
  const packageGroups = useMemo(() => {
    const pkgs = new Map<string, string[]>();
    const resources: string[] = [];
    const archives = new Map<string, string[]>();
    const meta: string[] = [];
    for (const path of decompiledPaths) {
      const { archive, inner } = splitArchive(path);
      if (path.endsWith('.java')) {
        const key = packageOf(path);
        pkgs.set(key, [...(pkgs.get(key) ?? []), path]);
      } else if (isArchivePath(path) && !archive) {
        const dir = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '(root)';
        archives.set(dir, [...(archives.get(dir) ?? []), path]);
      } else if (!archive && inner.startsWith('META-INF/')) {
        meta.push(path);
      } else if (!archive) {
        resources.push(path);
      }
    }
    return {
      packages: [...pkgs.entries()].sort(([a], [b]) => a.localeCompare(b)),
      resources,
      archives: [...archives.entries()].sort(([a], [b]) => a.localeCompare(b)),
      meta,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [decompiled]);

  const explorerRow = (path: string, depth: number, label?: string, hint?: string) => {
    const kind = sourceKinds.get(path);
    const { letter, tone } = letterFor(path, kind);
    const isArchive = isArchivePath(path);
    const busy = expandingArchive === path;
    return (
      <button
        key={path}
        className={`dv-row${selectedSource === path ? ' is-selected' : ''}`}
        style={{ paddingLeft: 12 + depth * 14 }}
        onClick={() => openFile(path)}
        onDoubleClick={isArchive ? () => decompileNested(path) : undefined}
        title={isArchive ? `${path}: double-click to decompile` : path}
      >
        <span className={`dv-letter ${tone}`}>{letter}</span>
        <span className="dv-name">{label ?? path.split('/').pop()}</span>
        {(hint || (kind && kind !== 'class') || isArchive) && (
          <span className="dv-hint">{busy ? 'decompiling…' : hint ?? (isArchive ? 'nested ↵' : kind)}</span>
        )}
      </button>
    );
  };
  const explorerGroup = (key: string, label: string, count: string | null, rows: React.ReactNode) => {
    const isClosed = collapsedDirs.has(key);
    return (
      <div key={key}>
        <button className="dv-row is-group" style={{ paddingLeft: 12 }} onClick={() => toggleDir(key)} aria-expanded={!isClosed}>
          <span className="tree-caret">{isClosed ? '▸' : '▾'}</span>
          <span className="dv-name">{label}</span>
          {count && <span className="dv-hint">{count}</span>}
        </button>
        {!isClosed && rows}
      </div>
    );
  };
  const renderPackages = () => (
    <>
      {packageGroups.packages.map(([pkg, paths]) =>
        explorerGroup(`pkg:${pkg}`, pkg, null, paths.sort().map(p => explorerRow(p, 1, p.split('/').pop()!.replace(/\.java$/, '')))))}
      {packageGroups.resources.length > 0 && explorerGroup('grp:resources', 'resources', null, packageGroups.resources.map(p => explorerRow(p, 1, p)))}
      {packageGroups.archives.map(([dir, paths]) =>
        explorerGroup(`arc:${dir}`, dir, `${paths.length} jar${paths.length === 1 ? '' : 's'}`, paths.map(p => explorerRow(p, 1))))}
      {packageGroups.meta.length > 0 && explorerGroup('grp:meta', 'META-INF', null, packageGroups.meta.map(p => explorerRow(p, 1, p.slice('META-INF/'.length))))}
    </>
  );

  // Recursively render a package/path tree. Single-child package chains are
  // collapsed (e.g. com/example/util → com.example.util) like an IDE.
  const renderTree = (node: TreeNode, depth: number): React.ReactNode[] => {
    // A decompiled nested archive is a file node that also has children — group
    // it with folders so expandable rows sort above plain leaf files.
    const expandable = (n: TreeNode) => !n.isFile || (isArchivePath(n.path) && n.children.size > 0);
    const children = [...node.children.values()].sort((a, b) => {
      const ea = expandable(a), eb = expandable(b);
      if (ea !== eb) return ea ? -1 : 1; // folders / expanded archives first
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
              <span className="tree-name">{label}</span>
            </button>
            {!collapsed && renderTree(folder, depth + 1)}
          </div>
        );
      }
      // A nested archive that's already been decompiled renders as an
      // expandable node (jar path is both a file and a folder of sources).
      if (isArchivePath(child.path) && child.children.size > 0) {
        const collapsed = collapsedDirs.has(child.path);
        return (
          <div key={child.path}>
            <button
              className="tree-row tree-dir tree-archive"
              style={{ paddingLeft: depth * 12 + 8 }}
              onClick={() => toggleDir(child.path)}
              title={`${child.path} (decompiled)`}
            >
              <span className="tree-caret">{collapsed ? '▸' : '▾'}</span>
              <span className="dv-letter k-archive">J</span>
              <span className="tree-name">{child.name}</span>
            </button>
            {!collapsed && renderTree(child, depth + 1)}
          </div>
        );
      }

      const isArchive = isArchivePath(child.path);
      const busy = expandingArchive === child.path;
      return (
        <button
          key={child.path}
          className={`tree-row tree-file${selectedSource === child.path ? ' selected' : ''}${isArchive ? ' tree-archive-leaf' : ''}${busy ? ' busy' : ''}`}
          style={{ paddingLeft: depth * 12 + 8 }}
          onClick={() => openFile(child.path)}
          onDoubleClick={isArchive ? () => decompileNested(child.path) : undefined}
          title={isArchive ? `${child.path} — double-click to decompile` : child.path}
        >
          <span className={`dv-letter ${letterFor(child.path, sourceKinds.get(child.path)).tone}`}>{letterFor(child.path, sourceKinds.get(child.path)).letter}</span>
          <span className="tree-name">{child.name}</span>
          {isArchive && <span className="tree-archive-hint">{busy ? 'decompiling…' : 'nested ↵'}</span>}
        </button>
      );
    });
  };

  // The Markdown tab is a workspace from the start (no upload step).
  // Shortcuts that work everywhere: open a file, switch tool with 1–4.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      const typing = !!t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName) || !!t.closest('.cm-editor'));
      if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        openPicker.current?.click();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      const tool = TOOLS.find(x => x.key === e.key);
      if (tool) { e.preventDefault(); setMode(tool.id); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // In Decompile, / focuses the explorer filter.
  useEffect(() => {
    if (mode !== 'decompile' || !decompiled) return;
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.key !== '/' || e.metaKey || e.ctrlKey || e.altKey) return;
      if (t && (t.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      e.preventDefault();
      explorerFilterRef.current?.focus();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [mode, decompiled]);

  const shortcuts = [
    { label: 'Open file', keys: [`${MOD}O`] },
    { label: 'Switch tool', keys: ['1 – 4'] },
  ];

  const toolName = (t: Tool) => (t === 'home' ? 'home' : t);
  const crumbs: string[] = [toolName(mode)];
  if (mode === 'compare' && diffResult && jar1File && jar2File) crumbs.push(`${jar1File.name} → ${jar2File.name}`);
  if (mode === 'decompile' && decompiled && srcJar) crumbs.push(srcJar.name);
  if (mode === 'profile' && jfrResult && jfrFile) crumbs.push(jfrFile.name);

  const titleActions = (
    <>
      {mode === 'home' && (
        <a className="wb-text-btn" href="https://github.com/Emindu/jar-compare" target="_blank" rel="noopener noreferrer">
          GitHub <ExternalLink size={13} />
        </a>
      )}
      {mode === 'compare' && diffResult && (
        <button className="wb-btn wb-btn-primary" onClick={resetCompare}><RotateCcw size={14} /> New comparison</button>
      )}
      {mode === 'decompile' && decompiled && (
        <>
          <button className="wb-btn" onClick={resetDecompile}><RotateCcw size={14} /> New file</button>
          <button className="wb-btn wb-btn-primary" onClick={downloadZip}><Download size={14} /> sources.zip</button>
        </>
      )}
      {mode === 'profile' && jfrResult && (
        <button className="wb-btn wb-btn-primary" onClick={resetProfile}><RotateCcw size={14} /> Open recording</button>
      )}
      <ThemeButton theme={theme} onToggle={toggleTheme} />
    </>
  );

  /** The empty state of a tool: what it does and the input panel. */
  const toolStart = (tool: 'compare' | 'decompile' | 'profile', title: string, lede: React.ReactNode, intake: React.ReactNode) => (
    <div className="wb-scroll">
      <div className="tool-start">
        <p className="home-path">~/{tool}</p>
        <h1 className="tool-start-title">{title}</h1>
        <p className="tool-start-lede">{lede}</p>
        {intake}
      </div>
    </div>
  );
  const busy = (tool: Tool) => isProcessing && busyTool === tool;
  const lockedBy = (tool: Tool) => (isProcessing && busyTool !== tool ? busyTool : null);
  const failure = (tool: Tool) => (jobError?.tool === tool ? jobError.message : '');

  return (
    <div className="wb">
      <TitleBar crumbs={crumbs} onHome={() => switchMode('home')} actions={titleActions} />
      <ActivityBar tool={mode} onSelect={switchMode} busy={busyTool ? { [busyTool]: isProcessing } : undefined} />

      <main className="wb-main">
      {mode === 'home' && (
        <div className="wb-scroll">
          <Home
            onFiles={routeFiles}
            onTool={switchMode}
            recent={recent}
            onClearRecent={() => { clearRecent(); setRecent([]); }}
            jvm={jvm}
            shortcuts={shortcuts}
          />
        </div>
      )}

      {mode === 'compare' && !diffResult && toolStart(
        'compare',
        'Compare two builds',
        'Drop the old and the new archive. Every entry is hashed and matched, changed classes are decompiled, and you read the difference as Java source.',
        <Intake
          command={<>diff <var>a/</var>original <var>b/</var>new</>}
          slots={[
            { marker: '−', prefix: 'a/', role: 'original build', tone: 'old', file: jar1File, setFile: setJar1File },
            { marker: '+', prefix: 'b/', role: 'new build', tone: 'new', file: jar2File, setFile: setJar2File },
          ]}
          accept={['.jar', '.war', '.ear']}
          action="Compare"
          busy={busy('compare')}
          lockedBy={lockedBy('compare')}
          failure={failure('compare')}
          progress={progressText}
          onRun={() => handleCompare()}
          onSwap={() => { setJar1File(jar2File); setJar2File(jar1File); }}
        />,
      )}

      {mode === 'decompile' && !decompiled && toolStart(
        'decompile',
        'Decompile an archive',
        <>CFR turns the bytecode back into Java and every resource is extracted alongside it. Browse the package tree, then download it all as <code>sources.zip</code>.</>,
        <Intake
          command={<>cfr <var>archive</var> → src/</>}
          slots={[{ marker: '›', prefix: 'in/', role: 'archive to decompile', tone: 'neutral', file: srcJar, setFile: setSrcJar }]}
          accept={['.jar', '.war', '.ear']}
          action="Decompile"
          busy={busy('decompile')}
          lockedBy={lockedBy('decompile')}
          failure={failure('decompile')}
          progress={progressText}
          onRun={() => handleDecompile()}
        />,
      )}

      {mode === 'profile' && !jfrResult && toolStart(
        'profile',
        'Profile a flight recording',
        <>Open a <code>.jfr</code> file. CPU samples become a hot-method table and a searchable flame graph. Record one with <code>-XX:StartFlightRecording=duration=60s,filename=app.jfr,settings=profile</code>.</>,
        <Intake
          command={<>jfr <var>recording</var> → flame graph</>}
          slots={[{ marker: '›', prefix: 'in/', role: 'flight recording', tone: 'neutral', file: jfrFile, setFile: setJfrFile }]}
          accept={['.jfr']}
          action="Analyze"
          busy={busy('profile')}
          lockedBy={lockedBy('profile')}
          failure={failure('profile')}
          progress={progressText}
          onRun={() => handleProfile()}
        />,
      )}

      {/* ── Results: COMPARE ─────────────────────── */}
      {mode === 'compare' && diffResult && jar1File && jar2File && (
        <CompareView
          key={`${jar1File.name}|${jar2File.name}|${compareMs}`}
          diff={diffResult}
          nameA={jar1File.name}
          nameB={jar2File.name}
          theme={theme}
          selected={selectedFile}
          onSelect={setSelectedFile}
          onNested={compareNested}
          expanding={expandingNested}
          expanded={expandedNested}
          onSwap={() => { const a = jar1File, b = jar2File; setJar1File(b); setJar2File(a); setSelectedFile(null); handleCompare(b, a); }}
          onStatus={setCompareStatus}
        />
      )}

      {/* ── Results: DECOMPILE ───────────────────── */}
      {mode === 'decompile' && decompiled && (
        <div className="dv">
          <aside className="dv-side">
            <header className="dv-side-hd">
              <h2 className="wb-label">Explorer</h2>
              <span className="dv-seg" role="group" aria-label="Explorer view">
                <button className={explorerView === 'packages' ? 'is-on' : ''} onClick={() => setExplorerView('packages')} aria-pressed={explorerView === 'packages'}>packages</button>
                <button className={explorerView === 'files' ? 'is-on' : ''} onClick={() => setExplorerView('files')} aria-pressed={explorerView === 'files'}>files</button>
              </span>
            </header>
            <label className="cv-filter">
              <Search size={13} aria-hidden />
              <input
                ref={explorerFilterRef}
                value={sourceQuery}
                onChange={e => setSourceQuery(e.target.value)}
                onKeyDown={e => { if (e.key === 'Escape') { setSourceQuery(''); e.currentTarget.blur(); } }}
                placeholder="Filter classes and contents"
                spellCheck={false}
                autoComplete="off"
                aria-label="Filter classes and contents"
              />
              <kbd>/</kbd>
            </label>
            <div className="dv-tree">
              {searchResults ? (
                <>
                  {searchResults.total === 0 && <div className="cv-none">No matches.</div>}
                  {searchResults.classes.length > 0 && <div className="dv-sub">Names <b>{searchResults.classes.length}</b></div>}
                  {searchResults.classes.map(renderResultRow)}
                  {searchResults.contents.length > 0 && <div className="dv-sub">In contents <b>{searchResults.contents.length}</b></div>}
                  {searchResults.contents.map(renderResultRow)}
                </>
              ) : explorerView === 'packages' ? renderPackages() : (
                <div className="file-tree">{decompiledTree && renderTree(decompiledTree, 0)}</div>
              )}
            </div>
            <footer className="dv-side-ft">
              <span>{javaPaths.length} classes</span>
              <span>{resourcePaths.filter(p => !isArchivePath(p)).length} resources</span>
              {resourcePaths.some(isArchivePath) && <span>{resourcePaths.filter(isArchivePath).length} jars</span>}
            </footer>
          </aside>

          <section className="dv-main">
            {(() => {
              const tabs = selectedSource && !srcTabs.includes(selectedSource) ? [...srcTabs, selectedSource] : srcTabs;
              if (!tabs.length) return null;
              const close = (t: string) => {
                const i = tabs.indexOf(t);
                const rest = tabs.filter(x => x !== t);
                setSrcTabs(rest);
                if (t === selectedSource) openFile(rest[Math.min(i, rest.length - 1)] ?? null);
              };
              return (
                <div className="cv-tabs" role="tablist">
                  {tabs.map(t => {
                    const { letter, tone } = letterFor(t, sourceKinds.get(t));
                    return (
                      <div key={t} className={`cv-tab${t === selectedSource ? ' is-active' : ''}`} role="tab" aria-selected={t === selectedSource}>
                        <button className="cv-tab-open" onClick={() => { if (!srcTabs.includes(t)) setSrcTabs([...srcTabs, t]); openFile(t); }} title={t}>
                          <span className={`dv-letter ${tone}`}>{letter}</span> {t.split('/').pop()}
                        </button>
                        <button className="cv-tab-x" onClick={() => close(t)} aria-label={`Close ${t.split('/').pop()}`}><X size={12} /></button>
                      </div>
                    );
                  })}
                </div>
              );
            })()}

            {selectedSource && selectedDecompiledFile ? (
              <>
                <div className="cv-path dv-path">
                  <span className="dv-nav">
                    <button className="cv-icon" disabled={!canBack} onClick={navBack} title="Back (Alt+←)" aria-label="Back"><ArrowLeft size={14} /></button>
                    <button className="cv-icon" disabled={!canForward} onClick={navForward} title="Forward (Alt+→)" aria-label="Forward"><ArrowRight size={14} /></button>
                  </span>
                  <span className="dv-crumbs">{renderBreadcrumb(selectedSource)}</span>
                  <span className="cv-path-spacer" />
                  {selectedDecompiledFile.encoding === 'utf8' && (
                    <button className="wb-btn cv-copy" onClick={() => copySource(selectedDecompiledFile.content)}>
                      <ClipboardCopy size={13} /> {copied ? 'Copied' : 'Copy'}
                    </button>
                  )}
                  <button className="wb-btn cv-copy" onClick={() => downloadSingle(selectedSource, selectedDecompiledFile)}><FileDown size={13} /> Download</button>
                  <button
                    className="wb-btn cv-copy"
                    onClick={() => { setJar1File(srcJar); setJar2File(null); resetCompareResults(); setMode('compare'); }}
                    title="Use this archive as a/ in Compare"
                  >
                    <GitCompare size={13} /> Compare with…
                  </button>
                </div>

                <div className="dv-code" ref={sourceScrollRef}>
                  {selectedDecompiledFile.encoding === 'base64' ? (
                    isArchivePath(selectedSource) ? (
                      <div className="cv-nested-panel">
                        <h3>{selectedSource.split('/').pop()}</h3>
                        <p>A library packaged inside this archive. Decompile it to browse its classes and resources in the explorer.</p>
                        <button className="wb-btn wb-btn-primary" disabled={expandingArchive === selectedSource} onClick={() => decompileNested(selectedSource)}>
                          {expandingArchive === selectedSource ? 'Decompiling…' : 'Decompile this archive'}
                        </button>
                        <p className="cv-hint">Tip: double-click a nested archive in the explorer.</p>
                      </div>
                    ) : (
                      <div className="cv-nested-panel">
                        <h3>{selectedSource.split('/').pop()}</h3>
                        <p>Binary file. It can't be previewed here, but it is included in <code>sources.zip</code> and Download file.</p>
                      </div>
                    )
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
                        customStyle={{ margin: 0, background: 'transparent', padding: '12px 0', fontSize: '13px', lineHeight: '21px' }}
                        codeTagProps={{ style: { fontFamily: 'var(--font-mono)' } }}
                        lineNumberStyle={{ color: 'var(--text-faint)', minWidth: '3.5em', paddingRight: '1.4em', textAlign: 'right', fontStyle: 'normal' }}
                      >
                        {selectedDecompiledFile.content}
                      </SyntaxHighlighter>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="cv-empty">
                <p className="cv-empty-title">{decompiledPaths.length} files extracted</p>
                <p>Pick a class in the explorer, or press <kbd>{MOD}P</kbd> to go to one by name. <kbd>{MOD}</kbd>-click a type in the source to jump to it.</p>
              </div>
            )}
          </section>

          <aside className="dv-inspector" aria-label="Inspector">
            {outline.length > 0 && (
              <section className="dv-card">
                <h2 className="wb-label">Outline</h2>
                <ul className="dv-outline">
                  {outline.filter(o => o.kind !== 'class').map((o, i) => (
                    <li key={`${o.name}-${o.line}-${i}`}>
                      <button onClick={() => flashLine(o.line)} title={`Line ${o.line}`}>
                        <span className={`dv-ok ok-${o.kind}`}>{o.kind === 'method' ? 'm' : 'f'}</span>
                        <span className="dv-on">{o.name}<span className="dv-od">{o.kind === 'method' ? o.detail : ` ${o.detail}`}</span></span>
                        <span className="dv-ol">{o.line}</span>
                      </button>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            {classInfo && (
              <section className="dv-card">
                <h2 className="wb-label">{classInfo.kind === 'annotation' ? 'Annotation' : classInfo.kind[0].toUpperCase() + classInfo.kind.slice(1)}</h2>
                <dl className="dv-kv">
                  <div><dt>Declares</dt><dd title={classInfo.header}>{classInfo.header.replace(/\s+\S+$/, '') || classInfo.kind}</dd></div>
                  {decompiledMeta?.javaVersion && <div><dt>Class file</dt><dd>{decompiledMeta.javaVersion}</dd></div>}
                  <div><dt>Source</dt><dd>{classInfo.lines} lines · {fmtSize(classInfo.size)}</dd></div>
                  <div className="dv-kv-col">
                    <dt>Referenced by</dt>
                    <dd>
                      {referencedBy.length ? referencedBy.map(p => (
                        <button key={p} className="dv-ref" onClick={() => openFile(p)} title={p}>{p.split('/').pop()!.replace(/\.java$/, '')}</button>
                      )) : <span className="dv-none">no other class in this archive</span>}
                    </dd>
                  </div>
                </dl>
              </section>
            )}
            {manifest.length > 0 && (
              <section className="dv-card">
                <h2 className="wb-label">Manifest</h2>
                <dl className="dv-kv dv-kv-stack">
                  {manifest.slice(0, 10).map(e => (
                    <div key={e.key}><dt>{e.key}</dt><dd>{e.value}</dd></div>
                  ))}
                </dl>
              </section>
            )}
            {metaItems.length > 0 && (
              <section className="dv-card">
                <h2 className="wb-label">Archive</h2>
                <dl className="dv-kv">
                  {metaItems.map(it => <div key={it.label}><dt>{it.label}</dt><dd>{it.value}</dd></div>)}
                </dl>
              </section>
            )}
          </aside>
        </div>
      )}

      {/* ── Results: PROFILE (JFR) ───────────────── */}
      {mode === 'profile' && jfrResult && <Profiler result={jfrResult} />}

      {/* ── Results: MARKDOWN ────────────────────── */}
      {mode === 'markdown' && (
        <MarkdownWorkspace
          key={mdIncoming?.id ?? 'draft'}
          theme={theme}
          incoming={mdIncoming}
          onOpen={(name) => remember('markdown', name)}
        />
      )}
      </main>

      <StatusBar
        jvm={jvm}
        left={<>
          {mode === 'compare' && diffResult ? (
            <span>{allChanged(diffResult)} changed{compareMs !== null ? ` · compared in ${(compareMs / 1000).toFixed(1)} s` : ''}</span>
          ) : mode === 'decompile' && decompiled ? (
            <span>decompiled {javaPaths.length} classes{decompileMs !== null ? ` in ${(decompileMs / 1000).toFixed(1)} s` : ''}</span>
          ) : (
            <span>CheerpJ 4.3 · WebAssembly</span>
          )}
          <span>local only · 0 B uploaded</span>
          {isProcessing && progressText && <span className="wb-status-progress">{progressText}</span>}
        </>}
        right={<>
          {mode === 'compare' && diffResult && compareStatus && (
            <>
              {compareStatus.change && <span>{compareStatus.change}</span>}
              {compareStatus.lang && <span>{compareStatus.view}</span>}
              {compareStatus.lang && <span>{compareStatus.lang}{compareStatus.lang === 'Java' ? ' · CFR' : ''}</span>}
            </>
          )}
          {mode === 'decompile' && classInfo && <span>{classInfo.lines} lines · UTF-8 · Java · CFR</span>}
          <span>{theme}</span>
        </>}
      />

      <input
        ref={openPicker}
        type="file"
        multiple
        accept=".jar,.war,.ear,.jfr,.md,.markdown"
        hidden
        onChange={e => {
          const err = routeFiles([...(e.target.files ?? [])]);
          if (err) { setMode('home'); showToast(err); }
          e.target.value = '';
        }}
      />

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
