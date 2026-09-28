import {
  ed25519FromSeed,
  sha256Hex,
  signText,
  TAG,
} from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';

import { foldRoster, foldRosterAt, unfoundedRemovals } from '../src/roster.js';
import type {
  FoldInput,
  KeyInfo,
  LaterPairs,
  RosterOpRef,
  RosterView,
} from '../src/roster.js';

// Roster op builders for the dismiss, pause and level tests: an op's hash
// derives from its body, and its hlc wall time is T0 plus `ms`.

const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const RECOVERY = ed25519FromSeed(Buffer.alloc(32, 7));
export const handleOf = (r: string): string => r.slice(0, r.lastIndexOf('-'));

export function keysFor(replicas: readonly string[]): Map<string, KeyInfo> {
  return new Map(
    replicas.map((r) => [
      r,
      {
        replica: r,
        handle: handleOf(r),
        signPub: `sign-${r}`,
        fingerprint: `FP-${r}`,
      },
    ])
  );
}

export function op(
  replica: string,
  seq: number,
  ms: number,
  body: Record<string, unknown>
): RosterOpRef {
  return {
    replica,
    seq,
    hlc: `${String(T0 + ms).padStart(13, '0')}.0000.${replica}`,
    hash: sha256Hex(`${replica}:${seq}:${JSON.stringify(body)}`),
    body: { rv: 1, ...body } as RosterBody,
  };
}

export const admit = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  role = 'member',
  extra: Record<string, unknown> = {}
): RosterOpRef =>
  op(by, seq, ms, {
    action: 'admit',
    replica: target,
    handle: handleOf(target),
    role,
    fingerprint: `FP-${target}`,
    ...extra,
  });

export const revoke = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  afterSeq: number,
  rv = 1
): RosterOpRef =>
  op(by, seq, ms, {
    rv,
    action: 'revoke',
    replica: target,
    afterSeq,
    afterHash: `h-${target}-${afterSeq}`,
    reason: 'test',
  });

export const demote = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  afterSeq: number,
  rv = 1
): RosterOpRef =>
  op(by, seq, ms, {
    rv,
    action: 'role',
    replica: target,
    role: 'member',
    afterSeq,
    afterHash: `h-${target}-${afterSeq}`,
  });

export const promote = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  rv = 1
): RosterOpRef =>
  op(by, seq, ms, { rv, action: 'role', replica: target, role: 'admin' });

export const dismiss = (
  by: string,
  seq: number,
  ms: number,
  named: { replica: string; seq: number; hash: string },
  extra: Record<string, unknown> = {}
): RosterOpRef =>
  op(by, seq, ms, {
    action: 'dismiss',
    replica: named.replica,
    seq: named.seq,
    hash: named.hash,
    ...extra,
  });

/** An op no build in the level table reads. */
export const junk = (by: string, seq: number, ms: number): RosterOpRef =>
  op(by, seq, ms, { rv: 7, action: 'x-garbage' });

/** A team founded by `founder` with the recovery code RECOVERY. */
export function team(founder: string, keys: ReadonlyMap<string, KeyInfo>) {
  const found = op(founder, 1, 0, {
    action: 'found',
    name: 'acme',
    legacy: [],
    recoveryPub: RECOVERY.signPub,
  });
  const teamId = found.hash.slice(0, 32);
  const input = (
    ops: readonly RosterOpRef[],
    extra: { relay?: boolean } = {}
  ): FoldInput => ({
    founder: { replica: founder, seq: 1 },
    ops: [found, ...ops],
    keys,
    now: new Date(T0 + 24 * 60 * 60 * 1000),
    licensePublicKey: null,
    ...extra,
  });
  return {
    found,
    input,
    fold: (ops: readonly RosterOpRef[], extra: { relay?: boolean } = {}) =>
      foldRoster(input(ops, extra)),
    /** The fold as a build at `level` of the level table runs it. */
    at: (
      level: number,
      ops: readonly RosterOpRef[],
      extra: { relay?: boolean } = {}
    ) => foldRosterAt(input(ops, extra), laterAt(level)),
    /** Accepted removals at `level` that won no fight yet lack their right. */
    unfounded: (level: number, ops: readonly RosterOpRef[]) =>
      unfoundedRemovals(input(ops), laterAt(level)),
    recover: (replica: string, seq: number, ms: number): RosterOpRef =>
      op(replica, seq, ms, {
        action: 'recover',
        proof: signText(
          RECOVERY.signPriv,
          `${TAG.recovery}\n${teamId}\n${replica}\n${keys.get(replica)?.signPub ?? ''}`
        ),
      }),
  };
}

// Hypothetical later levels: level 2 adds pairs that decide no right, level 3
// an rv 99 op, and level 4 reads pairs shaped as rights, which the fold refuses.
export const LEVELS: ReadonlyMap<number, readonly string[]> = new Map([
  [2, ['license@2', 'transport@2', 'invite@2', 'hosts@2', 'note@1']],
  [3, ['zap@99']],
  [4, ['admit@2', 'role@2', 'revoke@2', 'recovery-key@2']],
]);

// A later pair's meaning in rv 1 terms; note@1 is read and does nothing.
function meaningOf(
  pair: string,
  b: Readonly<Record<string, unknown>>
): unknown {
  if (pair === 'note@1') return {};
  if (pair === 'zap@99')
    return { rv: 1, action: 'transport', kind: 'relay', url: 'zap' };
  return { ...b, rv: 1 };
}

/** How a build at `level` reads the pairs outside Known(1). */
function laterAt(level: number): LaterPairs {
  const known = new Set(
    [...LEVELS].filter(([l]) => l <= level).flatMap(([, pairs]) => pairs)
  );
  return (b) => {
    const pair = `${String(b.action)}@${String(b.rv)}`;
    return known.has(pair) ? meaningOf(pair, b) : null;
  };
}

/** Where a build pauses on `o`, as RosterView.unknown names it. */
export const pausedAt = (o: RosterOpRef) => ({
  hlc: o.hlc,
  replica: o.replica,
  seq: o.seq,
  hash: o.hash,
});

const byKey = <T>(m: ReadonlyMap<string, T>): [string, T][] =>
  [...m.entries()].sort(([a], [b]) => (a < b ? -1 : 1));

/** Everything a view decides, less its problems and the pause. */
export function rosterOf(v: RosterView): unknown {
  return {
    members: [...v.members.values()].sort((a, b) =>
      a.replica < b.replica ? -1 : 1
    ),
    revoked: byKey(v.revoked),
    hostCuts: byKey(v.hostCuts),
    resolution: byKey(v.resolution),
    pending: v.pending,
    invites: byKey(v.invites),
    invitedBy: byKey(v.invitedBy),
    recoveryPub: v.recoveryPub,
    license: v.license,
    licenseBy: v.licenseBy,
    people: v.people,
    covered: [...v.covered].sort(),
    closed: v.legacy.closed,
    transport: v.transport,
    dismissed: v.dismissed,
  };
}

/** What only Known(1) ops may decide: admission, handles, roles, ranks, revocations, the recovery key. */
export function standingOf(v: RosterView): unknown {
  return {
    members: [...v.members.values()]
      .sort((a, b) => (a.replica < b.replica ? -1 : 1))
      .map((m) => [
        m.replica,
        m.handle,
        m.role,
        m.rank,
        m.observer,
        m.recovered,
      ]),
    revoked: byKey(v.revoked).map(([r, c]) => [r, c.afterSeq, c.afterHash]),
    pending: v.pending,
    recoveryPub: v.recoveryPub,
  };
}
