// Fuzzy matching for the command palette: typed tokens against an item's
// label and hint (an identifier like "ATL-142"). Pure and dependency-free so
// it can be unit-tested and reused by hosts that filter elsewhere.

export interface FuzzyMatch {
  /** Higher is better; only meaningful relative to other matches. */
  score: number;
  /** Indices into the label that matched, for highlighting. */
  labelHits: number[];
  /** Indices into the hint that matched. */
  hintHits: number[];
}

interface TokenHit {
  score: number;
  hits: number[];
}

function isWordStart(text: string, i: number): boolean {
  if (i === 0) return true;
  const prev = text[i - 1];
  return /[\s\-_/·.:›(]/.test(prev);
}

/**
 * Best match of one lowercase token inside `text`. A contiguous substring
 * wins (more if it starts a word or the text); otherwise the token must
 * appear as an in-order subsequence, scored by runs and word starts.
 * `strict` (hints) keeps only subsequences where every character starts a
 * word or continues a run ("eng24" → "ENG-24"), so a context hint such as a
 * lead's name cannot match by scattered letters ("atl" in "Patel").
 */
function matchToken(
  token: string,
  text: string,
  strict = false
): TokenHit | null {
  const lower = text.toLowerCase();
  const at = lower.indexOf(token);
  if (at >= 0) {
    // Prefer an occurrence at a word start over the first occurrence.
    let start = at;
    for (let i = at; i >= 0; i = lower.indexOf(token, i + 1)) {
      if (isWordStart(text, i)) {
        start = i;
        break;
      }
    }
    const hits = Array.from({ length: token.length }, (_, k) => start + k);
    let score = 10 + token.length * 4;
    if (start === 0) score += 8;
    else if (isWordStart(text, start)) score += 5;
    if (token.length === lower.length) score += 6;
    return { score, hits };
  }
  // Try each occurrence of the first character as the anchor ("tml" should
  // anchor on Timeline, not on "to"); keep the best deliberate match.
  let best: TokenHit | null = null;
  let anchors = 0;
  for (
    let a = lower.indexOf(token[0]);
    a >= 0 && anchors < 12;
    a = lower.indexOf(token[0], a + 1)
  ) {
    anchors += 1;
    for (const preferStarts of [true, false]) {
      const hit = matchSubsequence(token, text, lower, a, preferStarts, strict);
      if (hit !== null && (best === null || hit.score > best.score)) best = hit;
    }
  }
  return best;
}

/**
 * In-order subsequence match from a fixed first hit (`anchor`). With
 * `preferStarts`, each later character first tries to continue the previous
 * hit, then a word start ("gtw" → "Go To my Week"), then any occurrence. A
 * match is kept only when it reads as deliberate: every hit continues a run
 * or starts a word, or the whole match spans at most twice the token's
 * length. That stops "atl" from matching "prorATe mid-cycLe" by accident.
 */
function matchSubsequence(
  token: string,
  text: string,
  lower: string,
  anchor: number,
  preferStarts: boolean,
  strict: boolean
): TokenHit | null {
  if (strict && !isWordStart(text, anchor)) return null;
  const hits: number[] = [anchor];
  let score = 1 + (isWordStart(text, anchor) ? 2 : 0);
  let loose = 0;
  let prev = anchor;
  for (const ch of token.slice(1)) {
    const from = prev + 1;
    let i = -1;
    if (preferStarts) {
      if (lower[from] === ch && hits.length > 0) i = from;
      else {
        for (
          let j = lower.indexOf(ch, from);
          j >= 0;
          j = lower.indexOf(ch, j + 1)
        ) {
          if (isWordStart(text, j)) {
            i = j;
            break;
          }
        }
      }
    }
    if (i < 0) i = lower.indexOf(ch, from);
    if (i < 0) return null;
    const run = i === prev + 1;
    const start = isWordStart(text, i);
    if (hits.length > 0 && !run && !start) loose += 1;
    score += 1 + (run ? 3 : 0) + (start ? 2 : 0);
    hits.push(i);
    prev = i;
  }
  const span = hits[hits.length - 1] - hits[0] + 1;
  if (loose > 0 && (strict || span > token.length * 2)) return null;
  // Spread-out matches are weak: penalise the distance they cover.
  score -= Math.min(6, Math.floor(span / 6));
  return { score, hits };
}

/**
 * Scores `query` against a label and optional hint. Every whitespace-
 * separated token must match the label or the hint; label matches weigh a
 * little more. In the hint a token must be a substring or a run of word
 * starts (an identifier), not scattered letters. Returns null when any
 * token misses. An empty query matches everything with score 0.
 */
export function fuzzyMatch(
  query: string,
  label: string,
  hint?: string
): FuzzyMatch | null {
  const tokens = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  const result: FuzzyMatch = { score: 0, labelHits: [], hintHits: [] };
  for (const token of tokens) {
    const inLabel = matchToken(token, label);
    const inHint =
      hint === undefined || hint === '' ? null : matchToken(token, hint, true);
    if (inLabel === null && inHint === null) return null;
    if (
      inLabel !== null &&
      (inHint === null || inLabel.score + 2 >= inHint.score)
    ) {
      result.score += inLabel.score + 2;
      result.labelHits.push(...inLabel.hits);
    } else if (inHint !== null) {
      result.score += inHint.score;
      result.hintHits.push(...inHint.hits);
    }
  }
  return result;
}

/** Splits `text` into plain and matched runs for rendering a highlight. */
export function highlightRuns(
  text: string,
  hits: readonly number[]
): { text: string; hit: boolean }[] {
  if (hits.length === 0) return [{ text, hit: false }];
  const marked = new Set(hits);
  const runs: { text: string; hit: boolean }[] = [];
  for (let i = 0; i < text.length; i++) {
    const hit = marked.has(i);
    const last = runs[runs.length - 1];
    if (last !== undefined && last.hit === hit) last.text += text[i];
    else runs.push({ text: text[i], hit });
  }
  return runs;
}
