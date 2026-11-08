// Turn a comparison result into one markdown document an AI chat can read:
// the summary and entry lists, and the source diffs of every changed file as
// unified diffs (the form language models parse best).

import { createTwoFilesPatch } from 'diff';
import { allEntries, type DiffResult, type FileStatus } from './diffModel';

const FENCE = '````';

/** A short header line for an entry, relative inside nested archive chains. */
const label = (path: string) => path.replace(/ -> /g, ' › ');

function section(out: string[], title: string, paths: string[]): void {
  if (!paths.length) return;
  out.push(`## ${title} (${paths.length})`, '');
  for (const p of paths) out.push(`- ${label(p)}`);
  out.push('');
}

/** Unified diff with a little context; an empty result when the texts match. */
function patch(path: string, c1: string, c2: string): string {
  return createTwoFilesPatch(`a/${path}`, `b/${path}`, c1, c2, undefined, undefined, { context: 3 });
}

/**
 * The whole comparison as LLM-ready markdown: jar names, a summary, every
 * added / removed entry, and the source-level diff of each changed file
 * (decompiled Java for classes). Recompiled-but-identical classes are listed,
 * not diffed — their sources are equal by definition.
 */
export function buildAiExport(d: DiffResult, nameA: string, nameB: string): string {
  const entries = allEntries(d);
  const of = (status: FileStatus[]) => entries.filter((e) => status.includes(e.status)).map((e) => e.path);

  const added = of(['added']);
  const removed = of(['removed']);
  const modified = of(['modified', 'modifiedClasses']);
  const same = of(['identicalSourceClasses']);
  const nested = of(['nestedChanges']);
  const nestedModified = of(['modifiedNested']);

  // Files we can diff: content present and at least one side non-empty.
  const diffs: { path: string; body: string }[] = [];
  const unreadable: string[] = [];
  for (const p of [...modified, ...nestedModified]) {
    const c1 = d.contents[p]?.content1 ?? '';
    const c2 = d.contents[p]?.content2 ?? '';
    if (c1 || c2) diffs.push({ path: p, body: patch(p, c1, c2) });
    else unreadable.push(p);
  }

  const out: string[] = [
    `# JAR comparison: \`${nameA}\` → \`${nameB}\``,
    '',
    'Entry paths inside nested archives are joined with ` › `. Class files are decompiled' +
      'd to Java before diffing; classes listed as "identical source" recompiled to the same Java.',
    '',
    '## Summary',
    `- added entries: ${added.length}`,
    `- removed entries: ${removed.length}`,
    `- modified entries: ${diffs.length + unreadable.length}`,
    `- identical source after recompile: ${same.length}`,
    `- changed nested archives: ${nested.length + nestedModified.length}`,
    '',
  ];

  section(out, 'Added entries', added);
  section(out, 'Removed entries', removed);
  section(out, 'Changed nested archives', [...nested, ...nestedModified.filter((p) => unreadable.includes(p))]);
  section(out, 'Modified entries without readable content (binary)', unreadable);
  section(out, 'Identical source (bytecode-only changes)', same);

  if (diffs.length) {
    out.push(`## Modified entries — source diffs (${diffs.length})`, '');
    for (const { path, body } of diffs) {
      out.push(`### ${label(path)}`, '', FENCE + 'diff', body.trimEnd(), FENCE, '');
    }
  }
  return out.join('\n');
}

