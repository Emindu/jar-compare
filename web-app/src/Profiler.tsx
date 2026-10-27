import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import type { FlameNode, JfrResult } from './jfr';
import Flame from './Flame';
import { categoryOf, flameSvg, fmtDuration, samePath, splitName } from './profileModel';

// Profile results: a stat strip, a hot-method table (left) and a flame graph
// with a detail card for the selected frame (right). Filter by thread, sort by
// self or total time, search to highlight frames.

export interface ProfileStatus { zoom: string; metric: 'self' | 'total' }

/** Walk a path of frame names from the root; returns the deepest node found. */
function nodeAt(root: FlameNode, path: string[]): FlameNode {
  let node = root;
  for (const name of path.slice(1)) {
    const next = node.children.find((c) => c.name === name);
    if (!next) break;
    node = next;
  }
  return node;
}

/** Sum of samples under the first frame on each path that matches `q`. */
function matchShare(root: FlameNode, q: string): { methods: number; samples: number } {
  const names = new Set<string>();
  let samples = 0;
  const walk = (n: FlameNode) => {
    if (n.name !== 'all' && n.name.toLowerCase().includes(q)) { samples += n.value; names.add(n.name); collect(n); return; }
    n.children.forEach(walk);
  };
  const collect = (n: FlameNode) => n.children.forEach((c) => { if (c.name.toLowerCase().includes(q)) names.add(c.name); collect(c); });
  walk(root);
  return { methods: names.size, samples };
}

/** Who calls `method`, weighted by samples. */
function callersOf(root: FlameNode, method: string): { name: string; value: number }[] {
  const m = new Map<string, number>();
  const walk = (n: FlameNode) => {
    for (const c of n.children) {
      if (c.name === method && n.name !== method) m.set(n.name, (m.get(n.name) || 0) + c.value);
      walk(c);
    }
  };
  walk(root);
  return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
}

export default function Profiler({
  result, theme, onStatus, onOpenSource, exportRef,
}: {
  result: JfrResult;
  theme: 'light' | 'dark';
  onStatus?: (s: ProfileStatus) => void;
  /** Open a class in Decompile, when it is available there. */
  onOpenSource?: (fqn: string, line: number) => boolean;
  /** Receives a function that downloads the current flame graph as SVG. */
  exportRef?: { current: (() => void) | null };
}) {
  const [metric, setMetric] = useState<'self' | 'total'>('self');
  const [query, setQuery] = useState('');
  const [thread, setThread] = useState('all');
  const [focusPath, setFocusPath] = useState<string[]>(['all']);
  const [selPath, setSelPath] = useState<string[] | null>(null);
  const [selMethod, setSelMethod] = useState<string | null>(null);

  const data = useMemo(() => {
    if (thread === 'all') return { flame: result.flame, hot: result.hot, samples: result.totalSamples };
    const t = result.byThread.find((x) => x.name === thread);
    return t ? { flame: t.flame, hot: t.hot, samples: t.samples } : { flame: result.flame, hot: result.hot, samples: result.totalSamples };
  }, [result, thread]);
  const total = data.samples || 1;
  const focus = nodeAt(data.flame, focusPath);

  const rows = useMemo(() => {
    const list = [...data.hot];
    list.sort(metric === 'total' ? (a, b) => b.total - a.total || b.self - a.self : (a, b) => b.self - a.self || b.total - a.total);
    return list.slice(0, 300);
  }, [data.hot, metric]);

  const q = query.trim().toLowerCase();
  const share = useMemo(() => (q ? matchShare(data.flame, q) : null), [data.flame, q]);

  // What the detail card describes: a picked frame, or a method picked in the table.
  const selNode = selPath ? nodeAt(data.flame, selPath) : null;
  const detailName = selNode && selPath && selNode.name === selPath[selPath.length - 1] ? selNode.name : selMethod;
  const detail = useMemo(() => {
    if (!detailName || detailName === 'all') return null;
    const h = data.hot.find((x) => x.name === detailName);
    const callers = callersOf(data.flame, detailName);
    const callerTotal = callers.reduce((a, c) => a + c.value, 0) || 1;
    return {
      name: detailName,
      self: h?.self ?? 0,
      total: h?.total ?? 0,
      caller: callers[0] ? { name: callers[0].name, pct: (callers[0].value / callerTotal) * 100 } : null,
      line: result.hotLine[detailName] ?? 0,
    };
  }, [detailName, data, result.hotLine]);

  useEffect(() => {
    onStatus?.({ zoom: focusPath.length > 1 ? splitName(focusPath[focusPath.length - 1]).short : 'all', metric });
  }, [onStatus, focusPath, metric]);

  useEffect(() => {
    if (!exportRef) return;
    exportRef.current = () => {
      const svg = flameSvg(focus, focusPath, total, theme === 'dark');
      const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = 'flame-graph.svg';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    return () => { exportRef.current = null; };
  }, [exportRef, focus, focusPath, total, theme]);

  const crumbs = focusPath.length > 4
    ? [focusPath[0], focusPath[1], null, focusPath[focusPath.length - 1]]
    : focusPath;

  const stats = [
    { value: result.totalSamples.toLocaleString(), label: 'CPU samples' },
    { value: fmtDuration(result.durationNanos), label: 'recording length' },
    { value: String(result.threads.length), label: result.threads.length === 1 ? 'thread' : 'threads' },
    { value: String(result.hot.length), label: 'distinct methods' },
    { value: String(result.chunks), label: result.chunks === 1 ? 'chunk' : 'chunks' },
    { value: `JFR ${result.version}`, label: 'format' },
  ];

  if (result.totalSamples === 0) {
    const events = result.eventCounts.reduce((a, e) => a + e.count, 0);
    return (
      <div className="cv-empty">
        <p className="cv-empty-title">No CPU samples in this recording</p>
        <p>It holds {events.toLocaleString()} events but no <code>jdk.ExecutionSample</code> data. Record with <code>settings=profile</code> to capture CPU samples.</p>
      </div>
    );
  }

  return (
    <div className="pf">
      <div className="pf-stats">
        {stats.map((s) => (
          <div key={s.label} className="pf-stat"><b>{s.value}</b><span>{s.label}</span></div>
        ))}
      </div>

      <div className="pf-bar">
        <span className="cv-seg" role="group" aria-label="Sort by">
          <button className={metric === 'self' ? 'is-on' : ''} onClick={() => setMetric('self')} aria-pressed={metric === 'self'}>Self time</button>
          <button className={metric === 'total' ? 'is-on' : ''} onClick={() => setMetric('total')} aria-pressed={metric === 'total'}>Total time</button>
        </span>
        <label className="cv-filter pf-search">
          <Search size={13} aria-hidden />
          <input value={query} onChange={(e) => setQuery(e.target.value)} onKeyDown={(e) => { if (e.key === 'Escape') setQuery(''); }} placeholder="Search methods" spellCheck={false} aria-label="Search methods" />
          {share && (
            <span className={`pf-match${share.methods ? '' : ' is-none'}`}>
              {share.methods ? `${share.methods} match${share.methods === 1 ? '' : 'es'} · ${((share.samples / total) * 100).toFixed(1)}%` : 'no match'}
            </span>
          )}
        </label>
        <label className="pf-thread">
          Thread
          <select value={thread} onChange={(e) => { setThread(e.target.value); setFocusPath(['all']); setSelPath(null); }}>
            <option value="all">all {result.threads.length} threads</option>
            {result.byThread.map((t) => <option key={t.name} value={t.name}>{t.name} · {t.samples}</option>)}
          </select>
        </label>
        <span className="pf-legend" aria-label="Legend">
          <span><i className="cat-app" /> your code</span>
          <span><i className="cat-lib" /> libraries</span>
          <span><i className="cat-jdk" /> JDK / VM</span>
        </span>
      </div>

      <div className="pf-body">
        <section className="pf-table" aria-label="Hot methods">
          <div className="pf-th">
            <span>Method</span>
            <button className={metric === 'self' ? 'is-on' : ''} onClick={() => setMetric('self')}>Self{metric === 'self' ? ' ▾' : ''}</button>
            <button className={metric === 'total' ? 'is-on' : ''} onClick={() => setMetric('total')}>Total{metric === 'total' ? ' ▾' : ''}</button>
          </div>
          <ul className="pf-rows">
            {rows.map((h) => {
              const { short, pkg } = splitName(h.name);
              const cat = categoryOf(h.name);
              const sp = (h.self / total) * 100, tp = (h.total / total) * 100;
              const active = detailName === h.name;
              const dim = q !== '' && !h.name.toLowerCase().includes(q);
              return (
                <li key={h.name}>
                  <button
                    className={`pf-row${active ? ' is-active' : ''}${dim ? ' is-dim' : ''}`}
                    onClick={() => { setSelPath(null); setSelMethod(active ? null : h.name); }}
                    title={h.name}
                  >
                    <span className="pf-m">
                      <span className={`pf-mn mn-${cat}`}>{short}</span>
                      {pkg && <span className="pf-mp">{pkg}</span>}
                    </span>
                    <span className="pf-num">
                      {sp.toFixed(1)}%
                      <i className={`pf-bar-self cat-${cat}`} style={{ width: `${Math.min(100, sp)}%` }} />
                    </span>
                    <span className="pf-num">
                      {tp.toFixed(1)}%
                      <i className="pf-bar-total" style={{ width: `${Math.min(100, tp)}%` }} />
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>

        <section className="pf-graph" aria-label="Flame graph">
          <div className="pf-crumbs">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span className="crumb-sep">›</span>}
                {c === null ? <span className="pf-ellipsis">…</span> : (
                  <button
                    className={`pf-crumb${i === crumbs.length - 1 ? ' is-last' : ''}`}
                    onClick={() => setFocusPath(focusPath.slice(0, focusPath.indexOf(c) + 1))}
                    title={c}
                  >
                    {c === 'all' ? 'all' : splitName(c).short}
                  </button>
                )}
              </span>
            ))}
            <span className="cv-path-spacer" />
            <button className="wb-btn cv-copy" disabled={focusPath.length === 1} onClick={() => setFocusPath(['all'])}>Reset zoom</button>
          </div>
          <div className="pf-graph-scroll">
            <Flame
              focus={focus}
              focusPath={focusPath}
              total={total}
              query={query}
              selected={selPath}
              highlightName={!selPath && selMethod ? selMethod : null}
              onSelect={(p) => { setSelMethod(null); setSelPath(samePath(p, selPath) ? null : p); }}
              onZoom={(p) => { setFocusPath(p); setSelPath(null); }}
            />
            {detail && (
              <div className="pf-detail">
                <div className="pf-detail-hd">
                  <span className="pf-detail-name">{detail.name}</span>
                  {onOpenSource && detail.line > 0 && categoryOf(detail.name) === 'app' && (
                    <button className="wb-link-btn pf-open" onClick={() => {
                      if (!onOpenSource(detail.name.slice(0, detail.name.lastIndexOf('.')), detail.line)) {
                        setQuery('');
                      }
                    }}>Open source in Decompile →</button>
                  )}
                </div>
                <div className="pf-detail-row">
                  <span>self <b>{((detail.self / total) * 100).toFixed(1)}%</b> · {detail.self.toLocaleString()} samples</span>
                  <span>total <b>{((detail.total / total) * 100).toFixed(1)}%</b> · {detail.total.toLocaleString()} samples</span>
                  {detail.caller && <span>called from <b>{splitName(detail.caller.name).short}</b> ({detail.caller.pct.toFixed(0)}%)</span>}
                  {detail.line > 0 && <span>hottest line <b>:{detail.line}</b></span>}
                </div>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
