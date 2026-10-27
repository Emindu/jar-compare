// The comparison result produced by WebJarComparer (plus fields the UI fills
// in), and helpers for classifying its entries.

export interface FileContent {
  content1?: string;
  content2?: string;
}

export interface DiffResult {
  added: string[];
  removed: string[];
  modified: string[];
  modifiedClasses: string[];
  identicalSourceClasses: string[];
  nestedChanges: string[];
  modifiedNested: string[];
  contents: Record<string, FileContent>;
}

export type FileStatus = 'modifiedClasses' | 'modified' | 'added' | 'removed' | 'identicalSourceClasses' | 'nestedChanges' | 'modifiedNested';

/** The four states the UI shows, each always paired with a glyph. */
export type Change = 'add' | 'del' | 'mod' | 'same';

export const CHANGE_OF: Record<FileStatus, Change> = {
  added: 'add',
  removed: 'del',
  modified: 'mod',
  modifiedClasses: 'mod',
  nestedChanges: 'mod',
  modifiedNested: 'mod',
  identicalSourceClasses: 'same',
};

export const CHANGE_META: Record<Change, { glyph: string; label: string }> = {
  add: { glyph: '+', label: 'added' },
  del: { glyph: '−', label: 'removed' },
  mod: { glyph: '~', label: 'modified' },
  same: { glyph: '≡', label: 'same source' },
};

/** Which bucket a path currently lives in. */
export function classifyPath(d: DiffResult, path: string): FileStatus {
  if (d.modifiedClasses.includes(path)) return 'modifiedClasses';
  if (d.modified.includes(path)) return 'modified';
  if (d.added.includes(path)) return 'added';
  if (d.removed.includes(path)) return 'removed';
  if (d.identicalSourceClasses.includes(path)) return 'identicalSourceClasses';
  if (d.nestedChanges.includes(path)) return 'nestedChanges';
  return 'modifiedNested';
}

/** Every entry in the result with its status, in a stable order. */
export function allEntries(d: DiffResult): { path: string; status: FileStatus }[] {
  const order: FileStatus[] = ['modifiedClasses', 'modified', 'added', 'removed', 'identicalSourceClasses', 'nestedChanges', 'modifiedNested'];
  const seen = new Set<string>();
  const out: { path: string; status: FileStatus }[] = [];
  for (const status of order) {
    for (const path of d[status]) {
      if (seen.has(path)) continue;
      seen.add(path);
      out.push({ path, status });
    }
  }
  return out;
}
