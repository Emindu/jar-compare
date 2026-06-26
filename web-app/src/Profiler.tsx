import { useMemo, useState } from 'react';
import type { JfrResult } from './jfr';
import Flame from './Flame';

// Profile results view: a summary stat bar, a hot-methods table (left) and the
// flame graph (right). Clicking a hot method highlights it in the flame graph.

function fmtDuration(nanos: number): string {
  if (!nanos || nanos < 0) return '—';
  const ms = nanos / 1e6;
  if (ms < 1000) return `${ms.toFixed(0)} ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)} s`;
  const m = Math.floor(s / 60);
  return `${m}m ${(s % 60).toFixed(0)}s`;
}

function shortName(fqn: string): { cls: string; method: string } {
  const dot = fqn.lastIndexOf('.');
  if (dot < 0) return { cls: '', method: fqn };
  return { cls: fqn.slice(0, dot), method: fqn.slice(dot + 1) };
}

export default function Profiler({ result }: { result: JfrResult }) {
  const [highlight, setHighlight] = useState('');
  const [tab, setTab] = useState<'self' | 'total'>('self');

  const total = result.totalSamples || 1;
  const hot = useMemo(() => {
    const list = [...result.hot];
    if (tab === 'total') list.sort((a, b) => b.total - a.total || b.self - a.self);
    else list.sort((a, b) => b.self - a.self || b.total - a.total);
    return list.slice(0, 200);
  }, [result.hot, tab]);

  return (
    <>
      <div className="stats-bar">
        <span className="stats-total">{result.totalSamples} CPU samples</span>
        <span className="stat stat-added">{result.hot.length} methods</span>
        <span className="stat stat-nested">JFR {result.version}</span>
        {result.chunks > 1 && <span className="stat stat-identical">{result.chunks} chunks</span>}
        <span className="stat stat-modified">{fmtDuration(result.durationNanos)}</span>
        {result.threads.length > 0 && (
          <span className="stat stat-modified-class">{result.threads.length} threads</span>
        )}
      </div>

      {result.totalSamples === 0 ? (
        <div className="diff-empty" style={{ flex: 1 }}>
          <span className="diff-empty-icon">📊</span>
          <p>No execution samples in this recording</p>
          <p className="diff-empty-sub">
            This .jfr has {result.eventCounts.reduce((a, e) => a + e.count, 0)} events but no
            jdk.ExecutionSample data. Record with the “profile” settings to capture CPU samples.
          </p>
        </div>
      ) : (
        <div className="workspace">
          <aside className="file-panel prof-panel">
            <div className="prof-tabs">
              <button className={`prof-tab${tab === 'self' ? ' active' : ''}`} onClick={() => setTab('self')}>
                Self
              </button>
              <button className={`prof-tab${tab === 'total' ? ' active' : ''}`} onClick={() => setTab('total')}>
                Total
              </button>
            </div>
            <div className="file-list">
              {hot.map((h) => {
                const { cls, method } = shortName(h.name);
                const count = tab === 'self' ? h.self : h.total;
                const pct = (count / total) * 100;
                const active = highlight === h.name;
                return (
                  <button
                    key={h.name}
                    className={`hot-row${active ? ' selected' : ''}`}
                    onClick={() => setHighlight(active ? '' : h.name)}
                    title={h.name}
                  >
                    <span className="hot-bar" style={{ width: `${Math.max(pct, 1)}%` }} />
                    <span className="hot-text">
                      <span className="hot-method">{method}</span>
                      {cls && <span className="hot-cls">{cls}</span>}
                    </span>
                    <span className="hot-count">
                      <span className="hot-pct">{pct.toFixed(1)}%</span>
                      <span className="hot-n">{count}</span>
                    </span>
                  </button>
                );
              })}
            </div>
            <div className="panel-hints">
              <span>Click a method to highlight it in the flame graph</span>
              <span><strong>Self</strong>: samples on top of stack · <strong>Total</strong>: anywhere on stack</span>
            </div>
          </aside>

          <div className="diff-panel">
            <div className="diff-panel-hd">
              <span className="diff-crumb">Flame graph</span>
              <div className="file-actions">
                <input
                  className="flame-search"
                  placeholder="Highlight method…"
                  value={highlight}
                  onChange={(e) => setHighlight(e.target.value)}
                  spellCheck={false}
                />
                {highlight && (
                  <button className="file-action-btn" onClick={() => setHighlight('')}>✕ Clear</button>
                )}
              </div>
            </div>
            <div className="diff-body">
              <Flame root={result.flame} highlight={highlight} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
