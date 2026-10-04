import { describe, expect, it } from 'bun:test';

import { foldRoster } from '../src/roster.js';
import { GENERATORS, u } from './rosterGenerators.js';
import { oracle } from './rosterOracle.js';

// FW-R18: the fold's decision is the oracle's on seeds 1-3000 of every
// generator (1-1000 in CI); ORACLE_SEEDS sets another count.
const SEEDS = Number(
  process.env.ORACLE_SEEDS ?? (process.env.CI === undefined ? 3000 : 1000)
);

describe('the resolution against the brute-force oracle', () => {
  for (const [name, gen] of GENERATORS)
    it(`decides the rank-lexicographic stable assignment on ${name} sets`, () => {
      const seen = { checked: 0, contested: 0, large: 0, twoCuts: 0, none: 0 };
      for (let seed = 1; seed <= SEEDS; seed++) {
        const input = u.input(gen(seed));
        const verdict = oracle(input);
        // FW-R13(d), a right needing two cuts at once, stays an accepted
        // residual; with no stable assignment (odd cycles), rank picks decide.
        if (verdict === 'large') seen.large++;
        else if (verdict === 'two-cuts') seen.twoCuts++;
        else if (verdict.best === null) seen.none++;
        else {
          seen.checked++;
          expect({ seed, decided: verdict.decided }).toEqual({
            seed,
            decided: verdict.best,
          });
          if (verdict.stable === 1) continue;
          seen.contested++;
          // Every contested decision in the view is the probe's.
          const v = foldRoster(input);
          const view = verdict.removals.map((o) => v.resolution.get(o.hash));
          const mine = verdict.removals.map((_, i) =>
            ((verdict.decided >> BigInt(i)) & 1n) === 1n ? 'accepted' : 'void'
          );
          expect({ seed, view }).toEqual({ seed, view: mine });
        }
      }
      // Enough sets must fit the oracle, with a real choice, to mean something.
      expect(seen.checked).toBeGreaterThan(SEEDS / 2);
      expect(seen.contested).toBeGreaterThan(
        SEEDS / (name === 'shadow' ? 4 : 20)
      );
    }, 600_000);
});
