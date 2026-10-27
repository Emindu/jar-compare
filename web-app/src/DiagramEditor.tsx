import { lazy, Suspense, useEffect, useRef } from 'react';
import { isFlowchart, type Theme } from './mermaidSource';

// The full-screen editor for a diagram: flowcharts get the free-position
// canvas, sequence diagrams the lifeline editor.

const FlowEditor = lazy(() => import('./FlowEditor'));
const SeqEditor = lazy(() => import('./SeqEditor'));

export default function DiagramEditor({ code, theme, getRendered, onSave, onClose }: {
  code: string;
  theme: Theme;
  /** The diagram as currently drawn, to start a flowchart from mermaid's layout. */
  getRendered: () => SVGSVGElement | null;
  onSave: (code: string) => void;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => { ref.current?.focus({ preventScroll: true }); }, []);
  return (
    <div className="qo-overlay md-modal-overlay dge-overlay" onPointerDown={(e) => e.stopPropagation()} onClick={(e) => e.stopPropagation()}>
      <div className="md-modal dge" ref={ref} tabIndex={-1} role="dialog" aria-label="Edit diagram">
        <Suspense fallback={<div className="dge-empty">Loading editor…</div>}>
          {isFlowchart(code)
            ? <FlowEditor code={code} theme={theme} getRendered={getRendered} onSave={onSave} onClose={onClose} />
            : <SeqEditor code={code} theme={theme} onSave={onSave} onClose={onClose} />}
        </Suspense>
      </div>
    </div>
  );
}
