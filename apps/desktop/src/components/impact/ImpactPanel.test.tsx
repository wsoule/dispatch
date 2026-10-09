import { ApiError } from '@dispatch/client';
import { expect, test } from 'bun:test';

import { impactErrorMessage } from './ImpactPanel';

test('a run with nothing to diff reads as plain words, not the daemon error', () => {
  const msg = impactErrorMessage(
    new ApiError('run has no worktree to diff: r-1e6a4f', 409)
  );
  expect(msg).not.toContain('r-1e6a4f');
  expect(msg).toContain('Nothing to measure');
});

test('other daemon errors still say what went wrong', () => {
  expect(impactErrorMessage(new ApiError('carto timed out', 504))).toBe(
    'carto timed out'
  );
  expect(impactErrorMessage(new Error('boom'))).toBe(
    "Couldn't load the blast radius."
  );
});
