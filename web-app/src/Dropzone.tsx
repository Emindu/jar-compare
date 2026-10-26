import { useState } from 'react';

// A file drop target for the upload pages: drop a file or click to browse,
// shows the chosen file with its size, and lets you clear it.

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export default function Dropzone({
  label, file, onFile, accept, icon,
}: {
  label: string;
  file: File | null;
  onFile: (f: File | null) => void;
  /** Accepted extensions, e.g. ['.jar', '.war']. */
  accept: string[];
  icon: string;
}) {
  const [active, setActive] = useState(false);

  const take = (f: File | undefined) => {
    if (!f) return;
    if (accept.some((x) => f.name.toLowerCase().endsWith(x))) onFile(f);
    else alert(`Please choose a ${accept.join(', ')} file`);
  };

  const drag = (e: React.DragEvent, on: boolean) => {
    e.preventDefault();
    e.stopPropagation();
    setActive(on);
  };

  return (
    <div
      className={`dz${active ? ' drag-active' : ''}${file ? ' has-file' : ''}`}
      onDragEnter={(e) => drag(e, true)}
      onDragOver={(e) => drag(e, true)}
      onDragLeave={(e) => drag(e, false)}
      onDrop={(e) => { drag(e, false); take(e.dataTransfer.files?.[0]); }}
    >
      <label>
        <span className="dz-icon" aria-hidden>{file ? '✓' : icon}</span>
        <span className="dz-label">{label}</span>
        {file ? (
          <>
            <span className="dz-name" title={file.name}>{file.name}</span>
            <span className="dz-meta">{fmtSize(file.size)} · click to change</span>
          </>
        ) : (
          <>
            <span className="dz-hint"><strong>Drop a file here</strong> or <span className="dz-link">browse</span></span>
            <span className="dz-exts">{accept.map((x) => <code key={x}>{x}</code>)}</span>
          </>
        )}
        <input
          type="file"
          accept={accept.join(',')}
          onChange={(e) => { take(e.target.files?.[0]); e.target.value = ''; }}
        />
      </label>
      {file && (
        <button className="dz-clear" onClick={() => onFile(null)} title="Remove file" aria-label={`Remove ${file.name}`}>✕</button>
      )}
    </div>
  );
}
