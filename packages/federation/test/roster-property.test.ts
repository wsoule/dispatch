import {
  ed25519FromSeed,
  sha256Hex,
  signText,
  TAG,
} from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { normalize, SCENARIOS } from '../scripts/roster-vectors.js';
import { foldRoster } from '../src/roster.js';
import type { FoldInput, KeyInfo, RosterOpRef } from '../src/roster.js';

// A seeded PRNG, so a failure reproduces from its seed.
function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('the fold ignores arrival order and duplicates', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      const expected = normalize(foldRoster(scenario.input));
      for (let seed = 1; seed <= 200; seed++) {
        const rand = mulberry32(seed);
        const ops = [...scenario.input.ops];
        for (let i = ops.length - 1; i > 0; i--) {
          const j = Math.floor(rand() * (i + 1));
          const tmp = ops[i];
          ops[i] = ops[j];
          ops[j] = tmp;
        }
        const dup = ops[Math.floor(rand() * ops.length)];
        if (dup !== undefined) ops.push(dup);
        expect(normalize(foldRoster({ ...scenario.input, ops }))).toEqual(
          expected
        );
      }
    });
  }
});

// The same op, as a build that does not know its rv reads it.
const unreadable = (o: RosterOpRef): RosterOpRef => ({
  ...o,
  body: { ...o.body, rv: 2 } as unknown as RosterBody,
});

const REPLICAS = [
  'ada-0000000a',
  'bob-0000000b',
  'cy-0000000c',
  'dee-0000000d',
  'bob-0000000f',
  'ada-0000000e',
  'eve-00000011',
] as const;
const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const RECOVERY = ed25519FromSeed(Buffer.alloc(32, 7));
const handleOf = (r: string) => r.slice(0, r.lastIndexOf('-'));
const keys = new Map<string, KeyInfo>(
  REPLICAS.map((r) => [
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

// An earlier op for a dismiss to name, often one no build reads.
function pickNamed(
  rand: () => number,
  earlier: readonly RosterOpRef[]
): RosterOpRef {
  const unread = earlier.filter((o) => (o.body as { rv: unknown }).rv !== 1);
  const from = unread.length > 0 && rand() < 0.6 ? unread : earlier;
  return from[Math.floor(rand() * from.length)];
}

// One random roster op by `by`: an admission, a promotion, a removal of any
// kind (its own or another's), a recover, an invite, an op no build reads or
// a dismiss.
function randomBody(
  rand: () => number,
  by: string,
  teamId: string,
  earlier: readonly RosterOpRef[]
): Record<string, unknown> {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const target = pick(REPLICAS.slice(1));
  const afterSeq = 1 + Math.floor(rand() * 3);
  const cut = { afterSeq, afterHash: `h-${target}-${afterSeq}` };
  const k = rand();
  if (k < 0.3)
    return {
      action: 'admit',
      replica: target,
      handle: handleOf(target),
      role: rand() < 0.5 ? 'admin' : 'member',
      fingerprint: `FP-${target}`,
      ...(rand() < 0.1 ? { hosts: ['zed'] } : {}),
    };
  if (k < 0.4) return { action: 'role', replica: target, role: 'admin' };
  const who = rand() < 0.25 ? by : target;
  if (k < 0.5) return { action: 'role', replica: who, role: 'member', ...cut };
  if (k < 0.7) return { action: 'revoke', replica: who, reason: 'x', ...cut };
  if (k < 0.78)
    return {
      action: 'recover',
      proof: signText(
        RECOVERY.signPriv,
        `${TAG.recovery}\n${teamId}\n${by}\nsign-${by}`
      ),
    };
  if (k < 0.84) return { action: 'hosts', replica: target, hosts: [], ...cut };
  if (k < 0.88)
    return {
      action: 'invite',
      id: `i-${by}-${earlier.length}`,
      pub: 'P',
      handle: handleOf(by),
      expires: '2026-10-03T00:00:00.000Z',
    };
  if (k < 0.94)
    return { rv: 2, action: 'role', replica: target, role: 'admin' };
  const named = pickNamed(rand, earlier);
  return {
    action: 'dismiss',
    replica: named.replica,
    seq: named.seq,
    hash: named.hash,
  };
}

// A random roster of 6 to 22 ops after the founding, some backdated;
// `dismisses` is an extra share of ops that each dismiss an earlier op.
function randomRoster(rand: () => number, dismisses = 0): FoldInput {
  const found = op(REPLICAS[0], 1, 0, {
    action: 'found',
    name: 'acme',
    legacy: [],
    recoveryPub: RECOVERY.signPub,
  });
  const teamId = found.hash.slice(0, 32);
  const seqs = new Map<string, number>();
  const ops: RosterOpRef[] = [found];
  let t = 50;
  const count = 6 + Math.floor(rand() * 14);
  for (let i = 0; i < count; i++) {
    const by = REPLICAS[Math.floor(rand() * REPLICAS.length)] ?? REPLICAS[0];
    const seq = (seqs.get(by) ?? 1) + 1;
    seqs.set(by, seq);
    t += Math.floor(rand() * 20);
    const ms = rand() < 0.15 ? Math.floor(rand() * t) : t;
    const named =
      dismisses > 0 && rand() < dismisses ? pickNamed(rand, ops) : undefined;
    const body =
      named === undefined
        ? randomBody(rand, by, teamId, ops)
        : {
            action: 'dismiss',
            replica: named.replica,
            seq: named.seq,
            hash: named.hash,
          };
    ops.push(op(by, seq, ms, body));
  }
  // The founder dismisses a few ops.
  for (let n = Math.floor(rand() * 4); n > 0; n--) {
    const named = pickNamed(rand, ops.slice(1));
    const seq = (seqs.get(REPLICAS[0]) ?? 1) + 1;
    seqs.set(REPLICAS[0], seq);
    t += Math.floor(rand() * 20);
    ops.push(
      op(REPLICAS[0], seq, t, {
        action: 'dismiss',
        replica: named.replica,
        seq: named.seq,
        hash: named.hash,
      })
    );
  }
  return {
    founder: { replica: REPLICAS[0], seq: 1 },
    ops,
    keys,
    now: new Date(T0 + 24 * 60 * 60 * 1000),
    licensePublicKey: null,
  };
}

describe('a dismiss from a replica that is never an admin', () => {
  const OUTSIDER = 'zed-00000012';
  const withOutsider = new Map(keys).set(OUTSIDER, {
    replica: OUTSIDER,
    handle: handleOf(OUTSIDER),
    signPub: `sign-${OUTSIDER}`,
    fingerprint: `FP-${OUTSIDER}`,
  });
  // Seeds rotate the outsider through pending, a plain member and a revoked one.
  function outsiderOps(seed: number): RosterOpRef[] {
    const founder = REPLICAS[0];
    const admitted = op(founder, 1000, 1, {
      action: 'admit',
      replica: OUTSIDER,
      handle: handleOf(OUTSIDER),
      role: 'member',
      fingerprint: `FP-${OUTSIDER}`,
    });
    const revoked = op(founder, 1001, 2, {
      action: 'revoke',
      replica: OUTSIDER,
      afterSeq: 1,
      afterHash: 'h',
      reason: 'x',
    });
    return [[], [admitted], [admitted, revoked]][seed % 3] ?? [];
  }

  it('changes nothing on random rosters, the pause included, whatever op it names', () => {
    for (let seed = 1; seed <= 1200; seed++) {
      const rand = mulberry32(seed);
      const roster = randomRoster(rand, seed % 2 === 0 ? 0.3 : 0);
      // The ops dismisses name are unreadable, so a dismiss can lift a pause.
      const named = new Set(
        roster.ops.flatMap((o) => ('hash' in o.body ? [o.body.hash] : []))
      );
      const ops = roster.ops.map((o, i) =>
        i > 0 && named.has(o.hash) ? unreadable(o) : o
      );
      const input = {
        ...roster,
        ops: [...ops, ...outsiderOps(seed)],
        keys: withOutsider,
      };
      const rest = roster.ops.slice(1);
      const target = rest[Math.floor(rand() * rest.length)];
      if (target === undefined) continue;
      const dismiss = op(OUTSIDER, 2, 50 + Math.floor(rand() * 400), {
        action: 'dismiss',
        replica: target.replica,
        seq: target.seq,
        hash: target.hash,
      });
      expect({
        seed,
        view: normalize(foldRoster({ ...input, ops: [...input.ops, dismiss] })),
      }).toEqual({ seed, view: normalize(foldRoster(input)) });
    }
  }, 60_000);
});

// The dismisses a fold ignored, each named by its "may not dismiss" problem.
function ignoredDismisses(input: FoldInput): RosterOpRef[] {
  const subjects = new Set(
    foldRoster(input)
      .problems.filter((p) => p.message.includes(' may not dismiss '))
      .map((p) => p.subject)
  );
  return input.ops.filter(
    (o) =>
      o.body.action === 'dismiss' && subjects.has(`op:${o.replica}:${o.seq}`)
  );
}

describe('a dismiss the fold ignores', () => {
  it('changes no roster and no pause on random rosters dense with dismisses', () => {
    let checked = 0;
    for (let seed = 1; seed <= 1500; seed++) {
      const input = randomRoster(mulberry32(seed), 0.35);
      for (const d of ignoredDismisses(input)) {
        checked++;
        // In its place, a dismiss naming no op, so the publisher's first op stays put.
        const blank = op(d.replica, d.seq, 0, {
          action: 'dismiss',
          replica: d.replica,
          seq: 0,
          hash: 'f'.repeat(64),
        });
        const without = {
          ...input,
          ops: input.ops.map((o) => (o === d ? { ...blank, hlc: d.hlc } : o)),
        };
        expect({
          seed,
          d: d.hash,
          roster: normalize(foldRoster(without)),
        }).toEqual({ seed, d: d.hash, roster: normalize(foldRoster(input)) });
      }
    }
    // Enough ignored dismisses must turn up for the check to mean something.
    expect(checked).toBeGreaterThan(1000);
  }, 120_000);
});

describe('dismisses by admins the winner of a revocation fight outranks', () => {
  // Two standing admins revoke or demote each other past their last ops; the
  // loser or a junior dismisses the counter-move or any op, and the winner and
  // that side then take turns dismissing the other's latest dismiss.
  it('never change who wins the fight, on random rosters', () => {
    let fights = 0;
    for (let seed = 1; seed <= 800; seed++) {
      const rand = mulberry32(seed);
      const input = randomRoster(rand, seed % 3 === 0 ? 0.2 : 0);
      const admins = [...foldRoster(input).members.values()]
        .filter((m) => m.rank !== null)
        .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
        .map((m) => m.replica);
      if (admins.length < 2) continue;
      const i = Math.floor(rand() * admins.length);
      const j =
        (i + 1 + Math.floor(rand() * (admins.length - 1))) % admins.length;
      const winner = admins[Math.min(i, j)] ?? '';
      const loser = admins[Math.max(i, j)] ?? '';
      const juniors = admins.slice(Math.min(i, j) + 1);
      const seqs = new Map<string, number>();
      for (const o of input.ops)
        seqs.set(o.replica, Math.max(seqs.get(o.replica) ?? 1, o.seq));
      const lastOf = (r: string) => seqs.get(r) ?? 1;
      let t =
        Math.max(...input.ops.map((o) => Number(o.hlc.slice(0, 13)))) - T0;
      // The next op by `by`, after every op so far.
      const next = (by: string, body: Record<string, unknown>) => {
        seqs.set(by, lastOf(by) + 1);
        t += 10;
        return op(by, lastOf(by), t, body);
      };
      const demotes = rand() < 0.3;
      const cutOf = (by: string, target: string, afterSeq: number) =>
        next(by, {
          replica: target,
          afterSeq,
          afterHash: 'h',
          ...(demotes
            ? { action: 'role', role: 'member' }
            : { action: 'revoke', reason: 'x' }),
        });
      const lost = (v: ReturnType<typeof foldRoster>) =>
        demotes ? v.members.get(loser)?.role !== 'admin' : v.revoked.has(loser);
      const [afterW, afterL] = [lastOf(winner), lastOf(loser)];
      const first = cutOf(loser, winner, afterW);
      const counter = cutOf(winner, loser, afterL);
      const ops = [...input.ops, first, counter];
      const before = foldRoster({ ...input, ops });
      // Other removals among the random ops can decide the fight first.
      if (before.members.get(winner)?.role !== 'admin' || !lost(before))
        continue;
      fights++;
      let named =
        rand() < 0.5
          ? counter
          : (ops[1 + Math.floor(rand() * (ops.length - 1))] ?? counter);
      const chain: RosterOpRef[] = [];
      for (let n = 0, rounds = 1 + Math.floor(rand() * 4); n < rounds; n++) {
        const junior = juniors[Math.floor(rand() * juniors.length)] ?? loser;
        const by = n % 2 === 1 ? winner : rand() < 0.5 ? loser : junior;
        const d = next(by, {
          action: 'dismiss',
          replica: named.replica,
          seq: named.seq,
          hash: named.hash,
        });
        chain.push(d);
        named = d;
        const after = foldRoster({ ...input, ops: [...ops, ...chain] });
        expect({
          seed,
          n,
          winner: after.members.get(winner)?.role,
          lost: lost(after),
        }).toEqual({ seed, n, winner: 'admin', lost: true });
      }
    }
    // Enough fights must stand for the check to mean something.
    expect(fights).toBeGreaterThan(200);
  }, 120_000);
});
