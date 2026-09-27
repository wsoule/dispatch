import { hlcWallMs, TAG, verifyText } from '@dispatch/protocol/federation';
import type {
  LegacyAttestation,
  RosterBody,
} from '@dispatch/protocol/federation';

import { FREE_SEATS, readLicenseKey } from './license.js';
import type { LicenseState } from './license.js';
import { comparePositions } from './position.js';
import type { Position } from './position.js';

// The roster fold: who is on the team, with which role, hosts and rank, and
// the seats, from the set of verified roster ops alone. Every daemon and the
// relay run it, so its result never depends on arrival order or a local clock
// (only license expiry reads `now`).

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

type Transport = { kind: 'git' | 'relay'; url?: string };
type Invite = { pub: string; handle: string; expires: string; by: string };
type Closed = { by: string; entries: readonly LegacyAttestation[] };
type HostCut = { afterSeq: number; hosts: readonly string[] };
type Problem = { subject: string; message: string };

export interface RosterView {
  teamId: string;
  name: string;
  founder: string;
  members: ReadonlyMap<string, RosterMember>;
  revoked: ReadonlyMap<string, { afterSeq: number; afterHash: string }>;
  /** Per replica, the hosts each accepted hosts removal took away. */
  hostCuts: ReadonlyMap<string, HostCut[]>;
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
  problems: readonly Problem[];
  /** The first op this build cannot read; while set, the caller applies nothing. */
  unknown: Position | null;
}

type Body = RosterBody | 'unknown' | 'malformed';
type Action<A extends RosterBody['action']> = Extract<
  RosterBody,
  { action: A }
>;
type CutKind = 'all' | 'admin' | 'hosts';

interface Item {
  op: RosterOpRef;
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

interface Context {
  input: FoldInput;
  items: readonly Item[];
  found: { op: RosterOpRef; body: Action<'found'> };
  teamId: string;
  deadlineMs: number;
}

// Everything one walk over the ops in fold order derives, given the removals
// accepted so far.
interface Evaluation {
  cuts: readonly Removal[];
  holders: Map<string, Holder>;
  grants: Map<string, Grant[]>;
  invites: Map<string, Invite>;
  recoveryPub: string;
  usedRecovery: Set<string>;
  licenses: { key: string; by: string }[];
  transport: Transport;
  legacyClosed: Closed | null;
  order: string[];
  hostCuts: Map<string, HostCut[]>;
  problems: Problem[];
  unknown: Position | null;
}

const NEWER_ROSTER =
  "a teammate's newer Dispatch changed the roster in a way this build cannot read; upgrade to continue";

/**
 * Folds verified roster ops into the team's view: grants count at their
 * position, removals cut by seq, and a revocation fight goes to the earlier admin.
 */
export function foldRoster(input: FoldInput): RosterView {
  const ctx = contextOf(input);
  const removals = ctx.items
    .map(removalOf)
    .filter((r): r is Removal => r !== null);
  const status = new Map<Removal, 'undecided' | 'accepted' | 'void'>(
    removals.map((r) => [r, 'undecided'])
  );
  const having = (s: 'undecided' | 'accepted') =>
    removals.filter((r) => status.get(r) === s);

  for (;;) {
    const undecided = having('undecided');
    if (undecided.length === 0) break;
    const ev = evaluate(ctx, having('accepted'));
    let progress = false;
    // Rights only shrink as removals are accepted: one missing now stays missing,
    for (const r of undecided) {
      if (hadRight(ctx, ev, r)) continue;
      status.set(r, 'void');
      progress = true;
    }
    // and one held even were every other open removal accepted stays held.
    for (const r of having('undecided')) {
      const worst = removals.filter((o) => o !== r && status.get(o) !== 'void');
      if (!hadRight(ctx, evaluate(ctx, worst), r)) continue;
      status.set(r, 'accepted');
      progress = true;
    }
    if (progress) continue;
    // Only removals that cut each other remain: the earliest-ranked publisher's
    // is accepted, and every removal that would take its right away is void.
    const pick = undecided.reduce((best, r) =>
      byRank(ev, r, best) < 0 ? r : best
    );
    status.set(pick, 'accepted');
    for (const o of undecided) {
      if (o === pick) continue;
      const withIt = [...having('accepted'), o];
      if (!hadRight(ctx, evaluate(ctx, withIt), pick)) status.set(o, 'void');
    }
  }

  let ev = evaluate(ctx, having('accepted'));
  // A result with no admin voids accepted removals, latest publisher rank first.
  while (adminsOf(ev).length === 0 && having('accepted').length > 0) {
    const worst = having('accepted').reduce((w, r) =>
      byRank(ev, r, w) > 0 ? r : w
    );
    status.set(worst, 'void');
    ev = evaluate(ctx, having('accepted'));
  }
  return viewOf(ctx, ev);
}

/** Whether `replica`'s op `seq` may speak for `handle`. Observers speak for nobody. */
export function speaksForHandle(
  view: RosterView,
  replica: string,
  handle: string,
  seq: number
): boolean {
  const m = view.members.get(replica);
  if (m === undefined || m.observer) return false;
  if (m.handle === handle || m.hosts.includes(handle)) return true;
  // A host a removal took away still counts for ops at or below its afterSeq.
  return (view.hostCuts.get(replica) ?? []).some(
    (c) => c.afterSeq >= seq && c.hosts.includes(handle)
  );
}

/** Whether `replica` is within the seats. Observers count for nothing, so always are. */
export function isCovered(view: RosterView, replica: string): boolean {
  const m = view.members.get(replica);
  if (m === undefined) return false;
  return m.observer || view.covered.has(m.handle);
}

function contextOf(input: FoldInput): Context {
  const items = dedupe(input.ops)
    .sort(comparePositions)
    .map((op) => ({ op, body: readBody(op.body) }));
  const found = items.find(
    (i) =>
      i.op.replica === input.founder.replica && i.op.seq === input.founder.seq
  );
  if (found === undefined || !isAction(found.body, 'found')) {
    throw new Error(
      `the founding op ${input.founder.replica}:${input.founder.seq} is not among the roster ops`
    );
  }
  return {
    input,
    items,
    found: { op: found.op, body: found.body },
    teamId: found.op.hash.slice(0, 32),
    deadlineMs: (hlcWallMs(found.op.hlc) ?? 0) + LEGACY_WINDOW_MS,
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
  [
    'transport',
    (b) => (b.kind === 'git' || b.kind === 'relay') && optional(b.url, isStr),
  ],
]);

// A newer `rv` or action is unknown, and pauses the caller; a known action
// missing its fields is malformed, and ignored.
function readBody(body: unknown): Body {
  if (typeof body !== 'object' || body === null || Array.isArray(body))
    return 'malformed';
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b.rv) || !isStr(b.action)) return 'malformed';
  if (b.rv !== 1) return 'unknown';
  const shape = SHAPES.get(b.action);
  if (shape === undefined) return 'unknown';
  return shape(b) ? (body as RosterBody) : 'malformed';
}

function removalOf({ op, body }: Item): Removal | null {
  const cut = (
    target: string,
    afterSeq: number,
    afterHash: string,
    kind: CutKind
  ): Removal => ({ op, target, afterSeq, afterHash, kind });
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
  /** The earliest admin grant still standing, which sets the rank. */
  firstAdmin: Grant | null;
}

// The rights `replica` holds for its op `seq` at `pos` (every grant when pos is
// null). A cut kills, for the target's ops above its afterSeq, only the grants
// positioned before it, so a later promotion restores admin.
function rightsAt(
  ev: Evaluation,
  replica: string,
  seq: number,
  pos: Position | null
): Rights {
  const mine = ev.cuts.filter((c) => c.target === replica && c.afterSeq < seq);
  const killed = (g: Grant, kinds: readonly CutKind[]) =>
    mine.some(
      (c) => kinds.includes(c.kind) && comparePositions(g.pos, c.op) < 0
    );
  const before = (ev.grants.get(replica) ?? []).filter(
    (g) => pos === null || comparePositions(g.pos, pos) < 0
  );
  const member = before.some((g) => !killed(g, ['all']));
  const firstAdmin = member
    ? (before.find((g) => g.admin && !killed(g, ['all', 'admin'])) ?? null)
    : null;
  return { member, admin: firstAdmin !== null, firstAdmin };
}

function revokedBefore(
  ev: Evaluation,
  replica: string,
  pos: Position
): boolean {
  return ev.cuts.some(
    (c) =>
      c.kind === 'all' &&
      c.target === replica &&
      comparePositions(c.op, pos) < 0
  );
}

function admittedAt(ev: Evaluation, replica: string, pos: Position): boolean {
  return ev.holders.has(replica) && !revokedBefore(ev, replica, pos);
}

function grant(ev: Evaluation, replica: string, g: Grant): void {
  const list = ev.grants.get(replica);
  if (list === undefined) ev.grants.set(replica, [g]);
  else list.push(g);
}

// Records handles in the order they were first granted, for seats.
function addPeople(ev: Evaluation, handles: readonly string[]): void {
  for (const h of handles) if (!ev.order.includes(h)) ev.order.push(h);
}

function evaluate(ctx: Context, cuts: readonly Removal[]): Evaluation {
  const ev: Evaluation = {
    cuts,
    holders: new Map(),
    grants: new Map(),
    invites: new Map(),
    recoveryPub: ctx.found.body.recoveryPub,
    usedRecovery: new Set(),
    licenses: [],
    transport: { kind: 'git' },
    legacyClosed: null,
    order: [],
    hostCuts: new Map(),
    problems: [],
    unknown: null,
  };
  const accepted = new Set(cuts.map((c) => c.op));
  for (const item of ctx.items) step(ctx, ev, accepted, item);
  return ev;
}

// Applies one op in fold order, valid only when its publisher held the right
// at the op's own seq and position.
function step(
  ctx: Context,
  ev: Evaluation,
  accepted: ReadonlySet<RosterOpRef>,
  { op, body }: Item
): void {
  const refuse = (message: string): void => {
    ev.problems.push({ subject: `op:${op.replica}:${op.seq}`, message });
  };
  if (comparePositions(op, ctx.found.op) < 0) {
    refuse(
      `${op.replica}'s roster op at seq ${op.seq} precedes the founding; ignored`
    );
    return;
  }
  const publisher = ev.holders.get(op.replica);
  if (publisher?.observer === true) {
    refuse(
      `${op.replica} is an observer; an observer publishes only keys, presence and acks`
    );
    return;
  }
  if (body === 'unknown') {
    ev.unknown ??= positionOf(op);
    refuse(NEWER_ROSTER);
    return;
  }
  if (body === 'malformed') {
    refuse(`${op.replica}'s roster op at seq ${op.seq} is malformed; ignored`);
    return;
  }
  const rights = rightsAt(ev, op.replica, op.seq, op);
  const noRight = (): void =>
    refuse(
      `${op.replica} lacks the right to ${body.action} at seq ${op.seq}; ignored`
    );
  switch (body.action) {
    case 'found':
      foundStep(ctx, ev, op, body, refuse);
      return;
    case 'admit':
      admitStep(ctx, ev, op, body, rights, refuse);
      return;
    case 'role':
      if (body.role === 'member') {
        // A demotion is a removal, which the resolution loop decides.
        if (body.afterSeq === undefined || body.afterHash === undefined)
          refuse('a demotion must name afterSeq and afterHash; ignored');
        return;
      }
      if (!rights.admin) return noRight();
      if (!admittedAt(ev, body.replica, op)) {
        refuse(`${body.replica} is not admitted; ignored`);
        return;
      }
      grant(ev, body.replica, {
        pos: positionOf(op),
        admin: true,
        source: 'grant',
      });
      return;
    case 'hosts':
      hostsStep(ev, op, body, rights, accepted, refuse);
      return;
    case 'license':
      if (!rights.admin) return noRight();
      ev.licenses.push({ key: body.key, by: op.replica });
      return;
    case 'invite':
      if (
        !rights.admin &&
        !(rights.member && publisher?.handle === body.handle)
      )
        return noRight();
      if (!ev.invites.has(body.id)) {
        const { pub, handle, expires } = body;
        ev.invites.set(body.id, { pub, handle, expires, by: op.replica });
      }
      return;
    case 'recovery-key':
      if (!rights.admin) return noRight();
      ev.recoveryPub = body.pub;
      return;
    case 'recover':
      recoverStep(ctx, ev, op, body, refuse);
      return;
    case 'close-legacy': {
      if (ev.legacyClosed !== null) return;
      const wall = hlcWallMs(op.hlc);
      const due = wall !== null && wall >= ctx.deadlineMs;
      if (!rights.admin && !(rights.member && due)) return noRight();
      ev.legacyClosed = { by: op.replica, entries: body.entries };
      return;
    }
    case 'transport':
      if (!rights.admin) return noRight();
      ev.transport =
        body.url === undefined
          ? { kind: body.kind }
          : { kind: body.kind, url: body.url };
      return;
    case 'revoke':
      // A removal, which the resolution loop decides.
      return;
  }
}

function foundStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'found'>,
  refuse: (message: string) => void
): void {
  if (op !== ctx.found.op) {
    const fp = ctx.input.keys.get(op.replica)?.fingerprint ?? 'no pinned key';
    refuse(`a second founding by ${op.replica} (${fp}), ignored`);
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
  grant(ev, op.replica, { pos, admin: true, source: 'found' });
  // Attested legacy people rank right after the founder.
  addPeople(ev, [handle, ...body.legacy.map((a) => personOf(a.replica))]);
}

function admitStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'admit'>,
  rights: Rights,
  refuse: (message: string) => void
): void {
  const key = ctx.input.keys.get(body.replica);
  if (key === undefined) {
    refuse(
      `the admit of ${body.replica} names fingerprint ${body.fingerprint}, but no key of ${body.replica} is pinned; ignored`
    );
    return;
  }
  if (key.fingerprint !== body.fingerprint) {
    refuse(
      `the admit of ${body.replica} names fingerprint ${body.fingerprint}, but its key's is ${key.fingerprint}; ignored`
    );
    return;
  }
  if (revokedBefore(ev, body.replica, op)) {
    refuse(`${body.replica} was revoked and is never admitted again`);
    return;
  }
  if (ev.holders.has(body.replica)) return;
  const hosts = [...(body.hosts ?? [])];
  const observer = body.observer === true;
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
    refuse(
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
    pos,
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
  rights: Rights,
  accepted: ReadonlySet<RosterOpRef>,
  refuse: (message: string) => void
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
    if (!rights.admin) {
      refuse(
        `${op.replica} lacks the right to hosts at seq ${op.seq}; ignored`
      );
      return;
    }
    if (target === undefined || !admittedAt(ev, body.replica, op)) {
      refuse(`${body.replica} is not admitted; ignored`);
      return;
    }
    if (removed.length > 0) {
      refuse(
        `a hosts change that removes ${removed.join(', ')} must name afterSeq and afterHash; ignored`
      );
      return;
    }
  }
  target.hosts = [...body.hosts];
  if (!target.observer) addPeople(ev, body.hosts);
}

// A pending replica's recover op admits it as an admin when its proof verifies
// against the recovery key current at that position, once per key.
function recoverStep(
  ctx: Context,
  ev: Evaluation,
  op: RosterOpRef,
  body: Action<'recover'>,
  refuse: (message: string) => void
): void {
  const key = ctx.input.keys.get(op.replica);
  if (ev.holders.has(op.replica)) {
    refuse(`${op.replica} is already admitted; its recover is ignored`);
    return;
  }
  if (revokedBefore(ev, op.replica, op)) {
    refuse(`${op.replica} was revoked and is never admitted again`);
    return;
  }
  if (key === undefined) {
    refuse(`${op.replica} has no pinned key; its recover is ignored`);
    return;
  }
  if (ev.usedRecovery.has(ev.recoveryPub)) {
    refuse(
      `the recovery code ${op.replica} used has already admitted a replica; ignored`
    );
    return;
  }
  const signed = `${TAG.recovery}\n${ctx.teamId}\n${op.replica}\n${key.signPub}`;
  if (!verifyText(ev.recoveryPub, signed, body.proof)) {
    refuse(
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
  grant(ev, op.replica, { pos, admin: true, source: 'recover' });
  addPeople(ev, [key.handle]);
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
const NOT_ADMIN = 3;

// Admin rank at an op: the founder, then admins by their first standing admin
// grant, then recovered admins, then everyone else.
function compareRank(
  ev: Evaluation,
  a: { replica: string; seq: number; pos: Position | null },
  b: { replica: string; seq: number; pos: Position | null }
): number {
  const ga = rightsAt(ev, a.replica, a.seq, a.pos).firstAdmin;
  const gb = rightsAt(ev, b.replica, b.seq, b.pos).firstAdmin;
  const ta = ga === null ? NOT_ADMIN : TIER[ga.source];
  const tb = gb === null ? NOT_ADMIN : TIER[gb.source];
  if (ta !== tb) return ta - tb;
  if (ga === null || gb === null) return 0;
  return comparePositions(ga.pos, gb.pos);
}

// Removals by their publishers' rank at each removal, then by position.
function byRank(ev: Evaluation, a: Removal, b: Removal): number {
  const at = (r: Removal) => ({
    replica: r.op.replica,
    seq: r.op.seq,
    pos: r.op,
  });
  const d = compareRank(ev, at(a), at(b));
  if (d !== 0) return d;
  return comparePositions(a.op, b.op);
}

function adminsOf(ev: Evaluation): string[] {
  return [...ev.holders.keys()].filter(
    (r) => rightsAt(ev, r, Infinity, null).admin
  );
}

function viewOf(ctx: Context, ev: Evaluation): RosterView {
  const { input } = ctx;
  const revoked = new Map<string, { afterSeq: number; afterHash: string }>();
  for (const c of ev.cuts) {
    if (c.kind !== 'all') continue;
    const seen = revoked.get(c.target);
    if (seen === undefined || c.afterSeq < seen.afterSeq)
      revoked.set(c.target, { afterSeq: c.afterSeq, afterHash: c.afterHash });
  }
  const standing = (replica: string) => ({ replica, seq: Infinity, pos: null });
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
  const people = ev.order.filter((h) => counted.has(h));

  return {
    teamId: ctx.teamId,
    name: ctx.found.body.name,
    founder: input.founder.replica,
    members,
    revoked,
    hostCuts: ev.hostCuts,
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
    problems: ev.problems,
    unknown: ev.unknown,
  };
}
