import { useState } from 'react';

// The upload panel on the home page, drawn as the header of a diff: one row per
// input file ("--- a/" original, "+++ b/" new), a command line on top and a
// status line with the action at the bottom. Each row is a drop target and a
// file picker; dropping several files on the panel fills the rows in order.

export interface IntakeSlot {
  /** Gutter marker, e.g. '−' / '+' / '›'. */
  marker: string;
  /** Path-like prefix shown before the file, e.g. 'a/'. */
  prefix: string;
  /** What belongs here, shown while empty. */
  role: string;
  tone: 'old' | 'new' | 'neutral';
  file: File | null;
  setFile: (f: File | null) => void;
}

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Intake({
  command, slots, accept, action, busy, progress, onRun, onSwap,
}: {
  command: React.ReactNode;
  slots: IntakeSlot[];
  accept: string[];
  action: string;
  busy: boolean;
  progress: string;
  onRun: () => void;
  onSwap?: () => void;
}) {
  const [over, setOver] = useState<number | 'panel' | null>(null);
  const [error, setError] = useState('');

  const ok = (f: File) => accept.some((x) => f.name.toLowerCase().endsWith(x));
  const types = accept.join(', ');

  /** Put files into slots: the target slot first, then any other empty slots in order. */
  const place = (files: File[], start: number) => {
    const bad = files.find((f) => !ok(f));
    const good = files.filter(ok);
    setError(bad ? `${bad.name} is not a ${types} file` : '');
    if (!good.length) return;
    const order = [start, ...slots.map((_, i) => i).filter((i) => i !== start)];
    const targets = good.length > 1 ? order.filter((i, n) => n === 0 || !slots[i].file) : [start];
    good.slice(0, targets.length).forEach((f, n) => slots[targets[n]].setFile(f));
  };

  const filled = slots.filter((s) => s.file).length;
  const ready = filled === slots.length;
  const missing = slots.find((s) => !s.file);
  const total = slots.reduce((a, s) => a + (s.file?.size ?? 0), 0);

  const status = busy
    ? progress || 'working…'
    : error
      ? error
      : ready
        ? `ready · ${slots.length > 1 ? `${slots.length} files, ` : ''}${fmtSize(total)}`
        : `waiting for ${missing!.prefix}${slots.length > 1 ? ` (${missing!.role})` : ''}`;

  return (
    <section
      className={`intake${over === 'panel' ? ' is-over' : ''}${busy ? ' is-busy' : ''}`}
      aria-label="Input files"
      onDragOver={(e) => { e.preventDefault(); if (over === null) setOver('panel'); }}
      onDragLeave={(e) => { if (!e.currentTarget.contains(e.relatedTarget as Node)) setOver(null); }}
      onDrop={(e) => {
        e.preventDefault();
        setOver(null);
        const first = slots.findIndex((s) => !s.file);
        place([...e.dataTransfer.files], first < 0 ? 0 : first);
      }}
    >
      <header className="intake-cmd">
        <span className="intake-prompt" aria-hidden>$</span>
        <span className="intake-cmd-text">{command}</span>
        {onSwap && (
          <button
            className="intake-swap"
            onClick={onSwap}
            disabled={!filled || busy}
            title="Swap a/ and b/"
          >
            swap a⇄b
          </button>
        )}
      </header>

      <ol className="intake-rows">
        {slots.map((s, i) => (
          <li
            key={s.prefix}
            className={`intake-row tone-${s.tone}${s.file ? ' has-file' : ''}${over === i ? ' is-over' : ''}`}
            onDragOver={(e) => { e.preventDefault(); e.stopPropagation(); setOver(i); }}
            onDrop={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setOver(null);
              place([...e.dataTransfer.files], i);
            }}
          >
            <span className="intake-gutter" aria-hidden>{s.marker}</span>
            <label className="intake-pick">
              <span className="intake-prefix">{s.prefix}</span>
              {s.file ? (
                <>
                  <span className="intake-name" title={s.file.name}>{s.file.name}</span>
                  <span className="intake-size">{fmtSize(s.file.size)}</span>
                </>
              ) : (
                <span className="intake-empty">
                  <span className="intake-role">{s.role}</span>
                  <span className="intake-howto">drop {types} here, or <u>choose a file</u></span>
                </span>
              )}
              <input
                type="file"
                accept={accept.join(',')}
                disabled={busy}
                onChange={(e) => { place([...(e.target.files ?? [])], i); e.target.value = ''; }}
              />
            </label>
            {s.file && !busy && (
              <button className="intake-clear" onClick={() => s.setFile(null)} aria-label={`Remove ${s.file.name}`}>
                ×
              </button>
            )}
          </li>
        ))}
      </ol>

      <footer className="intake-foot">
        <span className={`intake-status${error && !busy ? ' is-error' : ''}${ready && !busy && !error ? ' is-ready' : ''}`} role="status" aria-live="polite">
          {status}
        </span>
        <button className="intake-run" onClick={onRun} disabled={!ready || busy}>
          {busy ? 'Running…' : action}
        </button>
        {busy && <span className="intake-progress" aria-hidden />}
      </footer>
    </section>
  );
}
