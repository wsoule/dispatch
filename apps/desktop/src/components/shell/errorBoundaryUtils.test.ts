import { describe, expect, test } from 'bun:test';

import { isStaleChunkError } from './errorBoundaryUtils.ts';

// `ErrorBoundary`'s class wiring (componentDidCatch, the "Try again" remount, the rendered
// fallback markup) is not unit-tested here — this repo has no react-testing-library, and there
// is no other DOM-rendering harness to exercise a class component's lifecycle methods with.
// Only this pure fallback-decision function is tested.
describe('isStaleChunkError', () => {
  test('matches a failed module-script import', () => {
    expect(isStaleChunkError('Importing a module script failed')).toBe(true);
  });

  test('matches a failed dynamic import of a chunk', () => {
    expect(
      isStaleChunkError(
        'Failed to fetch dynamically imported module: https://example/chunk-abc.js'
      )
    ).toBe(true);
  });

  test('matches Safari\'s generic "Load failed" phrasing', () => {
    expect(isStaleChunkError('Load failed')).toBe(true);
  });

  test('does not match an unrelated render error', () => {
    expect(isStaleChunkError('Cannot read properties of undefined')).toBe(
      false
    );
  });

  test('does not match an empty message', () => {
    expect(isStaleChunkError('')).toBe(false);
  });
});
