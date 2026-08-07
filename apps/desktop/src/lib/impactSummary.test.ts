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
};

test('splits direct from downstream', () => {
  const s = summarizeImpact(base, 20);
  expect(s.direct).toBe(2);
  expect(s.downstream).toBe(1);
  expect(s.deepest).toBe(3);
});

test('a truncated result never reads as an exact count', () => {
  const s = summarizeImpact({ ...base, truncated: true }, 20);
  expect(s.label).toContain('+');
  expect(s.label).toContain('capped');
});

test('a scanner-only result states what it walks', () => {
  const s = summarizeImpact({ ...base, sources: ['scanner'] }, 20);
  expect(s.sourceLabel).toContain('.ts');
});

test('a degraded result is not presented as a plain scanner result', () => {
  const s = summarizeImpact(
    { ...base, sources: ['scanner'], degraded: true },
    20
  );
  expect(s.sourceLabel).toContain('unavailable');
});

test('coverage appears only when the review cap actually bit', () => {
  expect(summarizeImpact(base, 20).coverage).toBeNull();
  expect(summarizeImpact({ ...base, count: 30 }, 20).coverage).toContain(
    '20 of 30'
  );
});

test('an empty reach has no coverage line and reads as zero', () => {
  const s = summarizeImpact({ ...base, entries: [], count: 0, maxHops: 0 }, 20);
  expect(s.total).toBe(0);
  expect(s.coverage).toBeNull();
});
