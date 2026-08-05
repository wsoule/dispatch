import { expect, test } from 'bun:test';

import { mapGitHubComment, mergeComments } from '../src/githubComments.js';
import type { ReviewComment } from '../src/reviewComments.js';

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
  // Same rule as the LEFT-side case above: a file comment has no diff line
  // to anchor to, so it must come back empty rather than a guessed value.
  expect(c?.anchorText).toBe('');
});

test('a payload with no path is dropped rather than stored half-formed', () => {
  expect(mapGitHubComment({ ...base, path: undefined })).toBeNull();
});

// Builds a minimal, valid ReviewComment for mergeComments tests, with
// overrides for the fields each rule actually turns on.
function comment(overrides: Partial<ReviewComment> = {}): ReviewComment {
  return {
    id: 'rc-000',
    file: 'src/a.ts',
    line: 5,
    anchorText: 'const x = 1;',
    author: 'someone',
    body: 'a comment',
    resolved: false,
    pending: false,
    created: '2026-08-01T00:00:00Z',
    replies: [],
    ...overrides,
  };
}

test('rule 1: a comment on both sides is matched by githubId, not by text', () => {
  const local = comment({
    id: 'rc-local',
    line: 5,
    githubId: 42,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    body: 'old wording entirely',
    resolved: true,
  });
  const remote = comment({
    id: 'rc-remote',
    line: 99,
    githubId: 42,
    githubUpdatedAt: '2026-08-02T00:00:00Z',
    body: 'completely different wording',
    origin: 'github',
  });
  const merged = mergeComments([local], [remote]);
  // Matching on line or body would see no overlap (different line, no
  // shared text) and produce a drop-plus-insert instead of one update.
  expect(merged).toHaveLength(1);
  expect(merged[0]?.githubId).toBe(42);
  expect(merged[0]?.body).toBe('completely different wording');
  // Resolution is local-only; a newer remote body must not reset it.
  expect(merged[0]?.resolved).toBe(true);
});

test('rule 2: a local pending comment is never touched by a pull', () => {
  const pendingLocal = comment({
    id: 'rc-pending',
    pending: true,
    body: 'still drafting',
  });
  const merged = mergeComments([pendingLocal], []);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toEqual(pendingLocal);
});

test('rule 3: a newer remote body wins over the stored one', () => {
  const local = comment({
    id: 'rc-local',
    githubId: 7,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    body: 'stored version',
  });
  const remote = comment({
    id: 'rc-remote',
    githubId: 7,
    githubUpdatedAt: '2026-08-03T00:00:00Z',
    body: 'edited on github',
    origin: 'github',
  });
  const merged = mergeComments([local], [remote]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.body).toBe('edited on github');
  expect(merged[0]?.githubUpdatedAt).toBe('2026-08-03T00:00:00Z');
});

test('rule 3b: a remote body no newer than githubUpdatedAt does not clobber', () => {
  const local = comment({
    id: 'rc-local',
    githubId: 8,
    githubUpdatedAt: '2026-08-02T00:00:00Z',
    body: 'kept as-is',
  });
  const remote = comment({
    id: 'rc-remote',
    githubId: 8,
    githubUpdatedAt: '2026-08-02T00:00:00Z',
    body: 'stale payload text',
    origin: 'github',
  });
  const merged = mergeComments([local], [remote]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.body).toBe('kept as-is');
});

test('a remote-win keeps locally-written replies', () => {
  // mapGitHubComment always hands back replies: [] (this codebase never
  // pulls GitHub's reply threads into ReviewComment.replies), so a naive
  // remote-wins-the-whole-record merge would silently wipe out replies a
  // reviewer wrote locally against this comment.
  const local = comment({
    id: 'rc-local',
    githubId: 20,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    body: 'stored version',
    replies: [
      {
        id: 'rr-1',
        author: 'me',
        body: 'a reply',
        created: '2026-08-01T00:00:00Z',
      },
    ],
  });
  const remote = comment({
    id: 'rc-remote',
    githubId: 20,
    githubUpdatedAt: '2026-08-02T00:00:00Z',
    body: 'edited on github',
    origin: 'github',
  });
  const merged = mergeComments([local], [remote]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.body).toBe('edited on github');
  expect(merged[0]?.replies).toEqual(local.replies);
});

test('a remote-win keeps the local id stable', () => {
  // mapGitHubComment assigns a fresh random id to every remote record, so
  // taking the remote record wholesale on a win would swap the id callers
  // already hold (ReviewCommentStore keys reply/setResolved/remove off it).
  const local = comment({
    id: 'rc-stable',
    githubId: 21,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    body: 'stored version',
  });
  const remote = comment({
    id: 'rc-freshly-random',
    githubId: 21,
    githubUpdatedAt: '2026-08-02T00:00:00Z',
    body: 'edited on github',
    origin: 'github',
  });
  const merged = mergeComments([local], [remote]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.id).toBe('rc-stable');
});

test('rule 4: a comment with a githubId absent from the pull was deleted upstream', () => {
  const local = comment({
    id: 'rc-local',
    githubId: 11,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    body: 'will vanish',
  });
  const merged = mergeComments([local], []);
  expect(merged).toHaveLength(0);
});

test('rule 5: a published local comment with no githubId survives, to be pushed', () => {
  const published = comment({
    id: 'rc-published',
    pending: false,
    body: 'ready to push',
  });
  const merged = mergeComments([published], []);
  expect(merged).toHaveLength(1);
  expect(merged[0]).toEqual(published);
});

test('rule 6: a remote-only comment is inserted', () => {
  const remote = comment({
    id: 'rc-gh',
    githubId: 55,
    githubUpdatedAt: '2026-08-01T00:00:00Z',
    origin: 'github',
  });
  const merged = mergeComments([], [remote]);
  expect(merged).toHaveLength(1);
  expect(merged[0]?.githubId).toBe(55);
  expect(merged[0]?.origin).toBe('github');
});
