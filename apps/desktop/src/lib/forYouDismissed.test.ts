import { expect, test } from 'bun:test';

import { dismissPosts, visiblePosts } from './forYouDismissed';
import type { Post } from './posts';

function post(key: string, createdAt: string): Post {
  return {
    key,
    subject: key,
    kind: 'for-you',
    latest: { createdAt } as Post['latest'],
    count: 1,
    unread: false,
    deliveries: [],
  };
}

const NOW = Date.parse('2026-10-26T20:00:00Z');

test('a dismissed post stays hidden until a newer message lands', () => {
  const first = post('run:r-1', '2026-10-26T19:17:00Z');
  const dismissed = dismissPosts({}, [first], NOW);
  expect(visiblePosts([first], dismissed)).toEqual([]);
  const newer = post('run:r-1', '2026-10-26T19:30:00Z');
  expect(visiblePosts([newer], dismissed)).toEqual([newer]);
});

test('dismissing drops marks older than a day', () => {
  const dismissed = dismissPosts(
    { stale: '2026-10-24T00:00:00Z', fresh: '2026-10-26T10:00:00Z' },
    [post('run:r-2', '2026-10-26T19:18:00Z')],
    NOW
  );
  expect(Object.keys(dismissed).sort()).toEqual(['fresh', 'run:r-2']);
});
