import {
  ed25519FromSeed,
  sha256Hex,
  signText,
  TAG,
} from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRoster, speaksForHandle } from '../src/roster.js';
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
const roles = (v: ReturnType<typeof fold>) =>
  Object.fromEntries([...v.members.values()].map((m) => [m.replica, m.role]));

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

  it('resolves a three-admin cycle by rank and keeps the admins it does not cut', () => {
    const v = fold([
      admit(A, 2, 100, B, 'admin'),
      admit(A, 3, 110, C, 'admin'),
      revoke(A, 4, 300, B, 1),
      revoke(B, 2, 300, C, 1),
      revoke(C, 2, 300, A, 3),
    ]);
    expect(roles(v)).toEqual({ [A]: 'admin', [C]: 'admin' });
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

  it('pauses on an action or rv this build cannot read', () => {
    expect(fold([op(A, 2, 100, { action: 'teleport' })]).unknown?.seq).toBe(2);
    expect(fold([admit(A, 2, 100, B, 'member', { rv: 2 })]).unknown?.seq).toBe(
      2
    );
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
});
