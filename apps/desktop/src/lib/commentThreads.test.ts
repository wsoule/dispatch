import type { TaskComment } from '@dispatch/core/browser';
import { describe, expect, test } from 'bun:test';

import {
  canModifyComment,
  commentThreads,
  isPendingComment,
  pendingCommentId,
} from './commentThreads';

function comment(
  id: string,
  parentId: string | null = null,
  author = 'human:wyat'
): TaskComment {
  return {
    id,
    taskId: 't-1',
    author,
    body: id,
    created: '2026-09-23T10:00:00.000Z',
    updated: '2026-09-23T10:00:00.000Z',
    parentId,
    external: null,
  };
}

describe('commentThreads', () => {
  test('nests replies under their root, however deep, in input order', () => {
    const threads = commentThreads([
      comment('a'),
      comment('b'),
      comment('a1', 'a'),
      comment('a1x', 'a1'),
      comment('b1', 'b'),
    ]);
    expect(threads.map((t) => [t.root.id, t.replies.map((r) => r.id)])).toEqual(
      [
        ['a', ['a1', 'a1x']],
        ['b', ['b1']],
      ]
    );
  });

  test('a reply whose parent is gone becomes its own thread', () => {
    const threads = commentThreads([comment('r', 'missing'), comment('a')]);
    expect(threads.map((t) => t.root.id)).toEqual(['r', 'a']);
  });

  test('a reply listed before its root still lands under it', () => {
    const threads = commentThreads([comment('a1', 'a'), comment('a')]);
    expect(threads).toHaveLength(1);
    expect(threads[0]?.replies.map((r) => r.id)).toEqual(['a1']);
  });

  test('survives a parent cycle', () => {
    const threads = commentThreads([comment('a', 'b'), comment('b', 'a')]);
    expect(threads).toHaveLength(1);
  });
});

describe('canModifyComment', () => {
  test('your own comments and your agents’ comments', () => {
    expect(canModifyComment('human:wyat', 'human:wyat')).toBe(true);
    expect(canModifyComment('agent:wyat/claude', 'human:wyat')).toBe(true);
    expect(canModifyComment('human:maya', 'human:wyat')).toBe(false);
    expect(canModifyComment('agent:maya/claude', 'human:wyat')).toBe(false);
    expect(canModifyComment('agent', 'human:wyat')).toBe(false);
  });

  test('nobody may before the daemon says who you are', () => {
    expect(canModifyComment('human:wyat', null)).toBe(false);
  });
});

test('pending ids are recognizable', () => {
  expect(isPendingComment(comment(pendingCommentId(3)))).toBe(true);
  expect(isPendingComment(comment('c-123'))).toBe(false);
});
