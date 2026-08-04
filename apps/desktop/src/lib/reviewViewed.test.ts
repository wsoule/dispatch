import { beforeEach, describe, expect, test } from 'bun:test';

import {
  readViewed,
  toggleViewed,
  viewedSummary,
  writeViewed,
} from './reviewViewed';

// test-setup.ts registers happy-dom's globals, so a real `window.localStorage` already exists
// here; clearing it (rather than replacing `window`) keeps tests isolated without breaking
// anything else in the process that also depends on `window`.
beforeEach(() => localStorage.clear());

describe('toggleViewed', () => {
  test('adds then removes, without mutating the input', () => {
    const start = new Set<string>();
    const on = toggleViewed(start, 'a.ts');
    expect(on.has('a.ts')).toBe(true);
    expect(start.size).toBe(0);
    expect(toggleViewed(on, 'a.ts').has('a.ts')).toBe(false);
  });
});

describe('viewedSummary', () => {
  test('counts against the files in this diff', () => {
    expect(viewedSummary(new Set(['a', 'b']), ['a', 'b', 'c'])).toBe(
      '2 of 3 viewed'
    );
  });

  // A file ticked in an earlier version of the diff must not push the count past the total.
  test('a tick for a file no longer in the diff does not inflate the count', () => {
    expect(viewedSummary(new Set(['a', 'gone']), ['a', 'b'])).toBe(
      '1 of 2 viewed'
    );
  });

  test('an empty diff reads as zero of zero rather than dividing by nothing', () => {
    expect(viewedSummary(new Set(), [])).toBe('0 of 0 viewed');
  });
});

describe('persistence', () => {
  test('round-trips per run', () => {
    writeViewed('r-1', new Set(['a.ts', 'b.ts']));
    expect([...readViewed('r-1')].sort()).toEqual(['a.ts', 'b.ts']);
  });

  // A re-dispatch of the same task is a new run against a new diff; inheriting ticks would mark
  // files read that nobody has looked at.
  test('runs do not share state', () => {
    writeViewed('r-1', new Set(['a.ts']));
    expect(readViewed('r-2').size).toBe(0);
  });

  test('an unknown run reads as nothing viewed', () => {
    expect(readViewed('r-never-seen').size).toBe(0);
  });

  test('a corrupt entry degrades to nothing viewed rather than throwing', () => {
    localStorage.setItem('dispatch:review-viewed:r-bad', '{oops');
    expect(readViewed('r-bad').size).toBe(0);
  });

  test('a non-array entry is ignored', () => {
    localStorage.setItem('dispatch:review-viewed:r-obj', '{"a":1}');
    expect(readViewed('r-obj').size).toBe(0);
  });
});
