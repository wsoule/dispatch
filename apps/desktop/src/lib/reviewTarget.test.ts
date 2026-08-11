import { expect, test } from 'bun:test';

import { prNumberFromUrl, reviewTargetKey } from './reviewTarget';

test('a run target and a pr target never collide on the same key', () => {
  expect(reviewTargetKey({ kind: 'run', runId: '7' })).toBe('run:7');
  expect(reviewTargetKey({ kind: 'pr', number: 7 })).toBe('pr:7');
});

// This key is also the conversation subject the daemon stores against, so its `run:` shape is
// load-bearing beyond React lists — `isSubjectRef` on the server rejects anything else.
test('a run key is the conversation subject the store expects', () => {
  expect(reviewTargetKey({ kind: 'run', runId: 'r-abc' })).toBe('run:r-abc');
});

test('a PR number is read off the run PR url, trailing slash or not', () => {
  expect(prNumberFromUrl('https://github.com/o/r/pull/42')).toBe(42);
  expect(prNumberFromUrl('https://github.com/o/r/pull/42/')).toBe(42);
});

test('a run with no PR — or a url that names none — resolves to null', () => {
  expect(prNumberFromUrl(undefined)).toBeNull();
  expect(prNumberFromUrl('https://github.com/o/r/pulls')).toBeNull();
});
