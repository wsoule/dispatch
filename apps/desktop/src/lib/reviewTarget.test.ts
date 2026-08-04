import { expect, test } from 'bun:test';

import { reviewTargetKey } from './reviewTarget';

test('a run target and a pr target never collide on the same key', () => {
  expect(reviewTargetKey({ kind: 'run', runId: '7' })).toBe('run:7');
  expect(reviewTargetKey({ kind: 'pr', number: 7 })).toBe('pr:7');
});
