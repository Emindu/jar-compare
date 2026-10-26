import { useMemo, useState } from 'react';
import type { FlameNode } from './jfr';
import { FLAME_ROW as ROW, categoryOf, layout, samePath, splitName, type Cell } from './profileModel';

// Icicle flame graph: the zoomed frame at the top, callees below, widths
// proportional to samples. Click a frame to select it, double-click to zoom.
// Frames are coloured by where the code lives: your code, libraries, JDK/VM.

export default function Flame({
  focus, focusPath, total, query, selected, highlightName, onSelect, onZoom,
}: {
  focus: FlameNode;
  focusPath: string[];
  total: number;
  query: string;
  selected: string[] | null;
  /** Highlight every frame of this method (e.g. picked in the table). */
  highlightName: string | null;
  onSelect: (path: string[]) => void;
  onZoom: (path: string[]) => void;
}) {
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);
  const { cells, maxDepth } = useMemo(() => layout(focus, focusPath), [focus, focusPath]);
  const q = query.trim().toLowerCase();

  return (
    <div className="pf-flame" onMouseLeave={() => setHover(null)}>
      <div className="pf-flame-canvas" style={{ height: (maxDepth + 1) * ROW }}>
        {cells.map((cell) => {
          const name = cell.node.name;
          const cat = categoryOf(name);
          const match = q !== '' && name.toLowerCase().includes(q);
          const isSel = samePath(cell.path, selected);
          const isHl = highlightName !== null && name === highlightName;
          const dim = (q !== '' && !match) || (highlightName !== null && !isHl && !isSel);
          return (
            <button
              key={cell.path.join('\u0001')}
              className={`pf-cell cat-${cat}${dim ? ' is-dim' : ''}${isSel || isHl || match ? ' is-hot' : ''}${isSel ? ' is-sel' : ''}`}
              style={{ left: `${cell.x * 100}%`, width: `${cell.w * 100}%`, top: cell.depth * ROW, height: ROW - 2 }}
              onClick={() => onSelect(cell.path)}
              onDoubleClick={() => onZoom(cell.path)}
              onMouseMove={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
              tabIndex={cell.w > 0.02 ? 0 : -1}
              aria-label={`${name}, ${cell.node.value} samples`}
            >
              <span className="pf-cell-label">{cell.depth === 0 && cell.path.length === 1 ? 'all' : splitName(name).short}</span>
            </button>
          );
        })}
      </div>
      {hover && (
        <div className="pf-tip" style={{ left: hover.x + 14, top: hover.y + 14 }}>
          <div className="pf-tip-name">{hover.cell.node.name}</div>
          <div className="pf-tip-meta">
            {hover.cell.node.value} samples · {((hover.cell.node.value / total) * 100).toFixed(1)}%
            {hover.cell.node.self > 0 && ` · ${hover.cell.node.self} self`}
          </div>
          <div className="pf-tip-hint">click to select · double-click to zoom</div>
        </div>
      )}
    </div>
  );
}
