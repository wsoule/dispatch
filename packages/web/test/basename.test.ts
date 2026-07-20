import { describe, expect, it } from 'bun:test';

import { basename } from '../src/basename';

describe('basename', () => {
  it('returns the last path segment', () => {
    expect(basename('/Users/dev/my-project')).toBe('my-project');
  });

  it('strips trailing slashes before taking the last segment', () => {
    expect(basename('/Users/dev/my-project/')).toBe('my-project');
    expect(basename('/Users/dev/my-project///')).toBe('my-project');
  });

  it('returns the whole string when there is no slash', () => {
    expect(basename('my-project')).toBe('my-project');
  });
});
