import { ed25519FromSeed, signText, TAG } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRosterAt, KNOWN_ROSTER_PAIRS } from '../src/roster.js';
import type { LaterPairs, RosterOpRef, RosterView } from '../src/roster.js';
import { licenseFor, testKeys } from './licenseKeys.js';
import {
  admit,
  demote,
  dismiss,
  handleOf,
  junk,
  keysFor,
  LEVELS,
  op,
  pausedAt,
  revoke,
  rosterOf,
  standingOf,
  team,
} from './rosterOps.js';

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

const A = 'ada-0000000a';
const MEMBERS = ['bo-0000000b', 'cy-0000000c', 'di-0000000d'] as const;
const O = 'obs-0000000f';
const P = 'pat-00000011'; // pinned but admitted only when a run admits it
const Q = 'quin-00000013'; // a recovering machine
const M = 'mo-0000000e'; // a hosts cut's target
const ALL = [A, ...MEMBERS, O, P, Q] as const;
const t = team(A, keysFor([...ALL, M]));
const OTHER = ed25519FromSeed(Buffer.alloc(32, 9));
const WRONG = ed25519FromSeed(Buffer.alloc(32, 13));

// An op body's (action, rv), or null when it has none.
function pairOf(body: unknown): string | null {
  const b = body as Record<string, unknown>;
  if (!Number.isInteger(b.rv) || typeof b.action !== 'string') return null;
  return `${b.action}@${String(b.rv)}`;
}
const outsideKnown = (o: RosterOpRef): boolean =>
  !KNOWN_ROSTER_PAIRS.has(pairOf(o.body) ?? '');

// Every pair the level table reads, and pairs no level reads, most of them
// shaped as rights.
const TABLE_PAIRS = [...LEVELS.values()].flat();
const UNREAD_PAIRS = [
  'found@2',
  'recover@2',
  'dismiss@2',
  'close-legacy@2',
  'x-garbage@7',
];
// Level 1 reads Known(1) alone; the table's highest level reads every pair in it.
const AT = [1, ...LEVELS.keys()];
const TOP = Math.max(...AT);

// A random op set on one shared clock, some ops backdated, drawing on every
// pair the table reads; with `fights`, mostly removals among the admins.
function randomOps(rand: () => number, fights: boolean): RosterOpRef[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const seqs = new Map<string, number>(ALL.map((r) => [r, 1]));
  let now = 0;
  const ops: RosterOpRef[] = [];
  const mk = (replica: string, body: Record<string, unknown>) => {
    const seq = (seqs.get(replica) ?? 1) + 1;
    seqs.set(replica, seq);
    now += 1 + Math.floor(rand() * 40);
    const at = rand();
    let ms = now;
    if (at < 0.03) ms = -5000 - Math.floor(rand() * 100);
    else if (at < 0.18) ms = 1 + Math.floor(rand() * now);
    const o = op(replica, seq, ms, body);
    ops.push(o);
    return o;
  };
  const cut = (target: string) => {
    const afterSeq = Math.max(
      1,
      (seqs.get(target) ?? 1) - Math.floor(rand() * 2)
    );
    return { replica: target, afterSeq, afterHash: `h-${target}-${afterSeq}` };
  };
  const named = () => {
    const odd = ops.filter(outsideKnown);
    const o =
      odd.length > 0 && rand() < 0.85
        ? pick(odd)
        : pick(ops.length > 0 ? ops : [t.found]);
    return { replica: o.replica, seq: o.seq, hash: o.hash };
  };
  // The fields a Known(1) op of `action` carries, so a later pair of that
  // action reads with the shape of a right.
  const fieldsOf = (
    action: string,
    by: string,
    target: string,
    k: number
  ): Record<string, unknown> => {
    switch (action) {
      case 'found':
        return { name: 'evil', legacy: [], recoveryPub: OTHER.signPub };
      case 'admit': {
        const r = rand() < 0.5 ? P : target;
        const role = pick(['member', 'admin']);
        return {
          replica: r,
          handle: handleOf(r),
          role,
          fingerprint: `FP-${r}`,
        };
      }
      case 'revoke':
        return { reason: 'r', ...cut(target) };
      case 'role':
        return rand() < 0.5
          ? { replica: target, role: 'admin' }
          : { role: 'member', ...cut(target) };
      case 'hosts':
        return {
          replica: target,
          hosts: pick([[], [`h${k}`], [`${handleOf(target)}-x`]]),
          ...(rand() < 0.5 ? cut(target) : {}),
        };
      case 'close-legacy':
        return { entries: [] };
      case 'license':
        return { key: `k-${k}` };
      case 'invite':
        return {
          id: `i-${k}`,
          pub: 'p',
          handle: handleOf(by),
          expires: '2027-01-01T00:00:00.000Z',
        };
      case 'recover':
        return { proof: (t.recover(by, 0, 0).body as { proof: string }).proof };
      case 'recovery-key':
        return { pub: OTHER.signPub };
      case 'dismiss':
        return named();
      case 'transport':
        return { kind: 'relay', url: `u-${k}` };
      default:
        return { text: 'n' };
    }
  };
  const pairOp = (pair: string, by: string, target: string, k: number) => {
    const at = pair.lastIndexOf('@');
    const action = pair.slice(0, at);
    const rv = Number(pair.slice(at + 1));
    mk(by, { ...fieldsOf(action, by, target, k), rv, action });
  };
  if (rand() < 0.15) {
    const seq = (seqs.get(P) ?? 1) + 1;
    seqs.set(P, seq);
    ops.push(op(P, seq, -5000, { rv: 7, action: 'x-garbage' }));
  }
  if (rand() < 0.1) mk(Q, { rv: 7, action: 'x-garbage' });
  if (rand() < 0.3) {
    const seq = (seqs.get(Q) ?? 1) + 1;
    seqs.set(Q, seq);
    const o = t.recover(Q, seq, 5 + Math.floor(rand() * 200));
    ops.push(o);
  }
  for (const r of MEMBERS)
    mk(A, {
      action: 'admit',
      replica: r,
      handle: handleOf(r),
      role: rand() < 0.6 ? 'admin' : 'member',
      fingerprint: `FP-${r}`,
      ...(rand() < 0.4
        ? { hosts: [`${handleOf(r)}-x`, `${handleOf(r)}-y`] }
        : {}),
    });
  if (rand() < 0.5)
    mk(A, {
      action: 'admit',
      replica: O,
      handle: handleOf(O),
      role: 'member',
      observer: true,
      fingerprint: `FP-${O}`,
    });
  const n = 4 + Math.floor(rand() * 12);
  for (let k = 0; k < n; k++) {
    const pool = fights ? [A, ...MEMBERS] : ALL;
    const by = pick(pool);
    const target = pick(pool.filter((x) => x !== by));
    const x = rand();
    if (x < (fights ? 0.45 : 0.12)) {
      if (rand() < 0.7)
        mk(by, { action: 'revoke', reason: 'r', ...cut(target) });
      else mk(by, { action: 'role', role: 'member', ...cut(target) });
    } else if (x < (fights ? 0.75 : 0.5))
      pairOp(
        rand() < 0.7 ? pick(TABLE_PAIRS) : pick(UNREAD_PAIRS),
        by,
        target,
        k
      );
    else if (x < (fights ? 0.8 : 0.6))
      mk(by, { action: 'role', replica: target, role: 'admin' });
    else if (x < (fights ? 0.82 : 0.7))
      pairOp(
        pick(['license@1', 'transport@1', 'invite@1', 'hosts@1']),
        by,
        target,
        k
      );
    else if (x < (fights ? 0.84 : 0.73))
      mk(by, { action: 'recovery-key', pub: OTHER.signPub });
    else if (x < (fights ? 0.86 : 0.76))
      mk(A, {
        action: 'admit',
        replica: P,
        handle: handleOf(P),
        role: pick(['member', 'admin']),
        fingerprint: `FP-${P}`,
      });
    else if (x < (fights ? 0.88 : 0.8))
      mk(by, { rv: '1', action: 'admit', replica: target });
    else mk(by, { action: 'dismiss', ...named() });
  }
  return ops;
}

function shuffled<T>(rand: () => number, xs: readonly T[]): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

// Hinge chains: removals cut an admitter just below its admit of a replica, so
// that replica's second admit counts; later hosts cuts and dismisses ride along.
function hingeOps(rand: () => number): RosterOpRef[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const seqs = new Map<string, number>();
  const hinges = new Map<string, number[]>();
  let now = 5;
  const ops: RosterOpRef[] = [];
  const mk = (by: string, body: Record<string, unknown>): RosterOpRef => {
    const seq = (seqs.get(by) ?? 1) + 1;
    seqs.set(by, seq);
    now += 1 + Math.floor(rand() * 6);
    const o = op(by, seq, now, body);
    ops.push(o);
    return o;
  };
  const admitOf = (
    r: string,
    role: string,
    extra: Record<string, unknown> = {}
  ) => ({
    action: 'admit',
    replica: r,
    handle: handleOf(r),
    role,
    fingerprint: `FP-${r}`,
    ...extra,
  });
  const joined: string[] = [A];
  for (const r of shuffled(rand, [...MEMBERS, P])) {
    const by = pick(joined);
    if (by !== A && rand() < 0.75) {
      const first = rand() < 0.7 ? 'member' : 'admin';
      const hinge = mk(by, admitOf(r, first));
      hinges.set(by, [...(hinges.get(by) ?? []), hinge.seq]);
      mk(A, admitOf(r, first === 'member' ? 'admin' : 'member'));
    } else mk(A, admitOf(r, rand() < 0.8 ? 'admin' : 'member'));
    joined.push(r);
  }
  mk(A, admitOf(M, 'member', { hosts: ['mx', 'my'] }));
  const n = 5 + Math.floor(rand() * 9);
  for (let k = 0; k < n; k++) {
    const by = pick(joined);
    const x = rand();
    const odd = ops.filter(outsideKnown);
    if (x < 0.3)
      mk(by, {
        rv: 2,
        action: 'hosts',
        replica: M,
        hosts: rand() < 0.5 ? [] : ['mx'],
        afterSeq: 1,
        afterHash: `h-${M}-1`,
      });
    else if (x < 0.36 && odd.length > 0) {
      const o = pick(odd);
      mk(pick([...joined, Q]), {
        action: 'dismiss',
        replica: o.replica,
        seq: o.seq,
        hash: o.hash,
      });
    } else {
      const target = pick(joined.filter((r) => r !== by));
      const below = hinges.get(target) ?? [];
      const afterSeq =
        below.length > 0 && rand() < 0.7
          ? pick(below) - 1
          : Math.max(1, (seqs.get(target) ?? 1) + Math.floor(rand() * 3) - 1);
      const cut = {
        replica: target,
        afterSeq,
        afterHash: `h-${target}-${afterSeq}`,
      };
      if (rand() < 0.65) mk(by, { action: 'revoke', reason: 'r', ...cut });
      else mk(by, { action: 'role', role: 'member', ...cut });
    }
  }
  return ops;
}

// Each seed's op set: every fourth a fight among admins, every fourth a hinge
// chain, the rest mixed.
function opsFor(seed: number, rand: () => number): RosterOpRef[] {
  if (seed % 4 === 2) return hingeOps(rand);
  return randomOps(rand, seed % 4 === 0);
}

// A view as every level must agree on it: less problems, the pause, and the
// removals only a level that reads them decides.
function agreed(v: RosterView, known: ReadonlySet<string>): unknown {
  const r = rosterOf(v) as { resolution: [string, unknown][] };
  return {
    ...r,
    resolution: r.resolution.filter(([hash]) => known.has(hash)),
  };
}

// A dismiss that names no op, in the dismiss's own place.
const blank = (o: RosterOpRef): RosterOpRef =>
  o.body.action === 'dismiss'
    ? {
        ...o,
        body: {
          rv: 1,
          action: 'dismiss',
          replica: o.replica,
          seq: 0,
          hash: 'f'.repeat(64),
        },
      }
    : o;

const SEEDS = 700;

// All accepted, these removals leave no admin; P's revoke of B is what makes C
// an admin, so voiding it voids C's revoke of the founder too.
const NO_ADMIN_LEFT = (() => {
  const [B, C, D] = MEMBERS;
  return [
    admit(A, 2, 5, M, 'member', { hosts: ['mx', 'my'] }),
    admit(A, 3, 10, B, 'admin'),
    admit(B, 2, 20, C, 'member'),
    admit(A, 4, 30, C, 'admin'),
    revoke(C, 2, 35, A, 8),
    admit(C, 3, 40, D, 'admin'),
    admit(A, 5, 45, P, 'admin'),
    revoke(P, 2, 50, B, 1),
    revoke(A, 6, 70, P, 2),
    demote(A, 7, 75, D, 2),
    revoke(A, 8, 80, C, 3),
  ];
})();

// Admins by rank, members, and each revoked replica's cut.
function summary(v: RosterView) {
  const all = [...v.members.values()];
  return {
    admins: all
      .filter((m) => m.rank !== null)
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .map((m) => m.replica),
    members: all.filter((m) => m.rank === null).map((m) => m.replica),
    revoked: [...v.revoked]
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([r, c]) => [r, c.afterSeq]),
  };
}

describe('the level table', () => {
  it('keeps Known(1) verbatim', () => {
    expect([...KNOWN_ROSTER_PAIRS]).toEqual([
      'found@1',
      'admit@1',
      'revoke@1',
      'role@1',
      'hosts@1',
      'close-legacy@1',
      'license@1',
      'invite@1',
      'recover@1',
      'recovery-key@1',
      'dismiss@1',
      'transport@1',
    ]);
  });

  it('folds the same roster in any order and with duplicates, at every level', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = mulberry32(seed);
      const ops = opsFor(seed, rand);
      for (const level of AT) {
        const v = t.at(level, ops);
        const again = t.at(level, [
          ...shuffled(rand, ops),
          ops[Math.floor(rand() * ops.length)],
        ]);
        expect({ seed, level, v: rosterOf(again), p: again.unknown }).toEqual({
          seed,
          level,
          v: rosterOf(v),
          p: v.unknown,
        });
      }
    }
  }, 120_000);

  it('has a lower level either pause or fold what the highest level folds', () => {
    let compared = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = opsFor(seed, mulberry32(seed));
      const known = new Set(
        [t.found, ...ops].filter((o) => !outsideKnown(o)).map((o) => o.hash)
      );
      const top = t.at(TOP, ops);
      for (const level of AT.filter((l) => l < TOP)) {
        const low = t.at(level, ops);
        if (low.unknown !== null) continue;
        compared++;
        expect({ seed, level, paused: top.unknown }).toEqual({
          seed,
          level,
          paused: null,
        });
        expect({ seed, level, v: agreed(low, known) }).toEqual({
          seed,
          level,
          v: agreed(top, known),
        });
      }
    }
    // Enough lower folds must not pause for the agreement to mean something.
    expect(compared).toBeGreaterThan(SEEDS / 2);
  }, 120_000);

  it('lets no op outside Known(1) decide admission, handles, roles, ranks, revocations or the recovery key', () => {
    let removed = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const rand = mulberry32(seed);
      const ops = opsFor(seed, rand);
      const outside = ops.filter(outsideKnown);
      const drops = [
        outside,
        ...shuffled(rand, outside)
          .slice(0, 3)
          .map((o) => [o]),
      ];
      for (const level of AT) {
        const standing = standingOf(t.at(level, ops));
        for (const drop of drops) {
          if (drop.length === 0) continue;
          removed++;
          const rest = ops.filter((o) => !drop.includes(o));
          expect({
            seed,
            level,
            drop: drop.map((o) => o.hash),
            s: standingOf(t.at(level, rest)),
          }).toEqual({
            seed,
            level,
            drop: drop.map((o) => o.hash),
            s: standing,
          });
        }
      }
    }
    expect(removed).toBeGreaterThan(SEEDS * 3);
  }, 120_000);

  it('lets no dismiss, valid or not, change a right, rank or revocation, at any level', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = opsFor(seed, mulberry32(seed));
      for (const level of AT)
        expect({
          seed,
          level,
          s: standingOf(t.at(level, ops.map(blank))),
        }).toEqual({
          seed,
          level,
          s: standingOf(t.at(level, ops)),
        });
    }
  }, 120_000);

  it('accepts no removal that lacks its right in the final fold, unless it won a fight', () => {
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = opsFor(seed, mulberry32(seed));
      for (const level of AT)
        expect({ seed, level, unfounded: t.unfounded(level, ops) }).toEqual({
          seed,
          level,
          unfounded: [],
        });
    }
  }, 120_000);

  it('never pauses the relay, which folds what a daemon at its level folds', () => {
    for (let seed = 1; seed <= SEEDS; seed += 3) {
      const ops = opsFor(seed, mulberry32(seed));
      for (const level of AT) {
        const relay = t.at(level, ops, { relay: true });
        expect({ seed, level, paused: relay.unknown }).toEqual({
          seed,
          level,
          paused: null,
        });
        expect(rosterOf(relay)).toEqual(rosterOf(t.at(level, ops)));
      }
    }
  }, 120_000);

  it('voids a later removal whose publisher lacks its right at it in the final roster', () => {
    const [B, C, D] = MEMBERS;
    // A hosts cut at rv 2, which levels 2 and up read as a removal.
    const cutBy = (
      by: string,
      seq: number,
      ms: number,
      replica = M,
      hosts = ['mx'],
      afterSeq = 1
    ) =>
      op(by, seq, ms, {
        rv: 2,
        action: 'hosts',
        replica,
        hosts,
        afterSeq,
        afterHash: `h-${replica}-${afterSeq}`,
      });
    const cases = [
      {
        // B revokes C below C's cut, amid a fight between B and P.
        later: cutBy(C, 2, 41),
        rest: [
          admit(A, 2, 15, C, 'admin'),
          admit(A, 3, 25, B, 'admin'),
          admit(A, 4, 28, P, 'admin'),
          admit(A, 5, 37, M, 'member', { hosts: ['mx', 'my'] }),
          revoke(B, 2, 47, P, 1),
          revoke(P, 2, 64, B, 1),
          revoke(B, 3, 78, C, 1),
        ],
        target: M,
        hosts: ['mx', 'my'],
        pauses: false,
      },
      {
        // B demotes C below C's cut instead: C still stands at it, so level 1
        // pauses, but lacks the admin right a hosts cut needs.
        later: cutBy(C, 2, 41),
        rest: [
          admit(A, 2, 15, C, 'admin'),
          admit(A, 3, 25, B, 'admin'),
          admit(A, 4, 28, P, 'admin'),
          admit(A, 5, 37, M, 'member', { hosts: ['mx', 'my'] }),
          revoke(B, 2, 47, P, 1),
          revoke(P, 2, 64, B, 1),
          demote(B, 3, 78, C, 1),
        ],
        target: M,
        hosts: ['mx', 'my'],
        pauses: true,
      },
      {
        // The founder's cut, above the revocation that cuts it after seq 3.
        later: cutBy(A, 5, 55),
        rest: [
          admit(A, 2, 14, B, 'admin'),
          admit(A, 4, 50, D, 'admin'),
          admit(B, 2, 27, M),
          revoke(D, 5, 64, B, 1),
          revoke(B, 4, 50, A, 3),
        ],
        target: M,
        hosts: [],
        pauses: false,
      },
      {
        // The founder's cut of B, above D's revocation of it after seq 4,
        // among a fight over C and other later ops.
        later: cutBy(A, 6, 77, B, ['zz'], 3),
        rest: [
          admit(A, 2, 15, B),
          admit(A, 3, 18, C, 'admin'),
          admit(A, 4, 31, D, 'admin'),
          op(A, 5, 69, { rv: 2, action: 'transport', kind: 'relay', url: 'u' }),
          revoke(D, 2, 73, A, 5),
          revoke(D, 3, 74, A, 4),
          op(A, 7, -2000, {
            rv: 2,
            action: 'invite',
            id: 'i-a',
            pub: 'p',
            handle: handleOf(A),
            expires: '2027-01-01T00:00:00.000Z',
          }),
          revoke(D, 4, 112, C, 0),
          cutBy(A, 8, 125, D, [], 3),
          revoke(C, 3, 136, A, 2),
          revoke(A, 9, 143, C, 1),
        ],
        target: B,
        hosts: [],
        pauses: false,
      },
      {
        // With no admin left, P's revoke is voided, and D, the cut's
        // publisher, ends pending.
        later: cutBy(D, 2, 60),
        rest: NO_ADMIN_LEFT,
        target: M,
        hosts: ['mx', 'my'],
        pauses: false,
      },
    ];
    for (const { later, rest, target, hosts, pauses } of cases) {
      const ops = [...rest, later];
      const known = new Set([t.found, ...rest].map((o) => o.hash));
      for (const level of AT) {
        const v = t.at(level, ops);
        expect({
          later: later.hash,
          level,
          paused: v.unknown,
          hosts: v.members.get(target)?.hosts,
          cut: v.resolution.get(later.hash) ?? 'void',
          v: agreed(v, known),
        }).toEqual({
          later: later.hash,
          level,
          paused: pauses && level === 1 ? pausedAt(later) : null,
          hosts,
          cut: 'void',
          v: agreed(t.at(level, rest), known),
        });
      }
    }
  });

  it('never lets a later pair empower a dismiss, whether or not a dismiss names it', () => {
    const [B, C] = MEMBERS;
    // A level that reads a promotion at rv 2 as a right, which is refused.
    const breaking: LaterPairs = (b) =>
      b.action === 'role' && b.rv === 2 ? { ...b, rv: 1 } : null;
    const grant = op(A, 3, 20, {
      rv: 2,
      action: 'role',
      replica: B,
      role: 'admin',
    });
    const byC = op(C, 2, 30, { rv: 7, action: 'x-garbage' });
    const ops = [
      admit(A, 2, 10, B),
      grant,
      admit(A, 4, 25, C),
      byC,
      op(B, 2, 40, {
        action: 'dismiss',
        replica: C,
        seq: 2,
        hash: byC.hash,
      }),
      // A pending replica names the grant, so the base fold leaves it out.
      op(P, 2, 50, {
        action: 'dismiss',
        replica: A,
        seq: 3,
        hash: grant.hash,
      }),
    ];
    for (const set of [ops, ops.slice(0, -1)]) {
      const v = foldRosterAt(t.input(set), breaking);
      expect(v.members.get(B)?.role).toBe('member');
      expect(v.dismissed).toEqual([]);
      expect(v.unknown?.hash).toBe(byC.hash);
    }
  });

  it('refuses a later pair read as a right, so no level lets one decide it', () => {
    const [B, C, D] = MEMBERS;
    // A level that reads every pair at rv 2 as its rv 1 meaning.
    const breaking: LaterPairs = (b) => (b.rv === 2 ? { ...b, rv: 1 } : null);
    const base = [
      admit(A, 2, 10, B, 'admin'),
      admit(A, 3, 20, C, 'admin'),
      admit(A, 4, 25, D),
    ];
    const recover = t.recover(Q, 2, 80);
    const rights = [
      op(A, 5, 30, {
        rv: 2,
        action: 'admit',
        replica: P,
        handle: handleOf(P),
        role: 'admin',
        fingerprint: `FP-${P}`,
      }),
      op(A, 5, 40, { rv: 2, action: 'recovery-key', pub: 'next' }),
      demote(A, 5, 50, B, 1, 2),
      op(C, 2, 60, { rv: 2, action: 'role', replica: D, role: 'admin' }),
      revoke(B, 2, 70, C, 1, 2),
      {
        ...recover,
        body: { ...recover.body, rv: 2 } as unknown as RosterOpRef['body'],
      },
      op(A, 5, 90, {
        rv: 2,
        action: 'found',
        name: 'evil',
        legacy: [],
        recoveryPub: OTHER.signPub,
      }),
    ];
    const expected = rosterOf(t.at(1, base));
    for (const o of rights) {
      const v = foldRosterAt(t.input([...base, o]), breaking);
      expect({ o: o.body.action, v: rosterOf(v) }).toEqual({
        o: o.body.action,
        v: expected,
      });
    }
  });

  it('holds a later pair void at every level wherever its publisher holds no right', () => {
    const [, C, D] = MEMBERS;
    const base = [
      admit(A, 2, 100, O, 'member', { observer: true }),
      admit(A, 3, 110, C, 'admin'),
      revoke(A, 4, 200, C, 1),
      admit(A, 5, 210, D, 'admin'),
    ];
    const inert = [
      // An observer's.
      op(O, 2, 300, {
        rv: 2,
        action: 'invite',
        id: 'i-o',
        pub: 'p',
        handle: handleOf(O),
        expires: '2027-01-01T00:00:00.000Z',
      }),
      op(O, 2, 300, { rv: 99, action: 'zap' }),
      // One above an accepted revocation's cut.
      op(C, 2, 300, {
        rv: 2,
        action: 'transport',
        kind: 'relay',
        url: 'https://evil.test',
      }),
      // A pending replica's.
      op(P, 2, 300, { rv: 2, action: 'license', key: 'k' }),
      // One positioned before the founding, and one before its admission.
      op(D, 2, -5000, { rv: 2, action: 'hosts', replica: D, hosts: ['dx'] }),
      op(D, 2, 150, { rv: 2, action: 'transport', kind: 'relay', url: 'u' }),
    ];
    for (const o of inert) {
      for (const level of AT) {
        const v = t.at(level, [...base, o]);
        expect({ o: o.hash, level, paused: v.unknown, v: rosterOf(v) }).toEqual(
          {
            o: o.hash,
            level,
            paused: null,
            v: rosterOf(t.at(level, base)),
          }
        );
      }
    }
  });

  it('applies a later license only from an admin, though a non-admin key verifies', () => {
    const [B] = MEMBERS;
    const lk = testKeys();
    const extra = { licensePublicKey: lk.publicKey };
    const license = (by: string, seq: number, ms: number) =>
      op(by, seq, ms, {
        rv: 2,
        action: 'license',
        key: licenseFor(lk.privateKey, { seats: 9 }),
      });
    const base = [
      admit(A, 2, 100, B),
      admit(A, 3, 110, O, 'member', { observer: true }),
    ];
    for (const level of AT.filter((l) => l >= 2))
      expect(t.at(level, [...base, license(A, 4, 200)], extra).seats).toBe(9);
    // A member's, a pending replica's and an observer's.
    for (const o of [
      license(B, 2, 200),
      license(P, 2, 210),
      license(O, 2, 220),
    ])
      for (const level of AT) {
        const v = t.at(level, [...base, o], extra);
        expect({
          o: o.replica,
          level,
          seats: v.seats,
          by: v.licenseBy,
        }).toEqual({ o: o.replica, level, seats: 3, by: null });
      }
  });
});

describe('a later removal among a revocation fight', () => {
  const [B, C, D] = MEMBERS;
  // A hosts cut at rv 2: levels 2 and up read it as a removal, level 1 cannot.
  const laterCut = (by: string, seq: number, ms: number) =>
    op(by, seq, ms, {
      rv: 2,
      action: 'hosts',
      replica: M,
      hosts: [],
      afterSeq: 1,
      afterHash: `h-${M}-1`,
    });
  // Hinge admits: a fight can cut a replica's member admit, so the founder's
  // admin admit counts. P's later cut ranks with P's revoke of D, and is first.
  const PICK = {
    later: laterCut(P, 4, 20),
    rest: [
      admit(A, 3, 8, B, 'admin'),
      admit(A, 5, 12, P, 'admin'),
      admit(B, 3, 14, C),
      admit(A, 7, 16, C, 'admin'),
      admit(P, 3, 17, D),
      admit(A, 9, 19, D, 'admin'),
      revoke(P, 5, 27, D, 1),
      revoke(A, 13, 30, B, 2),
      revoke(B, 5, 36, A, 13),
      revoke(D, 3, 41, A, 12),
      revoke(C, 5, 47, P, 2),
      revoke(A, 15, 59, B, 2),
    ],
    // The founder's revokes of B lose their right twice, as each lets D
    // revoke the founder, so B's counter-revocation stands.
    expected: {
      admins: [B, P],
      members: [C],
      revoked: [
        [A, 13],
        [D, 1],
      ],
    },
  };
  // B is an admin only once D is cut, so B's revoke of the founder would undo
  // the founder's revoke of D that B's right rests on.
  const PASS = {
    later: laterCut(D, 2, 18),
    rest: [
      admit(A, 3, 6, P, 'admin'),
      admit(A, 5, 9, C, 'admin'),
      admit(C, 3, 15, D),
      admit(A, 7, 17, D, 'admin'),
      admit(D, 3, 22, B),
      admit(A, 9, 25, B, 'admin'),
      revoke(B, 3, 29, A, 12),
      demote(P, 3, 32, C, 2),
      revoke(A, 13, 39, D, 2),
      revoke(B, 7, 51, D, 2),
    ],
    expected: { admins: [A, P, B], members: [C], revoked: [[D, 2]] },
  };
  const SPLITS = [PICK, PASS];

  it('re-checks until no accepted removal rests on one a pass demoted', () => {
    for (const { later, rest } of SPLITS)
      for (const ops of [rest, [...rest, later]])
        for (const level of AT)
          expect({ level, unfounded: t.unfounded(level, ops) }).toEqual({
            level,
            unfounded: [],
          });
  });

  it('folds one standing at every level, which the level-1 relay shares', () => {
    for (const { later, rest, expected } of SPLITS) {
      const ops = [...rest, later];
      const relay = t.at(1, ops, { relay: true });
      expect(summary(relay)).toEqual(expected);
      for (const level of AT)
        expect({
          later: later.hash,
          level,
          s: standingOf(t.at(level, ops)),
        }).toEqual({ later: later.hash, level, s: standingOf(relay) });
    }
  });

  it('changes no standing when the later cut is dropped', () => {
    for (const { later, rest } of SPLITS)
      for (const level of AT)
        expect({
          later: later.hash,
          level,
          s: standingOf(t.at(level, [...rest, later])),
        }).toEqual({
          later: later.hash,
          level,
          s: standingOf(t.at(level, rest)),
        });
  });

  it('judges a dismiss the same at every level, however another names the cut', () => {
    // C, a member, names B's junk; P, an admin, names the revoked founder's.
    const U = junk(B, 7, 65);
    const V = junk(A, 17, 66);
    const set = [
      ...PICK.rest,
      PICK.later,
      U,
      dismiss(C, 7, 70, U),
      V,
      dismiss(P, 6, 72, V),
    ];
    // A pending replica's dismiss of the later cut is invalid but eligible.
    const steered = [...set, dismiss(Q, 2, 75, PICK.later)];
    for (const ops of [set, steered])
      for (const level of AT)
        expect({ level, dismissed: t.at(level, ops).dismissed }).toEqual({
          level,
          dismissed: [{ replica: A, seq: 17, hash: V.hash, by: P }],
        });
  });

  it('lets no dismiss of the later cut move the fight', () => {
    const ops = [...PICK.rest, PICK.later];
    // The revoked founder's dismiss is invalid, and B's valid.
    const byB = dismiss(B, 6, 70, PICK.later);
    expect(t.at(1, [...ops, byB]).dismissed.map((d) => d.by)).toEqual([B]);
    for (const named of [dismiss(A, 17, 70, PICK.later), byB])
      for (const level of AT)
        expect({
          level,
          s: standingOf(t.at(level, [...ops, named])),
        }).toEqual({
          level,
          s: standingOf(t.at(level, [...ops, blank(named)])),
        });
  });
});

const Z = 'zed-00000014'; // pinned, never admitted
const X = 'xi-00000015'; // an admin the founder revokes after its key op
const M2 = 'mo-00000017'; // a second device of M's handle, never admitted
const u = team(A, keysFor([...ALL, M, Z, X, M2]));

// Each removal's decision, for the removals among `ops`.
const decided = (v: RosterView, ops: readonly RosterOpRef[]) =>
  ops.flatMap((o) => {
    const d = v.resolution.get(o.hash);
    return d === undefined ? [] : [[o.hash, d]];
  });

// A recover signed with a code no admin ever set.
const wrongRecover = (by: string): Record<string, unknown> => ({
  action: 'recover',
  proof: signText(
    WRONG.signPriv,
    `${TAG.recovery}\n${u.found.hash.slice(0, 32)}\n${by}\nsign-${by}`
  ),
});

// A hinge fight with key rotations, and ops no right backs in any fold: a
// stranger's, an observer's, a plain member's, a revoked admin's, early ones,
// and grants each makes to itself or a stranger.
function rightlessOps(rand: () => number): {
  ops: RosterOpRef[];
  rightless: RosterOpRef[];
} {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const seqs = new Map<string, number>();
  const hinges = new Map<string, number[]>();
  let now = 5;
  const ops: RosterOpRef[] = [];
  const rightless: RosterOpRef[] = [];
  const mk = (by: string, body: Record<string, unknown>, ms?: number) => {
    const seq = (seqs.get(by) ?? 1) + 1;
    seqs.set(by, seq);
    now += 1 + Math.floor(rand() * 6);
    const o = op(by, seq, ms ?? now, body);
    ops.push(o);
    return o;
  };
  const admitOf = (
    r: string,
    role: string,
    extra: Record<string, unknown> = {}
  ) => ({
    action: 'admit',
    replica: r,
    handle: handleOf(r),
    role,
    fingerprint: `FP-${r}`,
    ...extra,
  });
  // The founder's first ops, below any cut a fight names.
  mk(A, admitOf(X, 'admin'));
  mk(A, {
    action: 'revoke',
    reason: 'r',
    replica: X,
    afterSeq: 1,
    afterHash: `h-${X}-1`,
  });
  mk(A, admitOf(O, 'member', { observer: true }));
  mk(A, admitOf(M, 'member'));
  const joined: string[] = [A];
  for (const r of shuffled(rand, [...MEMBERS, P])) {
    const by = pick(joined);
    if (by !== A && rand() < 0.8) {
      const first = rand() < 0.75 ? 'member' : 'admin';
      const hinge = mk(by, admitOf(r, first));
      hinges.set(by, [...(hinges.get(by) ?? []), hinge.seq]);
      const second = first === 'member' ? 'admin' : 'member';
      mk(pick(joined.filter((j) => j !== by)), admitOf(r, second));
    } else mk(pick(joined), admitOf(r, rand() < 0.8 ? 'admin' : 'member'));
    joined.push(r);
  }
  // A cut just below a hinge admit, near the target's last op, or its first.
  const removal = (target: string, low = false): Record<string, unknown> => {
    const below = hinges.get(target) ?? [];
    let afterSeq = Math.max(
      1,
      (seqs.get(target) ?? 1) + Math.floor(rand() * 3) - 1
    );
    if (low) afterSeq = 1;
    else if (below.length > 0 && rand() < 0.7) afterSeq = pick(below) - 1;
    const cut = {
      replica: target,
      afterSeq,
      afterHash: `h-${target}-${afterSeq}`,
    };
    return rand() < 0.65
      ? { action: 'revoke', reason: 'r', ...cut }
      : { action: 'role', role: 'member', ...cut };
  };
  // Any roster op aimed at another handle, or a grant to the publisher itself
  // or to a pinned stranger, which no right backs. X never cuts the founder
  // below its revocation of X, which would be a fight, and never admits a
  // stranger, whom that would give a right until X's revocation is decided.
  const stray = (by: string, k: number): Record<string, unknown> => {
    const target = pick(joined.filter((r) => r !== by));
    const stranger = by === X ? P : pick([Z, Q].filter((r) => r !== by));
    const x = rand();
    if (x < 0.45)
      return removal(target, rand() < 0.5 && !(by === X && target === A));
    if (x < 0.5)
      return {
        action: 'hosts',
        replica: target,
        hosts: [],
        afterSeq: 1,
        afterHash: `h-${target}-1`,
      };
    if (x < 0.55) return { action: 'role', replica: target, role: 'admin' };
    if (x < 0.62) return { action: 'role', replica: by, role: 'admin' };
    if (x < 0.69) return admitOf(by, 'admin');
    if (x < 0.75) return admitOf(stranger, pick(['member', 'admin']));
    if (x < 0.8) return wrongRecover(by);
    if (x < 0.84) return { action: 'recovery-key', pub: OTHER.signPub };
    if (x < 0.9) return { action: 'transport', kind: 'relay', url: `u-${k}` };
    if (x < 0.95)
      return {
        action: 'invite',
        id: `i-${k}`,
        pub: 'p',
        handle: handleOf(target),
        expires: '2027-01-01T00:00:00.000Z',
      };
    return { action: 'license', key: `k-${k}` };
  };
  // A grant no right backs that names `by`, from `by` itself or another
  // replica with no right.
  const voidGrant = (by: string): [string, Record<string, unknown>] => {
    const x = rand();
    if (x < 0.3) return [by, admitOf(by, 'admin')];
    if (x < 0.55) return [by, { action: 'role', replica: by, role: 'admin' }];
    if (x < 0.75) return [by, wrongRecover(by)];
    return [pick([Z, Q, O, M].filter((r) => r !== by)), admitOf(by, 'admin')];
  };
  const n = 6 + Math.floor(rand() * 10);
  for (let k = 0; k < n; k++) {
    const x = rand();
    if (x < 0.4) {
      const by = pick([Z, Q, O, M, X]);
      const when = rand();
      let ms: number | undefined;
      if (when < 0.15) ms = -5000 - k;
      else if (when < 0.25) ms = 10 ** 9 + k;
      if (rand() < 0.5) {
        rightless.push(mk(by, stray(by, k), ms));
        continue;
      }
      // A void grant to the publisher, then its cut, mostly of a hinge admitter.
      const [grantor, grant] = voidGrant(by);
      rightless.push(mk(grantor, grant, ms));
      const others = joined.filter((r) => r !== by);
      const hinged = others.filter((r) => hinges.has(r));
      const target = pick(hinged.length > 0 && rand() < 0.8 ? hinged : others);
      rightless.push(mk(by, removal(target), ms));
      continue;
    }
    const by = pick(joined);
    // An op positioned before the founding, by a publisher with rights later.
    if (x < 0.46) rightless.push(mk(by, stray(by, k), -5000 - k));
    else if (x < 0.52) mk(by, { action: 'recovery-key', pub: `next-${k}` });
    else
      mk(
        by,
        removal(rand() < 0.15 ? by : pick(joined.filter((r) => r !== by)))
      );
  }
  return { ops, rightless };
}

describe('a removal whose publisher holds no right at it', () => {
  const [B, C, D] = MEMBERS;
  // P is an admin only once the founder's revoke of C cuts C's member admit of
  // P; the founder then wins the fight over B's revocation of it.
  const FIGHT = [
    admit(A, 2, 10, B, 'admin'),
    admit(B, 2, 13, C, 'admin'),
    admit(C, 2, 25, P, 'member'),
    admit(A, 3, 29, P, 'admin'),
    revoke(P, 2, 53, B, 1),
    revoke(B, 3, 64, A, 3),
    revoke(A, 4, 75, C, 1),
  ];
  // Each rightless removal, after the founder's ops that set its publisher up.
  const STRAYS: [string, RosterOpRef[], RosterOpRef][] = [
    ['a stranger', [], revoke(Z, 2, 38, P, 1)],
    ['a stranger, before the founding', [], revoke(Z, 2, -5000, P, 1)],
    ['a stranger, far ahead', [], demote(Z, 2, 10 ** 9, P, 1)],
    [
      'an observer',
      [admit(A, 5, 90, O, 'member', { observer: true })],
      revoke(O, 2, 95, P, 1),
    ],
    ['a plain member', [admit(A, 5, 90, M)], revoke(M, 2, 95, P, 1)],
    [
      'an admin revoked below it',
      [admit(A, 5, 4, X, 'admin'), revoke(A, 6, 6, X, 1)],
      revoke(X, 3, 38, P, 1),
    ],
    [
      'an admin revoked below it, admitted late',
      [admit(A, 5, 80, X, 'admin'), revoke(A, 6, 85, X, 1)],
      revoke(X, 2, 90, P, 1),
    ],
  ];

  it('decides no fight, at every level and on the relay', () => {
    for (const [name, setup, stray] of STRAYS) {
      const base = [...FIGHT, ...setup];
      for (const level of AT)
        for (const relay of [false, true]) {
          const without = u.at(level, base, { relay });
          expect(summary(without).admins).toEqual([A, P]);
          const v = u.at(level, [...base, stray], { relay });
          expect({
            name,
            level,
            relay,
            s: standingOf(v),
            fights: decided(v, base),
            stray: v.resolution.get(stray.hash),
          }).toEqual({
            name,
            level,
            relay,
            s: standingOf(without),
            fights: decided(without, base),
            stray: 'void',
          });
        }
    }
  });

  // D's revoke of C would save the founder from C's revoke of it, but D's
  // right to it rests on a cut of B's member admit of D.
  const C_REVOKES_FOUNDER = [
    admit(A, 3, 10, C, 'admin'),
    admit(C, 2, 16, B, 'member'),
    admit(A, 4, 18, B, 'admin'),
    admit(B, 2, 20, D, 'member'),
    admit(A, 5, 26, D, 'admin'),
    revoke(D, 2, 33, C, 1),
    demote(B, 3, 35, C, 1),
    revoke(C, 4, 46, A, 7),
  ];
  const strays = new Set<RosterOpRef>();
  const stray = (o: RosterOpRef): RosterOpRef => {
    strays.add(o);
    return o;
  };
  // Each shrunk to the ops that let its stray op move a fight under an
  // earlier rule; X is the admin the founder revokes after its key op.
  const SETS: [string, RosterOpRef[]][] = [
    [
      "X's revoke of B cannot let D revoke the founder",
      [
        admit(A, 2, 11, X, 'admin'),
        revoke(A, 3, 17, X, 1),
        admit(A, 5, 20, D, 'admin'),
        admit(A, 6, 21, P, 'admin'),
        admit(A, 7, 25, C, 'admin'),
        admit(P, 2, 30, B, 'member'),
        admit(C, 2, 33, B, 'admin'),
        stray(revoke(X, 2, 45, B, 1)),
        demote(B, 4, 50, D, 1),
        demote(A, 8, 52, P, 1),
        revoke(D, 2, 57, A, 7),
      ],
    ],
    [
      "X's revoke of P cannot keep B an admin",
      [
        admit(A, 2, 7, X, 'admin'),
        revoke(A, 3, 8, X, 1),
        admit(A, 6, 12, B, 'admin'),
        admit(A, 7, 16, C, 'admin'),
        admit(B, 2, 21, P, 'member'),
        admit(C, 2, 25, P, 'admin'),
        admit(P, 2, 31, D, 'member'),
        admit(C, 3, 33, D, 'admin'),
        revoke(D, 2, 51, C, 3),
        revoke(P, 5, 54, B, 1),
        stray(revoke(X, 3, 67, P, 1)),
        demote(C, 5, 71, B, 3),
      ],
    ],
    [
      "X's revoke of the founder cannot decide B's fight with D",
      [
        admit(A, 2, 9, X, 'admin'),
        revoke(A, 3, 13, X, 1),
        admit(A, 5, 21, P, 'admin'),
        admit(P, 2, 26, C, 'member'),
        admit(A, 6, 30, C, 'admin'),
        admit(C, 2, 34, B, 'admin'),
        admit(A, 7, 37, D, 'admin'),
        revoke(B, 2, 54, D, 1),
        revoke(D, 2, 59, B, 1),
        stray(revoke(X, 2, 67, A, 6)),
        revoke(P, 4, 69, P, 1),
      ],
    ],
    [
      "X's demotion of P cannot let C revoke P",
      [
        admit(A, 2, 9, X, 'admin'),
        revoke(A, 3, 14, X, 1),
        admit(A, 5, 26, P, 'admin'),
        admit(P, 2, 31, D, 'admin'),
        admit(P, 3, 36, B, 'member'),
        admit(D, 2, 40, B, 'admin'),
        admit(B, 2, 45, C, 'member'),
        admit(A, 6, 50, C, 'admin'),
        stray(demote(X, 2, 64, P, 1)),
        demote(P, 4, 75, P, 2),
        revoke(C, 3, 81, P, 2),
      ],
    ],
    [
      "X's revoke of B cannot decide C's demotions of D",
      [
        admit(A, 2, 11, X, 'admin'),
        revoke(A, 3, 17, X, 1),
        admit(A, 5, 27, C, 'admin'),
        admit(C, 2, 28, B, 'member'),
        admit(A, 6, 33, B, 'admin'),
        admit(B, 2, 36, D, 'member'),
        admit(A, 7, 39, D, 'admin'),
        admit(B, 3, 41, P, 'admin'),
        demote(D, 2, 58, C, 1),
        stray(revoke(X, 3, 78, B, 1)),
        revoke(D, 3, 79, D, 3),
        revoke(D, 4, 82, P, 1),
        revoke(P, 2, 87, A, 6),
        demote(C, 5, 91, D, 4),
      ],
    ],
    [
      "a stranger's revoke of B cannot save the founder from C",
      [...C_REVOKES_FOUNDER, stray(revoke(Z, 3, 40, B, 1))],
    ],
  ];

  it('decides no fight in the sets a search found, at every level and on the relay', () => {
    for (const [name, ops] of SETS) {
      const kept = ops.filter((o) => !strays.has(o));
      for (const level of AT)
        for (const relay of [false, true]) {
          const v = u.at(level, ops, { relay });
          const w = u.at(level, kept, { relay });
          expect({
            name,
            level,
            relay,
            s: standingOf(v),
            fights: decided(v, kept),
          }).toEqual({
            name,
            level,
            relay,
            s: standingOf(w),
            fights: decided(w, kept),
          });
        }
    }
  });

  // The founder's demotion of B cuts B's member admit of P, so P's member
  // admit of D stands and D cannot revoke the founder.
  const FOUNDER_KEEPS = [
    admit(A, 2, 10, B, 'admin'),
    admit(B, 2, 20, P, 'member'),
    admit(A, 3, 30, P, 'admin'),
    admit(P, 2, 40, D, 'member'),
    admit(A, 4, 50, D, 'admin'),
    revoke(D, 2, 60, A, 4),
    demote(A, 5, 70, B, 1),
  ];
  // The same fight a seq later, below an observer's or a plain member's admit.
  const below = (first: RosterOpRef): RosterOpRef[] => [
    first,
    admit(A, 3, 10, B, 'admin'),
    admit(B, 2, 20, P, 'member'),
    admit(A, 4, 30, P, 'admin'),
    admit(P, 2, 40, D, 'member'),
    admit(A, 5, 50, D, 'admin'),
    revoke(D, 2, 60, A, 5),
    demote(A, 6, 70, B, 1),
  ];
  const selfPromotion = (by: string, seq: number, ms: number) =>
    op(by, seq, ms, { action: 'role', replica: by, role: 'admin' });
  const wrongCode = (by: string, seq: number, ms: number) =>
    op(by, seq, ms, wrongRecover(by));
  // Each kept set, and a grant no right backs with a removal it would enable.
  const GRANTS: [string, RosterOpRef[], RosterOpRef[]][] = [
    [
      "the founder's promotion of a replica it never admitted",
      C_REVOKES_FOUNDER,
      [
        op(A, 6, 38, { action: 'role', replica: Z, role: 'admin' }),
        revoke(Z, 2, 40, B, 1),
      ],
    ],
    [
      "the founder's promotion of an observer",
      [admit(A, 2, 5, O, 'member', { observer: true }), ...C_REVOKES_FOUNDER],
      [
        op(A, 6, 38, { action: 'role', replica: O, role: 'admin' }),
        revoke(O, 2, 40, B, 1),
      ],
    ],
    [
      "the founder's admission again of a member it revoked",
      [
        admit(A, 2, 3, X, 'member'),
        revoke(A, 6, 4, X, 5),
        ...C_REVOKES_FOUNDER,
      ],
      [admit(A, 7, 38, X, 'admin'), revoke(X, 2, 40, B, 1)],
    ],
    [
      "a plain member's admit of its own device under another handle",
      [admit(A, 2, 5, M), ...C_REVOKES_FOUNDER],
      [
        admit(M, 2, 38, M2, 'member', { handle: handleOf(B) }),
        revoke(M2, 2, 40, B, 1),
      ],
    ],
    [
      "a stranger's admit of itself",
      C_REVOKES_FOUNDER,
      [admit(Z, 2, 39, Z, 'admin'), revoke(Z, 3, 40, B, 1)],
    ],
    [
      "a stranger's promotion of itself",
      C_REVOKES_FOUNDER,
      [selfPromotion(Z, 2, 39), revoke(Z, 3, 40, B, 1)],
    ],
    [
      "a stranger's recover with a wrong code",
      C_REVOKES_FOUNDER,
      [wrongCode(Z, 2, 39), revoke(Z, 3, 40, B, 1)],
    ],
    [
      "an observer's promotion of itself",
      [admit(A, 2, 5, O, 'member', { observer: true }), ...C_REVOKES_FOUNDER],
      [selfPromotion(O, 2, 39), revoke(O, 3, 40, B, 1)],
    ],
    [
      "a plain member's promotion of itself",
      [admit(A, 2, 5, M), ...C_REVOKES_FOUNDER],
      [selfPromotion(M, 2, 39), revoke(M, 3, 40, B, 1)],
    ],
    [
      "a plain member's admit of a stranger",
      [admit(A, 2, 5, M), ...C_REVOKES_FOUNDER],
      [admit(M, 2, 39, Z, 'admin'), revoke(Z, 3, 40, B, 1)],
    ],
    [
      "a revoked admin's admit of a stranger",
      [admit(A, 2, 3, X, 'admin'), revoke(A, 6, 4, X, 1), ...C_REVOKES_FOUNDER],
      [admit(X, 2, 39, Z, 'admin'), revoke(Z, 3, 40, B, 1)],
    ],
    [
      "a stranger's promotion of itself, against the founder",
      FOUNDER_KEEPS,
      [selfPromotion(Z, 2, 55), demote(Z, 3, 65, P, 1)],
    ],
    [
      "a stranger's admit of itself, against the founder",
      FOUNDER_KEEPS,
      [admit(Z, 2, 55, Z, 'admin'), demote(Z, 3, 65, P, 1)],
    ],
    [
      "a stranger's wrong code, against the founder",
      FOUNDER_KEEPS,
      [wrongCode(Z, 2, 55), demote(Z, 3, 65, P, 1)],
    ],
    [
      "a stranger's admit of another, against the founder",
      FOUNDER_KEEPS,
      [admit(Q, 2, 45, Z, 'admin'), demote(Z, 3, 65, P, 1)],
    ],
    [
      "an observer's promotion of itself, against the founder",
      below(admit(A, 2, 5, O, 'member', { observer: true })),
      [selfPromotion(O, 2, 55), demote(O, 3, 65, P, 1)],
    ],
    [
      "a plain member's promotion of itself, against the founder",
      below(admit(A, 2, 5, M)),
      [selfPromotion(M, 2, 55), revoke(M, 3, 65, P, 1)],
    ],
    [
      "a revoked admin's promotion of C, which would make C's revoke of B stand",
      [
        admit(A, 2, 10, X, 'admin'),
        revoke(A, 3, 14, X, 1),
        admit(A, 6, 27, D, 'admin'),
        admit(A, 7, 29, B, 'admin'),
        admit(B, 3, 41, C, 'member'),
        admit(A, 9, 46, C, 'admin'),
        demote(D, 2, 56, B, 1),
        demote(D, 3, 83, D, 1),
        revoke(C, 2, 87, B, 4),
        revoke(B, 6, 89, D, 2),
      ],
      [op(X, 2, 52, { action: 'role', replica: C, role: 'admin' })],
    ],
    [
      "a stranger's admit of itself, against P's fight",
      [
        admit(A, 2, 21, P, 'admin'),
        admit(P, 2, 27, D, 'member'),
        admit(A, 3, 30, D, 'admin'),
        admit(D, 2, 32, B, 'member'),
        admit(A, 4, 35, B, 'admin'),
        revoke(B, 2, 42, A, 3),
        demote(A, 5, 68, P, 1),
      ],
      [admit(Z, 2, 48, Z, 'admin'), demote(Z, 3, 51, D, 1)],
    ],
    [
      "an observer's admit of itself, against the founder's revoke of D",
      [
        admit(A, 4, 11, O, 'member', { observer: true }),
        admit(A, 6, 14, P, 'admin'),
        admit(P, 2, 16, C, 'admin'),
        admit(C, 2, 20, B, 'member'),
        admit(A, 7, 26, B, 'admin'),
        admit(B, 2, 27, D, 'member'),
        admit(A, 8, 33, D, 'admin'),
        revoke(B, 3, 36, C, 1),
        revoke(D, 2, 41, A, 7),
        revoke(A, 9, 60, D, 2),
      ],
      [admit(O, 2, 54, O, 'admin'), demote(O, 3, 57, B, 1)],
    ],
    [
      "a plain member's admit of the founder under its own handle",
      [
        admit(A, 5, 22, M),
        admit(A, 6, 28, C, 'admin'),
        admit(C, 2, 31, D, 'member'),
        admit(A, 7, 35, D, 'admin'),
        admit(D, 2, 38, B, 'member'),
        admit(A, 8, 39, B, 'admin'),
        revoke(B, 3, 47, P, 1),
        demote(D, 3, 54, C, 1),
        revoke(C, 3, 68, D, 1),
        demote(B, 4, 69, C, 1),
        revoke(A, 9, 83, C, 2),
      ],
      [
        admit(M, 2, 57, A, 'member', { handle: handleOf(M) }),
        revoke(M, 3, 59, A, 1),
      ],
    ],
    [
      'a grant and a removal placed before the founding',
      [
        admit(A, 6, 24, B, 'admin'),
        admit(A, 7, 25, C, 'admin'),
        admit(B, 2, 31, D, 'member'),
        admit(A, 8, 34, D, 'admin'),
        admit(D, 2, 35, P, 'member'),
        admit(C, 2, 39, P, 'admin'),
        revoke(P, 5, 66, B, 1),
        revoke(D, 3, 70, B, 1),
        revoke(B, 3, 73, C, 4),
      ],
      [admit(P, 3, -6005, P, 'admin'), revoke(P, 4, -5005, D, 1)],
    ],
  ];

  it('gives no right to a grant no right backs, at every level and on the relay', () => {
    const removal = (o: RosterOpRef): boolean =>
      o.body.action === 'revoke' ||
      (o.body.action === 'role' && o.body.role === 'member');
    for (const [name, kept, grants] of GRANTS) {
      const ops = [...kept, ...grants];
      for (const level of AT)
        for (const relay of [false, true]) {
          const v = u.at(level, ops, { relay });
          const w = u.at(level, kept, { relay });
          expect({
            name,
            level,
            relay,
            s: standingOf(v),
            fights: decided(v, kept),
            void: grants.filter(removal).map((o) => v.resolution.get(o.hash)),
          }).toEqual({
            name,
            level,
            relay,
            s: standingOf(w),
            fights: decided(w, kept),
            void: grants.filter(removal).map(() => 'void'),
          });
        }
    }
  });

  it("lets no stranger's grant to itself and one cut move a set a search found", () => {
    const T0 = Date.parse('2026-09-26T00:00:00.000Z');
    const grants = [
      (ms: number) => admit(Q, 2, ms, Q, 'admin'),
      (ms: number) => selfPromotion(Q, 2, ms),
      (ms: number) => wrongCode(Q, 2, ms),
    ];
    const fights: [string, RosterOpRef[]][] = [
      ["the founder's fight with B", FIGHT],
      ...SETS,
    ];
    for (const [name, ops] of fights) {
      const base = u.fold(ops);
      const last = Math.max(...ops.map((o) => Number(o.hlc.slice(0, 13)))) - T0;
      const seqOf = (r: string) =>
        Math.max(1, ...ops.filter((o) => o.replica === r).map((o) => o.seq));
      for (const target of [A, B, C, D, P, X])
        for (let after = 0; after <= seqOf(target); after++)
          for (const ms of [5, Math.floor(last / 2), last + 5])
            for (const cut of [revoke, demote])
              for (const grant of grants) {
                const v = u.fold([
                  ...ops,
                  grant(ms),
                  cut(Q, 3, ms + 1, target, after),
                ]);
                expect({
                  name,
                  target,
                  after,
                  ms,
                  s: standingOf(v),
                  fights: decided(v, ops),
                  pending: v.pending.includes(Q),
                }).toEqual({
                  name,
                  target,
                  after,
                  ms,
                  s: standingOf(base),
                  fights: decided(base, ops),
                  pending: true,
                });
              }
    }
  }, 60_000);

  // P's demotion of the founder contests the founder's revoke of X, so X holds
  // its right until that fight is decided, and its removal counts until then.
  it('counts a removal by an admin whose revocation is still contested', () => {
    const contested = [
      admit(A, 2, 16, P, 'admin'),
      admit(P, 2, 20, C, 'member'),
      admit(A, 3, 22, C, 'admin'),
      admit(A, 4, 36, X, 'admin'),
      revoke(A, 5, 40, X, 1),
      demote(P, 3, 42, A, 4),
      revoke(C, 2, 64, P, 2),
      demote(P, 4, 69, P, 1),
    ];
    const byX = demote(X, 2, 48, C, 1);
    for (const level of AT)
      for (const relay of [false, true]) {
        expect({
          level,
          relay,
          with: summary(u.at(level, [...contested, byX], { relay })),
          without: summary(u.at(level, contested, { relay })),
        }).toEqual({
          level,
          relay,
          with: { admins: [A, C], members: [P], revoked: [[X, 1]] },
          without: { admins: [C], members: [A, P], revoked: [[X, 1]] },
        });
      }
  });

  it('leaves standing the recovery key the founder rotates after winning', () => {
    const rotate = op(A, 5, 80, { action: 'recovery-key', pub: OTHER.signPub });
    for (const level of AT)
      expect({
        level,
        pub: u.at(level, [...FIGHT, rotate, revoke(Z, 2, 38, P, 1)])
          .recoveryPub,
      }).toEqual({ level, pub: OTHER.signPub });
  });

  it('changes no right, rank, revocation, fight winner or recovery key when dropped', () => {
    const RIGHTLESS_SEEDS = 8000;
    let changed = 0;
    for (let seed = 1; seed <= RIGHTLESS_SEEDS; seed++) {
      const { ops, rightless } = rightlessOps(mulberry32(seed));
      const kept = ops.filter((o) => !rightless.includes(o));
      for (const level of [1, TOP]) {
        const v = u.at(level, ops);
        const w = u.at(level, kept);
        if (level === 1 && summary(w).revoked.length > 1) changed++;
        expect({
          seed,
          level,
          s: standingOf(v),
          fights: decided(v, kept),
        }).toEqual({
          seed,
          level,
          s: standingOf(w),
          fights: decided(w, kept),
        });
      }
    }
    // Enough fights must revoke someone besides X for the check to mean something.
    expect(changed).toBeGreaterThan(RIGHTLESS_SEEDS / 3);
  }, 120_000);
});

describe('a revocation sure to stand', () => {
  const [B, C, D] = MEMBERS;
  // Each set's standing, the same at every level and on the relay.
  const SURE: [string, RosterOpRef[], ReturnType<typeof summary>][] = [
    [
      'never takes a replica revoked before its admission as sure of its right',
      [
        admit(A, 2, 5, B, 'admin'),
        revoke(B, 2, 10, D, 0),
        admit(A, 3, 20, D, 'admin'),
        revoke(D, 2, 30, B, 1),
      ],
      { admins: [A, B], members: [], revoked: [[D, 0]] },
    ],
    [
      'never takes a promotion as sure before the admission it promotes is',
      [
        admit(A, 2, 5, C, 'admin'),
        admit(A, 3, 8, B, 'admin'),
        admit(C, 2, 10, D, 'member'),
        op(A, 4, 15, { action: 'role', replica: D, role: 'admin' }),
        revoke(B, 2, 30, C, 1),
        revoke(D, 2, 35, B, 1),
      ],
      { admins: [A, B], members: [], revoked: [[C, 1]] },
    ],
  ];

  for (const [name, ops, expected] of SURE)
    it(name, () => {
      for (const level of AT)
        for (const relay of [false, true])
          expect({
            level,
            relay,
            s: summary(t.at(level, ops, { relay })),
          }).toEqual({
            level,
            relay,
            s: expected,
          });
    });
});

// Hinge chains where most admins end cut, some by themselves, so the
// resolution often leaves no admin; later hosts cuts of M ride along.
function adminlessOps(rand: () => number): RosterOpRef[] {
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)];
  const seqs = new Map<string, number>();
  const hinges = new Map<string, number[]>();
  let now = 5;
  const ops: RosterOpRef[] = [];
  const mk = (by: string, body: Record<string, unknown>) => {
    const seq = (seqs.get(by) ?? 1) + 1;
    seqs.set(by, seq);
    now += 1 + Math.floor(rand() * 6);
    const o = op(by, seq, now, body);
    ops.push(o);
    return o;
  };
  const admitOf = (
    r: string,
    role: string,
    extra: Record<string, unknown> = {}
  ) => ({
    action: 'admit',
    replica: r,
    handle: handleOf(r),
    role,
    fingerprint: `FP-${r}`,
    ...extra,
  });
  const joined: string[] = [A];
  for (const r of shuffled(rand, [...MEMBERS, P])) {
    const by = pick(joined);
    if (by !== A && rand() < 0.7) {
      const first = rand() < 0.75 ? 'member' : 'admin';
      const hinge = mk(by, admitOf(r, first));
      hinges.set(by, [...(hinges.get(by) ?? []), hinge.seq]);
      const second = first === 'member' ? 'admin' : 'member';
      mk(pick(joined.filter((j) => j !== by)), admitOf(r, second));
    } else mk(pick(joined), admitOf(r, rand() < 0.8 ? 'admin' : 'member'));
    joined.push(r);
  }
  if (rand() < 0.5) mk(A, admitOf(M, 'member', { hosts: ['mx', 'my'] }));
  const n = 4 + Math.floor(rand() * 10);
  for (let k = 0; k < n; k++) {
    const by = pick(joined);
    if (rand() < 0.12) {
      mk(by, {
        rv: 2,
        action: 'hosts',
        replica: M,
        hosts: [],
        afterSeq: 1,
        afterHash: `h-${M}-1`,
      });
      continue;
    }
    const target = rand() < 0.2 ? by : pick(joined.filter((r) => r !== by));
    const below = hinges.get(target) ?? [];
    const afterSeq =
      below.length > 0 && rand() < 0.6
        ? pick(below) - 1
        : Math.max(1, (seqs.get(target) ?? 1) + Math.floor(rand() * 4) - 1);
    const cut = {
      replica: target,
      afterSeq,
      afterHash: `h-${target}-${afterSeq}`,
    };
    if (rand() < 0.55) mk(by, { action: 'revoke', reason: 'r', ...cut });
    else mk(by, { action: 'role', role: 'member', ...cut });
  }
  return ops;
}

const NO_ADMIN = 'would leave the team with no admin; void';

describe('a resolution that would leave no admin', () => {
  const [B, C, D] = MEMBERS;
  // Sets whose removals, all accepted, leave no admin, and what each folds to.
  const SETS: [string, RosterOpRef[], ReturnType<typeof summary> | null][] = [
    [
      'one voided revoke made C an admin',
      NO_ADMIN_LEFT,
      {
        admins: [A, B],
        members: [M],
        revoked: [
          [C, 3],
          [P, 2],
        ],
      },
    ],
    [
      "D's revoke of B makes C an admin, and C admits P as one",
      [
        admit(A, 2, 10, B, 'admin'),
        admit(B, 2, 20, C, 'member'),
        admit(A, 3, 30, C, 'admin'),
        admit(C, 2, 47, P, 'admin'),
        admit(A, 4, 48, D, 'admin'),
        revoke(D, 2, 49, B, 1),
        revoke(P, 2, 50, A, 6),
        demote(P, 3, 52, D, 2),
        demote(A, 5, 60, C, 2),
        demote(A, 6, 62, P, 3),
      ],
      { admins: [A, B, D], members: [C], revoked: [] },
    ],
    [
      "D's revoke of B makes C an admin",
      [
        admit(A, 2, 10, B, 'admin'),
        admit(B, 2, 20, C, 'member'),
        admit(A, 3, 30, C, 'admin'),
        admit(A, 4, 40, D, 'admin'),
        revoke(D, 2, 45, B, 1),
        revoke(C, 2, 50, A, 5),
        demote(C, 3, 55, D, 2),
        demote(A, 5, 60, C, 3),
      ],
      { admins: [A, B, D], members: [C], revoked: [] },
    ],
    [
      "B's revoke of D, a fight's pick, makes C an admin",
      [
        admit(A, 2, 9, D, 'admin'),
        admit(D, 2, 15, C, 'member'),
        admit(A, 3, 16, C, 'admin'),
        admit(C, 3, 26, B, 'member'),
        admit(A, 5, 27, B, 'admin'),
        revoke(C, 4, 31, A, 7),
        revoke(B, 2, 43, D, 1),
        demote(A, 6, 51, C, 4),
      ],
      { admins: [A, D, B], members: [C], revoked: [] },
    ],
    ['a generated hinge chain', opsFor(55610, mulberry32(55610)), null],
  ];

  it('voids the latest-ranked removal and re-runs, leaving none unfounded', () => {
    for (const [name, ops, expected] of SETS)
      for (const level of AT)
        for (const relay of [false, true]) {
          const v = t.at(level, ops, { relay });
          expect({
            name,
            level,
            relay,
            voided: v.problems.some((p) => p.message.endsWith(NO_ADMIN)),
            unfounded: t.unfounded(level, ops, { relay }),
          }).toEqual({ name, level, relay, voided: true, unfounded: [] });
          if (expected !== null) expect(summary(v)).toEqual(expected);
          else expect(summary(v).admins.length).toBeGreaterThan(0);
        }
  });

  it('leaves no removal unfounded on generated sets, in any order and with duplicates, at every level and on the relay', () => {
    const seeds = [
      ...Array.from({ length: 5000 }, (_, i) => i + 1),
      ...Array.from({ length: 21 }, (_, i) => 55600 + i),
    ];
    let adminless = 0;
    for (const seed of seeds) {
      const rand = mulberry32(seed);
      const ops = seed > 5000 ? opsFor(seed, rand) : adminlessOps(rand);
      const again = [
        ...shuffled(rand, ops),
        ops[Math.floor(rand() * ops.length)],
      ];
      // Every fourth set is also folded whole, in both orders and on the relay.
      const whole = seed % 4 === 0 || seed > 5000;
      for (const level of AT) {
        expect({
          seed,
          level,
          daemon: t.unfounded(level, ops),
          relay: t.unfounded(level, again, { relay: true }),
        }).toEqual({ seed, level, daemon: [], relay: [] });
        if (!whole) continue;
        const v = t.at(level, ops);
        if (level === 1 && v.problems.some((p) => p.message.endsWith(NO_ADMIN)))
          adminless++;
        expect({
          seed,
          level,
          daemon: rosterOf(t.at(level, again)),
          relay: rosterOf(t.at(level, again, { relay: true })),
        }).toEqual({ seed, level, daemon: rosterOf(v), relay: rosterOf(v) });
      }
    }
    // Enough sets must end with no admin for the check to mean something.
    expect(adminless).toBeGreaterThan(80);
  }, 300_000);
});
