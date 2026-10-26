// Recently opened items, by name only (never file contents), kept in this
// browser. Used by the Home launcher. Storage can be unavailable; every access
// is wrapped so the app works without it.

export type RecentKind = 'compare' | 'decompile' | 'profile' | 'markdown';

export interface RecentItem {
  kind: RecentKind;
  label: string;
  at: number; // epoch ms
}

const KEY = 'jar-compare.recent';
const MAX = 8;

export function loadRecent(): RecentItem[] {
  try {
    const raw = localStorage.getItem(KEY);
    const list = raw ? (JSON.parse(raw) as RecentItem[]) : [];
    return Array.isArray(list) ? list.filter((r) => r && typeof r.label === 'string') : [];
  } catch {
    return [];
  }
}

export function addRecent(kind: RecentKind, label: string): RecentItem[] {
  const list = [{ kind, label, at: Date.now() }, ...loadRecent().filter((r) => !(r.kind === kind && r.label === label))].slice(0, MAX);
  try { localStorage.setItem(KEY, JSON.stringify(list)); } catch { /* storage unavailable */ }
  return list;
}

export function clearRecent(): void {
  try { localStorage.removeItem(KEY); } catch { /* storage unavailable */ }
}

export function timeAgo(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.round(h / 24);
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  if (d < 14) return 'last week';
  return new Date(at).toLocaleDateString();
}
