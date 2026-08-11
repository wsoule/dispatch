import { expect, test } from 'bun:test';

import { summarizeImpact } from './impactSummary.js';

const base = {
  entries: [
    { path: 'a.ts', hops: 1 },
    { path: 'b.ts', hops: 1 },
    { path: 'c.ts', hops: 3 },
  ],
  count: 3,
  maxHops: 3,
  sources: ['carto', 'scanner'] as ('carto' | 'scanner')[],
  degraded: false,
  truncated: false,
  unanalyzedSeeds: [] as string[],
};
const seeds = ['seed.ts'];

test('splits direct from downstream', () => {
  const s = summarizeImpact(base, seeds, 20);
  expect(s.direct).toBe(2);
  expect(s.downstream).toBe(1);
  expect(s.deepest).toBe(3);
});

test('a truncated result never reads as an exact count', () => {
  const s = summarizeImpact({ ...base, truncated: true }, seeds, 20);
  expect(s.label).toContain('+');
  expect(s.label).toContain('capped');
});

test('a scanner-only result states what it walks', () => {
  const s = summarizeImpact({ ...base, sources: ['scanner'] }, seeds, 20);
  expect(s.sourceLabel).toContain('.ts');
});

test('a degraded result is not presented as a plain scanner result', () => {
  const s = summarizeImpact(
    { ...base, sources: ['scanner'], degraded: true },
    seeds,
    20
  );
  expect(s.sourceLabel).toContain('unavailable');
});

test('coverage appears only when the review cap actually bit', () => {
  expect(summarizeImpact(base, seeds, 20).coverage).toBeNull();
  expect(summarizeImpact({ ...base, count: 30 }, seeds, 20).coverage).toContain(
    '20 of 30'
  );
});

test('a truncated result carries the + into its coverage denominator too', () => {
  // Reproduces the reported bug: "500+ files (capped)" above "review scope
  // covered 20 of 500" reads as an exact denominator on a truncated result.
  const s = summarizeImpact(
    { ...base, count: 500, truncated: true },
    seeds,
    20
  );
  expect(s.label).toContain('500+');
  expect(s.coverage).toBe('review scope covered 20 of 500+');
});

test('an empty reach has no coverage line and reads as zero', () => {
  const s = summarizeImpact(
    { ...base, entries: [], count: 0, maxHops: 0 },
    seeds,
    20
  );
  expect(s.total).toBe(0);
  expect(s.coverage).toBeNull();
});

// The finding this pins: selecting a file the scanner can't parse (e.g. a
// .jsonl) must never render as a confident "0 files affected" — a 0 count
// for an unanalyzed seed means "I never looked", not "nothing depends on
// it". Both this test and the next one must fail against the pre-fix
// summarizeImpact, which had no way to distinguish the two zeros at all.
test('an unanalyzable seed does not read as a confident zero', () => {
  const s = summarizeImpact(
    {
      ...base,
      entries: [],
      count: 0,
      maxHops: 0,
      unanalyzedSeeds: ['x.jsonl'],
    },
    ['x.jsonl'],
    20
  );
  expect(s.total).toBe(0);
  expect(s.zeroMessage).not.toBe('No files affected.');
  expect(s.zeroMessage.toLowerCase()).toContain('unknown');
});

// The companion fact this must not break: a genuinely analysable file with
// no dependents is a real, honest zero and must keep reading as one.
test('an analysable file with no dependents still reads as a real zero', () => {
  const s = summarizeImpact(
    { ...base, entries: [], count: 0, maxHops: 0, unanalyzedSeeds: [] },
    ['a.ts'],
    20
  );
  expect(s.total).toBe(0);
  expect(s.zeroMessage).toBe('No files affected.');
  expect(s.analysisNote).toBeNull();
});

// The mixed-seed decision: a run touching both a .ts file and a .jsonl file
// must not collapse to "wholly unanalysable" — the real count from the
// analysable seed still surfaces, alongside a caveat about the seed that
// couldn't be analyzed, rather than either swallowing the real data or
// silently dropping the caveat.
test('a mixed seed set reports the real count plus a partial caveat, not "wholly unknown"', () => {
  const s = summarizeImpact(
    {
      ...base,
      sources: ['scanner'],
      entries: [{ path: 'dep.ts', hops: 1 }],
      count: 1,
      maxHops: 1,
      unanalyzedSeeds: ['notes.jsonl'],
    },
    ['a.ts', 'notes.jsonl'],
    20
  );
  expect(s.total).toBe(1);
  expect(s.analysisNote).not.toBeNull();
  expect(s.analysisNote).toContain('1 of 2');
  expect(s.analysisNote?.toLowerCase()).not.toContain('unknown');
});

// The zero-count sibling of the mixed case: the analysable seed's real
// zero must still be distinguishable from "we looked at nothing at all".
test('a mixed seed set with a real zero from the analysable seed says so, not "wholly unknown"', () => {
  const s = summarizeImpact(
    {
      ...base,
      sources: ['scanner'],
      entries: [],
      count: 0,
      maxHops: 0,
      unanalyzedSeeds: ['notes.jsonl'],
    },
    ['a.ts', 'notes.jsonl'],
    20
  );
  expect(s.total).toBe(0);
  expect(s.zeroMessage).not.toBe('No files affected.');
  expect(s.zeroMessage).not.toBe(
    "Can't analyze any of these 2 files. Impact unknown, not zero."
  );
  expect(s.zeroMessage).toContain(
    'No files affected among what could be analyzed'
  );
});
