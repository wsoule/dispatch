import { describe, expect, it } from 'bun:test';

import {
  claimConflictsWithWrites,
  schedulableBatch,
  tasksConflict,
} from '../src/conflicts.js';

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

  // A synthesized PR review task escapes glob metacharacters into its
  // `writes` (escapeGlobPath, server's prReviewTask.ts) so the Bun.Glob
  // readers match. Left unnormalized here, the escaped spelling never
  // equals the path a human declared and the pair schedules concurrently.
  it('is true for an escaped path and its unescaped twin', () => {
    expect(
      tasksConflict(['app/\\[id\\]/route.ts'], ['app/[id]/route.ts'])
    ).toBe(true);
  });

  it('is false for escaped paths that name different files', () => {
    expect(
      tasksConflict(['app/\\[id\\]/route.ts'], ['app/\\[slug\\]/route.ts'])
    ).toBe(false);
    expect(
      tasksConflict(['app/\\[id\\]/route.ts'], ['app/[slug]/route.ts'])
    ).toBe(false);
  });

  it('is true when a glob with an escaped directory covers a path', () => {
    expect(tasksConflict(['dir\\[a\\]/**'], ['dir[a]/file.ts'])).toBe(true);
  });

  // The trap: `dir/\*\*` is one escaped literal file, not a directory glob.
  // Unescaping before the `/**` suffix check would reinterpret it as one and
  // silently widen a single-file claim into a whole-subtree one.
  it('does not read an escaped literal `**` as a directory glob', () => {
    expect(tasksConflict(['dir/\\*\\*'], ['dir/sub/file.ts'])).toBe(false);
    expect(tasksConflict(['dir/\\*\\*'], ['dir/other.ts'])).toBe(false);
    expect(tasksConflict(['dir/\\*\\*'], ['dir/\\*\\*'])).toBe(true);
    expect(tasksConflict(['dir/\\*\\*'], ['dir/**'])).toBe(true);
  });
});

describe('claimConflictsWithWrites', () => {
  it('is false when the claim is empty, unlike tasksConflict', () => {
    expect(claimConflictsWithWrites([], ['a.ts'])).toBe(false);
    expect(tasksConflict([], ['a.ts'])).toBe(true);
  });

  it('is false when both sides are empty', () => {
    expect(claimConflictsWithWrites([], [])).toBe(false);
  });

  it('is true when the candidate writes are empty but the claim is not', () => {
    expect(claimConflictsWithWrites(['a.ts'], [])).toBe(true);
  });

  it('is true when a non-empty claim overlaps the candidate writes', () => {
    expect(claimConflictsWithWrites(['shared.ts'], ['shared.ts'])).toBe(true);
  });

  it('is false when a non-empty claim is disjoint from the candidate writes', () => {
    expect(claimConflictsWithWrites(['a.ts'], ['b.ts'])).toBe(false);
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
