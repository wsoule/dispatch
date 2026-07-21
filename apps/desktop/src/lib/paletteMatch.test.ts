import { describe, expect, test } from 'bun:test';

import { fuzzyScore, rankPaletteItems } from './paletteMatch';

describe('fuzzyScore', () => {
  test('empty query matches everything with score 0', () => {
    expect(fuzzyScore('', 'anything')).toBe(0);
    expect(fuzzyScore('   ', 'anything')).toBe(0);
  });

  test('matches a subsequence regardless of contiguity', () => {
    expect(fuzzyScore('dsp', 'dispatch task')).not.toBeNull();
    expect(fuzzyScore('dt', 'dispatch task')).not.toBeNull();
  });

  test('is case-insensitive', () => {
    expect(fuzzyScore('DISPATCH', 'dispatch task')).not.toBeNull();
  });

  test('returns null when the query has letters not present in order', () => {
    expect(fuzzyScore('xyz', 'dispatch task')).toBeNull();
    // "z" then "a" is present, but not "a" then "z" in that order.
    expect(fuzzyScore('az', 'dispatch task')).toBeNull();
  });

  test('a contiguous match scores higher than an equal-length scattered one', () => {
    const contiguous = fuzzyScore('dis', 'dispatch');
    const scattered = fuzzyScore('dth', 'dispatch');
    expect(contiguous).not.toBeNull();
    expect(scattered).not.toBeNull();
    expect((contiguous ?? 0) > (scattered ?? 0)).toBe(true);
  });

  test('a prefix match scores higher than the same query matching mid-string', () => {
    const prefix = fuzzyScore('task', 'task: fix bug');
    const midString = fuzzyScore('task', 'fix bug: task');
    expect(prefix).not.toBeNull();
    expect(midString).not.toBeNull();
    expect((prefix ?? 0) > (midString ?? 0)).toBe(true);
  });
});

describe('rankPaletteItems', () => {
  const items = [
    { id: '1', label: 'Dispatch task', sublabel: 'action' },
    { id: '2', label: 'DSP-042', sublabel: 'Fix the login flow' },
    { id: '3', label: 'New task', sublabel: 'action' },
    { id: '4', label: 'Unrelated entry', sublabel: 'zzz' },
  ];

  test('empty query returns items unchanged', () => {
    expect(rankPaletteItems(items, '')).toEqual(items);
  });

  test('filters out non-matches and ranks the rest', () => {
    const ranked = rankPaletteItems(items, 'task');
    expect(ranked.map((i) => i.id).sort()).toEqual(['1', '3']);
    expect(ranked.some((i) => i.id === '4')).toBe(false);
  });

  test('matches against id/label and sublabel combined', () => {
    const ranked = rankPaletteItems(items, 'login');
    expect(ranked.map((i) => i.id)).toEqual(['2']);
  });
});
