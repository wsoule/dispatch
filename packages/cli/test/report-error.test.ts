import { ConfigError } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import { CliError } from '../src/context.js';
import { reportCliError } from '../src/reportError.js';

function report(
  err: unknown,
  debug = false
): { lines: string[]; code: number } {
  const lines: string[] = [];
  const code = reportCliError(err, (l) => lines.push(l), debug);
  return { lines, code };
}

describe('reportCliError', () => {
  it('prints one line for an unexpected error, with no stack', () => {
    const out = report(new TypeError('boom\n    at x (/abs/path.ts:1:1)'));
    expect(out.lines).toEqual(['error: boom']);
    expect(out.code).toBe(1);
  });

  it('adds the stack only under DEBUG', () => {
    const err = new Error('boom');
    const out = report(err, true);
    expect(out.lines[0]).toBe('error: boom');
    expect(out.lines.join('\n')).toContain('report-error.test.ts');
  });

  it('keeps the known errors and their exit codes', () => {
    expect(report(new CliError('nope', 3))).toEqual({
      lines: ['error: nope'],
      code: 3,
    });
    expect(report(new ConfigError('bad yaml')).lines).toEqual([
      'error: bad yaml',
    ]);
    expect(report('a string')).toEqual({
      lines: ['error: a string'],
      code: 1,
    });
  });

  it('prints nothing for commander, which already did', () => {
    const err = Object.assign(new Error('x'), {
      code: 'commander.helpDisplayed',
      exitCode: 0,
    });
    expect(report(err)).toEqual({ lines: [], code: 0 });
  });
});
