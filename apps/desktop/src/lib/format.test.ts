import { describe, expect, test } from 'bun:test';

import { formatRelativeTime, sessionDisplayName } from './format.ts';
import { colorForProject } from './projectColor.ts';

// Placeholder coverage for the vendored lib helpers (R1 vendor slice). Exercises the pure
// display-name/time/color helpers so `bun test` has a non-empty desktop suite; richer
// coverage of the Tauri-backed views lands with R2's Tasks work.
describe('sessionDisplayName', () => {
  test('prefers the session title', () => {
    expect(sessionDisplayName('My session', 'A summary')).toBe('My session');
  });

  test('falls back to the summary when there is no title', () => {
    expect(sessionDisplayName(null, 'A summary')).toBe('A summary');
  });

  test('falls back to a placeholder when neither exists', () => {
    expect(sessionDisplayName(null, null)).toBe('Untitled session');
  });
});

describe('formatRelativeTime', () => {
  test('reports very recent timestamps as "just now"', () => {
    expect(formatRelativeTime(Date.now() / 1000)).toBe('just now');
  });

  test('formats minutes ago', () => {
    expect(formatRelativeTime(Date.now() / 1000 - 5 * 60)).toBe('5m ago');
  });
});

describe('colorForProject', () => {
  test('is deterministic for the same project id', () => {
    expect(colorForProject('proj-a')).toBe(colorForProject('proj-a'));
  });

  test('returns one of the 8 project color tokens', () => {
    expect(colorForProject('proj-a')).toMatch(/^var\(--project-color-[1-8]\)$/);
  });
});
