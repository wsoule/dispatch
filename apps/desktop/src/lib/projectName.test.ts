import { describe, expect, test } from 'bun:test';

import { basename, parentDir } from './projectName';

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

describe('parentDir', () => {
  test('returns the folder that holds a project', () => {
    expect(parentDir('/Users/wyat/Sites/dispatch')).toBe('/Users/wyat/Sites');
  });

  test('ignores a trailing slash', () => {
    expect(parentDir('/Users/wyat/Sites/dispatch/')).toBe('/Users/wyat/Sites');
  });

  test('keeps the root slash for a top-level folder', () => {
    expect(parentDir('/Users')).toBe('/');
  });

  test('handles Windows paths', () => {
    expect(parentDir('C:\\Users\\wyat\\dispatch')).toBe('C:\\Users\\wyat');
    expect(parentDir('C:\\Users')).toBe('C:\\');
  });

  test('returns null when there is no parent', () => {
    expect(parentDir('dispatch')).toBeNull();
    expect(parentDir('/')).toBeNull();
    expect(parentDir('')).toBeNull();
  });
});
