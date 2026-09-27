import { afterEach, describe, expect, it } from 'bun:test';

import { optionalAppToken, resolveAppToken } from '../src/commands/appToken.js';

const originalAppToken = process.env.DISPATCH_APP_TOKEN;

afterEach(() => {
  if (originalAppToken === undefined) delete process.env.DISPATCH_APP_TOKEN;
  else process.env.DISPATCH_APP_TOKEN = originalAppToken;
});

describe('resolveAppToken', () => {
  // license, team and browser need the app token too, and none of them
  // messages anyone, so the reason must hold for every caller.
  it('names the command and why the agent token will not do, for any caller', () => {
    delete process.env.DISPATCH_APP_TOKEN;
    for (const command of ['dispatch license set', 'dispatch team invite']) {
      let message = '';
      try {
        resolveAppToken(undefined, command);
      } catch (err) {
        message = err instanceof Error ? err.message : '';
      }
      expect(message).toStartWith(
        `${command} needs the daemon app token, which only a human holds`
      );
      expect(message).not.toContain('messaging');
      expect(message).toContain('DISPATCH_APP_TOKEN');
    }
  });

  it('prefers the explicit token and trims it', () => {
    process.env.DISPATCH_APP_TOKEN = 'from-env';
    expect(resolveAppToken('  explicit  ', 'dispatch approve')).toBe(
      'explicit'
    );
    expect(resolveAppToken(undefined, 'dispatch approve')).toBe('from-env');
  });
});

describe('optionalAppToken', () => {
  it('follows the same precedence, and a blank token is no token', () => {
    process.env.DISPATCH_APP_TOKEN = ' from-env ';
    expect(optionalAppToken(undefined)).toBe('from-env');
    expect(optionalAppToken('explicit')).toBe('explicit');
    expect(optionalAppToken('   ')).toBeUndefined();
    delete process.env.DISPATCH_APP_TOKEN;
    expect(optionalAppToken(undefined)).toBeUndefined();
  });
});
