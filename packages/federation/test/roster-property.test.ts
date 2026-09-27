import { describe, expect, it } from 'bun:test';

import { normalize, SCENARIOS } from '../scripts/roster-vectors.js';
import { foldRoster } from '../src/roster.js';

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
