import { resolutionProbe } from '../src/roster.js';
import type { FoldInput, LaterPairs } from '../src/roster.js';

// FW-R19's independent oracle: it shares no up-front, affects or stands code
// with the fold, only its grant evaluation (resolutionProbe().under()). It
// reads which removals the fold decided up front solely to check them.

/** The most removals able to hold their right whose subsets it enumerates. */
const MAX_COULD = 11;
/** The most removals left open by the up-front decisions it judges. */
const MAX_OPEN = 11;

/**
 * Why no verdict: too many removals, FW-R13(d) (a right needing two cuts at
 * once), no stable assignment (rank picks decide), or FW-R13(e) (a set
 * grounded only in an order that defers an up-front removal).
 */
export type Unjudged = 'large' | 'open' | 'two-cuts' | 'none' | 'deferred';

export interface IndependentVerdict {
  /** Up-front decisions some stable assignment decides the other way. */
  unsound: readonly string[];
  /** Whether the fold's answer is a stable assignment. */
  stable: boolean;
  /** Whether it is the rank-lexicographic one, ranks under the up-front. */
  wins: boolean;
  /** How many assignments are stable. */
  count: number;
}

const readsNoLaterPair = (): null => null;

/** The fold's decision against every assignment of the removals that can act. */
export function judge(
  input: FoldInput,
  later: LaterPairs = readsNoLaterPair
): IndependentVerdict | Unjudged {
  const probe = resolutionProbe(input, later);
  const n = probe.removals.length;
  const all = [...Array(n).keys()];
  const under = new Map<number, ReturnType<typeof probe.under>>();
  // FW-R14: a right with no cut, or one cut by another such removal.
  const J: number[] = all.filter((i) => probe.under([]).had(i));
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of all)
      if (!J.includes(x) && J.some((c) => c !== x && probe.under([c]).had(x))) {
        J.push(x);
        grew = true;
      }
  }
  J.sort((a, b) => a - b);
  const k = J.length;
  if (k > MAX_COULD) return 'large';
  const full = (1 << k) - 1;
  const bit = (b: number): number => 1 << b;
  const has = (m: number, b: number): boolean => ((m >> b) & 1) === 1;
  const fold = (m: number): ReturnType<typeof probe.under> => {
    const known = under.get(m);
    if (known !== undefined) return known;
    const f = probe.under(J.filter((_, b) => has(m, b)));
    under.set(m, f);
    return f;
  };
  const had = (m: number, b: number): boolean => fold(m).had(J[b] ?? -1);
  const masks = [...Array(full + 1).keys()];
  const outside = all.filter((x) => !J.includes(x));
  if (masks.some((m) => outside.some((x) => fold(m).had(x)))) return 'two-cuts';

  const maskOf = (idx: readonly number[]): number =>
    idx.reduce((m, i) => (J.includes(i) ? m | bit(J.indexOf(i)) : m), 0);
  const upDecided = probe.upfront.decided.filter((i) => J.includes(i));
  const upAcc = maskOf(probe.upfront.accepted);
  const upVoid = maskOf(upDecided) & ~upAcc;
  if (k - upDecided.length > MAX_OPEN) return 'open';

  const bits = [...Array(k).keys()];
  // Some order from `start` accepts each removal of m while it holds its right.
  const grounded = (m: number, start: number): boolean => {
    if ((start & m) !== start) return false;
    const seen = new Set([start]);
    const stack = [start];
    for (let g = stack.pop(); g !== undefined; g = stack.pop()) {
      if (g === m) return true;
      for (const b of bits) {
        const grown: number = g | bit(b);
        if (!has(m, b) || grown === g || seen.has(grown) || !had(g, b))
          continue;
        seen.add(grown);
        stack.push(grown);
      }
    }
    return false;
  };
  // FW-R19: void b holding its right is excused when accepting it cascades
  // until what remains has no admin or b lacks its right.
  const excused = (m: number, b: number): boolean => {
    let cur = m | bit(b);
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of bits)
        if (j !== b && has(cur, j) && !had(cur & ~bit(j), j)) {
          cur &= ~bit(j);
          changed = true;
        }
    }
    return fold(cur).admins === 0 || !had(cur & ~bit(b), b);
  };
  const consistent = (m: number): boolean =>
    fold(m).admins > 0 &&
    bits.every((b) => !has(m, b) || had(m & ~bit(b), b)) &&
    bits.every((b) => has(m, b) || !had(m, b) || excused(m, b));
  const stable = masks.filter((m) => consistent(m) && grounded(m, 0));

  const name = (b: number): string => {
    const o = probe.removals[J[b] ?? -1];
    return `${o?.replica ?? '?'}:${o?.seq ?? '?'}`;
  };
  const unsound = bits
    .filter((b) => has(upAcc | upVoid, b))
    .filter((b) => stable.some((m) => has(m, b) !== has(upAcc, b)))
    .map((b) => `${name(b)}=${has(upAcc, b) ? 'accepted' : 'void'}`);
  if (unsound.length > 0)
    return { unsound, stable: false, wins: false, count: stable.length };
  if (stable.length === 0) return 'none';
  // FW-R13(e): the fold grounds from the up-front decisions.
  if (stable.some((m) => !grounded(m, upAcc))) return 'deferred';

  const decided = maskOf(probe.accepted);
  const foldOutside = probe.accepted.some((i) => !J.includes(i));
  const ranks = fold(upAcc);
  const order = [...bits].sort((a, b) => ranks.rank(J[a] ?? -1, J[b] ?? -1));
  const beats = (a: number, b: number): boolean => {
    const top = order.find((x) => has(a ^ b, x));
    return top !== undefined && has(a, top);
  };
  const best = stable.reduce((w, m) => (beats(m, w) ? m : w));
  return {
    unsound,
    stable: !foldOutside && stable.includes(decided),
    wins: !foldOutside && best === decided,
    count: stable.length,
  };
}
