import {
  ed25519FromSeed,
  sha256Hex,
  signText,
  TAG,
} from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRoster, isCovered, speaksForHandle } from '../src/roster.js';
import type { KeyInfo, RosterOpRef } from '../src/roster.js';
import { licenseFor, testKeys } from './licenseKeys.js';

const A = 'ada-0000000a';
const B = 'bob-0000000b';
const C = 'cy-0000000c';
const D = 'dee-0000000d';
const B2 = 'bob-0000000f';
const A2 = 'ada-0000000e';
const OBS = 'obs-00000010';
const handleOf = (r: string) => r.slice(0, r.lastIndexOf('-'));
const RECOVERY = ed25519FromSeed(Buffer.alloc(32, 7));
const DAY = 24 * 60 * 60 * 1000;
const T0 = Date.parse('2026-09-26T00:00:00.000Z');

const keys = new Map<string, KeyInfo>(
  [A, B, C, D, B2, A2, OBS].map((r) => [
    r,
    {
      replica: r,
      handle: handleOf(r),
      signPub: `sign-${r}`,
      fingerprint: `FP-${r}`,
    },
  ])
);

function op(
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
const FOUND = op(A, 1, 0, {
  action: 'found',
  name: 'acme',
  legacy: [],
  recoveryPub: RECOVERY.signPub,
});
const admit = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  role = 'member',
  extra: Record<string, unknown> = {}
) =>
  op(by, seq, ms, {
    action: 'admit',
    replica: target,
    handle: handleOf(target),
    role,
    fingerprint: `FP-${target}`,
    ...extra,
  });
const revoke = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  afterSeq: number
) =>
  op(by, seq, ms, {
    action: 'revoke',
    replica: target,
    afterSeq,
    afterHash: `h-${target}-${afterSeq}`,
    reason: 'test',
  });
const demote = (
  by: string,
  seq: number,
  ms: number,
  target: string,
  afterSeq: number
) =>
  op(by, seq, ms, {
    action: 'role',
    replica: target,
    role: 'member',
    afterSeq,
    afterHash: `h-${target}-${afterSeq}`,
  });
function fold(
  ops: RosterOpRef[],
  extra: { now?: Date; licensePublicKey?: string | null } = {}
) {
  return foldRoster({
    founder: { replica: A, seq: 1 },
    ops: [FOUND, ...ops],
    keys,
    now: extra.now ?? new Date(T0 + DAY),
    licensePublicKey: extra.licensePublicKey ?? null,
  });
}
const recoveryProof = (replica: string) =>
  signText(
    RECOVERY.signPriv,
    `${TAG.recovery}\n${FOUND.hash.slice(0, 32)}\n${replica}\n${keys.get(replica)?.signPub ?? ''}`
  );
const roles = (v: ReturnType<typeof fold>) =>
  Object.fromEntries([...v.members.values()].map((m) => [m.replica, m.role]));
// The same op, as a build that does not know its rv reads it.
const unreadable = (o: RosterOpRef): RosterOpRef => ({
  ...o,
  body: { ...o.body, rv: 2 } as unknown as RosterBody,
});
// The roster itself, leaving out the problems.
const rosterOf = (v: ReturnType<typeof fold>) => ({
  members: [...v.members.values()].sort((a, b) =>
    a.replica < b.replica ? -1 : 1
  ),
  revoked: [...v.revoked.entries()].sort(([a], [b]) => (a < b ? -1 : 1)),
  people: v.people,
  pending: v.pending,
});

describe('foldRoster', () => {
  it('admits the founder as admin rank 0, derives the team id and lists the rest as pending', () => {
    const v = fold([]);
    expect(roles(v)).toEqual({ [A]: 'admin' });
    expect(v.members.get(A)?.rank).toBe(0);
    expect(v.teamId).toBe(FOUND.hash.slice(0, 32));
    expect([...v.pending].sort()).toEqual([A2, B, B2, C, D, OBS].sort());
  });

  it('admits by fingerprint and ignores a mismatch with a problem', () => {
    const v = fold([
      admit(A, 2, 100, B),
      op(A, 3, 200, {
        action: 'admit',
        replica: C,
        handle: 'cy',
        role: 'member',
        fingerprint: 'FP-wrong',
      }),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'member' });
    expect(v.problems.some((p) => p.message.includes('FP-wrong'))).toBe(true);
  });

  it('lets a member admit only their own device, only as a member', () => {
    const v = fold([
      admit(A, 2, 100, B),
      admit(B, 2, 200, B2),
      admit(B, 3, 300, C),
      admit(B, 4, 400, 'bob-00000011', 'admin'),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'member', [B2]: 'member' });
  });

  it('cuts a revoked replica by seq, whatever its clock says', () => {
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(B, 4, 120, D), // seq 4 <= afterSeq 5: stands
      admit(B, 7, 150, C), // seq 7 > 5, backdated before the revoke: cut
      revoke(A, 3, 300, B, 5),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [D]: 'member' });
    expect(v.revoked.get(B)?.afterSeq).toBe(5);
  });

  it('never admits a revoked replica id again', () => {
    const v = fold([
      admit(A, 2, 100, B),
      revoke(A, 3, 200, B, 1),
      admit(A, 4, 300, B),
    ]);
    expect(v.members.has(B)).toBe(false);
  });

  it('gives a revocation fight to the earlier-admitted admin, backdated or not', () => {
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 150, C, 'admin'),
      revoke(B, 3, 200, C, 1),
      revoke(C, 3, 190, B, 1),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'admin' });
  });

  it('voids a counter-revocation positioned before its publisher was even an admin', () => {
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      revoke(A, 3, 300, B, 2),
      revoke(B, 3, 50, A, 2),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin' });
  });

  it('resolves a three-admin cycle by rank, then accepts what the winner left uncut', () => {
    const byA = revoke(A, 4, 300, B, 1);
    const byB = revoke(B, 2, 300, C, 1);
    const byC = revoke(C, 2, 300, A, 3);
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, C, 'admin'),
      byA,
      byB,
      byC,
    ]);
    // A's revocation wins the pick and cuts B's, so nothing cuts C's any more.
    // C's cuts A at seq 4 too, but A's stays: it won the fight.
    expect(v.resolution.get(byA.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(roles(v)).toEqual({ [C]: 'admin' });
    expect([...v.revoked.keys()].sort()).toEqual([A, B].sort());
  });

  it("voids a removal whose publisher's own admission a revocation cuts", () => {
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(B, 2, 150, C, 'admin'), // seq 2 > afterSeq 1: C never was an admin
      admit(A, 3, 160, D),
      revoke(C, 2, 200, D, 1),
      revoke(A, 4, 300, B, 1),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [D]: 'member' });
  });

  it('voids a removal that would leave the team with no admin', () => {
    const v = fold([
      op(A, 2, 100, {
        action: 'role',
        replica: A,
        role: 'member',
        afterSeq: 1,
        afterHash: FOUND.hash,
      }),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin' });
  });

  it('admits a recovering machine once per code, ranked after every other admin', () => {
    const teamId = FOUND.hash.slice(0, 32);
    const proof = (replica: string) =>
      signText(
        RECOVERY.signPriv,
        `${TAG.recovery}\n${teamId}\n${replica}\n${keys.get(replica)?.signPub ?? ''}`
      );
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      op(A2, 2, 500, { action: 'recover', proof: proof(A2) }),
      op(D, 2, 600, { action: 'recover', proof: proof(D) }),
    ]);
    expect(v.members.get(A2)).toMatchObject({ role: 'admin', recovered: true });
    expect(v.members.has(D)).toBe(false);
    expect(
      (v.members.get(A2)?.rank ?? 0) > (v.members.get(B)?.rank ?? 99)
    ).toBe(true);
    expect(
      v.problems.some(
        (p) => p.message === `${A2} became an admin with the recovery code`
      )
    ).toBe(true);
  });

  it('stops a replaced recovery code working after the replacement', () => {
    const teamId = FOUND.hash.slice(0, 32);
    const next = ed25519FromSeed(Buffer.alloc(32, 9));
    const proof = signText(
      RECOVERY.signPriv,
      `${TAG.recovery}\n${teamId}\n${A2}\n${keys.get(A2)?.signPub ?? ''}`
    );
    const v = fold([
      op(A, 2, 100, { action: 'recovery-key', pub: next.signPub }),
      op(A2, 2, 500, { action: 'recover', proof }),
    ]);
    expect(v.members.has(A2)).toBe(false);
    expect(v.recoveryPub).toBe(next.signPub);
  });

  it("reads a pending replica's recover only as its first roster op", () => {
    const v = fold([
      op(C, 2, 100, {
        action: 'invite',
        id: 'i-cy',
        pub: 'P',
        handle: 'cy',
        expires: '2026-10-03T00:00:00.000Z',
      }),
      op(C, 3, 200, { action: 'recover', proof: recoveryProof(C) }),
    ]);
    expect(v.members.has(C)).toBe(false);
    expect(v.problems).toContainEqual({
      subject: `op:${C}:3`,
      message: `${C}'s recover is not its first roster op; ignored`,
    });
  });

  it('ignores a recover above a revocation of its replica, wherever it is positioned', () => {
    const cut = revoke(A, 2, 200, C, 1);
    const byD = op(D, 2, 300, { action: 'recover', proof: recoveryProof(D) });
    const v = fold([
      op(C, 2, 100, { action: 'recover', proof: recoveryProof(C) }),
      cut,
      byD,
    ]);
    expect(v.revoked.get(C)?.handle).toBeNull();
    // C never used the code, so D's recover admits D.
    expect(v.members.get(D)).toMatchObject({ role: 'admin', recovered: true });
    // A recover at a later rv is inert: C is pending there, so it never pauses.
    const unread = unreadable(
      op(C, 2, 100, { action: 'recover', proof: recoveryProof(C) })
    );
    const later = fold([unread, cut, byD]);
    expect(later.unknown).toBeNull();
    expect(later.members.get(D)).toMatchObject({ recovered: true });
  });

  it('takes seats from the roster license and counts people and hosts, not observers', () => {
    const lk = testKeys();
    const ops = [
      admit(A, 2, 100, B, 'member', { hosts: ['eve'] }),
      admit(A, 3, 200, OBS, 'member', { observer: true }),
      admit(A, 4, 300, C),
      admit(A, 5, 400, D),
    ];
    const free = fold(ops, { licensePublicKey: lk.publicKey });
    expect(free.seats).toBe(3);
    expect(free.people).toEqual(['ada', 'bob', 'eve', 'cy', 'dee']);
    expect([...free.covered]).toEqual(['ada', 'bob', 'eve']);
    const paid = fold(
      [
        ...ops,
        op(A, 6, 500, {
          action: 'license',
          key: licenseFor(lk.privateKey, { seats: 4 }),
        }),
      ],
      { licensePublicKey: lk.publicKey }
    );
    expect(paid.seats).toBe(4);
    expect([...paid.covered]).toEqual(['ada', 'bob', 'eve', 'cy']);
    expect(paid.members.get(OBS)?.observer).toBe(true);
  });

  it('lets a host speak for its hosts until a hosts removal cuts it', () => {
    const v = fold([
      admit(A, 2, 100, B, 'member', { hosts: ['eve'] }),
      op(A, 3, 200, {
        action: 'hosts',
        replica: B,
        hosts: [],
        afterSeq: 6,
        afterHash: 'h',
      }),
    ]);
    expect(speaksForHandle(v, B, 'bob', 99)).toBe(true);
    expect(speaksForHandle(v, B, 'eve', 6)).toBe(true);
    expect(speaksForHandle(v, B, 'eve', 7)).toBe(false);
  });

  it('lets a revoked replica speak, for its ops at or below the cut, for what it held', () => {
    const v = fold([
      admit(A, 2, 100, B, 'member', { hosts: ['eve'] }),
      admit(A, 3, 150, OBS, 'member', { observer: true }),
      revoke(A, 4, 300, B, 5),
      revoke(A, 5, 310, OBS, 5),
      revoke(A, 6, 320, C, 5),
    ]);
    expect(v.members.has(B)).toBe(false);
    expect(v.revoked.get(B)).toMatchObject({ handle: 'bob', hosts: ['eve'] });
    expect(speaksForHandle(v, B, 'bob', 5)).toBe(true);
    expect(speaksForHandle(v, B, 'eve', 4)).toBe(true);
    expect(speaksForHandle(v, B, 'bob', 6)).toBe(false);
    expect(speaksForHandle(v, B, 'dee', 4)).toBe(false);
    // An observer never spoke, and C was never admitted.
    expect(speaksForHandle(v, OBS, 'obs', 1)).toBe(false);
    expect(v.revoked.get(C)?.handle).toBeNull();
    expect(speaksForHandle(v, C, 'cy', 1)).toBe(false);
  });

  it("gives a member's fight with their own stolen device to the earlier-admitted one, backdated or not", () => {
    const base = [
      admit(A, 2, 100, B),
      admit(B, 2, 200, B2),
      revoke(B, 3, 500, B2, 1),
    ];
    for (const ms of [250, 600]) {
      const v = fold([...base, revoke(B2, 2, ms, B, 2)]);
      expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'member' });
      expect(v.revoked.has(B2)).toBe(true);
    }
  });

  it('lets an observer speak for nobody and voids every roster op it publishes', () => {
    const v = fold([
      admit(A, 2, 100, OBS, 'member', { observer: true }),
      op(OBS, 2, 200, {
        action: 'invite',
        id: 'i-obs',
        pub: 'P',
        handle: 'obs',
        expires: '2026-10-03T00:00:00.000Z',
      }),
    ]);
    expect(v.members.get(OBS)?.observer).toBe(true);
    expect(speaksForHandle(v, OBS, 'obs', 9)).toBe(false);
    expect(v.invites.size).toBe(0);
    expect(
      v.problems.some(
        (p) =>
          p.message ===
          `${OBS} is an observer; an observer publishes only keys, presence and acks`
      )
    ).toBe(true);
  });

  it('closes the legacy window: an admin any time, anyone admitted after the deadline, first valid wins', () => {
    const attest = [
      { replica: 'old-00000099', throughSeq: 4, digest: 'd'.repeat(64) },
    ];
    const early = fold(
      [
        admit(A, 2, 100, B),
        op(B, 2, 10 * DAY, { action: 'close-legacy', entries: attest }),
      ],
      { now: new Date(T0 + 40 * DAY) }
    );
    expect(early.legacy.closed).toBeNull();
    const late = fold(
      [
        admit(A, 2, 100, B),
        op(B, 2, 31 * DAY, { action: 'close-legacy', entries: attest }),
      ],
      { now: new Date(T0 + 40 * DAY) }
    );
    expect(late.legacy.closed?.by).toBe(B);
    const admin = fold([
      op(A, 2, DAY, { action: 'close-legacy', entries: [] }),
      admit(A, 3, 2 * DAY, B),
      op(B, 2, 31 * DAY, { action: 'close-legacy', entries: attest }),
    ]);
    expect(admin.legacy.closed?.by).toBe(A);
  });

  it('counts attested legacy people right after the founder while the window is open', () => {
    const legacy = [
      { replica: 'old-00000099', throughSeq: 4, digest: 'd'.repeat(64) },
      { replica: C, throughSeq: 2, digest: 'e'.repeat(64) },
    ];
    const found = op(A, 1, 0, {
      action: 'found',
      name: 'acme',
      legacy,
      recoveryPub: RECOVERY.signPub,
    });
    const people = (ops: RosterOpRef[]) =>
      foldRoster({
        founder: { replica: A, seq: 1 },
        ops: [found, ...ops],
        keys,
        now: new Date(T0 + DAY),
        licensePublicKey: null,
      }).people;
    // C has published a key: it counts once admitted, in its legacy place.
    expect(people([admit(A, 2, 100, B)])).toEqual(['ada', 'old', 'bob']);
    expect(people([admit(A, 2, 100, B), admit(A, 3, 200, C)])).toEqual([
      'ada',
      'old',
      'cy',
      'bob',
    ]);
    const closed = op(A, 3, 200, { action: 'close-legacy', entries: legacy });
    expect(people([admit(A, 2, 100, B), closed])).toEqual(['ada', 'bob']);
  });

  it("shows who invited a pending replica whose key carries the invite's proof", () => {
    const code = ed25519FromSeed(Buffer.alloc(32, 11));
    const teamId = FOUND.hash.slice(0, 32);
    const invited = (replica: string): KeyInfo => ({
      replica,
      handle: handleOf(replica),
      signPub: `sign-${replica}`,
      fingerprint: `FP-${replica}`,
      invite: {
        id: 'i-1',
        sig: signText(
          code.signPriv,
          `${TAG.invite}\n${teamId}\n${replica}\nsign-${replica}`
        ),
      },
    });
    const v = foldRoster({
      founder: { replica: A, seq: 1 },
      ops: [
        FOUND,
        op(A, 2, 100, {
          action: 'invite',
          id: 'i-1',
          pub: code.signPub,
          handle: 'bob',
          expires: '2026-10-03T00:00:00.000Z',
        }),
      ],
      keys: new Map([...keys, [B, invited(B)], [C, invited(C)]]),
      now: new Date(T0 + DAY),
      licensePublicKey: null,
    });
    expect(v.invitedBy.get(B)).toBe('ada');
    // The invite names bob, so cy's proof of it shows nothing.
    expect(v.invitedBy.has(C)).toBe(false);
  });

  it('ignores roster ops positioned before the founding', () => {
    const teamId = FOUND.hash.slice(0, 32);
    const proof = signText(
      RECOVERY.signPriv,
      `${TAG.recovery}\n${teamId}\n${A2}\n${keys.get(A2)?.signPub ?? ''}`
    );
    const v = fold([op(A2, 2, -100, { action: 'recover', proof })]);
    expect(v.members.has(A2)).toBe(false);
  });

  it('names a second founding as such, even one positioned before the pinned one', () => {
    const rival = op(C, 1, -100, {
      action: 'found',
      name: 'rival',
      legacy: [],
      recoveryPub: RECOVERY.signPub,
    });
    expect(fold([rival]).problems).toContainEqual({
      subject: `op:${C}:1`,
      message: `a second founding by ${C} (FP-${C}), ignored`,
    });
  });

  it('accepts a removal whose publisher gains the right only once another removal is accepted', () => {
    const byC = revoke(C, 2, 500, B, 1);
    const byB = revoke(B, 3, 500, C, 1);
    const byA2 = revoke(A2, 2, 400, D, 1);
    const v = fold([
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, B, 'admin'),
      admit(A, 4, 120, D),
      // B's admit comes first, so A2 is a member until C's revocation cuts it.
      admit(B, 2, 200, A2),
      admit(A, 5, 300, A2, 'admin'),
      byA2,
      byC,
      byB,
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin', [A2]: 'admin' });
    expect([...v.revoked.keys()].sort()).toEqual([B, D]);
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    expect(v.resolution.get(byA2.hash)).toBe('accepted');
  });

  it('holds a removal back while one still waiting for its right cuts the publisher', () => {
    const byA = revoke(A, 6, 400, C, 1);
    const byB = revoke(B, 2, 500, D, 1);
    const byA2 = revoke(A2, 2, 600, B, 1);
    const ops = [
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 110, B, 'admin'),
      admit(A, 4, 120, D),
      // C's admit comes first, so A2 is a member until A's revocation cuts it.
      admit(C, 2, 200, A2),
      admit(A, 5, 300, A2, 'admin'),
      byA,
      byB,
      byA2,
    ];
    const v = fold(ops);
    expect(roles(v)).toEqual({ [A]: 'admin', [A2]: 'admin', [D]: 'member' });
    expect([...v.revoked.keys()].sort()).toEqual([B, C]);
    expect(v.resolution.get(byA2.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    // Publishing a removal of its own does not shield B.
    const without = fold(ops.filter((o) => o !== byB));
    expect([...without.revoked.keys()].sort()).toEqual([B, C]);
  });

  it('keeps the earlier admin winning a fight that decides whether another removal has its right', () => {
    const [X, U, Y, Z, P, V] = [C, B, D, OBS, A2, B2];
    const byY = revoke(Y, 2, 310, U, 1);
    const byU = revoke(U, 3, 320, Y, 1);
    const byP = revoke(P, 2, 330, Z, 1);
    const ops = (first: string, second: string) => [
      admit(A, 2, 100, X, 'admin'),
      admit(A, 3, 101, first, 'admin'),
      admit(A, 4, 102, second, 'admin'),
      admit(A, 5, 103, Z, 'admin'),
      admit(A, 6, 104, P),
      op(X, 2, 200, { action: 'role', replica: P, role: 'admin' }),
      // U's admit comes first, so V is an admin only if Y's revocation stands.
      admit(U, 2, 210, V),
      admit(A, 7, 220, V, 'admin'),
      op(V, 2, 230, { action: 'role', replica: P, role: 'admin' }),
      revoke(A, 8, 300, X, 1),
      byY,
      byU,
      byP,
    ];
    const uWins = fold(ops(U, Y));
    expect(uWins.resolution.get(byU.hash)).toBe('accepted');
    expect(uWins.resolution.get(byY.hash)).toBe('void');
    expect(uWins.resolution.get(byP.hash)).toBe('void');
    expect(roles(uWins)).toEqual({
      [A]: 'admin',
      [U]: 'admin',
      [Z]: 'admin',
      [P]: 'member',
      [V]: 'member',
    });
    // Were Y the earlier admin, its win would make V, and so P, an admin.
    const yWins = fold(ops(Y, U));
    expect(yWins.resolution.get(byY.hash)).toBe('accepted');
    expect(yWins.resolution.get(byU.hash)).toBe('void');
    expect(yWins.resolution.get(byP.hash)).toBe('accepted');
    expect([...yWins.revoked.keys()].sort()).toEqual([U, X, Z].sort());
  });

  it('never lets a removal whose publisher cannot gain the right stall another', () => {
    const byC = revoke(C, 2, 200, B, 2);
    const byB = revoke(B, 3, 300, D, 1);
    const byA2 = revoke(A2, 2, 250, C, 1);
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, C, 'admin'),
      admit(A, 4, 120, D),
      admit(A, 5, 130, A2),
      byC,
      byB,
      byA2,
    ]);
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    expect(v.resolution.get(byA2.hash)).toBe('void');
    expect(roles(v)).toEqual({
      [A]: 'admin',
      [C]: 'admin',
      [D]: 'member',
      [A2]: 'member',
    });
  });

  it('gives the fight to the earlier admin when a waiting removal would cut the later one', () => {
    const byC = revoke(C, 2, 400, D, 1);
    const byB = revoke(B, 2, 410, C, 1);
    const byA2 = revoke(A2, 2, 420, B, 1);
    const v = fold([
      admit(A, 2, 100, C, 'admin'),
      admit(A, 3, 105, D, 'admin'),
      admit(A, 4, 110, B, 'admin'),
      // D's admit comes first, so A2 is an admin only once C's revocation stands.
      admit(D, 2, 200, A2),
      admit(A, 5, 300, A2, 'admin'),
      byC,
      byB,
      byA2,
    ]);
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    expect(v.resolution.get(byA2.hash)).toBe('accepted');
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin', [A2]: 'admin' });
  });

  it('accepts a revocation of a self-demotion that won a fight once nothing left cuts it', () => {
    const selfDemotion = demote(B, 2, 200, B, 1);
    const byC = revoke(C, 2, 210, B, 1);
    const byBofC = revoke(B, 3, 220, C, 1);
    const byBofA2 = revoke(B, 4, 225, A2, 1);
    const byA2 = revoke(A2, 2, 300, D, 1);
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, C, 'admin'),
      admit(A, 4, 120, D),
      admit(A, 5, 130, A2, 'admin'),
      selfDemotion,
      byC,
      byBofC,
      byBofA2,
      byA2,
    ]);
    // B's self-demotion wins the pick and voids B's revocations, so nothing
    // cuts C's revocation of B any more.
    expect(v.resolution.get(selfDemotion.hash)).toBe('accepted');
    expect(v.resolution.get(byBofC.hash)).toBe('void');
    expect(v.resolution.get(byBofA2.hash)).toBe('void');
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    // Nothing cuts A2, so its revocation of D stands.
    expect(v.resolution.get(byA2.hash)).toBe('accepted');
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin', [A2]: 'admin' });
    expect([...v.revoked.keys()].sort()).toEqual([B, D].sort());
    // B's void revocation of C changes nothing: without it, B is revoked too.
    const without = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, C, 'admin'),
      admit(A, 4, 120, D),
      admit(A, 5, 130, A2, 'admin'),
      selfDemotion,
      byC,
      byBofA2,
      byA2,
    ]);
    expect(rosterOf(without)).toEqual(rosterOf(v));
  });

  it('voids a removal that would undo the accepted removal its own right rests on', () => {
    const selfRevoke = revoke(D, 3, 400, D, 1);
    const byC = revoke(C, 2, 410, D, 1);
    const v = fold([
      admit(A, 2, 100, D, 'admin'),
      // C is an admin only once a revocation of D cuts this admit.
      admit(D, 2, 200, C),
      admit(A, 3, 300, C, 'admin'),
      // A pending replica's demotion, which never gains its right.
      demote(B2, 2, 150, A, 1),
      selfRevoke,
      byC,
    ]);
    expect(v.resolution.get(selfRevoke.hash)).toBe('accepted');
    expect(v.resolution.get(byC.hash)).toBe('void');
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin' });
    expect([...v.revoked.keys()]).toEqual([D]);
  });

  it("holds nothing back with a waiting removal that would cut its own publisher's admission", () => {
    const selfDemotion = demote(B2, 3, 405, B2, 2);
    const byC = revoke(C, 2, 433, A, 1);
    const selfRevoke = revoke(B2, 4, 443, B2, 1);
    const v = fold([
      admit(A, 2, 115, B2, 'admin'),
      // C is an admin only once B2's self-revocation cuts this admit, and C's
      // revocation of A would cut A's admit of C.
      admit(B2, 2, 204, C),
      admit(A, 3, 281, C, 'admin'),
      selfDemotion,
      byC,
      selfRevoke,
    ]);
    expect(v.resolution.get(selfRevoke.hash)).toBe('accepted');
    expect(v.resolution.get(selfDemotion.hash)).toBe('void');
    expect(v.resolution.get(byC.hash)).toBe('void');
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin' });
    expect([...v.revoked.keys()]).toEqual([B2]);
  });

  it('lets a revocation cut a removal accepted while it waited, when no fight decided that one', () => {
    const byD = revoke(D, 2, 175, B2, 1);
    const byC = revoke(C, 2, 448, D, 1);
    const demotion = demote(A, 5, 496, B, 1);
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, D, 'admin'),
      byD,
      // C is an admin only once A's demotion of B cuts this admit.
      admit(B, 2, 236, C),
      admit(A, 4, 304, C, 'admin'),
      // A pending replica's demotion, which never gains its right.
      demote(A2, 2, 413, A, 1),
      byC,
      demotion,
    ]);
    expect(v.resolution.get(demotion.hash)).toBe('accepted');
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(v.resolution.get(byD.hash)).toBe('void');
    expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'member', [C]: 'admin' });
    expect(v.revoked.has(B2)).toBe(false);
  });

  it('ends a fight whose removals keep trading rights by voiding one on its second loss', () => {
    const byB = revoke(B, 2, 400, C, 1);
    const byC = revoke(C, 2, 411, A2, 1);
    const selfRevoke = revoke(D, 3, 429, D, 1);
    const byA2 = revoke(A2, 2, 441, B, 1);
    const v = fold([
      admit(A, 2, 105, C, 'admin'),
      admit(A, 3, 115, D, 'admin'),
      admit(A, 4, 120, B, 'admin'),
      // A2 is an admin only once D's self-revocation cuts this admit.
      admit(D, 2, 230, A2),
      admit(A, 5, 302, A2, 'admin'),
      byB,
      byC,
      selfRevoke,
      byA2,
    ]);
    expect(v.resolution.get(byC.hash)).toBe('accepted');
    expect(v.resolution.get(selfRevoke.hash)).toBe('accepted');
    expect(v.resolution.get(byB.hash)).toBe('void');
    expect(v.resolution.get(byA2.hash)).toBe('void');
    expect(roles(v)).toEqual({ [A]: 'admin', [B]: 'admin', [C]: 'admin' });
  });

  it('never makes an observer an admin, so the last admin cannot hand the team to one', () => {
    const v = fold([
      admit(A, 2, 100, OBS, 'admin', { observer: true }),
      admit(A, 3, 150, C, 'member', { observer: true }),
      op(A, 4, 200, { action: 'role', replica: C, role: 'admin' }),
      op(A, 5, 300, {
        action: 'role',
        replica: A,
        role: 'member',
        afterSeq: 4,
        afterHash: 'h',
      }),
    ]);
    expect(v.members.has(OBS)).toBe(false);
    expect(v.members.get(C)).toMatchObject({
      role: 'member',
      observer: true,
      rank: null,
    });
    expect(roles(v)[A]).toBe('admin');
  });

  it('cuts a demoted admin by seq and restores admin on a later promotion', () => {
    const ops = [
      admit(A, 2, 100, B, 'admin'),
      admit(B, 2, 150, C), // seq 2 <= afterSeq 2: stands
      admit(B, 3, 200, OBS, 'member', { observer: true }), // backdated: cut
      op(A, 3, 300, {
        action: 'role',
        replica: B,
        role: 'member',
        afterSeq: 2,
        afterHash: 'h',
      }),
      admit(B, 4, 500, D),
    ];
    const demoted = fold(ops);
    expect(roles(demoted)).toEqual({
      [A]: 'admin',
      [B]: 'member',
      [C]: 'member',
    });
    const promoted = fold([
      ...ops,
      op(A, 4, 400, { action: 'role', replica: B, role: 'admin' }),
    ]);
    expect(roles(promoted)).toEqual({
      [A]: 'admin',
      [B]: 'admin',
      [C]: 'member',
      [D]: 'member',
    });
    expect(promoted.members.get(D)?.since.seq).toBe(4);
    expect(promoted.members.get(B)?.rank).toBe(1);
  });

  it('switches the transport on an admin op only', () => {
    const v = fold([
      admit(A, 2, 100, B),
      op(A, 3, 200, {
        action: 'transport',
        kind: 'relay',
        url: 'https://relay.test',
      }),
      op(B, 2, 300, { action: 'transport', kind: 'git' }),
    ]);
    expect(v.transport).toEqual({ kind: 'relay', url: 'https://relay.test' });
  });

  it('takes the latest license an admin shared that verifies, and names who shared it', () => {
    const lk = testKeys();
    const license = (by: string, seq: number, ms: number, seats: number) =>
      op(by, seq, ms, {
        action: 'license',
        key: licenseFor(lk.privateKey, { seats }),
      });
    const v = fold(
      [
        admit(A, 2, 100, B),
        license(B, 2, 200, 9),
        license(A, 3, 300, 5),
        op(A, 4, 400, { action: 'license', key: 'dispatch1.garbage' }),
      ],
      { licensePublicKey: lk.publicKey }
    );
    expect(v.seats).toBe(5);
    expect(v.licenseBy).toBe(A);
  });

  it('lets a member invite only for their own handle', () => {
    const invite = (by: string, seq: number, id: string, handle: string) =>
      op(by, seq, 200 + seq, {
        action: 'invite',
        id,
        pub: 'P',
        handle,
        expires: '2026-10-03T00:00:00.000Z',
      });
    const v = fold([
      admit(A, 2, 100, B),
      invite(B, 2, 'i-own', 'bob'),
      invite(B, 3, 'i-other', 'cy'),
      invite(A, 3, 'i-admin', 'cy'),
    ]);
    expect([...v.invites.keys()].sort()).toEqual(['i-admin', 'i-own']);
    expect(v.invites.get('i-own')?.by).toBe(B);
  });

  it('counts an observer as covered and a replica past the seats as not', () => {
    const v = fold([
      admit(A, 2, 100, B),
      admit(A, 3, 200, OBS, 'member', { observer: true }),
      admit(A, 4, 300, C),
      admit(A, 5, 400, D),
    ]);
    expect(isCovered(v, C)).toBe(true);
    expect(isCovered(v, OBS)).toBe(true);
    expect(isCovered(v, D)).toBe(false);
    expect(isCovered(v, A2)).toBe(false);
  });
});
