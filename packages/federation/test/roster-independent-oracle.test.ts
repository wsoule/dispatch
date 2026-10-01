import { describe, expect, it } from 'bun:test';

import { foldRoster } from '../src/roster.js';
import type { FoldInput } from '../src/roster.js';
import { fixtureInput, GENERATORS, u } from './rosterGenerators.js';
import { judge } from './rosterIndependentOracle.js';
import { admit, revoke } from './rosterOps.js';

// FW-R19: an oracle sharing no up-front code with the fold checks that each
// up-front decision holds in every stable assignment, and that the fold's
// answer is stable and the rank-lexicographic winner. Seeds 1-3000 of every
// generator (1-1000 in CI); ORACLE_SEEDS sets another count.
const SEEDS = Number(
  process.env.ORACLE_SEEDS ?? (process.env.CI === undefined ? 3000 : 1000)
);

const A = 'ada-0000000a';
const B = 'bo-0000000b';
const E = 'ea-00000031';
const X = 'xi-00000016';

describe('the up-front decisions against an independent oracle', () => {
  // Judged on the raw union, voiding the founder's cut of X was excused (X's
  // revoke of the founder leaves no admin), so {X's cut} was stable too.
  it("holds the founder's cut of X below X's revoke of it", () => {
    const ops = [
      admit(A, 2, 10, X, 'admin'),
      revoke(A, 3, 20, X, 1),
      revoke(X, 2, 30, A, 3),
    ];
    expect(judge(u.input(ops))).toEqual({
      unsound: [],
      stable: true,
      wins: true,
      count: 1,
    });
  });

  // E's revoke of the founder cuts the founder's cut of B and E's own admit.
  it("holds E's revoke of the founder below the founder's cut of B", () => {
    const ops = [
      admit(A, 2, 10, B, 'admin'),
      admit(A, 3, 20, E, 'admin'),
      revoke(A, 4, 30, B, 0),
      revoke(E, 2, 40, A, 2),
    ];
    expect(judge(u.input(ops))).toEqual({
      unsound: [],
      stable: true,
      wins: true,
      count: 1,
    });
  });

  for (const [name, gen] of GENERATORS)
    it(`holds on ${name} sets`, () => {
      const skipped: Record<string, number> = {};
      let checked = 0;
      for (let seed = 1; seed <= SEEDS; seed++) {
        const verdict = judge(u.input(gen(seed)));
        if (typeof verdict === 'string') {
          skipped[verdict] = (skipped[verdict] ?? 0) + 1;
          continue;
        }
        checked++;
        expect({ seed, ...verdict, count: 0 }).toEqual({
          seed,
          unsound: [],
          stable: true,
          wins: true,
          count: 0,
        });
      }
      expect(checked).toBeGreaterThan(SEEDS / 2);
    }, 600_000);
});

// FW-R13(e), an accepted residual: grounding starts from the up-front
// decisions, so a set grounded only by deferring one is never found and the
// component takes the no-stable-assignment rank pick, as here.
describe('a set grounded only by deferring an up-front removal', () => {
  const accepted = (input: FoldInput): string[] => {
    const v = foldRoster(input);
    return input.ops
      .filter((o) => v.resolution.get(o.hash) === 'accepted')
      .map((o) => `${o.replica}:${o.seq}`);
  };
  const chain = GENERATORS.find(([name]) => name === 'chain')?.[1];

  it('takes the rank pick on chain seed 2869', () => {
    const input = u.input(chain?.(2869) ?? []);
    expect(judge(input)).toBe('deferred');
    expect(accepted(input)).toEqual(['ada-0000000a:11', 'bo-0000000b:2']);
  });

  it("takes the rank pick on a reviewer's chain set", async () => {
    const input = await fixtureInput('chain-983');
    expect(judge(input)).toBe('deferred');
    expect(accepted(input)).toEqual([
      'ec-00000033:3',
      'ada-0000000a:7',
      'vb-00000042:3',
      'vb-00000042:4',
      'ec-00000033:4',
    ]);
  });
});
