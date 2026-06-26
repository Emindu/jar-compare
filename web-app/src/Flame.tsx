import React, { useMemo, useState } from 'react';
import type { FlameNode } from './jfr';

// Icicle/flame-graph renderer. Root at the top; depth grows downward; a cell's
// width is proportional to its sample count relative to the focused node.

const ROW = 20; // px per stack depth

// Stable warm hue per method name (classic flame-graph palette: reds→yellows).
function colorFor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  const hue = 8 + (h % 42);          // 8°–50°
  const sat = 62 + (h >> 8) % 16;    // 62–78%
  const light = 48 + (h >> 16) % 10; // 48–58%
  return `hsl(${hue} ${sat}% ${light}%)`;
}

interface Cell { node: FlameNode; depth: number; x: number; w: number; }

function layout(focus: FlameNode): { cells: Cell[]; maxDepth: number } {
  const cells: Cell[] = [];
  let maxDepth = 0;
  const total = focus.value || 1;
  const walk = (node: FlameNode, depth: number, x: number) => {
    const w = node.value / total;
    cells.push({ node, depth, x, w });
    if (depth > maxDepth) maxDepth = depth;
    let cx = x;
    for (const c of node.children) {
      walk(c, depth + 1, cx);
      cx += c.value / total;
    }
  };
  walk(focus, 0, 0);
  return { cells, maxDepth };
}

export default function Flame({ root, highlight }: { root: FlameNode; highlight: string }) {
  const [focus, setFocus] = useState<FlameNode>(root);
  const [hover, setHover] = useState<{ cell: Cell; x: number; y: number } | null>(null);

  // Reset focus when a new recording (new root) comes in.
  const rootRef = React.useRef(root);
  if (rootRef.current !== root) { rootRef.current = root; if (focus !== root) setFocus(root); }

  const { cells, maxDepth } = useMemo(() => layout(focus), [focus]);
  const hl = highlight.trim().toLowerCase();
  const total = root.value || 1;

  return (
    <div className="flame">
      <div className="flame-toolbar">
        <button
          className="flame-reset"
          disabled={focus === root}
          onClick={() => setFocus(root)}
          title="Reset zoom"
        >
          ⤢ Reset zoom
        </button>
        <span className="flame-hint">Click a frame to zoom · {root.value} samples</span>
      </div>

      <div className="flame-canvas" style={{ height: (maxDepth + 1) * ROW }}>
        {cells.map((cell, i) => {
          const name = cell.node.name;
          const dim = hl !== '' && !name.toLowerCase().includes(hl);
          const pct = ((cell.node.value / total) * 100).toFixed(1);
          return (
            <div
              key={i}
              className={`flame-cell${dim ? ' dim' : ''}`}
              style={{
                left: `${cell.x * 100}%`,
                width: `${cell.w * 100}%`,
                top: cell.depth * ROW,
                height: ROW - 1,
                background: colorFor(name),
              }}
              onClick={(e) => { e.stopPropagation(); setFocus(cell.node); }}
              onMouseEnter={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
              onMouseMove={(e) => setHover({ cell, x: e.clientX, y: e.clientY })}
              onMouseLeave={() => setHover(null)}
            >
              <span className="flame-label">{name}</span>
              <span className="flame-cell-pct">{cell.w > 0.08 ? `${pct}%` : ''}</span>
            </div>
          );
        })}
      </div>

      {hover && (
        <div className="flame-tip" style={{ left: hover.x + 12, top: hover.y + 12 }}>
          <div className="flame-tip-name">{hover.cell.node.name}</div>
          <div className="flame-tip-meta">
            {hover.cell.node.value} samples ({((hover.cell.node.value / total) * 100).toFixed(2)}%)
            {hover.cell.node.self > 0 && ` · ${hover.cell.node.self} self`}
          </div>
        </div>
      )}
    </div>
  );
}
