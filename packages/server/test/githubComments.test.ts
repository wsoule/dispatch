import { expect, test } from 'bun:test';

import { mapGitHubComment } from '../src/githubComments.js';

const base = {
  id: 101,
  node_id: 'PRRC_abc',
  path: 'src/a.ts',
  line: 12,
  original_line: 9,
  start_line: null,
  diff_hunk: '@@ -1,3 +1,4 @@\n context\n+const x = 1;',
  body: 'why one?',
  user: { login: 'teammate' },
  created_at: '2026-08-01T00:00:00Z',
  updated_at: '2026-08-02T00:00:00Z',
  side: 'RIGHT',
  subject_type: 'line',
};

test('strips the diff prefix from the anchor line', () => {
  // The whole mirror rests on this: GitHub's diff_hunk keeps the +/-/space
  // marker, and an anchor that keeps it can never equal a real file line.
  expect(mapGitHubComment(base)?.anchorText).toBe('const x = 1;');
});

test('carries the GitHub ids needed to match it on the next pull', () => {
  const c = mapGitHubComment(base);
  expect(c?.githubId).toBe(101);
  expect(c?.githubUpdatedAt).toBe('2026-08-02T00:00:00Z');
  expect(c?.origin).toBe('github');
  expect(c?.pending).toBe(false);
});

test('falls back to original_line when the comment has gone outdated', () => {
  expect(mapGitHubComment({ ...base, line: null })?.line).toBe(9);
});

test('a LEFT-side comment is stored with no usable anchor', () => {
  // The local model only has new-side line numbers, so inventing one would
  // point the reader at unrelated code. An empty anchor reads as outdated.
  expect(mapGitHubComment({ ...base, side: 'LEFT' })?.anchorText).toBe('');
});

test('a file-level comment gets line 0 rather than a fake line', () => {
  const c = mapGitHubComment({
    ...base,
    subject_type: 'file',
    line: null,
    original_line: null,
  });
  expect(c?.line).toBe(0);
});

test('a payload with no path is dropped rather than stored half-formed', () => {
  expect(mapGitHubComment({ ...base, path: undefined })).toBeNull();
});
