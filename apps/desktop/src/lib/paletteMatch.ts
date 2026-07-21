// A ~30-line hand-rolled fuzzy matcher for the command palette, per the redesign brief's
// call to write this rather than add a dependency for it. Subsequence match (every query
// character must appear in order in the target, not necessarily contiguously) with a score
// that rewards consecutive runs and prefix matches, so "dsp tsk" ranks "Dispatch task" above
// an unrelated string that happens to contain the same scattered letters.

/** Scores how well `query` fuzzy-matches `text` (case-insensitive). Returns `null` when some
 * query character has no match left in `text` at all (not a match); otherwise a
 * non-negative number where higher means a better match. An empty query matches everything
 * with score 0, so clearing the palette input shows the full unranked list. */
export function fuzzyScore(query: string, text: string): number | null {
  const q = query.trim().toLowerCase();
  if (q === '') return 0;
  const t = text.toLowerCase();

  let qi = 0;
  let score = 0;
  let consecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      // Each additional character in an unbroken run is worth more than the last, so a
      // tight contiguous match beats an equal-length scattered one.
      score += 1 + consecutive * 2;
      consecutive++;
      qi++;
    } else {
      consecutive = 0;
    }
  }
  if (qi < q.length) return null;
  if (t.startsWith(q)) score += 10;
  return score;
}

export interface PaletteItem {
  id: string;
  label: string;
  sublabel?: string;
}

/** Ranks `items` by fuzzy match against `label`+`sublabel` combined (so a task's id and
 * title both count), filtering out non-matches. An empty query returns `items` unchanged
 * (original order), matching `fuzzyScore`'s "empty query matches everything" behavior. */
export function rankPaletteItems<T extends PaletteItem>(
  items: T[],
  query: string
): T[] {
  if (query.trim() === '') return items;
  return items
    .map((item) => ({
      item,
      score: fuzzyScore(query, `${item.label} ${item.sublabel ?? ''}`),
    }))
    .filter(
      (scored): scored is { item: T; score: number } => scored.score !== null
    )
    .sort((a, b) => b.score - a.score)
    .map((scored) => scored.item);
}
