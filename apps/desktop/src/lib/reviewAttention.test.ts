import { describe, expect, test } from 'bun:test';

import { composeRowDecoration } from './reviewAttention';

describe('composeRowDecoration', () => {
  test('an untouched file gets no decoration', () => {
    expect(composeRowDecoration({ viewed: false, comments: 0 })).toBeNull();
  });

  test('a viewed file gets a tick', () => {
    expect(composeRowDecoration({ viewed: true, comments: 0 })).toEqual({
      text: '✓',
      title: 'Viewed',
    });
  });

  test('one comment is singular', () => {
    expect(composeRowDecoration({ viewed: false, comments: 1 })).toEqual({
      text: '1',
      title: '1 unresolved comment',
    });
  });

  test('several comments are plural', () => {
    expect(composeRowDecoration({ viewed: false, comments: 2 })?.title).toBe(
      '2 unresolved comments'
    );
  });

  test('comments and viewed compose into one token', () => {
    expect(composeRowDecoration({ viewed: true, comments: 3 })).toEqual({
      text: '3 ✓',
      title: '3 unresolved comments · Viewed',
    });
  });
});
