import { ApiError } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { resolveAffectedFilesStatus } from './impactViewStatus.js';

const entries = [
  { path: 'src/a.ts', hops: 1 },
  { path: 'src/b.ts', hops: 2 },
];

// The central regression this pins: a failed request must never fall
// through to an empty-state message, which would read as "nothing is
// affected" instead of "the request failed" — exactly the silent
// under-report the honesty rules exist to prevent.
test('a failed request is reported as an error, never an empty state', () => {
  const status = resolveAffectedFilesStatus({
    isError: true,
    error: new ApiError('path escapes the repository root', 400),
    entries: [],
    filter: '',
    resolved: true,
  });
  expect(status).toEqual({
    kind: 'error',
    message: 'path escapes the repository root',
  });
});

test('an error wins even when stale entries are still sitting in cache', () => {
  const status = resolveAffectedFilesStatus({
    isError: true,
    error: new ApiError('not found', 404),
    entries,
    filter: '',
    resolved: true,
  });
  expect(status.kind).toBe('error');
});

test('a non-ApiError failure still reports as an error, with a generic message', () => {
  const status = resolveAffectedFilesStatus({
    isError: true,
    error: new Error('network down'),
    entries: [],
    filter: '',
    resolved: true,
  });
  expect(status).toEqual({
    kind: 'error',
    message: "Couldn't load the blast radius.",
  });
});

test('no entries and no error is a real empty state', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries: [],
    filter: '',
    resolved: true,
  });
  expect(status).toEqual({ kind: 'empty', message: 'No files affected.' });
});

test('entries present but filtered to nothing says so distinctly', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries,
    filter: 'nope',
    resolved: true,
  });
  expect(status).toEqual({
    kind: 'empty',
    message: 'No files match that filter.',
  });
});

// The regression this pins: a disabled query (e.g. no API client yet) never
// becomes `isError` and never produces `entries`, so without an explicit
// `resolved: false` it would fall through to "No files affected." forever —
// a terminal false-empty, not a transient loading flash.
test('an unresolved query with no entries is pending, not empty', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries: [],
    filter: '',
    resolved: false,
  });
  expect(status).toEqual({ kind: 'pending' });
});

test('an unresolved query is pending even if stale entries linger', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries,
    filter: '',
    resolved: false,
  });
  expect(status.kind).toBe('pending');
});

test('an error still wins over an unresolved query', () => {
  const status = resolveAffectedFilesStatus({
    isError: true,
    error: new ApiError('boom', 500),
    entries: [],
    filter: '',
    resolved: false,
  });
  expect(status.kind).toBe('error');
});

// `ImpactPanel` (rendered above this panel) already says "This task's
// declared writes don't match any tracked file yet." for this reason. This
// panel must never contradict that with "No files affected." underneath it.
test('writes-match-nothing never renders as "No files affected."', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries: [],
    filter: '',
    resolved: true,
    reason: 'writes-match-nothing',
  });
  expect(status.kind).not.toBe('empty');
  expect(status.kind === 'empty' && status.message).not.toBe(
    'No files affected.'
  );
});

// Same contradiction, for the sibling reason: `ImpactPanel` says "This task
// declares no writes, so it has no blast radius to show."
test('no-declared-writes never renders as "No files affected."', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries: [],
    filter: '',
    resolved: true,
    reason: 'no-declared-writes',
  });
  expect(status.kind).not.toBe('empty');
  expect(status.kind === 'empty' && status.message).not.toBe(
    'No files affected.'
  );
});

test('a resolved response with no reason is still a real empty state', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries: [],
    filter: '',
    resolved: true,
    reason: undefined,
  });
  expect(status).toEqual({ kind: 'empty', message: 'No files affected.' });
});

test('entries survive into grouped output when nothing failed', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries,
    filter: '',
    resolved: true,
  });
  expect(status).toEqual({
    kind: 'entries',
    groups: [
      { hops: 1, paths: ['src/a.ts'] },
      { hops: 2, paths: ['src/b.ts'] },
    ],
  });
});
