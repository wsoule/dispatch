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
  });
  expect(status.kind).toBe('error');
});

test('a non-ApiError failure still reports as an error, with a generic message', () => {
  const status = resolveAffectedFilesStatus({
    isError: true,
    error: new Error('network down'),
    entries: [],
    filter: '',
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
  });
  expect(status).toEqual({ kind: 'empty', message: 'No files affected.' });
});

test('entries present but filtered to nothing says so distinctly', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries,
    filter: 'nope',
  });
  expect(status).toEqual({
    kind: 'empty',
    message: 'No files match that filter.',
  });
});

test('entries survive into grouped output when nothing failed', () => {
  const status = resolveAffectedFilesStatus({
    isError: false,
    error: null,
    entries,
    filter: '',
  });
  expect(status).toEqual({
    kind: 'entries',
    groups: [
      { hops: 1, paths: ['src/a.ts'] },
      { hops: 2, paths: ['src/b.ts'] },
    ],
  });
});
