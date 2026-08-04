import { describe, expect, it } from 'bun:test';
import { resolve } from 'node:path';

import { normalizeProjectPath } from '../src/projectPath.js';

describe('normalizeProjectPath', () => {
  it('strips a trailing separator', () => {
    expect(normalizeProjectPath('/Users/x/proj/')).toBe('/Users/x/proj');
  });

  it('leaves a path without a trailing separator alone', () => {
    expect(normalizeProjectPath('/Users/x/proj')).toBe('/Users/x/proj');
  });

  it('keeps the filesystem root intact', () => {
    expect(normalizeProjectPath('/')).toBe('/');
  });

  it('resolves a relative path to an absolute one', () => {
    expect(normalizeProjectPath('.')).toBe(resolve('.'));
  });

  it('collapses redundant segments so one directory has one key', () => {
    expect(normalizeProjectPath('/Users/x/other/../proj/')).toBe(
      '/Users/x/proj'
    );
  });

  it('is idempotent', () => {
    const once = normalizeProjectPath('/Users/x/proj/');
    expect(normalizeProjectPath(once)).toBe(once);
  });
});
