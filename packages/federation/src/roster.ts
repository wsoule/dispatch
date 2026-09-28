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
   * observer; the caller then applies nothing. Always null for the relay.
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
// A removal's state in the resolution loop; `waiting` lacks the right for now.
type Status = 'open' | 'waiting' | Resolution;

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
  found: { op: RosterOpRef; body: Action<'found'> };
  teamId: string;
  deadlineMs: number;
  /** Each replica's lowest Known(1) roster op seq, where a pending recover goes. */
  firstSeq: ReadonlyMap<string, number>;
  /** The replicas whose rights a cut of `replica` can change, itself included. */
  reach: (replica: string) => ReadonlySet<string>;
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

// The rights some fold accepting at least a given set of cuts could give:
// every grant whose publisher could hold its right, shadowed or not.
interface Reachable extends Granted {
  /** Every handle each replica could hold. */
  handles: Map<string, Set<string>>;
  /** Each replica's earliest op that could admit it, an observer's admit included. */
  first: Map<string, RosterOpRef>;
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
  // A result with no admin voids its latest-ranked accepted removal, and the
  // fight is fought again with every removal so voided held void.
  const held: Removal[] = [];
  let fight = decide(ctx, known);
  let ev = evaluate(ctx, fight.accepted);
  while (adminsOf(ev).length === 0 && fight.accepted.length > 0) {
    const last = fight.accepted.reduce((w, r) =>
      byRank(ev, r, w) > 0 ? r : w
    );
    held.push(last);
    fight = decide(
      ctx,
      known.filter((r) => !held.includes(r))
    );
    ev = evaluate(ctx, fight.accepted);
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
  for (const r of held)
    note(
      final,
      r.op,
      `${r.op.replica}'s removal at seq ${r.op.seq} ${NO_ADMIN}`
    );
  return { ev: final, resolution, accepted, won: fight.won };
}

// The fight over `removals`: which it accepts, and which of those won a pick.
function decide(
  ctx: Context,
  removals: readonly Removal[]
): { accepted: Removal[]; won: ReadonlySet<Removal> } {
  const status = new Map<Removal, Status>(removals.map((r) => [r, 'open']));
  const having = (...wanted: Status[]) =>
    removals.filter((r) => wanted.includes(status.get(r) ?? 'void'));
  // Fight winners stand, even if a later accepted removal cuts their publisher,
  // or the removals they beat would return and never settle; and those sent back.
  const won = new Set<Removal>();
  const demoted = new Set<Removal>();
  // Fight winners and removals accepted before any fight: their cuts hold in
  // every outcome.
  const settled = new Set<Removal>();
  const uncut = reachable(ctx, []);

  for (;;) {
    // One accepted on a worst case that failed can lose its right: it waits
    // again, a second loss voids it, and checks repeat until none loses.
    for (let lost = true; lost; ) {
      lost = false;
      for (const s of having('accepted')) {
        if (won.has(s)) continue;
        const others = having('accepted').filter((o) => o !== s);
        if (hadRight(ctx, evaluate(ctx, others), s)) continue;
        status.set(s, demoted.has(s) ? 'void' : 'waiting');
        demoted.add(s);
        lost = true;
      }
    }
    const accepted = having('accepted');
    const ev = evaluate(ctx, accepted);
    const could = reachable(ctx, [...settled]);
    // A removal whose publisher lacks the right waits while some outcome could
    // give it, as a cut first admit lets a later admit stand; else it is void.
    for (const r of having('open', 'waiting')) {
      if (hadRight(ctx, ev, r)) status.set(r, 'open');
      else status.set(r, couldHold(ctx, could, r) ? 'waiting' : 'void');
    }
    const open = having('open');
    if (open.length === 0) break;
    // One whose publisher holds its right however the undecided ones fall is
    // accepted first, so a removal its cut leaves no right never counts.
    const threats = having('accepted', 'open', 'waiting');
    const sure = robustRights(ctx, uncut, threats);
    const first = open.filter(
      (r) => rightsAt(sure, r.op.replica, r.op.seq, r.op).admin
    );
    for (const r of first) {
      status.set(r, 'accepted');
      settled.add(r);
    }
    if (first.length > 0) continue;
    let progress = false;
    // A removal that would undo the accepted removals its own right rests on
    // is void,
    const holding = new Map<Removal, boolean>();
    const holds = (s: Removal): boolean => {
      const known = holding.get(s);
      if (known !== undefined) return known;
      const others = accepted.filter((o) => o !== s);
      const held = hadRight(ctx, evaluate(ctx, others), s);
      holding.set(s, held);
      return held;
    };
    for (const r of open) {
      if (!undoes(ctx, accepted, holds, r)) continue;
      status.set(r, 'void');
      progress = true;
    }
    if (progress) continue;
    // A removal a sure revocation cuts below never cuts in a worst case nor
    // takes a pick,
    const doomed = doomedBy(ctx, accepted, open, having('waiting'));
    const live = open.filter((r) => !doomed.has(r));
    // and one held were every undecided removal that could cut it accepted is.
    const waiting = having('waiting').filter((r) => !doomed.has(r));
    const cutters = [
      ...accepted,
      ...live,
      ...couldCut(ctx, accepted, live, waiting),
    ];
    for (const r of live) {
      const worst = cutters.filter((o) => o !== r);
      if (!hadRight(ctx, evaluate(ctx, worst), r)) continue;
      status.set(r, 'accepted');
      progress = true;
    }
    if (progress) continue;
    // Only removals that cut each other remain: the earliest-ranked publisher's
    // is accepted and wins the fight.
    const pick = live.reduce((best, r) => (byRank(ev, r, best) < 0 ? r : best));
    status.set(pick, 'accepted');
    won.add(pick);
    settled.add(pick);
  }
  return { accepted: having('accepted'), won };
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
interface Shared extends Omit<Context, 'items' | 'reach'> {
  all: readonly Item[];
}

function sharedOf(input: FoldInput, all: readonly Item[]): Shared {
  const found = foundingOf(input, all);
  // Only Known(1) ops count toward a replica's first roster op, so neither an
  // unreadable op nor its dismissal ever moves it.
  const firstSeq = new Map<string, number>();
  for (const { op, kind } of all)
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
  const ctx: Context = { ...rest, items, reach: reachOf(items) };
  return { ctx, without, ...resolve(ctx) };
}

// Admissions and promotions link a publisher to its targets; a recover or a
// recovery key links to every recovering replica.
function reachOf(
  items: readonly Item[]
): (replica: string) => ReadonlySet<string> {
  const links = new Map<string, Set<string>>();
  const link = (from: string, to: string): void => {
    const set = links.get(from);
    if (set === undefined) links.set(from, new Set([to]));
    else set.add(to);
  };
  const recovering = items
    .filter((i) => isAction(i.body, 'recover'))
    .map((i) => i.op.replica);
  for (const { op, body } of items) {
    if (isAction(body, 'admit') || isAction(body, 'role'))
      link(op.replica, body.replica);
    else if (isAction(body, 'recover') || isAction(body, 'recovery-key'))
      for (const r of recovering) link(op.replica, r);
  }
  const memo = new Map<string, ReadonlySet<string>>();
  return (replica) => {
    const known = memo.get(replica);
    if (known !== undefined) return known;
    const seen = new Set([replica]);
    const queue = [replica];
    for (let q = queue.pop(); q !== undefined; q = queue.pop())
      for (const n of links.get(q) ?? [])
        if (!seen.has(n)) {
          seen.add(n);
          queue.push(n);
        }
    memo.set(replica, seen);
    return seen;
  };
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
  const cuts = ev.cutsOn.get(replica) ?? [];
  const killed = (g: Grant, kind: CutKind): boolean => {
    for (const c of cuts)
      if (c.kind === kind && c.afterSeq < seq && ev.order(g.pos, c.op) < 0)
        return true;
    return false;
  };
  let firstGrant: Grant | null = null;
  let firstAdmin: Grant | null = null;
  // Grants are recorded in fold order, so the ones before pos are a prefix.
  for (const g of ev.grants.get(replica) ?? []) {
    if (pos !== null && ev.order(g.pos, pos) >= 0) break;
    if (killed(g, 'all')) continue;
    firstGrant ??= g;
    if (g.admin && !killed(g, 'admin')) {
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

function evaluate(
  ctx: Context,
  cuts: readonly Removal[],
  notes = false
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
  for (const item of ctx.items) step(ctx, ev, accepted, item);
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

// Whether accepting r would take the right from accepted removals that r's own
// right rests on; each is judged without its own cut, and `holds` without r.
function undoes(
  ctx: Context,
  accepted: readonly Removal[],
  holds: (s: Removal) => boolean,
  r: Removal
): boolean {
  // Cutting r's target changes rights only where that target's grants reach.
  const reach = ctx.reach(r.target);
  const exposed = accepted.filter(
    (s) => reach.has(s.op.replica) || reach.has(s.target)
  );
  if (exposed.length === 0) return false;
  const withIt = [...accepted, r];
  const loses = (s: Removal): boolean => {
    const others = withIt.filter((o) => o !== s);
    return !hadRight(ctx, evaluate(ctx, others), s) && holds(s);
  };
  const undone = exposed.filter(loses);
  if (undone.length === 0) return false;
  const kept = accepted.filter((s) => !undone.includes(s));
  return !hadRight(ctx, evaluate(ctx, kept), r);
}

// The waiting removals that cut in a worst case: those whose publisher holds
// its right, own cut included, with every open removal accepted or with none.
function couldCut(
  ctx: Context,
  accepted: readonly Removal[],
  open: readonly Removal[],
  waiting: readonly Removal[]
): Removal[] {
  const holds = (w: Removal, cuts: readonly Removal[]): boolean =>
    hadRight(ctx, evaluate(ctx, [...accepted, ...cuts, w]), w);
  return waiting.filter(
    (w) => !cutBelow(accepted, w) && (holds(w, open) || holds(w, []))
  );
}

// The undecided removals a sure revocation cuts below: one held with no cut and
// with every other undecided removal accepted, bar those other sure ones cut.
function doomedBy(
  ctx: Context,
  accepted: readonly Removal[],
  open: readonly Removal[],
  waiting: readonly Removal[]
): Set<Removal> {
  const undecided = [...open, ...waiting].filter((r) => !cutBelow(accepted, r));
  const cutBy = (by: readonly Removal[]): Set<Removal> =>
    new Set(
      undecided.filter((o) => by.some((u) => u !== o && cutBelow([u], o)))
    );
  const holds = (u: Removal, shut: ReadonlySet<Removal>): boolean => {
    const others = undecided.filter((o) => o !== u && !shut.has(o));
    return hadRight(ctx, evaluate(ctx, [...accepted, ...others]), u);
  };
  // Only a revocation that cuts another undecided removal below it can doom one.
  const cutting = open.filter((u) => cutBy([u]).size > 0);
  if (cutting.length === 0) return new Set();
  const bare = evaluate(ctx, []);
  const firm = cutting.filter((u) => hadRight(ctx, bare, u));
  // Each pass starts from what the last one doomed, never left out of the check
  // of a revocation that cuts it, and drops any revocation held only by a cut.
  let doomed = new Set<Removal>();
  for (let pass = 0; pass <= firm.length; pass++) {
    const given = (u: Removal): Set<Removal> =>
      new Set([...doomed].filter((o) => !cutBelow([u], o)));
    let sure = firm.filter((u) => holds(u, given(u)));
    for (;;) {
      const held = sure.filter((u) => {
        const others = cutBy(sure.filter((v) => v !== u));
        return holds(u, new Set([...given(u), ...others]));
      });
      if (held.length === sure.length) break;
      sure = held;
    }
    const next = cutBy(sure);
    const same =
      next.size === doomed.size && [...next].every((o) => doomed.has(o));
    doomed = next;
    if (same) break;
  }
  return doomed;
}

// Whether an accepted revocation cuts r's publisher below r, which then holds
// no right at r in any fold: a revoked replica is never granted again.
function cutBelow(accepted: readonly Removal[], r: Removal): boolean {
  return accepted.some(
    (c) =>
      c.kind === 'all' && c.target === r.op.replica && c.afterSeq < r.op.seq
  );
}

// Every grant valid in some fold whose accepted removals include `cuts`: one
// whose publisher could hold its right there, never an observer's, and a
// recover whose proof verifies against a recovery key an admin could have set.
function reachable(ctx: Context, cuts: readonly Removal[]): Reachable {
  const p: Reachable = {
    cutsOn: byTarget(cuts),
    order: ctx.order,
    grants: new Map(),
    handles: new Map(),
    first: new Map(),
  };
  // An admission: an observer's sets who holds its replica but grants nothing.
  const admits = (
    replica: string,
    op: RosterOpRef,
    g: Grant | null,
    handle: string
  ): void => {
    if (!p.first.has(replica)) p.first.set(replica, op);
    if (g === null) return;
    grant(p, replica, g);
    const set = p.handles.get(replica);
    if (set === undefined) p.handles.set(replica, new Set([handle]));
    else set.add(handle);
  };
  const found = ctx.found.op;
  const admin = (pos: RosterOpRef, source: Grant['source']): Grant => ({
    pos,
    admin: true,
    source,
  });
  admits(
    found.replica,
    found,
    admin(found, 'found'),
    handleOf(ctx, found.replica)
  );
  const pubs = new Set([ctx.found.body.recoveryPub]);
  for (const { op, body } of ctx.items) {
    if (typeof body !== 'object' || ctx.order(op, found) <= 0) continue;
    const rights = rightsAt(p, op.replica, op.seq, op);
    if (isAction(body, 'admit')) {
      const key = ctx.input.keys.get(body.replica);
      if (key === undefined || key.fingerprint !== body.fingerprint) continue;
      if (revokedBefore(p, body.replica, op)) continue;
      const observer = body.observer === true;
      if (observer && body.role === 'admin') continue;
      const ownDevice =
        rights.member &&
        body.role === 'member' &&
        (body.hosts ?? []).length === 0 &&
        !observer &&
        body.handle === key.handle &&
        p.handles.get(op.replica)?.has(key.handle) === true;
      if (!rights.admin && !ownDevice) continue;
      const g: Grant = {
        pos: op,
        admin: body.role === 'admin',
        source: 'grant',
      };
      admits(body.replica, op, observer ? null : g, body.handle);
    } else if (isAction(body, 'role')) {
      const admitted =
        p.grants.has(body.replica) && !revokedBefore(p, body.replica, op);
      if (body.role === 'admin' && rights.admin && admitted)
        grant(p, body.replica, admin(op, 'grant'));
    } else if (isAction(body, 'recovery-key')) {
      if (rights.admin) pubs.add(body.pub);
    } else if (isAction(body, 'recover')) {
      const key = ctx.input.keys.get(op.replica);
      if (key === undefined || ctx.firstSeq.get(op.replica) !== op.seq)
        continue;
      if (revokedBefore(p, op.replica, op) || cutBySeq(p, op)) continue;
      if ([...pubs].some((pub) => ctx.proves(op, body.proof, pub)))
        admits(op.replica, op, admin(op, 'recover'), key.handle);
    }
  }
  return p;
}

// Whether some fold `p` covers gives r's publisher the right r needs at r.
function couldHold(ctx: Context, p: Reachable, r: Removal): boolean {
  const rights = rightsAt(p, r.op.replica, r.op.seq, r.op);
  if (rights.admin) return true;
  if (!rights.member || r.kind !== 'all') return false;
  const target = new Set(p.handles.get(r.target));
  target.add(handleOf(ctx, r.target));
  return [...(p.handles.get(r.op.replica) ?? [])].some((h) => target.has(h));
}

// The admin grants valid in every fold that accepts any of `cuts`, none resting
// on a cut: the founding, an admin's admit that is the first op any fold could
// admit its replica with, and an admin's promotion of a replica so admitted.
function robustRights(
  ctx: Context,
  uncut: Reachable,
  cuts: readonly Removal[]
): Granted {
  const s: Granted = {
    cutsOn: byTarget(cuts),
    order: ctx.order,
    grants: new Map(),
  };
  const found = ctx.found.op;
  grant(s, found.replica, { pos: found, admin: true, source: 'found' });
  for (const { op, body } of ctx.items) {
    let target: string;
    if (isAction(body, 'admit')) {
      if (uncut.first.get(body.replica) !== op || body.observer === true)
        continue;
      target = body.replica;
    } else if (isAction(body, 'role') && body.role === 'admin') {
      if (!s.grants.has(body.replica)) continue;
      target = body.replica;
    } else continue;
    if (!rightsAt(s, op.replica, op.seq, op).admin) continue;
    if (revokedBefore(s, target, op)) continue;
    const admin = !isAction(body, 'admit') || body.role === 'admin';
    grant(s, target, { pos: op, admin, source: 'grant' });
  }
  return s;
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
