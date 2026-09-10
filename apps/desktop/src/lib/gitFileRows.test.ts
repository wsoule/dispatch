import type { GitFileChange } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { fileRowsFromStatus } from './gitFileRows';

function change(path: string): GitFileChange {
  return { path, status: 'M' };
}

describe('fileRowsFromStatus', () => {
  test('orders sections conflicted, staged, unstaged, untracked', () => {
    const rows = fileRowsFromStatus(
      [change('staged.ts')],
      [change('unstaged.ts')],
      ['untracked.ts'],
      ['conflict.ts']
    );
    expect(rows).toEqual([
      { section: 'conflicted', path: 'conflict.ts' },
      { section: 'staged', path: 'staged.ts', code: 'M' },
      { section: 'unstaged', path: 'unstaged.ts', code: 'M' },
      { section: 'untracked', path: 'untracked.ts' },
    ]);
  });

  test('a path in both conflicted and unstaged appears only once, as conflicted', () => {
    const rows = fileRowsFromStatus([], [change('both.ts')], [], ['both.ts']);
    expect(rows).toEqual([{ section: 'conflicted', path: 'both.ts' }]);
  });

  test('an empty status produces an empty list', () => {
    expect(fileRowsFromStatus([], [], [], [])).toEqual([]);
  });
});
