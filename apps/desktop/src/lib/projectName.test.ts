import { describe, expect, test } from 'bun:test';

import { basename } from './projectName';

describe('basename', () => {
  test('returns the last path segment', () => {
    expect(basename('/Users/wyat/Sites/dispatch')).toBe('dispatch');
  });

  test('strips a trailing slash before taking the last segment', () => {
    expect(basename('/Users/wyat/Sites/dispatch/')).toBe('dispatch');
  });

  test('returns the whole string when there is no slash', () => {
    expect(basename('dispatch')).toBe('dispatch');
  });

  test('falls back to the original path for the root path', () => {
    expect(basename('/')).toBe('/');
  });

  test('falls back to the original path for an empty string', () => {
    expect(basename('')).toBe('');
  });
});
