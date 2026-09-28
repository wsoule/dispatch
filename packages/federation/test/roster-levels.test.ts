import { ed25519FromSeed } from '@dispatch/protocol/federation';
import { describe, expect, it } from 'bun:test';

import { foldRosterAt, KNOWN_ROSTER_PAIRS } from '../src/roster.js';
import type { LaterPairs, RosterOpRef, RosterView } from '../src/roster.js';
import {
  admit,
  demote,
  handleOf,
  keysFor,
  LEVELS,
  op,
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
const ALL = [A, ...MEMBERS, O, P, Q] as const;
const t = team(A, keysFor(ALL));
const OTHER = ed25519FromSeed(Buffer.alloc(32, 9));

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
  'admit@2',
  'role@2',
  'revoke@2',
  'recover@2',
  'recovery-key@2',
  'dismiss@2',
  'close-legacy@2',
  'x-garbage@7',
];

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

// A view as every level must agree on it: less problems, the pause, and the
// removals only a level that reads them decides.
function agreed(v: RosterView, known: ReadonlySet<string>): unknown {
  const r = rosterOf(v) as { resolution: [string, unknown][] };
  return {
    ...r,
    resolution: r.resolution.filter(([hash]) => known.has(hash)),
  };
}

const SEEDS = 700;

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
      const ops = randomOps(rand, seed % 4 === 0);
      for (const level of [1, 2, 3]) {
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
      const ops = randomOps(mulberry32(seed), seed % 4 === 0);
      const known = new Set(
        [t.found, ...ops].filter((o) => !outsideKnown(o)).map((o) => o.hash)
      );
      const top = t.at(3, ops);
      for (const level of [1, 2]) {
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
      const ops = randomOps(rand, seed % 4 === 0);
      const outside = ops.filter(outsideKnown);
      const drops = [
        outside,
        ...shuffled(rand, outside)
          .slice(0, 3)
          .map((o) => [o]),
      ];
      for (const level of [1, 2, 3]) {
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
    for (let seed = 1; seed <= SEEDS; seed++) {
      const ops = randomOps(mulberry32(seed), seed % 4 === 0);
      for (const level of [1, 2, 3])
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

  it('never pauses the relay, which folds what a daemon at its level folds', () => {
    for (let seed = 1; seed <= SEEDS; seed += 3) {
      const ops = randomOps(mulberry32(seed), seed % 4 === 0);
      for (const level of [1, 2, 3]) {
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

  it('voids a later removal whose publisher holds no right at it in the final roster', () => {
    const [B, C, D] = MEMBERS;
    const M = 'mo-0000000e';
    const withM = team(A, keysFor([...ALL, M]));
    // A hosts cut at rv 2, which levels 2 and 3 read as a removal.
    const cutBy = (by: string, seq: number, ms: number) =>
      op(by, seq, ms, {
        rv: 2,
        action: 'hosts',
        replica: M,
        hosts: ['mx'],
        afterSeq: 1,
        afterHash: `h-${M}-1`,
      });
    const cases = [
      {
        // C's cut wins a fight it takes no part in; B then revokes C below it.
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
        hosts: ['mx', 'my'],
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
        hosts: [],
      },
      {
        // With no admin left, P's revoke is voided, and D, the cut's
        // publisher, ends pending.
        later: cutBy(D, 2, 60),
        rest: [
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
        ],
        hosts: ['mx', 'my'],
      },
    ];
    for (const { later, rest, hosts } of cases) {
      const ops = [...rest, later];
      const known = new Set([withM.found, ...rest].map((o) => o.hash));
      for (const level of [1, 2, 3]) {
        const v = withM.at(level, ops);
        expect({
          later: later.hash,
          level,
          paused: v.unknown,
          hosts: v.members.get(M)?.hosts,
          cut: v.resolution.get(later.hash) ?? 'void',
          v: agreed(v, known),
        }).toEqual({
          later: later.hash,
          level,
          paused: null,
          hosts,
          cut: 'void',
          v: agreed(withM.at(level, rest), known),
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
      for (const level of [1, 2, 3]) {
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
});
