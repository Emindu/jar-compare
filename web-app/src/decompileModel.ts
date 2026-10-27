// Helpers for the Decompile browser: what kind of type a source declares, the
// letter shown for each entry, package grouping, outline and manifest parsing.

export type SourceKind = 'class' | 'interface' | 'record' | 'enum' | 'annotation';

const KIND_RE = /^(?:(?:public|protected|private|abstract|final|static|sealed|non-sealed|strictfp)\s+)*(class|interface|record|enum|@interface)\s+([A-Za-z_$][\w$]*)/m;

export function kindOf(source: string): { kind: SourceKind; name: string; header: string } | null {
  const m = KIND_RE.exec(source);
  if (!m) return null;
  const kind = m[1] === '@interface' ? 'annotation' : (m[1] as SourceKind);
  return { kind, name: m[2], header: m[0].trim() };
}

const KIND_LETTER: Record<SourceKind, string> = { class: 'C', interface: 'I', record: 'R', enum: 'E', annotation: 'A' };

/** Letter and colour class for a tree row. */
export function letterFor(path: string, kind?: SourceKind | null): { letter: string; tone: string } {
  if (path.endsWith('.java')) return { letter: KIND_LETTER[kind ?? 'class'], tone: `k-${kind ?? 'class'}` };
  const ext = path.split('.').pop()!.toLowerCase();
  if (/^(jar|war|ear)$/.test(ext)) return { letter: 'J', tone: 'k-archive' };
  if (ext === 'yml' || ext === 'yaml') return { letter: 'Y', tone: 'k-yaml' };
  if (ext === 'xml' || ext === 'xsd') return { letter: 'X', tone: 'k-xml' };
  if (ext === 'properties' || ext === 'mf') return { letter: 'P', tone: 'k-props' };
  if (ext === 'json') return { letter: '{', tone: 'k-json' };
  if (ext === 'sql') return { letter: 'S', tone: 'k-sql' };
  return { letter: '·', tone: 'k-other' };
}

const ARCHIVE_SEG = /\.(jar|war|ear)\//gi;

/** Split a decompiled path into its nested-archive prefix and the path inside it. */
export function splitArchive(path: string): { archive: string; inner: string } {
  let cut = -1;
  for (const m of path.matchAll(ARCHIVE_SEG)) cut = (m.index ?? 0) + m[0].length;
  return cut < 0 ? { archive: '', inner: path } : { archive: path.slice(0, cut - 1), inner: path.slice(cut) };
}

export function packageOf(path: string): string {
  const { archive, inner } = splitArchive(path);
  const dir = inner.includes('/') ? inner.slice(0, inner.lastIndexOf('/')).replace(/\//g, '.') : '(default package)';
  return archive ? `${archive.split('/').pop()} › ${dir}` : dir;
}

export interface OutlineItem {
  kind: 'class' | 'method' | 'field';
  name: string;
  line: number;
  /** "(Order) : BigDecimal" for methods, ": TaxTable" for fields. */
  detail: string;
}

const KEYWORDS = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'new', 'synchronized', 'else', 'try', 'do', 'throw']);
const simple = (t: string) => t.replace(/<.*>/, '').trim().split('.').pop() || t;

export function parseOutline(content: string): OutlineItem[] {
  const out: OutlineItem[] = [];
  if (!content) return out;
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const k = /^(?:public |private |protected |final |abstract |static |sealed )*(class|interface|enum|record|@interface)\s+([A-Za-z_$][\w$]*)/.exec(ln);
    if (k) { out.push({ kind: 'class', name: k[2], line: i + 1, detail: k[1] === '@interface' ? 'annotation' : k[1] }); continue; }
    if (!/^ {4}\S/.test(ln)) continue;
    // Method or constructor: [modifiers] [<T>] [ReturnType] name(params) [throws …] { or ;
    const m = /^ {4}(?:(?:public|private|protected|static|final|abstract|synchronized|native|default|strictfp)\s+)*(?:<[^>]+>\s+)?(?:([\w$.<>[\], ?]+?)\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)\s*(?:throws [\w$., ]+)?\s*[{;]/.exec(ln);
    if (m && !KEYWORDS.has(m[2])) {
      const params = m[3].split(',').map((p) => p.trim()).filter(Boolean)
        .map((p) => simple(p.replace(/@\w+\s+/g, '').replace(/\bfinal\s+/, '').split(/\s+/).slice(0, -1).join(' ') || p));
      const ret = m[1] && !KEYWORDS.has(m[1]) ? ` : ${simple(m[1])}` : '';
      out.push({ kind: 'method', name: m[2], line: i + 1, detail: `(${params.join(', ')})${ret}` });
      continue;
    }
    const f = /^ {4}(?:(?:public|private|protected|static|final|volatile|transient)\s+)*([\w$.<>[\], ?]+?)\s+([A-Za-z_$][\w$]*)\s*(?:=|;)/.exec(ln);
    if (f && !KEYWORDS.has(f[1])) out.push({ kind: 'field', name: f[2], line: i + 1, detail: `: ${simple(f[1])}` });
  }
  return out;
}

/** Parse a JAR manifest into ordered key/value pairs (continuation lines joined). */
export function parseManifest(text: string): { key: string; value: string }[] {
  const out: { key: string; value: string }[] = [];
  for (const raw of text.replace(/\r/g, '').split('\n')) {
    if (raw.startsWith(' ') && out.length) { out[out.length - 1].value += raw.slice(1); continue; }
    const i = raw.indexOf(':');
    if (i > 0) out.push({ key: raw.slice(0, i).trim(), value: raw.slice(i + 1).trim() });
  }
  return out;
}
