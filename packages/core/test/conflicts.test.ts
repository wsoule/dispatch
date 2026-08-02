import { describe, expect, it } from 'bun:test';

import { schedulableBatch, tasksConflict } from '../src/conflicts.js';

describe('tasksConflict', () => {
  it('is false for disjoint write-sets', () => {
    expect(tasksConflict(['a.ts'], ['b.ts'])).toBe(false);
  });

  it('is true when write-sets intersect', () => {
    expect(tasksConflict(['shared.ts', 'a.ts'], ['shared.ts', 'b.ts'])).toBe(
      true
    );
  });

  it('is true when a glob overlaps an exact path', () => {
    expect(tasksConflict(['src/**'], ['src/api.ts'])).toBe(true);
  });

  it('is false when a glob does not cover the exact path', () => {
    expect(tasksConflict(['src/**'], ['docs/readme.md'])).toBe(false);
  });

  it('is true when an empty write-set meets a non-empty one', () => {
    expect(tasksConflict([], ['a.ts'])).toBe(true);
  });

  it('is true when both write-sets are empty', () => {
    expect(tasksConflict([], [])).toBe(true);
  });
});

describe('schedulableBatch', () => {
  it('batches disjoint sets together', () => {
    const ready = [
      { id: 't1', writes: ['a.ts'] },
      { id: 't2', writes: ['b.ts'] },
    ];
    expect(schedulableBatch(ready, 5)).toEqual(['t1', 't2']);
  });

  it('serializes intersecting sets, keeping only the first', () => {
    const ready = [
      { id: 't1', writes: ['shared.ts'] },
      { id: 't2', writes: ['shared.ts'] },
    ];
    expect(schedulableBatch(ready, 5)).toEqual(['t1']);
  });

  it('respects the limit even with no conflicts', () => {
    const ready = [
      { id: 't1', writes: ['a.ts'] },
      { id: 't2', writes: ['b.ts'] },
      { id: 't3', writes: ['c.ts'] },
    ];
    expect(schedulableBatch(ready, 2)).toEqual(['t1', 't2']);
  });

  it('is deterministic given the same input order', () => {
    const ready = [
      { id: 't1', writes: ['a.ts'] },
      { id: 't2', writes: ['a.ts'] },
      { id: 't3', writes: ['b.ts'] },
    ];
    expect(schedulableBatch(ready, 5)).toEqual(schedulableBatch(ready, 5));
    expect(schedulableBatch(ready, 5)).toEqual(['t1', 't3']);
  });
});
