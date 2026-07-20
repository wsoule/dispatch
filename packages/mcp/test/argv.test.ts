import { describe, expect, it } from 'bun:test';

import { parseRootArg } from '../src/argv.js';

describe('parseRootArg', () => {
  it('falls back to cwd when --root is absent', () => {
    expect(parseRootArg([], '/fallback')).toEqual({
      ok: true,
      root: '/fallback',
    });
  });

  it('uses the value following --root', () => {
    expect(parseRootArg(['--root', '/some/dir'], '/fallback')).toEqual({
      ok: true,
      root: '/some/dir',
    });
  });

  it('errors when --root is the last argument (missing value)', () => {
    const result = parseRootArg(['--root'], '/fallback');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      '--root requires a directory argument'
    );
  });

  it('errors when --root is followed by another flag', () => {
    const result = parseRootArg(['--root', '--verbose'], '/fallback');
    expect(result.ok).toBe(false);
    expect((result as { error: string }).error).toContain(
      '--root requires a directory argument'
    );
  });
});
