import { describe, expect, it } from 'bun:test';

import { scopePathsInsideRepo } from '../../src/messaging/scopePolicy.js';

// The policy engine auto-grants (rung 2) only requests every path of which
// stays inside the run's checkout and clear of `.git/`.
describe('scopePathsInsideRepo', () => {
  const roots = ['/work/r-1', '/repo'];

  it('accepts relative paths and absolute paths inside either checkout', () => {
    expect(scopePathsInsideRepo(['packages/core/src/x.ts'], roots)).toBe(true);
    expect(scopePathsInsideRepo(['a/../b.ts', 'src/**'], roots)).toBe(true);
    expect(scopePathsInsideRepo(['/work/r-1/src/x.ts'], roots)).toBe(true);
    expect(scopePathsInsideRepo(['/repo/src/x.ts'], roots)).toBe(true);
  });

  it('refuses a path that escapes the checkout', () => {
    expect(scopePathsInsideRepo(['../sibling/x.ts'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['src/../../x.ts'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['..'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['/etc/hosts'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['/work/r-10/x.ts'], roots)).toBe(false);
  });

  it('refuses the checkout root itself and the repository metadata', () => {
    expect(scopePathsInsideRepo(['.'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['/repo'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['.git'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['.git/hooks/pre-commit'], roots)).toBe(false);
    expect(scopePathsInsideRepo(['/repo/.git/config'], roots)).toBe(false);
    // `.gitignore` is an ordinary file, not metadata.
    expect(scopePathsInsideRepo(['.gitignore'], roots)).toBe(true);
  });

  it('one bad path parks the whole request', () => {
    expect(scopePathsInsideRepo(['src/ok.ts', '../no.ts'], roots)).toBe(false);
  });

  it('rejects .git and parent escapes, accepts in-repo relative paths', () => {
    expect(scopePathsInsideRepo(['src/a.ts'], ['/repo'])).toBe(true);
    expect(scopePathsInsideRepo(['../x.ts'], ['/repo'])).toBe(false);
    expect(scopePathsInsideRepo(['.git/config'], ['/repo'])).toBe(false);
  });
});
