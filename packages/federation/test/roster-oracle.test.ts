import { ed25519FromSeed, signText, TAG } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRoster } from '../src/roster.js';
import type { FoldInput, RosterOpRef, RosterView } from '../src/roster.js';
import {
  admit,
  demote,
  keysFor,
  op,
  promote,
  revoke,
  team,
} from './rosterOps.js';
import { oracle, PINNED, u } from './rosterOracle.js';

// FW-R18: the resolution as the oracle defines it, on the op sets that told
// the definition and the fold apart, and components too large to search.

const A = 'ada-0000000a';
const B = 'bo-0000000b';
const C = 'cy-0000000c';
const P = 'pat-00000011';
const W = 'ea-00000031';
const Y = 'eb-00000032';
const T0 = Date.parse('2026-09-26T00:00:00.000Z');

// The accepted removals, as replica:seq.
const acceptedOf = (v: RosterView, ops: readonly RosterOpRef[]): string[] =>
  ops
    .filter((o) => v.resolution.get(o.hash) === 'accepted')
    .map((o) => `${o.replica}:${o.seq}`);

// The fold's decision, checked to be the oracle's.
function decisionOf(input: FoldInput): string[] {
  const verdict = oracle(input);
  if (typeof verdict === 'string')
    throw new Error(`oracle skipped: ${verdict}`);
  expect(verdict.decided).toBe(verdict.best ?? -1n);
  return acceptedOf(foldRoster(input), input.ops);
}

// A reviewer's op set, its founding first, keyed as the oracle's team is. A
// recover's proof is stored as `signed-by:RECOVERY` (the team's code, signed
// here) or `signed-by:nobody` (a proof no code verifies).
async function fixture(name: string): Promise<FoldInput> {
  const url = new URL(`fixtures/oracle-${name}.json`, import.meta.url);
  const stored = (await Bun.file(url).json()) as RosterOpRef[];
  const teamId = stored[0]?.hash.slice(0, 32) ?? '';
  const code = ed25519FromSeed(Buffer.alloc(32, 7));
  const ops = stored.map((o) => {
    const b = o.body as unknown as Record<string, unknown>;
    if (b.proof !== 'signed-by:RECOVERY') return o;
    const signed = `${TAG.recovery}\n${teamId}\n${o.replica}\nsign-${o.replica}`;
    const proof = signText(code.signPriv, signed);
    return { ...o, body: { ...o.body, proof } } as RosterOpRef;
  });
  return {
    founder: { replica: A, seq: 1 },
    ops,
    keys: keysFor(PINNED),
    now: new Date(T0 + 24 * 60 * 60 * 1000),
    licensePublicKey: null,
  };
}

describe('the resolution as the oracle defines it', () => {
  // P's member admit of C shadows the founder's admin admit of it; B's cut of
  // the founder, decided up front, drops the promotion that let C cut P first.
  it('grounds a component with the up-front decisions first', () => {
    const ops = [
      admit(A, 2, 10, B, 'admin'),
      admit(A, 3, 20, P, 'admin'),
      admit(P, 2, 30, C, 'member'),
      admit(A, 4, 40, C, 'admin'),
      promote(A, 5, 50, C),
      revoke(C, 2, 60, P, 1),
      demote(C, 3, 70, P, 1),
      revoke(B, 2, 80, A, 4),
    ];
    expect(decisionOf(u.input(ops))).toEqual([`${B}:2`]);
  });

  // Nothing reaches Y, so its cut of W below W's revocation of P stands; no
  // excuse voids an unopposed removal.
  it('accepts a free removal, though C loses the right it rested on', () => {
    const ops = [
      admit(A, 2, 10, W, 'admin'),
      admit(A, 3, 15, Y, 'admin'),
      admit(A, 4, 20, P, 'admin'),
      admit(P, 2, 30, C, 'member'),
      admit(A, 5, 40, C, 'admin'),
      revoke(W, 2, 50, P, 1),
      revoke(C, 2, 60, P, 1),
      demote(C, 3, 70, P, 1),
      revoke(Y, 2, 80, W, 1),
    ];
    expect(decisionOf(u.input(ops))).toEqual([`${Y}:2`]);
  });

  // Each set has two stable assignments, which ranks read under the search's
  // accepted removals, or under what both accept, ordered differently.
  const RANKED: [string, string[]][] = [
    [
      'chain-8905',
      ['vd-00000044:2', 'vd-00000044:3', 'vd-00000044:4', 'vd-00000044:5'],
    ],
    ['mixed-2338', ['cy-0000000c:3', 'cy-0000000c:4', 'di-0000000d:2']],
    ['hinge-7789', ['bo-0000000b:2', 'ada-0000000a:11']],
    [
      'fights-2359',
      [
        'cy-0000000c:2',
        'di-0000000d:2',
        'cy-0000000c:3',
        'ada-0000000a:7',
        'di-0000000d:3',
        'di-0000000d:4',
      ],
    ],
  ];
  for (const [name, accepted] of RANKED)
    it(`reads ranks under the up-front decisions alone (${name})`, async () => {
      expect(decisionOf(await fixture(name))).toEqual(accepted);
    });
});

// One more contested removal than a component search decides.
const RING = 19;
const ringOf = (at: number): string[] =>
  Array.from(
    { length: RING },
    (_, i) =>
      `r${String(i).padStart(2, '0')}-${String(i + at).padStart(8, '0')}`
  );
const contests = (v: RosterView): boolean =>
  v.problems.some((p) => p.message.includes('contest'));

describe('a component too large to search', () => {
  // Each ring admin revokes the next below its revocation, and the last the
  // first: one cycle no build searches.
  const ring = ringOf(100);
  const w = team(A, keysFor([A, ...ring]));
  const cuts = ring.map((r, i) =>
    revoke(r, 2, 100 + i, ring[(i + 1) % RING] ?? r, 1)
  );
  const ops = [
    ...ring.map((r, i) => admit(A, i + 2, i + 1, r, 'admin')),
    ...cuts,
  ];

  // Rank picks go r00, r02, ..., r16, each voiding the next one's cut, then
  // r18, whose cut of r00 stands as FW-R7 has it.
  it('takes the rank fallback and pauses nothing', () => {
    const v = w.fold(ops);
    expect(v.unknown).toBeNull();
    expect(contests(v)).toBe(false);
    expect(acceptedOf(v, cuts)).toEqual(
      cuts.filter((_, i) => i % 2 === 0).map((o) => `${o.replica}:2`)
    );
    expect([...v.revoked.keys()].sort()).toEqual(
      ring.filter((_, i) => i % 2 === 1 || i === 0).sort()
    );
  });

  it('decides the same on the relay', () => {
    const relay = w.fold(ops, { relay: true });
    expect(relay.unknown).toBeNull();
    expect(relay.resolution).toEqual(w.fold(ops).resolution);
  });

  // M's devices share its handle, so each may revoke the next.
  it('never pauses on a ring of member devices', () => {
    const M = 'mo-0000000e';
    const devices = ringOf(0xd00).map((r) => `mo-${r.slice(-8)}`);
    const m = team(A, keysFor([A, M, ...devices]));
    const v = m.fold([
      admit(A, 2, 1, M, 'member'),
      ...devices.map((d, i) => admit(M, i + 2, 10 + i, d, 'member')),
      ...devices.map((d, i) =>
        revoke(d, 2, 100 + i, devices[(i + 1) % RING] ?? d, 1)
      ),
    ]);
    expect(v.unknown).toBeNull();
    expect(contests(v)).toBe(false);
    expect(v.revoked.size).toBe(10);
  });
});

describe('a component too large to search whose publishers all fall', () => {
  // G admits the ring; the last ring admin's second removal revokes G below
  // those admits, so no publisher in the component stands in the result.
  const G = 'gee-00000200';
  const ring = ringOf(300);
  const w = team(A, keysFor([A, G, ...ring]));
  const last = ring[RING - 1] ?? A;
  const ops = [
    admit(A, 2, 1, G, 'admin'),
    ...ring.map((r, i) => admit(G, i + 2, i + 2, r, 'admin')),
    ...ring.map((r, i) => revoke(r, 2, 100 + i, ring[(i + 1) % RING] ?? r, 1)),
    revoke(last, 3, 200, G, 1),
  ];

  it('pauses nothing', () => {
    const v = w.fold(ops);
    expect(v.unknown).toBeNull();
    expect(v.revoked.get(G)?.afterSeq).toBe(1);
    expect(ring.filter((r) => v.members.has(r))).toEqual([]);
    expect(contests(v)).toBe(false);
  });
});

describe('a hostile admin contesting more removals than a search decides', () => {
  // H revokes the founder and X and pads its fight with 17 more removals of
  // them; the founder's revocation of H below them joins one component.
  const H = 'hal-000000aa';
  const X = 'xen-000000bb';
  const Y2 = 'yu-000000cc';
  const R = 'rex-000000dd';
  const w = team(A, keysFor([A, H, X, Y2, R]));
  const rotate = (by: string, seq: number, ms: number): RosterOpRef =>
    op(by, seq, ms, {
      action: 'recovery-key',
      pub: ed25519FromSeed(Buffer.alloc(32, 3)).signPub,
    });
  // With `rotates`, H first rotates the recovery code, which its cut voids.
  const hostile = (rotates: boolean): RosterOpRef[] => {
    const at = rotates ? 3 : 2;
    const pad = Array.from({ length: 17 }, (_, k) =>
      k % 2 === 1
        ? demote(H, at + 2 + k, 12 + k, X, 0)
        : revoke(H, at + 2 + k, 12 + k, A, 0)
    );
    return [
      admit(A, 2, 1, H, 'admin'),
      admit(A, 3, 2, X, 'admin'),
      ...(rotates ? [rotate(H, 2, 5)] : []),
      revoke(H, at, 10, A, 3),
      revoke(H, at + 1, 11, X, 1),
      ...pad,
      revoke(A, 4, 50, H, 1),
    ];
  };

  for (const rotates of [false, true])
    it(`lets the founder win${rotates ? ' past a rotated code' : ''}, at every level and on the relay`, () => {
      const base = hostile(rotates);
      const sets: [string, RosterOpRef[], string[]][] = [
        ['alone', base, [A, X]],
        ['X revokes H too', [...base, revoke(X, 2, 51, H, 1)], [A, X]],
        ['the founder demotes H', [...base, demote(A, 5, 52, H, 1)], [A, X]],
        [
          'Y admitted revokes H',
          [...base, admit(A, 5, 60, Y2, 'admin'), revoke(Y2, 2, 61, H, 1)],
          [A, X, Y2],
        ],
        [
          'R recovered revokes H',
          [...base, w.recover(R, 2, 60), revoke(R, 3, 61, H, 1)],
          [A, X, R],
        ],
        [
          'R recovers past the founder rotating the code',
          [
            ...base,
            rotate(A, 5, 59),
            w.recover(R, 2, 60),
            revoke(R, 3, 61, H, 1),
          ],
          [A, X],
        ],
      ];
      for (const [name, ops, admins] of sets)
        for (const level of [1, 2, 3, 4])
          for (const relay of [false, true]) {
            const v = w.at(level, ops, { relay });
            expect({
              name,
              level,
              relay,
              unknown: v.unknown,
              contests: contests(v),
              admins: [...v.members.values()]
                .filter((m) => m.role === 'admin')
                .map((m) => m.replica),
              revoked: [...v.revoked.keys()],
            }).toEqual({
              name,
              level,
              relay,
              unknown: null,
              contests: false,
              admins,
              revoked: [H],
            });
          }
    });
});
