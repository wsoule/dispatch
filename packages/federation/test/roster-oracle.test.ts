import {
  ed25519FromSeed,
  sha256Hex,
  signText,
  TAG,
} from '@dispatch/protocol/federation';
import type { RosterBody } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRoster, resolutionProbe } from '../src/roster.js';
import type { ResolutionProbe, RosterOpRef } from '../src/roster.js';
import { admit, keysFor, revoke, team } from './rosterOps.js';

// FW-R16's brute-force oracle: every accept/void assignment of the Known(1)
// removals, the grounded, self-consistent ones kept, and the fold's decision
// checked to be the rank-lexicographic one among them.

function mulberry32(seed: number): () => number {
  let a = seed | 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const A = 'ada-0000000a';
const B = 'bo-0000000b';
const C = 'cy-0000000c';
const D = 'di-0000000d';
const M = 'mo-0000000e';
const O = 'obs-0000000f';
const P = 'pat-00000011';
const Q = 'quin-00000013';
const B2 = 'bo-00000014';
const Z = 'zed-00000015';
const X = 'xi-00000016';
const S = 'sy-00000017'; // no pinned key
const [EA, EB, EC, VA, VB, VC, VD, TA] = [
  'ea-00000031',
  'eb-00000032',
  'ec-00000033',
  'va-00000041',
  'vb-00000042',
  'vc-00000043',
  'vd-00000044',
  'ta-00000051',
] as const;
const PINNED = [
  A,
  B,
  C,
  D,
  M,
  O,
  P,
  Q,
  B2,
  Z,
  X,
  EA,
  EB,
  EC,
  VA,
  VB,
  VC,
  VD,
  TA,
];
const u = team(A, keysFor(PINNED));
const teamId = u.found.hash.slice(0, 32);
const T0 = Date.parse('2026-09-26T00:00:00.000Z');
const RECOVERY = ed25519FromSeed(Buffer.alloc(32, 7));
const OTHER = ed25519FromSeed(Buffer.alloc(32, 9));
const handleOf = (r: string): string => r.slice(0, r.lastIndexOf('-'));
const readsNoLaterPair = (): null => null;

// An op whose hash carries `salt`, so twins at one seq differ.
function mkOp(
  replica: string,
  seq: number,
  ms: number,
  body: unknown,
  salt: string
): RosterOpRef {
  return {
    replica,
    seq,
    hlc: `${String(T0 + ms).padStart(13, '0')}.0000.${replica}`,
    hash: sha256Hex(`${replica}:${seq}:${JSON.stringify(body)}:${salt}`),
    body: body as RosterBody,
  };
}

const proofFor = (replica: string, code = RECOVERY): string =>
  signText(
    code.signPriv,
    `${TAG.recovery}\n${teamId}\n${replica}\nsign-${replica}`
  );

// One generator's op builder: a shared clock, per-replica seqs, and admits.
function builder(rand: () => number, step: () => number) {
  const seqs = new Map<string, number>();
  const ops: RosterOpRef[] = [];
  let now = 1;
  let salt = 0;
  const mk = (
    by: string,
    body: unknown,
    ms?: number,
    skip = false
  ): RosterOpRef => {
    const seq = (seqs.get(by) ?? 1) + (skip ? 2 : 1);
    seqs.set(by, seq);
    now += step();
    const o = mkOp(by, seq, ms ?? now, body, String(salt++));
    ops.push(o);
    return o;
  };
  const admitBody = (
    who: string,
    role: string,
    extra: Record<string, unknown> = {}
  ) => ({
    rv: 1,
    action: 'admit',
    replica: who,
    handle: handleOf(who),
    role,
    fingerprint: `FP-${who}`,
    ...extra,
  });
  const cutBody = (revokes: boolean, target: string, afterSeq: number) =>
    revokes
      ? {
          rv: 1,
          action: 'revoke',
          reason: 'r',
          replica: target,
          afterSeq,
          afterHash: `h-${target}-${afterSeq}`,
        }
      : {
          rv: 1,
          action: 'role',
          role: 'member',
          replica: target,
          afterSeq,
          afterHash: `h-${target}-${afterSeq}`,
        };
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const chance = (p: number): boolean => rand() < p;
  return {
    ops,
    seqs,
    mk,
    admitBody,
    cutBody,
    pick,
    chance,
    now: () => now,
  };
}

// Directed hinge chains, depth 3-4: each chain node gets observer or member
// admits from the layer before, then an admin admit, so cuts of earlier
// admitters add first admissions; removals cut just below admits.
function genChain(rand: () => number): RosterOpRef[] {
  const g = builder(rand, () => 1 + Math.floor(rand() * 3));
  const { mk, admitBody, pick, chance } = g;
  const admitOf = (by: string, who: string, role: string, observer = false) =>
    mk(by, admitBody(who, role, observer ? { observer: true } : {}));
  const l0 = [B, C, D, EA, EB, EC].filter(() => chance(0.7)).slice(0, 4);
  if (l0.length < 2) l0.push(B, C);
  const top = [...new Set(l0)];
  for (const r of top) admitOf(A, r, 'admin');
  const chain = [VA, VB, VC, VD, TA].slice(0, chance(0.5) ? 3 : 4);
  let prev = top;
  chain.forEach((n, i) => {
    const parents = [
      ...new Set([
        pick(prev),
        ...(chance(0.6) ? [pick(prev)] : []),
        ...(chance(0.3) ? [pick(top)] : []),
      ]),
    ];
    for (const p of parents)
      admitOf(p, n, chance(0.25) ? 'admin' : 'member', chance(0.75));
    if (chance(0.3)) admitOf(pick(top), n, 'member', true);
    const by = chance(0.6) ? A : pick([...top, ...chain.slice(0, i)]);
    admitOf(by, n, chance(0.85) ? 'admin' : 'member');
    prev = [n];
  });
  if (chance(0.4)) admitOf(chain[0] ?? VA, pick(chain.slice(1)), 'admin');
  if (chance(0.3))
    mk(A, { rv: 1, action: 'role', replica: pick(chain), role: 'admin' });
  const everyone = [...top, ...chain];
  const n = 3 + Math.floor(rand() * 7);
  for (let k = 0; k < n; k++) {
    const by = chance(0.06) ? A : pick(everyone);
    const target = pick(
      [...everyone, ...(chance(0.05) ? [A] : [])].filter((t) => t !== by)
    );
    const own = g.ops.filter((o) => o.replica === target && o.seq > 1);
    const afterSeq =
      own.length > 0 && chance(0.7) ? pick(own).seq - 1 : chance(0.5) ? 1 : 0;
    const ms = chance(0.2)
      ? Math.max(2, g.now() - Math.floor(rand() * 10))
      : undefined;
    mk(by, g.cutBody(chance(0.75), target, afterSeq), ms);
  }
  return g.ops;
}

// Shadow and restore: V is shadowed by k observer admits (k cuts together make
// V an admin, whose observer admit of T shadows T), and a cut of V by T, an
// ally K or a contested K would restore T's right.
function genShadow(rand: () => number): RosterOpRef[] {
  const g = builder(rand, () => 1 + Math.floor(rand() * 2));
  const { mk, admitBody, pick, chance } = g;
  const admitOf = (by: string, who: string, role: string, observer = false) =>
    mk(by, admitBody(who, role, observer ? { observer: true } : {}));
  const cut = (by: string, t: string) => mk(by, g.cutBody(chance(0.8), t, 1));
  const shadows = [EA, EB, EC].slice(0, chance(0.6) ? 2 : 3);
  const [K, K2] = [C, D];
  const bFirst = chance(0.7);
  if (bFirst) admitOf(A, B, 'admin');
  for (const e of shadows) admitOf(A, e, 'admin');
  if (!bFirst) admitOf(A, B, 'admin');
  admitOf(A, K, 'admin');
  if (chance(0.4)) admitOf(A, K2, 'admin');
  for (const e of shadows) admitOf(e, VA, 'member', true);
  admitOf(A, VA, 'admin');
  const deep = chance(0.3);
  if (deep) {
    admitOf(VA, VB, 'member', true);
    admitOf(A, VB, 'admin');
    admitOf(VB, TA, 'member', true);
  } else admitOf(VA, TA, 'member', true);
  admitOf(A, TA, 'admin');
  const cuts: (() => void)[] = shadows.map((e) => () => cut(B, e));
  cuts.push(() => cut(TA, B));
  const restorer = pick([TA, K, K]);
  const target = deep && chance(0.5) ? VB : VA;
  cuts.push(() => cut(restorer, target));
  if (restorer === K && chance(0.7))
    cuts.push(() => cut(chance(0.8) ? B : K2, K));
  if (chance(0.3))
    cuts.push(() =>
      cut(pick([B, K, TA, ...shadows]), pick([B, K, TA, VA, ...shadows]))
    );
  for (const c of chance(0.5) ? cuts : cuts.sort(() => rand() - 0.5)) c();
  return g.ops;
}

type Mode = 'hinge' | 'doom' | 'dense' | 'fights';
const FIGHTERS = [A, B, C, D, P] as const;
const ANYONE = [A, B, C, D, M, O, P, Q, B2, Z, X, S] as const;
const RIGHTLESS = [Z, S, O, M, X, Q] as const;

// Fights among admins over hinge admits, with recovers, promotions, strays,
// observers, a revoked admin's later ops, ops no build reads and dismisses;
// `doom` adds a chain of revocations each cutting the next one's publisher.
function genFight(rand: () => number, mode: Mode): RosterOpRef[] {
  const g = builder(rand, () => 1 + Math.floor(rand() * 7));
  const { ops, seqs, mk, admitBody, pick, chance } = g;
  const hinges = new Map<string, number[]>();
  const later = () =>
    pick([
      { rv: 99, action: 'zap' },
      { rv: 7, action: 'x-garbage' },
      { rv: 2, action: 'role', replica: pick(FIGHTERS), role: 'admin' },
    ]);
  const admitOf = (
    by: string,
    who: string,
    role: string,
    extra: Record<string, unknown> = {}
  ) => mk(by, admitBody(who, role, extra), undefined, chance(0.04));
  const cutOf = (target: string, revokes: boolean) => {
    const cur = seqs.get(target) ?? 1;
    const below = hinges.get(target) ?? [];
    const afterSeq =
      below.length > 0 && chance(0.45)
        ? pick(below) - 1
        : Math.max(0, cur + Math.floor(rand() * 4) - 2);
    return g.cutBody(revokes, target, afterSeq);
  };
  const removal = (by: string, target: string, backdated = false) =>
    mk(
      by,
      cutOf(target, chance(0.62)),
      backdated ? Math.max(1, g.now() - 20) : undefined
    );
  const dismissBy = (by: string) => {
    const odd = ops.filter((o) => (o.body as { rv?: unknown }).rv !== 1);
    const named = odd.length > 0 && chance(0.8) ? pick(odd) : pick(ops);
    if (named === undefined) return;
    const { replica, seq, hash } = named;
    mk(by, { rv: 1, action: 'dismiss', replica, seq, hash });
  };
  if (chance(0.25)) mk(pick([P, Z, S, A, B]), later(), -5000);
  if (chance(0.5)) mk(Q, { rv: 1, action: 'recover', proof: proofFor(Q) });
  const xCut = chance(0.6);
  if (xCut) {
    admitOf(A, X, 'admin');
    if (chance(0.5)) mk(X, later());
    const afterSeq = seqs.get(X) ?? 1;
    mk(A, g.cutBody(true, X, afterSeq));
    if (chance(0.5)) removal(X, pick(FIGHTERS));
  }
  const hingeP = mode === 'hinge' || mode === 'doom' ? 0.75 : 0.4;
  const joined: string[] = [A];
  for (const r of [B, C, D, P].sort(() => rand() - 0.5)) {
    if (r === P && chance(0.2)) continue;
    const by = pick(joined);
    if (by !== A && chance(hingeP)) {
      const first = chance(0.72) ? 'member' : 'admin';
      const h = admitOf(by, r, first);
      hinges.set(by, [...(hinges.get(by) ?? []), h.seq]);
      if (chance(0.88))
        admitOf(
          chance(0.6) ? A : pick(joined.filter((j) => j !== by)),
          r,
          first === 'member' ? 'admin' : 'member'
        );
    } else admitOf(chance(0.7) ? A : by, r, chance(0.8) ? 'admin' : 'member');
    joined.push(r);
  }
  admitOf(pick(joined), M, 'member', { hosts: ['mx', 'my'] });
  if (chance(0.6)) admitOf(A, O, 'member', { observer: true });
  if (chance(0.3)) admitOf(B, B2, 'member');
  if (chance(0.15))
    mk(Z, {
      rv: 1,
      action: 'recover',
      proof: proofFor(Z, chance(0.4) ? OTHER : RECOVERY),
    });
  const n =
    mode === 'dense'
      ? 14 + Math.floor(rand() * 16)
      : 7 + Math.floor(rand() * 12);
  const fightP = mode === 'doom' ? 0.6 : 0.42;
  for (let k = 0; k < n; k++) {
    const by = pick(chance(0.22) ? ANYONE : FIGHTERS);
    const target = pick(FIGHTERS.filter((r) => r !== by));
    if (rand() < fightP) {
      removal(by, mode === 'doom' && chance(0.15) ? by : target, chance(0.08));
      continue;
    }
    const y = rand();
    if (y < 0.15)
      mk(by, {
        rv: 1,
        action: 'hosts',
        replica: M,
        hosts: pick([[], ['mx']]),
        afterSeq: 1,
        afterHash: `h-${M}-1`,
      });
    else if (y < 0.3) mk(by, later());
    else if (y < 0.4) dismissBy(chance(0.65) ? pick(FIGHTERS) : by);
    else if (y < 0.5)
      mk(by, { rv: 1, action: 'role', replica: target, role: 'admin' });
    else if (y < 0.58)
      admitOf(
        by,
        pick([P, B2, Q, Z, O]),
        chance(0.5) ? 'admin' : 'member',
        chance(0.15) ? { observer: true } : {}
      );
    else if (y < 0.64)
      mk(by, {
        rv: 1,
        action: 'recovery-key',
        pub: chance(0.5) ? OTHER.signPub : `pub-${k}`,
      });
    else if (y < 0.7) {
      const w = pick([Q, Z]);
      mk(w, {
        rv: 1,
        action: 'recover',
        proof: proofFor(w, chance(0.4) ? OTHER : RECOVERY),
      });
    } else if (y < 0.85) removal(pick(RIGHTLESS), pick(FIGHTERS));
    else mk(by, { rv: 1, action: 'license', key: `k1-${k}` });
  }
  if (mode === 'doom') {
    const chain = [...FIGHTERS]
      .sort(() => rand() - 0.5)
      .slice(0, 3 + Math.floor(rand() * 3));
    const made: RosterOpRef[] = [];
    for (let i = chain.length - 1; i >= 0; i--) {
      const by = chain[i] ?? A;
      const next = made[made.length - 1];
      if (next === undefined)
        made.push(removal(by, pick(FIGHTERS.filter((f) => f !== by))));
      else
        made.push(
          mk(
            by,
            g.cutBody(
              chance(0.75),
              next.replica,
              next.seq - 1 - (chance(0.3) ? 1 : 0)
            )
          )
        );
    }
    const first = made[0];
    const last = made[made.length - 1];
    if (chance(0.5) && first !== undefined && last !== undefined)
      mk(first.replica, g.cutBody(true, last.replica, last.seq - 1));
  }
  return ops;
}

// The oracle's verdict on one op set: null past 11 removals, else whether any
// assignment is stable and the fold's decision is one no stable set beats.
function oracle(ops: readonly RosterOpRef[]): {
  n: number;
  stable: number;
  decided: number;
  best: number[];
} | null {
  const probe: ResolutionProbe = resolutionProbe(
    u.input(ops),
    readsNoLaterPair
  );
  const n = probe.removals.length;
  if (n > 11) return null;
  const idx = [...Array(n).keys()];
  const bit = (i: number): number => 1 << i;
  const has = (m: number, i: number): boolean => (m & bit(i)) !== 0;
  const folds = Array.from({ length: 1 << n }, (_, m) =>
    probe.under(idx.filter((i) => has(m, i)))
  );
  const had = (m: number, i: number): boolean => folds[m]?.had(i) ?? false;
  const admins = (m: number): number => folds[m]?.admins ?? 0;
  const groundedMemo = new Map<number, boolean>();
  // Some order accepts each removal of m while its publisher holds its right.
  const grounded = (m: number): boolean => {
    const known = groundedMemo.get(m);
    if (known !== undefined) return known;
    const seen = new Set([0]);
    const queue = [0];
    let ok = false;
    for (let g = queue.pop(); g !== undefined; g = queue.pop()) {
      if (g === m) {
        ok = true;
        break;
      }
      for (const r of idx)
        if (has(m, r) && !has(g, r) && had(g, r) && !seen.has(g | bit(r))) {
          seen.add(g | bit(r));
          queue.push(g | bit(r));
        }
    }
    groundedMemo.set(m, ok);
    return ok;
  };
  // A void removal holding its right is excused when accepting it leaves no
  // admin, or cascades until it lacks its right or the rest is ungrounded.
  const excused = (m: number, i: number): boolean => {
    if (admins(m | bit(i)) === 0) return true;
    let cur = m | bit(i);
    for (let changed = true; changed; ) {
      changed = false;
      for (const j of idx)
        if (j !== i && has(cur, j) && !had(cur & ~bit(j), j)) {
          cur &= ~bit(j);
          changed = true;
        }
    }
    return !had(cur & ~bit(i), i) || !grounded(cur);
  };
  const stableSet = (m: number): boolean =>
    admins(m) > 0 &&
    grounded(m) &&
    idx.every((j) => (has(m, j) ? had(m & ~bit(j), j) : true)) &&
    idx.every((i) => has(m, i) || !had(m, i) || excused(m, i));
  const stable = folds.map((_, m) => m).filter(stableSet);
  // m' beats m when the best-ranked removal they differ on, ranked under what
  // both accept, is one m' accepts.
  const beats = (a: number, b: number): boolean => {
    const common = folds[a & b];
    const diff = idx.filter((i) => has(a ^ b, i));
    const top = diff.reduce((x, y) => ((common?.rank(y, x) ?? 0) < 0 ? y : x));
    return has(a, top);
  };
  const best = stable.filter(
    (m) => !stable.some((o) => o !== m && beats(o, m))
  );
  const decided = probe.accepted.reduce((m, i) => m | bit(i), 0);
  return { n, stable: stable.length, decided, best };
}

const GENERATORS: [string, (seed: number) => RosterOpRef[]][] = [
  ['chain', (seed) => genChain(mulberry32(seed * 7919 + 5))],
  ['shadow', (seed) => genShadow(mulberry32(seed * 7919 + 11))],
  ...(['hinge', 'doom', 'dense', 'fights'] as const).map(
    (mode): [string, (seed: number) => RosterOpRef[]] => [
      mode,
      (seed) => genFight(mulberry32(seed * 7919 + 17), mode),
    ]
  ),
];

describe('the resolution against the brute-force oracle', () => {
  for (const [name, gen] of GENERATORS)
    it(`decides the rank-lexicographic stable assignment on ${name} sets`, () => {
      let checked = 0;
      let contested = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const ops = gen(seed);
        const verdict = oracle(ops);
        // With no stable assignment (odd cycles), rank picks decide.
        if (verdict === null || verdict.stable === 0) continue;
        checked++;
        if (verdict.stable > 1) contested++;
        const { decided, best } = verdict;
        expect({ seed, best: best.includes(decided) }).toEqual({
          seed,
          best: true,
        });
        if (best.length === 1)
          expect({ seed, decided }).toEqual({ seed, decided: best[0] });
        // Every decision in the view is the probe's.
        const v = foldRoster(u.input(ops));
        const probe = resolutionProbe(u.input(ops), readsNoLaterPair);
        const view = probe.removals.map((o) => v.resolution.get(o.hash));
        const mine = probe.removals.map((_, i) =>
          (decided & (1 << i)) !== 0 ? 'accepted' : 'void'
        );
        expect({ seed, view }).toEqual({ seed, view: mine });
      }
      // Enough sets must fit the oracle, with a real choice, to mean something.
      expect(checked).toBeGreaterThan(40);
      expect(contested).toBeGreaterThan(name === 'shadow' ? 100 : 5);
    }, 120_000);
});

describe('a component too large to search', () => {
  // 19 admins each revoke the next below its revocation, and the last the
  // first: one cycle no build searches, so a daemon pauses and the relay picks.
  const ring = Array.from(
    { length: 19 },
    (_, i) =>
      `r${String(i).padStart(2, '0')}-${String(i + 100).padStart(8, '0')}`
  );
  const w = team(A, keysFor([A, ...ring]));
  const ops = [
    ...ring.map((r, i) => admit(A, i + 2, i + 1, r, 'admin')),
    ...ring.map((r, i) => revoke(r, 2, 100 + i, ring[(i + 1) % 19] ?? r, 1)),
  ];

  // Rank picks go r00, r02, ... r18, whose cut of r00 leaves r02's removal the
  // first whose publisher stands at it.
  it('pauses applying and names the component', () => {
    const v = w.fold(ops);
    const first = ops[21];
    expect(v.unknown).toEqual({
      hlc: first?.hlc,
      replica: first?.replica,
      seq: first?.seq,
      hash: first?.hash,
    });
    const problem = v.problems.find((p) => p.message.includes('contest'));
    expect(problem?.message).toStartWith('19 removals contest one another');
  });

  it('never pauses the relay, which folds the same roster', () => {
    const relay = w.fold(ops, { relay: true });
    expect(relay.unknown).toBeNull();
    expect([...relay.revoked.keys()].sort()).toEqual(
      [...w.fold(ops).revoked.keys()].sort()
    );
  });

  it('searches one removal fewer', () => {
    expect(w.fold(ops.slice(0, -1)).unknown).toBeNull();
  });

  it('lifts the pause once the founder revokes one publisher below its removal', () => {
    const lifted = w.fold([...ops, revoke(A, 21, 200, ring[5] ?? A, 1)]);
    expect(lifted.unknown).toBeNull();
    expect(lifted.revoked.get(ring[5] ?? A)?.afterSeq).toBe(1);
  });
});
