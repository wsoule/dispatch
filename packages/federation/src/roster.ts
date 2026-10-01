import { hlcWallMs, TAG, verifyText } from '@dispatch/protocol/federation';
import type {
  LegacyAttestation,
  RosterBody,
} from '@dispatch/protocol/federation';

import { FREE_SEATS, readLicenseKey } from './license.js';
import type { LicenseState } from './license.js';
import { comparePositions } from './position.js';
import type { Position } from './position.js';

// The roster fold: members, roles, hosts, ranks and seats from the set of
// verified roster ops alone, so every daemon and the relay agree.

/** How long after the founding only an admin may close the legacy window. */
export const LEGACY_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** A verified roster op: its position, its op hash and its body. */
export interface RosterOpRef extends Position {
  hash: string;
  body: RosterBody;
}

/** What the fold needs of a replica's pinned key. */
export interface KeyInfo {
  replica: string;
  handle: string;
  signPub: string;
  fingerprint: string;
  invite?: { id: string; sig: string };
}

export interface FoldInput {
  /** The pinned founding op, which must be among `ops`. */
  founder: { replica: string; seq: number };
  ops: readonly RosterOpRef[];
  keys: ReadonlyMap<string, KeyInfo>;
  now: Date;
  licensePublicKey: string | null;
  /** The relay never pauses: it folds the same roster, ops it cannot read left inert. */
  relay?: boolean;
}

export interface RosterMember {
  replica: string;
  handle: string;
  role: 'member' | 'admin';
  hosts: string[];
  observer: boolean;
  /** 0 for the earliest-ranked admin; null for a member. */
  rank: number | null;
  recovered: boolean;
  /** Where it was admitted. */
  since: Position;
}

/** A revoked replica's cut, and what it held, which its ops at or below afterSeq still speak for. */
export interface RevokedReplica {
  afterSeq: number;
  afterHash: string;
  /** Null when it was never admitted. */
  handle: string | null;
  hosts: readonly string[];
  observer: boolean;
}

/** An op a valid dismiss took out of the fold, and the admin who dismissed it. */
export interface Dismissal {
  replica: string;
  seq: number;
  hash: string;
  by: string;
}

/** The first op that pauses this build, named as a dismiss names it. */
export interface Paused extends Position {
  hash: string;
}

type Transport = { kind: 'git' | 'relay'; url?: string };
type Invite = { pub: string; handle: string; expires: string; by: string };
type Closed = { by: string; entries: readonly LegacyAttestation[] };
type HostCut = { afterSeq: number; hosts: readonly string[] };
type Problem = { subject: string; message: string };
type Resolution = 'accepted' | 'void';

export interface RosterView {
  teamId: string;
  name: string;
  founder: string;
  members: ReadonlyMap<string, RosterMember>;
  revoked: ReadonlyMap<string, RevokedReplica>;
  /** Per replica, the hosts each accepted hosts removal took away. */
  hostCuts: ReadonlyMap<string, HostCut[]>;
  /** Each removal's op hash (revoke, demotion, hosts cut) → the fold's decision. */
  resolution: ReadonlyMap<string, Resolution>;
  /** Pinned keys neither admitted nor revoked, sorted. */
  pending: readonly string[];
  invites: ReadonlyMap<string, Invite>;
  /** Pending replica → the handle whose invite its key op proves. */
  invitedBy: ReadonlyMap<string, string>;
  recoveryPub: string;
  license: LicenseState;
  licenseBy: string | null;
  seats: number;
  /** Handles that count for seats, in the order each was first granted. */
  people: readonly string[];
  covered: ReadonlySet<string>;
  legacy: {
    deadlineMs: number;
    attested: readonly LegacyAttestation[];
    closed: Closed | null;
  };
  transport: Transport;
  /** The ops valid dismisses took out of the fold, one per valid dismiss. */
  dismissed: readonly Dismissal[];
  problems: readonly Problem[];
  /**
   * Set while the fold keeps an unreadable op from a member or admin at it, no
   * observer (naming the first); the caller then applies nothing. Always null
   * for the relay.
   */
  unknown: Paused | null;
}

/**
 * How a build reads a pair outside Known(1): its meaning as an rv 1 body, which
 * the fold refuses when it would decide a right, or null when it cannot read it.
 */
export type LaterPairs = (body: Readonly<Record<string, unknown>>) => unknown;

type Body = RosterBody | 'unknown' | 'malformed';
// Level-independent: a well-formed Known(1) op, a pair outside Known(1), or malformed.
type Kind = 'known' | 'later' | 'malformed';
type Action<A extends RosterBody['action']> = Extract<
  RosterBody,
  { action: A }
>;
type CutKind = 'all' | 'admin' | 'hosts';

interface Item {
  op: RosterOpRef;
  kind: Kind;
  /** What this build reads; `unknown` when it cannot. */
  body: Body;
}

// A revoke, a demotion, or a hosts change carrying afterSeq: it cuts the
// target's rights for the target's ops above afterSeq.
interface Removal {
  op: RosterOpRef;
  target: string;
  afterSeq: number;
  afterHash: string;
  kind: CutKind;
  /** Read from a pair outside Known(1). */
  later: boolean;
}

interface Grant {
  pos: Position;
  admin: boolean;
  source: 'found' | 'recover' | 'grant';
}

interface Holder {
  handle: string;
  hosts: string[];
  observer: boolean;
  since: Position;
  recovered: boolean;
}

// A dismiss and the op it names; null when this daemon does not hold one.
interface Dismiss {
  item: Item;
  named: Item | null;
}

// A dismiss naming an op outside Known(1), which it may take out of the fold.
interface Eligible extends Dismiss {
  named: Item;
}

interface Context {
  input: FoldInput;
  items: readonly Item[];
  /** The items that can grant a right, all a fold of rights alone walks. */
  granting: readonly Item[];
  found: { op: RosterOpRef; body: Action<'found'> };
  teamId: string;
  deadlineMs: number;
  /** Each replica's lowest Known(1) roster op seq, where a pending recover goes. */
  firstSeq: ReadonlyMap<string, number>;
  /** The replicas whose rights a removal's cut can change, its target included. */
  reach: (cut: Removal) => ReadonlySet<string>;
  /** What the target's ops a cut exposes link to; its target only via a cycle. */
  exposes: (cut: Removal) => ReadonlySet<string>;
  /** comparePositions, by index for the ops being folded. */
  order: (a: Position, b: Position) => number;
  /** Whether a recover's proof verifies against a recovery key, memoized. */
  proves: (recover: RosterOpRef, proof: string, pub: string) => boolean;
}

// Everything one walk over the ops in fold order derives, given the removals
// accepted so far.
interface Evaluation {
  cuts: readonly Removal[];
  /** The accepted cuts by target. */
  cutsOn: ReadonlyMap<string, readonly Removal[]>;
  order: (a: Position, b: Position) => number;
  holders: Map<string, Holder>;
  grants: Map<string, Grant[]>;
  invites: Map<string, Invite>;
  recoveryPub: string;
  usedRecovery: Set<string>;
  licenses: { key: string; by: string }[];
  transport: Transport;
  legacyClosed: Closed | null;
  /** Handles in the order each was first granted, for seats. */
  people: string[];
  peopleSeen: Set<string>;
  hostCuts: Map<string, HostCut[]>;
  /** Whether this evaluation keeps problems; only the one the view shows does. */
  notes: boolean;
  problems: Problem[];
}

// What reading a replica's rights needs: its grants, the cuts on it, the order.
type Granted = Pick<Evaluation, 'cutsOn' | 'order' | 'grants'>;

// Evaluations under sets of removals, memoized by set.
type Folds = (cuts: readonly Removal[]) => Evaluation;

// The decision on the Known(1) removals: those accepted, and the rank picks
// among them.
interface Decision {
  accepted: Removal[];
  won: ReadonlySet<Removal>;
}

// What a component's search reads: the folds, which removals affect which,
// whether some admin stands in every fold, and the cuts decided outside it.
interface Given {
  ctx: Context;
  fold: Folds;
  affects: (r: Removal, s: Removal) => boolean;
  safe: boolean;
  outside: readonly Removal[];
}

// One fold of every op but `without`, its removals resolved.
interface Folded extends Resolved {
  ctx: Context;
  without: ReadonlySet<Item>;
}

// The evaluation under the accepted removals, and the fight winners among them.
interface Resolved {
  ev: Evaluation;
  resolution: Map<string, Resolution>;
  accepted: readonly Removal[];
  won: ReadonlySet<Removal>;
}

const NO_ADMIN = 'would leave the team with no admin; void';

// The most contested removals one search decides; a larger component takes
// the FW-R7 rank fallback.
const MAX_CONTESTED = 18;

const NEWER_ROSTER =
  "a teammate's newer Dispatch changed the roster in a way this build cannot read; upgrade to continue";

const READS_NO_LATER_PAIR: LaterPairs = () => null;

/**
 * Folds verified roster ops, less those admins dismissed, into the team's view:
 * grants count at their position, removals cut by seq, and a fight goes by rank.
 */
export function foldRoster(input: FoldInput): RosterView {
  return foldRosterAt(input, READS_NO_LATER_PAIR);
}

/**
 * The fold as a build that also reads the pairs outside Known(1) `later` reads.
 * Dismisses only ever take such ops out, so every build folds the same set.
 */
export function foldRosterAt(input: FoldInput, later: LaterPairs): RosterView {
  const { final, dismisses, valid } = finalFold(input, later);
  return viewOf(final, dismisses, valid);
}

/**
 * The accepted removals, by op hash, that won no fight and whose publisher
 * lacks the right at them in the final fold. The resolution leaves none.
 */
export function unfoundedRemovals(
  input: FoldInput,
  later: LaterPairs
): string[] {
  const { ctx, accepted, won } = finalFold(input, later).final;
  const unfounded = (r: Removal): boolean => {
    const others = accepted.filter((o) => o !== r);
    return !won.has(r) && !hadRight(ctx, evaluate(ctx, others), r);
  };
  return accepted.filter(unfounded).map((r) => r.op.hash);
}

/** The final fold's Known(1) removals, its decision, and rights under any cuts. */
export interface ResolutionProbe {
  removals: readonly RosterOpRef[];
  accepted: readonly number[];
  won: readonly number[];
  /** Whether accepting removal i can change the right removal j needs. */
  affects: (i: number, j: number) => boolean;
  /** Whether an admin under `cuts` that no removal in `rest` reaches stands. */
  stands: (cuts: readonly number[], rest: readonly number[]) => boolean;
  under: (cuts: readonly number[]) => {
    /** Whether removal i's publisher holds its right. */
    had: (i: number) => boolean;
    admins: number;
    /** Removals i and j by their publishers' rank at each, then position. */
    rank: (i: number, j: number) => number;
  };
}

/** The fold's rights under chosen removals, for the brute-force oracle test. */
export function resolutionProbe(
  input: FoldInput,
  later: LaterPairs
): ResolutionProbe {
  const { ctx, accepted, won } = finalFold(input, later).final;
  const removals = ctx.items
    .map(removalOf)
    .filter((r): r is Removal => r !== null && !r.later);
  // Matched by op: the fold built its own Removal objects.
  const indexOf = (rs: Iterable<Removal>): number[] =>
    [...rs]
      .map((r) => removals.findIndex((x) => x.op === r.op))
      .filter((i) => i >= 0);
  const fold = foldsOf(ctx, removals);
  const at = (i: number): Removal => removals[i];
  const affects = affectsOf(ctx);
  return {
    removals: removals.map((r) => r.op),
    accepted: indexOf(accepted),
    won: indexOf(won),
    affects: (i, j) => affects(at(i), at(j)),
    stands: (cuts, rest) => stands(ctx, fold(cuts.map(at)), rest.map(at)),
    under: (cuts) => {
      const ev = fold(cuts.map(at));
      return {
        had: (i) => hadRight(ctx, ev, at(i)),
        admins: adminsOf(ev).length,
        rank: (i, j) => byRank(ev, at(i), at(j)),
      };
    },
  };
}

// The base fold leaves out every op an eligible dismiss names, valid or not;
// the final fold only the ops valid ones name.
function finalFold(
  input: FoldInput,
  later: LaterPairs
): { final: Folded; dismisses: Dismiss[]; valid: Set<Eligible> } {
  const all = dedupe(input.ops)
    .sort(comparePositions)
    .map((op) => itemOf(op, later));
  const shared = sharedOf(input, all);
  const dismisses = dismissesOf(all);
  const eligible = dismisses.filter(
    (d): d is Eligible => d.named?.kind === 'later'
  );
  const base = foldWithout(shared, new Set(eligible.map((d) => d.named)));
  const valid = new Set(eligible.filter((d) => validIn(base.ev, d)));
  const named = new Set([...valid].map((d) => d.named));
  // What valid dismisses name is a subset of what eligible ones do.
  const final =
    named.size === base.without.size ? base : foldWithout(shared, named);
  return { final, dismisses, valid };
}

// Judged in the base fold: an admin at the dismiss may name its own op, a
// non-admin's, or one from an admin it outranks, each rank read at its op.
function validIn(ev: Evaluation, { item, named }: Eligible): boolean {
  const { op } = item;
  const x = named.op;
  if (!rightsAt(ev, op.replica, op.seq, op).admin) return false;
  if (x.replica === op.replica) return true;
  if (!rightsAt(ev, x.replica, x.seq, x).admin) return true;
  return (
    compareRanks(ev.order, rankOf(ev, rankAt(op)), rankOf(ev, rankAt(x))) < 0
  );
}

// Decides every removal, accepted or void, and evaluates the ops under the
// accepted ones.
function resolve(ctx: Context): Resolved {
  const all = ctx.items.map(removalOf).filter((r): r is Removal => r !== null);
  // Only Known(1) removals fight; a later one never changes a right, so it is
  // decided on the result.
  const known = all.filter((r) => !r.later);
  const fold = foldsOf(ctx, known);
  // A result with no admin (only after a rank pick) voids its latest-ranked
  // accepted removal, and the fight is fought again with it held void.
  const held: Removal[] = [];
  let fight = decide(ctx, known, fold);
  let ev = fold(fight.accepted);
  while (adminsOf(ev).length === 0 && fight.accepted.length > 0) {
    const last = fight.accepted.reduce((w, r) =>
      byRank(ev, r, w) > 0 ? r : w
    );
    held.push(last);
    fight = decide(
      ctx,
      known.filter((r) => !held.includes(r)),
      fold
    );
    ev = fold(fight.accepted);
  }
  // A later removal stands only where its publisher holds its right in the
  // result, where a build that cannot read it pauses rather than differs.
  const upheld = new Set<Removal>(fight.accepted);
  for (const r of all) if (r.later && hadRight(ctx, ev, r)) upheld.add(r);
  const accepted = all.filter((r) => upheld.has(r));
  const resolution = new Map<string, Resolution>();
  for (const r of all)
    resolution.set(r.op.hash, upheld.has(r) ? 'accepted' : 'void');
  const final = evaluate(ctx, accepted, true);
  // Held void by the re-run, or void holding its right as accepting it would
  // leave no admin.
  const noAdmin = known.filter(
    (r) =>
      held.includes(r) ||
      (!upheld.has(r) &&
        hadRight(ctx, ev, r) &&
        adminsOf(fold([...fight.accepted, r])).length === 0)
  );
  for (const r of noAdmin)
    note(
      final,
      r.op,
      `${r.op.replica}'s removal at seq ${r.op.seq} ${NO_ADMIN}`
    );
  return { ev: final, resolution, accepted, won: fight.won };
}

// Memoizes a fold of rights alone by the set of removals, in fold order.
function foldsOf(ctx: Context, removals: readonly Removal[]): Folds {
  const index = new Map(removals.map((r, i) => [r, i]));
  const memo = new Map<string, Evaluation>();
  return (cuts) => {
    const at = (r: Removal): number => index.get(r) ?? -1;
    const sorted = [...cuts].sort((a, b) => at(a) - at(b));
    const key = sorted.map(at).join(',');
    const known = memo.get(key);
    if (known !== undefined) return known;
    const ev = evaluate(ctx, sorted, false, ctx.granting);
    memo.set(key, ev);
    return ev;
  };
}

// FW-R16: the rank-lexicographic grounded, self-consistent decision. Removals
// whose publisher could hold its right are searched; one left out rejoins
// when it holds its right in the result.
function decide(
  ctx: Context,
  removals: readonly Removal[],
  fold: Folds
): Decision {
  const joined = couldHold(ctx, removals, fold);
  for (;;) {
    const decision = decideAmong(
      ctx,
      removals.filter((r) => joined.has(r)),
      fold
    );
    const ev = fold(decision.accepted);
    const missed = removals.filter(
      (r) => !joined.has(r) && hadRight(ctx, ev, r)
    );
    if (missed.length === 0) return decision;
    for (const r of missed) joined.add(r);
  }
}

// FW-R14: the removals whose publisher holds its right in the real fold with
// no cut, or with one cut by another such removal (a least fixed point).
function couldHold(
  ctx: Context,
  removals: readonly Removal[],
  fold: Folds
): Set<Removal> {
  const bare = fold([]);
  const could = new Set(removals.filter((r) => hadRight(ctx, bare, r)));
  for (let grew = true; grew; ) {
    grew = false;
    for (const u of removals) {
      if (could.has(u)) continue;
      if (![...could].some((c) => c !== u && hadRight(ctx, fold([c]), u)))
        continue;
      could.add(u);
      grew = true;
    }
  }
  return could;
}

// Whether accepting r can change the right s needs: r's cut reaches s's
// publisher (its target only for ops it cuts or grants it may refuse), or s's
// target where a member may revoke its own handle's device. A hosts cut
// changes no right.
function affectsOf(ctx: Context): (r: Removal, s: Removal) => boolean {
  const handles = new Map<string, Set<string>>();
  for (const replica of ctx.input.keys.keys())
    handles.set(replica, new Set([handleOf(ctx, replica)]));
  for (const { body } of ctx.items)
    if (isAction(body, 'admit')) {
      const known = handles.get(body.replica);
      if (known === undefined)
        handles.set(body.replica, new Set([body.handle]));
      else known.add(body.handle);
    }
  // Whether a and b can hold one handle, as some key or admit gives each.
  const share = (a: string, b: string): boolean => {
    const theirs = handles.get(b) ?? new Set([personOf(b)]);
    return [...(handles.get(a) ?? [personOf(a)])].some((h) => theirs.has(h));
  };
  return (r, s) => {
    if (r === s || r.kind === 'hosts') return false;
    const by = s.op.replica;
    if (ctx.exposes(r).has(by)) return true;
    // A revocation refuses its target's grants after it, which may precede s.
    const later = r.kind === 'all' && ctx.order(r.op, s.op) < 0;
    if (by === r.target && (s.op.seq > r.afterSeq || later)) return true;
    return (
      s.kind === 'all' && ctx.reach(r).has(s.target) && share(by, s.target)
    );
  };
}

// A removal no undecided one affects is decided outright: void without its
// right, else accepted, unless the no-admin rule could void it (no admin sure
// to stand once it and the removals it cuts below are decided); one an
// accepted revocation cuts below is void. The rest is searched per connected
// component, as one when the no-admin rule couples them all.
function decideAmong(
  ctx: Context,
  list: readonly Removal[],
  fold: Folds
): Decision {
  const affects = affectsOf(ctx);
  const accepted: Removal[] = [];
  const decided = new Set<Removal>();
  // Whether c, accepted, leaves r's publisher no right: a revocation below r.
  const below = (c: Removal, r: Removal): boolean =>
    c.kind === 'all' && c.target === r.op.replica && c.afterSeq < r.op.seq;
  const open = (): Removal[] => list.filter((r) => !decided.has(r));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of list) {
      if (decided.has(s)) continue;
      const free = !open().some((r) => affects(r, s));
      if (!free && !accepted.some((c) => below(c, s))) continue;
      const right = free && hadRight(ctx, fold(accepted), s);
      const rest = open().filter((r) => r !== s && !below(s, r));
      if (
        right &&
        s.kind !== 'hosts' &&
        !stands(ctx, fold([...accepted, s]), rest)
      )
        continue;
      decided.add(s);
      grew = true;
      if (right) accepted.push(s);
    }
  }
  const won = new Set<Removal>();
  const rest = open();
  const safe = stands(ctx, fold(accepted), rest);
  const comps = safe ? componentsOf(rest, affects) : [rest];
  for (const comp of comps.filter((c) => c.length > 0)) {
    const given: Given = { ctx, fold, affects, safe, outside: [...accepted] };
    const out = solve(given, comp, comp.length <= MAX_CONTESTED);
    accepted.push(...out.accepted);
    for (const r of out.won) won.add(r);
  }
  return { accepted, won };
}

// Whether some admin in `ev` holds its rights in every fold that adds any of
// `removals`, as none of their cuts reaches it.
function stands(
  ctx: Context,
  ev: Evaluation,
  removals: readonly Removal[]
): boolean {
  const reached = new Set(removals.flatMap((r) => [...ctx.reach(r)]));
  return adminsOf(ev).some((a) => !reached.has(a));
}

// The connected components of `rs` under `affects` either way, in fold order.
function componentsOf(
  rs: readonly Removal[],
  affects: (r: Removal, s: Removal) => boolean
): Removal[][] {
  const root = rs.map((_, i) => i);
  const find = (i: number): number => {
    let j = i;
    while (root[j] !== j) j = root[j] ?? j;
    return j;
  };
  for (let i = 0; i < rs.length; i++)
    for (let j = i + 1; j < rs.length; j++) {
      const a = rs[i];
      const b = rs[j];
      if (a === undefined || b === undefined) continue;
      if (affects(a, b) || affects(b, a)) root[find(j)] = find(i);
    }
  const groups = new Map<number, Removal[]>();
  rs.forEach((r, i) => {
    const g = groups.get(find(i));
    if (g === undefined) groups.set(find(i), [r]);
    else g.push(r);
  });
  return [...groups.values()];
}

// One component's decision: the first grounded, self-consistent assignment in
// priority order. With none (odd cycles), or too many removals to search, the
// best-ranked removal holding its right wins a rank pick and stands, and the
// rest is decided again (FW-R7: a later cut of the winner's publisher stands),
// so no component ever pauses a build.
function solve(
  given: Given,
  comp: readonly Removal[],
  searching: boolean
): { accepted: Removal[]; won: Removal[] } {
  const { ctx, fold, outside } = given;
  const won: Removal[] = [];
  for (;;) {
    const rest = comp.filter((r) => !won.includes(r));
    const base = [...outside, ...won];
    const found = searching ? search({ ...given, outside: base }, rest) : null;
    if (found !== null) return { accepted: [...won, ...found], won };
    const ev = fold(base);
    const live = rest.filter((r) => hadRight(ctx, ev, r));
    const pick = live.reduce<Removal | null>(
      (best, r) => (best === null || byRank(ev, r, best) < 0 ? r : best),
      null
    );
    if (pick === null) return { accepted: won, won };
    won.push(pick);
  }
}

// Depth-first over accept/void in priority order (the best-ranked undecided
// removal, accept first), so the first stable assignment is the
// rank-lexicographic one. Subsets are bitmasks over `comp`. A failure returns
// the removals whose values caused it, and the search jumps back past any
// decision not among them, as no assignment keeping them can succeed.
function search(given: Given, comp: readonly Removal[]): Removal[] | null {
  const { ctx, fold, affects, safe, outside } = given;
  const bit = (i: number): number => 1 << i;
  const all = comp.map((_, i) => i);
  const maskOf = (pred: (i: number) => boolean): number =>
    all.filter(pred).reduce((m, i) => m | bit(i), 0);
  const removal = (i: number): Removal => comp[i];
  // sources[i]: the removals whose cut can change i's right; reaches[i]: the
  // removals whose right i's cut can change.
  const sources = all.map((i) =>
    maskOf((j) => affects(removal(j), removal(i)))
  );
  const reaches = all.map((i) =>
    maskOf((j) => affects(removal(i), removal(j)))
  );
  // part[i]: i's connected part; rights, cascades and grounding stay in one.
  const part = all.map((i) => {
    let m = bit(i);
    for (let grew = true; grew; ) {
      const next = all.reduce(
        (out, j) => ((m & bit(j)) !== 0 ? out | sources[j] | reaches[j] : out),
        m
      );
      grew = next !== m;
      m = next;
    }
    return m;
  });
  const parts = [...new Set(part)];
  const folds = new Map<number, Evaluation>();
  const at = (m: number): Evaluation => {
    const known = folds.get(m);
    if (known !== undefined) return known;
    const ev = fold([...outside, ...comp.filter((_, i) => (m & bit(i)) !== 0)]);
    folds.set(m, ev);
    return ev;
  };
  const rights = new Map<number, boolean>();
  const had = (m: number, i: number): boolean => {
    const key = m * 32 + i;
    const known = rights.get(key);
    if (known !== undefined) return known;
    const right = hadRight(ctx, at(m), removal(i));
    rights.set(key, right);
    return right;
  };
  const adminsAt = new Map<number, string[]>();
  const adminsOfMask = (m: number): string[] => {
    const known = adminsAt.get(m);
    if (known !== undefined) return known;
    const admins = adminsOf(at(m));
    adminsAt.set(m, admins);
    return admins;
  };
  const adminless = (m: number): boolean =>
    !safe && adminsOfMask(m).length === 0;
  const reaching = new Map<string, number>();
  // The removals whose cut reaches replica x, so decide whether it is an admin.
  const reachingOf = (x: string): number => {
    const known = reaching.get(x);
    if (known !== undefined) return known;
    const m = maskOf(
      (j) => removal(j).kind !== 'hosts' && ctx.reach(removal(j)).has(x)
    );
    reaching.set(x, m);
    return m;
  };
  // Of the admins under m that no removal in `open` reaches, the fewest
  // removals deciding one; null when every admin is open to a cut.
  const standing = (m: number, open: number): number | null => {
    let best: number | null = null;
    for (const x of adminsOfMask(m)) {
      const r = reachingOf(x);
      if ((r & open) !== 0) continue;
      if (best === null || bitCount(r) < bitCount(best)) best = r;
    }
    return best;
  };
  // dooms[i]: the removals whose cut leaves i's publisher no right at i in any
  // fold: a revocation below i, or a demotion no later grant can make up for.
  const grantedAgain = (r: Removal, c: Removal): boolean =>
    ctx.items.some(
      ({ op, body }) =>
        ctx.order(c.op, op) < 0 &&
        (isAction(body, 'recover')
          ? op.replica === r.op.replica
          : (isAction(body, 'admit') || isAction(body, 'role')) &&
            body.replica === r.op.replica &&
            body.role === 'admin')
    );
  const dooms = all.map((i) => {
    const r = removal(i);
    return maskOf((j) => {
      const c = removal(j);
      if (j === i || c.target !== r.op.replica || c.afterSeq >= r.op.seq)
        return false;
      if (c.kind === 'all') return true;
      return c.kind === 'admin' && r.kind !== 'all' && !grantedAgain(r, c);
    });
  });
  // Grounded: some order accepts each removal of m while its publisher holds
  // its right under those before it.
  const groundedMemo = new Map<number, boolean>();
  const grounded = (m: number): boolean => {
    const known = groundedMemo.get(m);
    if (known !== undefined) return known;
    // Most sets ground in any order that takes whatever holds its right.
    let greedy = 0;
    for (let grew = true; grew && greedy !== m; ) {
      grew = false;
      for (const r of all)
        if ((m & ~greedy & bit(r)) !== 0 && had(greedy, r)) {
          greedy |= bit(r);
          grew = true;
        }
    }
    if (greedy === m) {
      groundedMemo.set(m, true);
      return true;
    }
    const seen = new Set([0]);
    const stack: number[] = [0];
    let ok = false;
    for (let g = stack.pop(); g !== undefined && !ok; g = stack.pop()) {
      if (g === m) ok = true;
      for (const r of all) {
        const grown: number = g | bit(r);
        if ((m & bit(r)) === 0 || grown === g || seen.has(grown)) continue;
        if (!had(g, r)) continue;
        seen.add(grown);
        stack.push(grown);
      }
    }
    groundedMemo.set(m, ok);
    return ok;
  };
  // Accepting void i into m drops, in turn, each accepted removal left
  // without its right; what remains.
  const cascade = (m: number, i: number): number => {
    let cur = m | bit(i);
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of all) {
        if (j === i || (cur & bit(j)) === 0 || had(cur & ~bit(j), j)) continue;
        cur &= ~bit(j);
        changed = true;
      }
    }
    return cur;
  };
  // A void removal holding its right is void only when accepting it leaves no
  // admin, or its cut cascades into removals its own right rests on.
  const excused = (m: number, i: number): boolean =>
    adminless(m | bit(i)) || !had(cascade(m, i) & ~bit(i), i);

  let acc = 0;
  let dec = 0;
  // Removals decided by propagation, and the removals each was decided by.
  let forced = 0;
  const why = all.map(() => 0);
  const close = (c: number): number => {
    let out = c & dec;
    for (let grew = true; grew; ) {
      grew = false;
      for (const x of all) {
        if ((out & forced & bit(x)) === 0 || (why[x] & ~out) === 0) continue;
        out |= why[x];
        grew = true;
      }
    }
    return out;
  };
  const doomed = (i: number): boolean => (dooms[i] & acc) !== 0;
  // Whether nothing undecided can change i's right any more.
  const settled = (i: number): boolean =>
    (sources[i] & ~dec) === 0 || doomed(i);
  // What decides i's right: its sources and any doom among them.
  const rightOf = (i: number): number => bit(i) | sources[i] | dooms[i];
  // Why void i, holding its right, has no excuse: no accepted or undecided
  // removal for its cut to cascade into, and an admin sure to stand; or null.
  const inexcusable = (i: number): number | null => {
    if ((reaches[i] & ~(dec & ~acc)) !== 0) return null;
    const sure = standing(acc, ~dec | bit(i));
    return sure === null ? null : sure | rightOf(i) | reaches[i];
  };
  // Decides i; a conflict when an accepted removal whose right is settled
  // lacks it without its own cut.
  const assign = (i: number, accept: boolean): number | null => {
    dec |= bit(i);
    if (accept) acc |= bit(i);
    const touched = (bit(i) | reaches[i]) & acc;
    for (const j of all) {
      if ((touched & bit(j)) === 0 || !settled(j)) continue;
      if (doomed(j) || !had(acc & ~bit(j), j)) return close(rightOf(j));
    }
    return null;
  };
  // Decides every removal only one way can decide, until none is left.
  const propagate = (): number | null => {
    for (let grew = true; grew; ) {
      grew = false;
      for (const i of all) {
        if (!settled(i) || (acc & bit(i)) !== 0) continue;
        const right = !doomed(i) && had(acc, i);
        const blame = right ? inexcusable(i) : rightOf(i);
        if ((dec & bit(i)) !== 0) {
          if (right && blame !== null) return close(blame);
          continue;
        }
        if (blame === null) continue;
        why[i] = close(blame);
        forced |= bit(i);
        const conflict = assign(i, right);
        if (conflict !== null) return conflict;
        grew = true;
      }
    }
    return null;
  };
  // Why the complete assignment is unstable, or null when it is stable.
  const unstable = (): number | null => {
    if (adminless(acc)) return dec;
    for (const i of all) {
      if ((acc & bit(i)) !== 0 || !had(acc, i) || excused(acc, i)) continue;
      const sure = standing(acc | bit(i), 0) ?? dec;
      // With nothing dropped, only i's right, which removals its cut reaches,
      // and their rights decide it.
      if (cascade(acc, i) !== (acc | bit(i))) return close(part[i] | sure);
      const reached = all.filter((j) => (reaches[i] & acc & bit(j)) !== 0);
      const blame = rightOf(i) | reaches[i] | sure;
      return close(reached.reduce((c, j) => c | rightOf(j), blame));
    }
    for (const p of parts) if (!grounded(acc & p)) return close(p);
    return null;
  };
  // Priority order, ranks read under the decisions made before the search,
  // never under what the search has accepted so far.
  const priority = [...all].sort((i, j) =>
    byRank(at(0), removal(i), removal(j))
  );
  const next = (): number => priority.find((i) => (dec & bit(i)) === 0) ?? -1;
  const dfs = (): number | null => {
    const saved = [acc, dec, forced] as const;
    const restore = (): void => {
      [acc, dec, forced] = saved;
    };
    const stuck = propagate();
    if (stuck !== null) {
      restore();
      return stuck;
    }
    const i = next();
    if (i < 0) {
      const why = unstable();
      if (why !== null) restore();
      return why;
    }
    const branch = [acc, dec, forced] as const;
    let conflict = 0;
    for (const accept of [true, false]) {
      const c = assign(i, accept) ?? dfs();
      if (c === null) return null;
      [acc, dec, forced] = branch;
      if ((c & bit(i)) === 0) {
        restore();
        return c;
      }
      conflict |= c;
    }
    restore();
    return conflict & ~bit(i);
  };
  if (comp.length === 0) return [];
  return dfs() === null ? comp.filter((_, i) => (acc & bit(i)) !== 0) : null;
}

// The set bits of m.
function bitCount(m: number): number {
  let n = 0;
  for (let x = m; x !== 0; x &= x - 1) n++;
  return n;
}

// Every Known(1) dismiss, and the op it names among the deduplicated ops.
function dismissesOf(items: readonly Item[]): Dismiss[] {
  const id = (o: { replica: string; seq: number; hash: string }): string =>
    `${o.replica}\n${o.seq}\n${o.hash}`;
  const byId = new Map(items.map((i) => [id(i.op), i]));
  return items.flatMap((item) =>
    item.kind === 'known' && isAction(item.body, 'dismiss')
      ? [{ item, named: byId.get(id(item.body)) ?? null }]
      : []
  );
}

/** Whether `replica`'s op `seq` may speak for `handle`. Observers speak for nobody. */
export function speaksForHandle(
  view: RosterView,
  replica: string,
  handle: string,
  seq: number
): boolean {
  const m = heldAt(view, replica, seq);
  if (m === null || m.handle === null || m.observer) return false;
  if (m.handle === handle || m.hosts.includes(handle)) return true;
  // A host a removal took away still counts for ops at or below its afterSeq.
  return (view.hostCuts.get(replica) ?? []).some(
    (c) => c.afterSeq >= seq && c.hosts.includes(handle)
  );
}

// What `replica` held for its op `seq`: a member's standing, or a revoked
// replica's for ops at or below its cut.
function heldAt(
  view: RosterView,
  replica: string,
  seq: number
): RosterMember | RevokedReplica | null {
  const cut = view.revoked.get(replica);
  if (cut === undefined) return view.members.get(replica) ?? null;
  return seq <= cut.afterSeq ? cut : null;
}

/** Whether `replica` is within the seats. Observers count for nothing, so always are. */
export function isCovered(view: RosterView, replica: string): boolean {
  const m = view.members.get(replica);
  if (m === undefined) return false;
  return m.observer || view.covered.has(m.handle);
}

interface Founding {
  item: Item;
  op: RosterOpRef;
  body: Action<'found'>;
}

// The pinned founding op, which no dismiss takes out of a fold.
function foundingOf(input: FoldInput, items: readonly Item[]): Founding {
  const item = items.find(
    (i) =>
      i.op.replica === input.founder.replica && i.op.seq === input.founder.seq
  );
  if (
    item === undefined ||
    item.kind !== 'known' ||
    !isAction(item.body, 'found')
  ) {
    throw new Error(
      `the founding op ${input.founder.replica}:${input.founder.seq} is not among the roster ops`
    );
  }
  return { item, op: item.op, body: item.body };
}

// What every fold of one op set shares: the founding, first seqs and the order.
interface Shared extends Omit<
  Context,
  'items' | 'granting' | 'reach' | 'exposes'
> {
  all: readonly Item[];
}

function sharedOf(input: FoldInput, all: readonly Item[]): Shared {
  const found = foundingOf(input, all);
  // Only Known(1) ops from the founding on count toward a replica's first
  // roster op, so no inert op, dismissed or dropped, ever moves it.
  const firstSeq = new Map<string, number>();
  for (const { op, kind } of all.slice(all.indexOf(found.item)))
    if (kind === 'known')
      firstSeq.set(
        op.replica,
        Math.min(op.seq, firstSeq.get(op.replica) ?? op.seq)
      );
  const index = new Map<Position, number>(all.map((i, n) => [i.op, n]));
  return {
    input,
    all,
    found: { op: found.op, body: found.body },
    teamId: found.op.hash.slice(0, 32),
    deadlineMs: (hlcWallMs(found.op.hlc) ?? 0) + LEGACY_WINDOW_MS,
    firstSeq,
    order: (a, b) => {
      const ia = index.get(a);
      const ib = index.get(b);
      if (ia === undefined || ib === undefined) return comparePositions(a, b);
      return ia - ib;
    },
    proves: provesOf(input, found.op.hash.slice(0, 32)),
  };
}

// Checks a recover's proof against a recovery key once per pair, since the
// resolution asks again of every key an admin could have set.
function provesOf(input: FoldInput, teamId: string): Context['proves'] {
  const seen = new Map<string, boolean>();
  return (recover, proof, pub) => {
    const id = `${recover.hash}\n${pub}`;
    const known = seen.get(id);
    if (known !== undefined) return known;
    const key = input.keys.get(recover.replica);
    const signed = `${TAG.recovery}\n${teamId}\n${recover.replica}\n${key?.signPub ?? ''}`;
    const ok = key !== undefined && verifyText(pub, signed, proof);
    seen.set(id, ok);
    return ok;
  };
}

// Folds every op but `without` and resolves its removals.
function foldWithout(shared: Shared, without: ReadonlySet<Item>): Folded {
  const { all, ...rest } = shared;
  const items = all.filter((i) => !without.has(i));
  const granting = items.filter(({ body }) =>
    GRANTING.some((a) => isAction(body, a))
  );
  const ctx: Context = {
    ...rest,
    items,
    granting,
    ...reachOf(items, rest.order),
  };
  return { ctx, without, ...resolve(ctx) };
}

// Admissions and promotions link a publisher to its targets; a recover or a
// recovery key links to every recovering replica. A cut reaches its target and
// all that the target's ops it exposes link to: those above afterSeq, and for
// a revocation those after it, whose later grants it refuses.
function reachOf(
  items: readonly Item[],
  order: Context['order']
): Pick<Context, 'reach' | 'exposes'> {
  const links = new Map<string, { op: RosterOpRef; to: string }[]>();
  const link = (op: RosterOpRef, to: string): void => {
    const list = links.get(op.replica);
    if (list === undefined) links.set(op.replica, [{ op, to }]);
    else list.push({ op, to });
  };
  const recovering = items
    .filter((i) => isAction(i.body, 'recover'))
    .map((i) => i.op.replica);
  for (const { op, body } of items) {
    if (isAction(body, 'admit') || isAction(body, 'role'))
      link(op, body.replica);
    else if (isAction(body, 'recover') || isAction(body, 'recovery-key'))
      for (const r of recovering) link(op, r);
  }
  const full = new Map<string, ReadonlySet<string>>();
  // Every replica `replica`'s ops link to, transitively, itself included.
  const fullReach = (replica: string): ReadonlySet<string> => {
    const known = full.get(replica);
    if (known !== undefined) return known;
    const seen = new Set([replica]);
    const queue = [replica];
    for (let q = queue.pop(); q !== undefined; q = queue.pop())
      for (const { to } of links.get(q) ?? [])
        if (!seen.has(to)) {
          seen.add(to);
          queue.push(to);
        }
    full.set(replica, seen);
    return seen;
  };
  const memo = new Map<Removal, ReadonlySet<string>>();
  const exposes = (cut: Removal): ReadonlySet<string> => {
    const known = memo.get(cut);
    if (known !== undefined) return known;
    const exposed = (op: RosterOpRef): boolean =>
      op.seq > cut.afterSeq || (cut.kind === 'all' && order(cut.op, op) < 0);
    const out = new Set<string>();
    for (const { op, to } of links.get(cut.target) ?? [])
      if (exposed(op)) for (const r of fullReach(to)) out.add(r);
    memo.set(cut, out);
    return out;
  };
  const withTarget = new Map<Removal, ReadonlySet<string>>();
  const reach = (cut: Removal): ReadonlySet<string> => {
    const known = withTarget.get(cut);
    if (known !== undefined) return known;
    const out = new Set([cut.target, ...exposes(cut)]);
    withTarget.set(cut, out);
    return out;
  };
  return { reach, exposes };
}

// One op per (replica, seq); of two that differ, the smaller hash, so the
// input's order never matters.
function dedupe(ops: readonly RosterOpRef[]): RosterOpRef[] {
  const bySeq = new Map<string, RosterOpRef>();
  for (const op of ops) {
    const key = `${op.replica}\n${op.seq}`;
    const seen = bySeq.get(key);
    if (seen === undefined || op.hash < seen.hash) bySeq.set(key, op);
  }
  return [...bySeq.values()];
}

function isAction<A extends RosterBody['action']>(
  body: Body,
  action: A
): body is Action<A> {
  return typeof body === 'object' && body.action === action;
}

const isStr = (v: unknown): v is string => typeof v === 'string';
const isSeq = (v: unknown): boolean =>
  Number.isSafeInteger(v) && (v as number) >= 0;
const isRole = (v: unknown): boolean => v === 'member' || v === 'admin';
const isStrings = (v: unknown): boolean => Array.isArray(v) && v.every(isStr);
const optional = (v: unknown, is: (x: unknown) => boolean): boolean =>
  v === undefined || is(v);

function isAttestations(v: unknown): boolean {
  if (!Array.isArray(v)) return false;
  return v.every((a: unknown) => {
    if (typeof a !== 'object' || a === null) return false;
    const o = a as Record<string, unknown>;
    return isStr(o.replica) && isSeq(o.throughSeq) && isStr(o.digest);
  });
}

// The fields each action this build knows must carry.
const SHAPES = new Map<string, (b: Record<string, unknown>) => boolean>([
  [
    'found',
    (b) => isStr(b.name) && isAttestations(b.legacy) && isStr(b.recoveryPub),
  ],
  [
    'admit',
    (b) =>
      isStr(b.replica) &&
      isStr(b.handle) &&
      isRole(b.role) &&
      isStr(b.fingerprint) &&
      optional(b.hosts, isStrings) &&
      optional(b.observer, (x) => x === true),
  ],
  [
    'revoke',
    (b) =>
      isStr(b.replica) &&
      isSeq(b.afterSeq) &&
      isStr(b.afterHash) &&
      isStr(b.reason),
  ],
  [
    'role',
    (b) =>
      isStr(b.replica) &&
      isRole(b.role) &&
      optional(b.afterSeq, isSeq) &&
      optional(b.afterHash, isStr),
  ],
  [
    'hosts',
    (b) =>
      isStr(b.replica) &&
      isStrings(b.hosts) &&
      optional(b.afterSeq, isSeq) &&
      optional(b.afterHash, isStr),
  ],
  ['close-legacy', (b) => isAttestations(b.entries)],
  ['license', (b) => isStr(b.key)],
  [
    'invite',
    (b) => isStr(b.id) && isStr(b.pub) && isStr(b.handle) && isStr(b.expires),
  ],
  ['recover', (b) => isStr(b.proof)],
  ['recovery-key', (b) => isStr(b.pub)],
  ['dismiss', (b) => isStr(b.replica) && isSeq(b.seq) && isStr(b.hash)],
  [
    'transport',
    (b) => (b.kind === 'git' || b.kind === 'relay') && optional(b.url, isStr),
  ],
]);

/**
 * Known(1): the (action, rv) pairs every build reads, each `action@rv`. Every
 * later build keeps them verbatim, and only they decide rights.
 */
export const KNOWN_ROSTER_PAIRS: ReadonlySet<string> = new Set(
  [...SHAPES.keys()].map((action) => `${action}@1`)
);

// A body without a string action and an integer rv is malformed, and so is a
// Known(1) pair missing its fields; any other pair is outside Known(1).
function kindOf(body: unknown): Kind {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return 'malformed';
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b.rv) || !isStr(b.action)) return 'malformed';
  const shape = b.rv === 1 ? SHAPES.get(b.action) : undefined;
  if (shape === undefined) return 'later';
  return shape(b) ? 'known' : 'malformed';
}

// What a later pair is never read as: the actions that decide admission, roles,
// ranks, revocations or the recovery key, and dismiss.
const RIGHTS = new Set([
  'found',
  'admit',
  'role',
  'revoke',
  'recover',
  'recovery-key',
  'dismiss',
]);

// An op as this build reads it: a later pair `later` cannot read is unknown,
// pausing only where its publisher stands; one read as a right is malformed.
function itemOf(op: RosterOpRef, later: LaterPairs): Item {
  const kind = kindOf(op.body);
  if (kind === 'known') return { op, kind, body: op.body };
  if (kind === 'malformed') return { op, kind, body: 'malformed' };
  const meaning = later(op.body as unknown as Record<string, unknown>);
  if (meaning === null) return { op, kind, body: 'unknown' };
  if (kindOf(meaning) !== 'known') return { op, kind, body: 'malformed' };
  const body = meaning as RosterBody;
  return { op, kind, body: RIGHTS.has(body.action) ? 'malformed' : body };
}

function removalOf({ op, kind: read, body }: Item): Removal | null {
  const later = read === 'later';
  const cut = (
    target: string,
    afterSeq: number,
    afterHash: string,
    kind: CutKind
  ): Removal => ({ op, target, afterSeq, afterHash, kind, later });
  if (isAction(body, 'revoke'))
    return cut(body.replica, body.afterSeq, body.afterHash, 'all');
  if (
    isAction(body, 'role') &&
    body.role === 'member' &&
    body.afterSeq !== undefined &&
    body.afterHash !== undefined
  )
    return cut(body.replica, body.afterSeq, body.afterHash, 'admin');
  if (
    isAction(body, 'hosts') &&
    body.afterSeq !== undefined &&
    body.afterHash !== undefined
  )
    return cut(body.replica, body.afterSeq, body.afterHash, 'hosts');
  return null;
}

const positionOf = (op: Position): Position => ({
  hlc: op.hlc,
  replica: op.replica,
  seq: op.seq,
});

// The handle a replica's key asks for, or the one its id carries.
function handleOf(ctx: Context, replica: string): string {
  return ctx.input.keys.get(replica)?.handle ?? personOf(replica);
}

function personOf(replica: string): string {
  return replica.replace(/-[0-9a-f]{8}$/, '');
}

interface Rights {
  member: boolean;
  admin: boolean;
  /** The earliest grant still standing: a non-admin's rank. */
  firstGrant: Grant | null;
  /** The earliest admin grant still standing, which sets an admin's rank. */
  firstAdmin: Grant | null;
}

// The rights `replica` holds for its op `seq` at `pos` (every grant when pos is
// null). A cut kills, for the target's ops above its afterSeq, only the grants
// positioned before it, so a later promotion restores admin.
function rightsAt(
  ev: Granted,
  replica: string,
  seq: number,
  pos: Position | null
): Rights {
  // Only the cuts below seq count; a grant after a cut's position outlives it.
  const cuts = (ev.cutsOn.get(replica) ?? []).filter(
    (c) => c.afterSeq < seq && c.kind !== 'hosts'
  );
  let firstGrant: Grant | null = null;
  let firstAdmin: Grant | null = null;
  // Grants are recorded in fold order, so the ones before pos are a prefix.
  for (const g of ev.grants.get(replica) ?? []) {
    if (pos !== null && ev.order(g.pos, pos) >= 0) break;
    let revoked = false;
    let demoted = false;
    for (const c of cuts) {
      if (ev.order(g.pos, c.op) >= 0) continue;
      if (c.kind === 'all') revoked = true;
      else demoted = true;
    }
    if (revoked) continue;
    firstGrant ??= g;
    if (g.admin && !demoted) {
      firstAdmin = g;
      break;
    }
  }
  const member = firstGrant !== null;
  return { member, admin: firstAdmin !== null, firstGrant, firstAdmin };
}

function revokedBefore(ev: Granted, replica: string, pos: Position): boolean {
  return (ev.cutsOn.get(replica) ?? []).some(
    (c) => c.kind === 'all' && ev.order(c.op, pos) < 0
  );
}

function admittedAt(ev: Evaluation, replica: string, pos: Position): boolean {
  return ev.holders.has(replica) && !revokedBefore(ev, replica, pos);
}

function grant(ev: Granted, replica: string, g: Grant): void {
  const list = ev.grants.get(replica);
  if (list === undefined) ev.grants.set(replica, [g]);
  else list.push(g);
}

// Records handles in the order they were first granted, for seats.
function addPeople(ev: Evaluation, handles: readonly string[]): void {
  for (const h of handles) {
    if (ev.peopleSeen.has(h)) continue;
    ev.peopleSeen.add(h);
    ev.people.push(h);
  }
}

function byTarget(cuts: readonly Removal[]): Map<string, Removal[]> {
  const out = new Map<string, Removal[]>();
  for (const c of cuts) {
    const list = out.get(c.target);
    if (list === undefined) out.set(c.target, [c]);
    else list.push(c);
  }
  return out;
}

// The actions that can grant a right; the rest never change one.
const GRANTING = ['found', 'admit', 'role', 'recover', 'recovery-key'] as const;

// A walk over the ops under `cuts`; `items` may be ctx.granting when only
// rights are read.
function evaluate(
  ctx: Context,
  cuts: readonly Removal[],
  notes = false,
  items = ctx.items
): Evaluation {
  const ev: Evaluation = {
    cuts,
    cutsOn: byTarget(cuts),
    order: ctx.order,
    holders: new Map(),
    grants: new Map(),
    invites: new Map(),
    recoveryPub: ctx.found.body.recoveryPub,
    usedRecovery: new Set(),
    licenses: [],
    transport: { kind: 'git' },
    legacyClosed: null,
    people: [],
    peopleSeen: new Set(),
    hostCuts: new Map(),
    notes,
    problems: [],
  };
  const accepted = new Set(cuts.map((c) => c.op));
  for (const item of items) step(ctx, ev, accepted, item);
  return ev;
}

// Records why an op was ignored, in the evaluation whose problems are kept.
function note(ev: Evaluation, op: RosterOpRef, message: string): void {
  if (ev.notes)
    ev.problems.push({ subject: `op:${op.replica}:${op.seq}`, message });
}

const lacks = (op: RosterOpRef, action: string): string =>
  `${op.replica} lacks the right to ${action} at seq ${op.seq}; ignored`;

// Applies one op in fold order, valid only when its publisher held the right
// at the op's own seq and position.
function step(
  ctx: Context,
  ev: Evaluation,
  accepted: ReadonlySet<RosterOpRef>,
  { op, body }: Item
): void {
  // An unreadable op grants nothing; notesOf decides whether it pauses.
  if (body === 'unknown') return;
  if (isAction(body, 'found')) {
    foundStep(ctx, ev, op, body);
    return;
  }
  if (ev.order(op, ctx.found.op) < 0) {
    note(
      ev,
      op,
      `${op.replica}'s roster op at seq ${op.seq} precedes the founding; ignored`
    );
    return;
  }
  const publisher = ev.holders.get(op.replica);
  if (publisher?.observer === true) {
    note(
      ev,
      op,
      `${op.replica} is an observer; an observer publishes only keys, presence and acks`
    );
    return;
  }
  if (body === 'malformed') {
    note(
      ev,
      op,
      `${op.replica}'s roster op at seq ${op.seq} is malformed; ignored`
    );
    return;
  }
  // Removals and recovers never need the publisher's rights.
  const rights = (): Rights => rightsAt(ev, op.replica, op.seq, op);
  const noRight = (): void => note(ev, op, lacks(op, body.action));
  switch (body.action) {
    case 'admit':
      admitStep(ctx, ev, op, body, rights());
      return;
    case 'role':
      if (body.role === 'member') {
        // A demotion is a removal, which the resolution loop decides.
        if (body.afterSeq === undefined || body.afterHash === undefined)
          note(ev, op, 'a demotion must name afterSeq and afterHash; ignored');
        return;
      }
      if (!rights().admin) return noRight();
      if (!admittedAt(ev, body.replica, op)) {
        note(ev, op, `${body.replica} is not admitted; ignored`);
        return;
      }
      if (ev.holders.get(body.replica)?.observer === true) {
        note(ev, op, `${body.replica} is an observer, never an admin; ignored`);
        return;
      }
      grant(ev, body.replica, { pos: op, admin: true, source: 'grant' });
      return;
    case 'hosts':
      hostsStep(ev, op, body, accepted);
      return;
    case 'license':
      if (!rights().admin) return noRight();
      ev.licenses.push({ key: body.key, by: op.replica });
      return;
    case 'invite': {
      const r = rights();
      if (!r.admin && !(r.member && publisher?.handle === body.handle))
        return noRight();
      if (!ev.invites.has(body.id)) {
        const { pub, handle, expires } = body;
        ev.invites.set(body.id, { pub, handle, expires, by: op.replica });
      }
      return;
    }
    case 'recovery-key':
      if (!rights().admin) return noRight();
      ev.recoveryPub = body.pub;
      return;
    case 'recover':
      recoverStep(ctx, ev, op, body);
      return;
    case 'close-legacy': {
      if (ev.legacyClosed !== null) return;
      const wall = hlcWallMs(op.hlc);
      const due = wall !== null && wall >= ctx.deadlineMs;
      const r = rights();
      if (!r.admin && !(r.member && due)) return noRight();
      ev.legacyClosed = { by: op.replica, entries: body.entries };
      return;
    }
    case 'transport':
      if (!rights().admin) return noRight();
      ev.transport =
        body.url === undefined
          ? { kind: body.kind }
          : { kind: body.kind, url: body.url };
      return;
    case 'revoke':
      // A removal, which the resolution loop decides.
      return;
    case 'dismiss':
      // Decided before the fold: a valid one's named op is not in it.
      return;
  }
}

// Whether an accepted revocation of op's publisher cuts op, by seq alone.
function cutBySeq(ev: Granted, op: RosterOpRef): boolean {
  return (ev.cutsOn.get(op.replica) ?? []).some(
    (c) => c.kind === 'all' && c.afterSeq < op.seq
  );
}

function foundStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'found'>
): void {
  if (op !== ctx.found.op) {
    const fp = ctx.input.keys.get(op.replica)?.fingerprint ?? 'no pinned key';
    note(ev, op, `a second founding by ${op.replica} (${fp}), ignored`);
    return;
  }
  const handle = handleOf(ctx, op.replica);
  const pos = positionOf(op);
  ev.holders.set(op.replica, {
    handle,
    hosts: [],
    observer: false,
    since: pos,
    recovered: false,
  });
  grant(ev, op.replica, { pos: op, admin: true, source: 'found' });
  // Attested legacy people rank right after the founder.
  addPeople(ev, [handle, ...body.legacy.map((a) => personOf(a.replica))]);
}

function admitStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'admit'>,
  rights: Rights
): void {
  const key = ctx.input.keys.get(body.replica);
  if (key === undefined) {
    note(
      ev,
      op,
      `the admit of ${body.replica} names fingerprint ${body.fingerprint}, but no key of ${body.replica} is pinned; ignored`
    );
    return;
  }
  if (key.fingerprint !== body.fingerprint) {
    note(
      ev,
      op,
      `the admit of ${body.replica} names fingerprint ${body.fingerprint}, but its key's is ${key.fingerprint}; ignored`
    );
    return;
  }
  if (revokedBefore(ev, body.replica, op)) {
    note(ev, op, `${body.replica} was revoked and is never admitted again`);
    return;
  }
  if (ev.holders.has(body.replica)) return;
  const hosts = [...(body.hosts ?? [])];
  const observer = body.observer === true;
  // Every roster op an observer publishes is void, so an observer admin would
  // count as an admin that can do nothing.
  if (observer && body.role === 'admin') {
    note(ev, op, `${body.replica} is an observer, never an admin; ignored`);
    return;
  }
  // A member may admit only a device of their own, as a plain member.
  const own = ev.holders.get(op.replica)?.handle;
  const ownDevice =
    rights.member &&
    own === key.handle &&
    own === body.handle &&
    body.role === 'member' &&
    hosts.length === 0 &&
    !observer;
  if (!rights.admin && !ownDevice) {
    note(
      ev,
      op,
      `${op.replica} may not admit ${body.replica} as ${body.role}; ignored`
    );
    return;
  }
  const pos = positionOf(op);
  ev.holders.set(body.replica, {
    handle: body.handle,
    hosts,
    observer,
    since: pos,
    recovered: false,
  });
  grant(ev, body.replica, {
    pos: op,
    admin: body.role === 'admin',
    source: 'grant',
  });
  if (!observer) addPeople(ev, [body.handle, ...hosts]);
}

// Without afterSeq a hosts change may only add handles; with it, it is a
// removal and takes effect once the resolution loop accepts it.
function hostsStep(
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'hosts'>,
  accepted: ReadonlySet<RosterOpRef>
): void {
  const target = ev.holders.get(body.replica);
  const removed = (target?.hosts ?? []).filter((h) => !body.hosts.includes(h));
  if (body.afterSeq !== undefined && body.afterHash !== undefined) {
    if (!accepted.has(op) || target === undefined) return;
    if (removed.length > 0) {
      const cuts = ev.hostCuts.get(body.replica) ?? [];
      cuts.push({ afterSeq: body.afterSeq, hosts: removed });
      ev.hostCuts.set(body.replica, cuts);
    }
  } else {
    if (!rightsAt(ev, op.replica, op.seq, op).admin) {
      note(ev, op, lacks(op, 'hosts'));
      return;
    }
    if (target === undefined || !admittedAt(ev, body.replica, op)) {
      note(ev, op, `${body.replica} is not admitted; ignored`);
      return;
    }
    if (removed.length > 0) {
      note(
        ev,
        op,
        `a hosts change that removes ${removed.join(', ')} must name afterSeq and afterHash; ignored`
      );
      return;
    }
  }
  target.hosts = [...body.hosts];
  if (!target.observer) addPeople(ev, body.hosts);
}

// A pending replica's recover, its first roster op, admits it as an admin
// when its proof verifies against the recovery key current there, once per key.
function recoverStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'recover'>
): void {
  const key = ctx.input.keys.get(op.replica);
  if (ev.holders.has(op.replica)) {
    note(ev, op, `${op.replica} is already admitted; its recover is ignored`);
    return;
  }
  if (revokedBefore(ev, op.replica, op) || cutBySeq(ev, op)) {
    note(ev, op, `${op.replica} was revoked and is never admitted again`);
    return;
  }
  if (ctx.firstSeq.get(op.replica) !== op.seq) {
    note(ev, op, `${op.replica}'s recover is not its first roster op; ignored`);
    return;
  }
  if (key === undefined) {
    note(ev, op, `${op.replica} has no pinned key; its recover is ignored`);
    return;
  }
  if (ev.usedRecovery.has(ev.recoveryPub)) {
    note(
      ev,
      op,
      `the recovery code ${op.replica} used has already admitted a replica; ignored`
    );
    return;
  }
  if (!ctx.proves(op, body.proof, ev.recoveryPub)) {
    note(
      ev,
      op,
      `${op.replica}'s recovery proof does not match the current recovery code; ignored`
    );
    return;
  }
  const pos = positionOf(op);
  ev.usedRecovery.add(ev.recoveryPub);
  ev.holders.set(op.replica, {
    handle: key.handle,
    hosts: [],
    observer: false,
    since: pos,
    recovered: true,
  });
  grant(ev, op.replica, { pos: op, admin: true, source: 'recover' });
  addPeople(ev, [key.handle]);
  if (ev.notes)
    ev.problems.push({
      subject: `replica:${op.replica}`,
      message: `${op.replica} became an admin with the recovery code`,
    });
}

// Whether r's publisher held the right r needs at r's own seq and position.
function hadRight(ctx: Context, ev: Evaluation, r: Removal): boolean {
  if (ev.holders.get(r.op.replica)?.observer === true) return false;
  const rights = rightsAt(ev, r.op.replica, r.op.seq, r.op);
  return rights.admin || (rights.member && !needsAdmin(ctx, ev, r));
}

// A member may revoke replicas with their own handle; every other removal
// needs an admin.
function needsAdmin(ctx: Context, ev: Evaluation, r: Removal): boolean {
  if (r.kind !== 'all') return true;
  const own = ev.holders.get(r.op.replica)?.handle;
  const target = ev.holders.get(r.target)?.handle ?? handleOf(ctx, r.target);
  return own !== target;
}

const TIER = { found: 0, grant: 1, recover: 2 } as const;
const MEMBER = 3;
const NO_RIGHTS = 4;

type RankAt = { replica: string; seq: number; pos: Position | null };
type Rank = { tier: number; by: Grant | null };

const rankAt = (op: RosterOpRef): RankAt => ({
  replica: op.replica,
  seq: op.seq,
  pos: op,
});

// A publisher's tier at an op and the grant that orders it within the tier.
function rankOf(ev: Evaluation, at: RankAt): Rank {
  const rights = rightsAt(ev, at.replica, at.seq, at.pos);
  if (rights.firstAdmin !== null)
    return { tier: TIER[rights.firstAdmin.source], by: rights.firstAdmin };
  if (rights.firstGrant !== null)
    return { tier: MEMBER, by: rights.firstGrant };
  return { tier: NO_RIGHTS, by: null };
}

// Rank at an op: the founder, admins by their first standing admin grant,
// recovered admins, then members by admission, which none can backdate.
function compareRanks(order: Evaluation['order'], ra: Rank, rb: Rank): number {
  if (ra.tier !== rb.tier) return ra.tier - rb.tier;
  if (ra.by === null || rb.by === null) return 0;
  return order(ra.by.pos, rb.by.pos);
}

function compareRank(ev: Evaluation, a: RankAt, b: RankAt): number {
  return compareRanks(ev.order, rankOf(ev, a), rankOf(ev, b));
}

// Removals by their publishers' rank at each removal, then by position.
function byRank(ev: Evaluation, a: Removal, b: Removal): number {
  const d = compareRank(ev, rankAt(a.op), rankAt(b.op));
  if (d !== 0) return d;
  return ev.order(a.op, b.op);
}

function adminsOf(ev: Evaluation): string[] {
  return [...ev.holders.keys()].filter(
    (r) => rightsAt(ev, r, Infinity, null).admin
  );
}

const standing = (replica: string): RankAt => ({
  replica,
  seq: Infinity,
  pos: null,
});

// Whether op's publisher was a member or admin at it and not an observer: only
// then does an unreadable op pause a build, or a later removal stand.
function standsAt(ev: Evaluation, op: RosterOpRef): boolean {
  if (ev.holders.get(op.replica)?.observer === true) return false;
  return rightsAt(ev, op.replica, op.seq, op).member;
}

// The standing admins, by rank, whose dismiss of `op` would be valid now.
function liftersOf(
  ev: Evaluation,
  admins: readonly string[],
  op: RosterOpRef
): string[] {
  if (!rightsAt(ev, op.replica, op.seq, op).admin) return [...admins];
  const theirs = rankOf(ev, rankAt(op));
  return admins.filter(
    (a) =>
      a === op.replica ||
      compareRanks(ev.order, rankOf(ev, standing(a)), theirs) < 0
  );
}

// "a", "a or b", "a, b or c".
function listed(xs: readonly string[]): string {
  if (xs.length <= 1) return xs.join('');
  return `${xs.slice(0, -1).join(', ')} or ${xs[xs.length - 1] ?? ''}`;
}

// What became of a dismiss that names an op this daemon holds.
function dismissNote(
  d: Dismiss,
  named: Item,
  valid: ReadonlySet<Dismiss>
): string {
  const by = d.item.op.replica;
  const op = `${named.op.replica}'s roster op at seq ${named.op.seq}`;
  if (named.kind === 'known')
    return `${by} may not dismiss ${op}: every build reads it; ignored`;
  if (named.kind === 'malformed')
    return `${by} may not dismiss ${op}: it is malformed, so no build applies it; ignored`;
  if (valid.has(d)) return `${by} dismissed ${op}, so no build applies it`;
  return `${by} may not dismiss ${op}; ignored`;
}

// The pause, which names who can lift it, and what became of each dismiss.
function notesOf(
  { ctx, ev }: Folded,
  dismisses: readonly Dismiss[],
  valid: ReadonlySet<Dismiss>,
  admins: readonly string[]
): { unknown: Paused | null; problems: Problem[] } {
  const problems = [...ev.problems];
  const at = (op: RosterOpRef) => `op:${op.replica}:${op.seq}`;
  for (const d of dismisses) {
    if (d.named === null) continue;
    problems.push({
      subject: at(d.item.op),
      message: dismissNote(d, d.named, valid),
    });
  }
  if (ctx.input.relay === true) return { unknown: null, problems };
  let unknown: Paused | null = null;
  for (const { op, body } of ctx.items) {
    if (body !== 'unknown' || !standsAt(ev, op)) continue;
    unknown ??= { ...positionOf(op), hash: op.hash };
    const who = liftersOf(ev, admins, op);
    const named = `${op.replica}'s roster op at seq ${op.seq} (${op.hash})`;
    const dismiss =
      who.length > 0 ? `${listed(who)} can dismiss ${named}, or ` : 'or ';
    problems.push({
      subject: at(op),
      message: `${NEWER_ROSTER}, ${dismiss}an admin can revoke ${op.replica} below seq ${op.seq}`,
    });
  }
  return { unknown, problems };
}

function viewOf(
  folded: Folded,
  dismisses: readonly Dismiss[],
  valid: ReadonlySet<Eligible>
): RosterView {
  const { ctx, ev, resolution } = folded;
  const { input } = ctx;
  const revoked = new Map<string, RevokedReplica>();
  for (const c of ev.cuts) {
    if (c.kind !== 'all') continue;
    const seen = revoked.get(c.target);
    if (seen !== undefined && seen.afterSeq <= c.afterSeq) continue;
    const held = ev.holders.get(c.target);
    revoked.set(c.target, {
      afterSeq: c.afterSeq,
      afterHash: c.afterHash,
      handle: held?.handle ?? null,
      hosts: [...(held?.hosts ?? [])],
      observer: held?.observer ?? false,
    });
  }
  const admins = adminsOf(ev).sort((a, b) =>
    compareRank(ev, standing(a), standing(b))
  );

  const members = new Map<string, RosterMember>();
  for (const [replica, h] of ev.holders) {
    if (revoked.has(replica)) continue;
    const rank = admins.indexOf(replica);
    members.set(replica, {
      replica,
      handle: h.handle,
      role: rank >= 0 ? 'admin' : 'member',
      hosts: [...h.hosts],
      observer: h.observer,
      rank: rank >= 0 ? rank : null,
      recovered: h.recovered,
      since: h.since,
    });
  }
  const pending = [...input.keys.keys()]
    .filter((r) => !ev.holders.has(r) && !revoked.has(r))
    .sort();

  const invitedBy = new Map<string, string>();
  for (const replica of pending) {
    const key = input.keys.get(replica);
    const proof = key?.invite;
    if (key === undefined || proof === undefined) continue;
    const invite = ev.invites.get(proof.id);
    if (invite === undefined || invite.handle !== key.handle) continue;
    const signed = `${TAG.invite}\n${ctx.teamId}\n${replica}\n${key.signPub}`;
    if (!verifyText(invite.pub, signed, proof.sig)) continue;
    invitedBy.set(replica, ev.holders.get(invite.by)?.handle ?? invite.by);
  }

  // The latest shared license that verifies, else the free tier.
  let license: LicenseState = { kind: 'free', seats: FREE_SEATS };
  let licenseBy: string | null = null;
  for (let i = ev.licenses.length - 1; i >= 0; i--) {
    const candidate = ev.licenses[i];
    if (candidate === undefined) continue;
    const state = readLicenseKey(
      candidate.key,
      input.licensePublicKey,
      input.now
    );
    if (state.kind !== 'licensed') continue;
    license = state;
    licenseBy = candidate.by;
    break;
  }

  const counted = new Set<string>();
  for (const m of members.values()) {
    if (m.observer) continue;
    counted.add(m.handle);
    for (const h of m.hosts) counted.add(h);
  }
  // While the window is open, attested legacy replicas without a key count too.
  if (ev.legacyClosed === null) {
    for (const a of ctx.found.body.legacy)
      if (!input.keys.has(a.replica)) counted.add(personOf(a.replica));
  }
  const people = ev.people.filter((h) => counted.has(h));

  return {
    teamId: ctx.teamId,
    name: ctx.found.body.name,
    founder: input.founder.replica,
    members,
    revoked,
    hostCuts: ev.hostCuts,
    resolution,
    pending,
    invites: ev.invites,
    invitedBy,
    recoveryPub: ev.recoveryPub,
    license,
    licenseBy,
    seats: license.seats,
    people,
    covered: new Set(people.slice(0, license.seats)),
    legacy: {
      deadlineMs: ctx.deadlineMs,
      attested: ctx.found.body.legacy,
      closed: ev.legacyClosed,
    },
    transport: ev.transport,
    dismissed: [...valid].map(({ item, named }) => ({
      replica: named.op.replica,
      seq: named.op.seq,
      hash: named.op.hash,
      by: item.op.replica,
    })),
    ...notesOf(folded, dismisses, valid, admins),
  };
}
