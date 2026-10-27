// Fuzzy subsequence scoring for the command palette.

/** Null if `query` isn't a subsequence of `target`; higher score = better match. */
export function fuzzyScore(query: string, target: string): number | null {
  const q = query.toLowerCase();
  const t = target.toLowerCase();
  let qi = 0, score = 0, streak = 0, last = -2;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      streak = i === last + 1 ? streak + 1 : 0;
      score += 1 + streak;
      if (i === 0 || /[^A-Za-z0-9]/.test(t[i - 1])) score += 2; // word-boundary bonus
      last = i;
      qi++;
    }
  }
  return qi === q.length ? score : null;
}
