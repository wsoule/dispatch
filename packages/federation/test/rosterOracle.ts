import { resolutionProbe } from '../src/roster.js';
import type { FoldInput, LaterPairs, RosterOpRef } from '../src/roster.js';

// The brute-force oracle for the resolution (FW-R16, as FW-R18 and FW-R19
// restate it), which reads the fold's up-front decisions as the fold does.

const readsNoLaterPair = (): null => null;

/** The most removals whose every accept/void assignment the oracle tries. */
const MAX_ENUMERATED = 11;

/** The oracle's verdict on one op set, its masks over the probe's removals. */
export interface Verdict {
  /** The Known(1) removals, which the masks index. */
  removals: readonly RosterOpRef[];
  /** Removals the up-front decisions leave open. */
  open: number;
  /** How many assignments are stable. */
  stable: number;
  /** What the fold accepted. */
  decided: bigint;
  /** The rank-lexicographic stable assignment, or null when none is. */
  best: bigint | null;
}

/**
 * Why the oracle judges no verdict: too many removals to enumerate, or
 * FW-R13(d), a right that needs two or more cuts at once.
 */
export type Skipped = 'large' | 'two-cuts';

// A removal's cut as its body names it.
function cutOf(op: RosterOpRef): {
  kind: string;
  target: string;
  after: number;
} {
  const b = op.body as unknown as Record<string, unknown>;
  const kind =
    b.action === 'revoke' ? 'all' : b.action === 'role' ? 'admin' : 'hosts';
  return { kind, target: String(b.replica), after: Number(b.afterSeq) };
}

/**
 * Every accept/void assignment of the Known(1) removals able to hold their
 * right, and the one the definition picks. Up front, a removal no undecided
 * one affects is accepted with its right (unless no admin is sure to stand
 * once it and those it cuts below are decided) or void without it, and one an
 * accepted revocation cuts below is void.
 * Among the rest, an assignment is stable when an admin stands, each accepted
 * removal holds its right under all the other accepted ones, some order from
 * the up-front ones accepts each while its right holds under those before it,
 * and each void removal holding its right is void only because accepting it
 * cascades until what remains has no admin or it lacks its right. The pick accepts the
 * earliest-ranked removal it can, ranks read under the up-front decisions.
 */
export function oracle(
  input: FoldInput,
  later: LaterPairs = readsNoLaterPair
): Verdict | Skipped {
  const probe = resolutionProbe(input, later);
  const n = probe.removals.length;
  const idx = [...Array(n).keys()];
  const has = (m: bigint, i: number): boolean => ((m >> BigInt(i)) & 1n) === 1n;
  const listed = (m: bigint): number[] => idx.filter((i) => has(m, i));
  const bit = (i: number): bigint => 1n << BigInt(i);
  const folds = new Map<bigint, ReturnType<typeof probe.under>>();
  const under = (m: bigint): ReturnType<typeof probe.under> => {
    const known = folds.get(m);
    if (known !== undefined) return known;
    const f = probe.under(listed(m));
    folds.set(m, f);
    return f;
  };
  const had = (m: bigint, i: number): boolean => under(m).had(i);
  // FW-R14: a right held with no cut, or with one cut by another such removal.
  let could = idx.filter((i) => had(0n, i)).reduce((m, i) => m | bit(i), 0n);
  for (let grew = true; grew; ) {
    grew = false;
    for (const x of idx)
      if (
        !has(could, x) &&
        idx.some((c) => c !== x && has(could, c) && had(bit(c), x))
      ) {
        could |= bit(x);
        grew = true;
      }
  }
  const J = listed(could);
  const subsets = (of: readonly number[]): bigint[] =>
    Array.from({ length: 1 << of.length }, (_, k) =>
      of.reduce((m, i, j) => (((k >> j) & 1) === 1 ? m | bit(i) : m), 0n)
    );
  // Only the removals that affect x can change its right (a failure of that
  // shows as a disagreement below, never as a skip).
  const sources = (x: number): number[] => J.filter((c) => probe.affects(c, x));
  const outside = idx.filter((x) => !has(could, x));
  if (outside.some((x) => sources(x).length > MAX_ENUMERATED)) return 'large';
  if (outside.some((x) => subsets(sources(x)).some((m) => had(m, x))))
    return 'two-cuts';

  // Up-front decisions.
  const cuts = probe.removals.map(cutOf);
  const below = (c: number, r: number): boolean =>
    cuts[c]?.kind === 'all' &&
    cuts[c]?.target === probe.removals[r]?.replica &&
    (cuts[c]?.after ?? 0) < (probe.removals[r]?.seq ?? 0);
  let acc = 0n;
  let dec = 0n;
  const undecided = (): number[] => J.filter((r) => !has(dec, r));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of J) {
      if (has(dec, s)) continue;
      const free = !undecided().some((r) => probe.affects(r, s));
      if (!free && !J.some((c) => has(acc, c) && below(c, s))) continue;
      const right = free && had(acc, s);
      const rest = undecided().filter((r) => r !== s && !below(s, r));
      if (
        right &&
        cuts[s]?.kind !== 'hosts' &&
        !probe.stands(listed(acc | bit(s)), rest)
      )
        continue;
      dec |= bit(s);
      if (right) acc |= bit(s);
      grew = true;
    }
  }

  const open = J.filter((i) => !has(dec, i));
  if (open.length > MAX_ENUMERATED) return 'large';
  const admins = (m: bigint): number => under(m).admins;
  // Some order from the up-front removals accepts each while it holds its right.
  const grounded = (m: bigint): boolean => {
    const seen = new Set([acc]);
    const stack = [acc];
    for (let g = stack.pop(); g !== undefined; g = stack.pop()) {
      if (g === m) return true;
      for (const r of open) {
        const grown: bigint = g | bit(r);
        if (!has(m, r) || grown === g || seen.has(grown) || !had(g, r))
          continue;
        seen.add(grown);
        stack.push(grown);
      }
    }
    return false;
  };
  // Accepting void i drops, in turn, each accepted removal left without its
  // right; i is excused when what remains leaves no admin or i without its
  // right (FW-R19: judged after the cascade, never on m plus i).
  const excused = (m: bigint, i: number): boolean => {
    let cur = m | bit(i);
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of J)
        if (j !== i && has(cur, j) && !had(cur & ~bit(j), j)) {
          cur &= ~bit(j);
          changed = true;
        }
    }
    return admins(cur) === 0 || !had(cur & ~bit(i), i);
  };
  const isStable = (m: bigint): boolean =>
    admins(m) > 0 &&
    J.every((j) => !has(m, j) || had(m & ~bit(j), j)) &&
    grounded(m) &&
    J.every((i) => has(m, i) || !had(m, i) || excused(m, i));
  const stable = subsets(open)
    .map((x) => acc | x)
    .filter(isStable);
  // Priority order: publisher rank, then position, read under the up-front
  // decisions alone.
  const ranks = under(acc);
  const order = [...open].sort((a, b) => ranks.rank(a, b));
  const beats = (a: bigint, b: bigint): boolean => {
    const top = order.find((i) => has(a ^ b, i));
    return top !== undefined && has(a, top);
  };
  const best = stable.reduce<bigint | null>(
    (w, m) => (w === null || beats(m, w) ? m : w),
    null
  );
  const decided = probe.accepted.reduce((m, i) => m | bit(i), 0n);
  return {
    removals: probe.removals,
    open: open.length,
    stable: stable.length,
    decided,
    best,
  };
}
