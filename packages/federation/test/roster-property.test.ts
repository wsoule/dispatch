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

// The view without the pause and without the hidden ops' own decisions,
// which only a build that reads them can report.
function rosterOf(input: FoldInput, hidden: ReadonlySet<string>): unknown {
  const v = foldRoster(input);
  const resolution = new Map(
    [...v.resolution].filter(([hash]) => !hidden.has(hash))
  );
  const { unknown: _paused, ...rest } = normalize({
    ...v,
    resolution,
  }) as Record<string, unknown>;
  return rest;
}

// An older build that cannot read `hidden` must pause or reach the newer one's
// roster; returns whether it reached one to compare.
function agrees(input: FoldInput, hidden: ReadonlySet<string>): boolean {
  const older = {
    ...input,
    ops: input.ops.map((o) => (hidden.has(o.hash) ? unreadable(o) : o)),
  };
  if (foldRoster(older).unknown !== null) return false;
  expect(rosterOf(older, hidden)).toEqual(rosterOf(input, hidden));
  return true;
}

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

// One random roster op by `by`: an admission, a promotion, a removal of any
// kind (its own or another's), a recover, an invite or a dismiss.
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
  if (k < 0.9)
    return {
      action: 'invite',
      id: `i-${by}-${earlier.length}`,
      pub: 'P',
      handle: handleOf(by),
      expires: '2026-10-03T00:00:00.000Z',
    };
  const named = pick(earlier);
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
      dismisses > 0 && rand() < dismisses
        ? ops[Math.floor(rand() * ops.length)]
        : undefined;
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
  // The founder dismisses a few ops, so hiding them need not pause.
  for (let n = Math.floor(rand() * 4); n > 0; n--) {
    const named = ops[1 + Math.floor(rand() * (ops.length - 1))] ?? found;
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

describe('an older build that cannot read some ops pauses or agrees with a newer one', () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, () => {
      for (const o of scenario.input.ops.slice(1))
        agrees(scenario.input, new Set([o.hash]));
    });
  }

  it('on random rosters, hiding random ops and the ops dismisses name', () => {
    let compared = 0;
    for (let seed = 1; seed <= 600; seed++) {
      const rand = mulberry32(seed);
      const input = randomRoster(rand);
      const rest = input.ops.slice(1);
      const founding = input.ops[0]?.hash;
      const named = input.ops
        .flatMap((o) =>
          'hash' in o.body && o.body.hash !== founding ? [o.body.hash] : []
        )
        .filter((hash) => rest.some((o) => o.hash === hash));
      const hideSets = [
        rest.filter(() => rand() < 0.2).map((o) => o.hash),
        named.filter(() => rand() < 0.7),
        rest.filter((o) => o.seq > 2 && rand() < 0.5).map((o) => o.hash),
      ];
      for (const hidden of hideSets)
        if (hidden.length > 0 && agrees(input, new Set(hidden))) compared++;
    }
    // Enough older folds must not pause for the agreement to be tested.
    expect(compared).toBeGreaterThan(200);
  });
});

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

// The roster, less the dismissal of `gone`, which names nothing once it is gone.
function withoutOp(input: FoldInput, gone: RosterOpRef): unknown {
  const v = foldRoster(input);
  const dismissed = v.dismissed.filter((d) => d.hash !== gone.hash);
  const { unknown: _paused, ...rest } = normalize({
    ...v,
    dismissed,
  }) as Record<string, unknown>;
  return rest;
}

describe('a dismiss the fold ignores', () => {
  it('changes no roster on random rosters dense with dismisses', () => {
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
        expect({ seed, d: d.hash, roster: withoutOp(without, d) }).toEqual({
          seed,
          d: d.hash,
          roster: withoutOp(input, d),
        });
      }
    }
    // Enough ignored dismisses must turn up for the check to mean something.
    expect(checked).toBeGreaterThan(1000);
  }, 120_000);
});
