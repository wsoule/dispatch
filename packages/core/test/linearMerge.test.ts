import { describe, expect, it } from 'bun:test';

import type { FieldBase, MergeInput } from '../src/linearMerge.js';
import {
  fieldHash,
  hashFields,
  mergeFields,
  nextBase,
  UNMAPPED,
} from '../src/linearMerge.js';

const EARLY = '2026-07-01T00:00:00.000Z';
const LATE = '2026-07-02T00:00:00.000Z';

function base(local: unknown, remote: unknown = local): FieldBase {
  return {
    local: { f: fieldHash(local) },
    remote: { f: fieldHash(remote) },
  };
}

function decide(
  local: unknown,
  remote: unknown,
  b: FieldBase | null,
  opts: Partial<MergeInput> = {}
) {
  return mergeFields({
    fields: ['f'],
    local: { f: local },
    remote: { f: remote },
    base: b,
    localUpdated: EARLY,
    remoteUpdated: LATE,
    localDirty: false,
    ...opts,
  });
}

describe('fieldHash', () => {
  it('ignores object key order but not array order', () => {
    expect(fieldHash({ a: 1, b: 2 })).toBe(fieldHash({ b: 2, a: 1 }));
    expect(fieldHash(['a', 'b'])).not.toBe(fieldHash(['b', 'a']));
  });

  it('tells null, empty and absent apart only where they differ', () => {
    expect(fieldHash(undefined)).toBe(fieldHash(null));
    expect(fieldHash('')).not.toBe(fieldHash(null));
    expect(fieldHash([])).not.toBe(fieldHash(null));
  });
});

// The merge matrix: every combination of which side moved since the base.
describe('mergeFields with a base', () => {
  it('does nothing when neither side moved', () => {
    expect(decide('a', 'a', base('a'))).toEqual([]);
  });

  it('pushes a local-only change', () => {
    expect(decide('mine', 'a', base('a'))).toEqual([
      { field: 'f', action: 'push', conflict: false },
    ]);
  });

  it('pulls a remote-only change', () => {
    expect(decide('a', 'theirs', base('a'))).toEqual([
      { field: 'f', action: 'pull', conflict: false },
    ]);
  });

  it('lets the newer side win a field both changed, and flags it', () => {
    expect(decide('mine', 'theirs', base('a'))).toEqual([
      { field: 'f', action: 'pull', conflict: true },
    ]);
    expect(
      decide('mine', 'theirs', base('a'), {
        localUpdated: LATE,
        remoteUpdated: EARLY,
      })
    ).toEqual([{ field: 'f', action: 'push', conflict: true }]);
  });

  it('gives Linear a tie', () => {
    expect(
      decide('mine', 'theirs', base('a'), {
        localUpdated: LATE,
        remoteUpdated: LATE,
      })
    ).toEqual([{ field: 'f', action: 'pull', conflict: true }]);
  });

  it('records, without a conflict, both sides landing on the same value', () => {
    expect(decide('same', 'same', base('a'))).toEqual([
      { field: 'f', action: 'rebase', conflict: false },
    ]);
  });

  it('never re-sends a value a lossy mapping could not reproduce', () => {
    // Base recorded the two sides differing; neither moved since.
    expect(
      decide('local-shape', 'remote-shape', base('local-shape', 'remote-shape'))
    ).toEqual([]);
  });

  it('pulls over a local value Linear cannot hold, and never pushes it', () => {
    expect(decide(UNMAPPED, 'theirs', base('a'))).toEqual([
      { field: 'f', action: 'pull', conflict: false },
    ]);
    expect(decide(UNMAPPED, 'a', base('a'))).toEqual([
      { field: 'f', action: 'rebase', conflict: false },
    ]);
  });

  it('ignores a local change to a pull-only field', () => {
    expect(
      decide('mine', 'a', base('a'), { pullOnly: new Set(['f']) })
    ).toEqual([{ field: 'f', action: 'rebase', conflict: false }]);
  });

  it('skips fields the fetch could not vouch for', () => {
    expect(
      decide('mine', 'theirs', base('a'), { unknown: new Set(['f']) })
    ).toEqual([]);
  });

  it('pulls a placeholder Linear can now fill, though neither side moved', () => {
    const settled = base(UNMAPPED, 'u-new');
    // Without the hint, nothing ever replaces it.
    expect(decide(UNMAPPED, 'u-new', settled)).toEqual([]);
    const refresh = new Set(['f']);
    expect(decide(UNMAPPED, 'u-new', settled, { refresh })).toEqual([
      { field: 'f', action: 'pull', conflict: false },
    ]);
    // An untrusted fetch still says nothing about the field.
    expect(
      decide(UNMAPPED, 'u-new', settled, { refresh, unknown: refresh })
    ).toEqual([]);
  });
});

describe('mergeFields without a base', () => {
  it('takes Linear’s value for a task with no unsent edit', () => {
    expect(decide('mine', 'theirs', null)).toEqual([
      { field: 'f', action: 'pull', conflict: false },
    ]);
  });

  it('sends a dirty task’s value when it is the newer copy', () => {
    expect(
      decide('mine', 'theirs', null, {
        localDirty: true,
        localUpdated: LATE,
        remoteUpdated: EARLY,
      })
    ).toEqual([{ field: 'f', action: 'push', conflict: true }]);
  });

  it('takes Linear’s value when Linear is newer, dirty or not', () => {
    expect(decide('mine', 'theirs', null, { localDirty: true })).toEqual([
      { field: 'f', action: 'pull', conflict: true },
    ]);
  });

  it('lets only the named fields push on first contact', () => {
    expect(
      decide('mine', 'theirs', null, {
        localDirty: true,
        localUpdated: LATE,
        remoteUpdated: EARLY,
        noBasePush: new Set(['other']),
      })
    ).toEqual([{ field: 'f', action: 'pull', conflict: false }]);
  });

  it('records agreement as a base straight away', () => {
    expect(decide('x', 'x', null)).toEqual([
      { field: 'f', action: 'rebase', conflict: false },
    ]);
  });
});

describe('nextBase', () => {
  it('hashes both sides and keeps the old base for fields that did not land', () => {
    const previous = {
      local: { a: 'old-a', b: 'old-b' },
      remote: { a: 'ra', b: 'rb' },
    };
    const next = nextBase(
      ['a', 'b'],
      { a: 1, b: 2 },
      { a: 1, b: 3 },
      previous,
      new Set(['b'])
    );
    expect(next.local).toEqual({ a: fieldHash(1), b: 'old-b' });
    expect(next.remote).toEqual({ a: fieldHash(1), b: 'rb' });
  });

  it('leaves a failed field with no base when it never had one', () => {
    const next = nextBase(['a'], { a: 1 }, { a: 2 }, null, new Set(['a']));
    expect(next).toEqual({ local: {}, remote: {} });
    expect(hashFields(['a'], { a: 1 })).toEqual({ a: fieldHash(1) });
  });
});
