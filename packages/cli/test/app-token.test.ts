import { afterEach, describe, expect, it } from 'bun:test';

import {
  noAppTokenMessage,
  optionalAppToken,
  resolveAppToken,
} from '../src/commands/appToken.js';

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

describe('noAppTokenMessage', () => {
  const daemon = { pid: 4242, port: 5151, startedBy: null };
  it('names a daemon the app or a terminal started, and who holds its token', () => {
    const message = noAppTokenMessage('dispatch team join', {
      ...daemon,
      background: false,
    });
    expect(message).toContain(
      '(pid 4242, port 5151) was started by the Dispatch app'
    );
    expect(message).toContain('Settings → Members → Join a team');
    expect(message).toContain('`dispatch serve --replace`');
    expect(message).toContain('once it has no live work');
    // cli.ts prints a failure's first line only.
    expect(message).not.toContain('\n');
  });

  it('says a background daemon cannot give its token back, and why', () => {
    const message = noAppTokenMessage('dispatch license set', {
      ...daemon,
      background: true,
    });
    expect(message).toContain(
      'started in the background by a dispatch command'
    );
    // Taking over is what `dispatch serve` itself does now; no kill loop.
    expect(message).toContain(
      'Run `dispatch serve` in a terminal you keep open'
    );
    expect(message).not.toContain('kill');
    expect(message).not.toContain('--replace');
    expect(message).toContain('press Restart Dispatch from this app.');
    expect(message).not.toContain('Join a team');
    expect(message).not.toContain('\n');
  });

  it('points a background join at the app’s takeover, then Join a team', () => {
    const message = noAppTokenMessage('dispatch team join', {
      ...daemon,
      background: true,
    });
    expect(message).toContain(
      'press Restart Dispatch from this app, then use Settings → Members → Join a team.'
    );
  });
});

describe('an invite where a token belongs', () => {
  it('is refused in every form, without echoing it', () => {
    for (const invite of [
      'dispatch-team:SECRET',
      'https://dispatch.foo/join#SECRET',
      'di1.SECRET',
    ]) {
      process.env.DISPATCH_APP_TOKEN = invite;
      expect(() => optionalAppToken(undefined)).toThrow(
        /^that is a team invite link, not a daemon token/
      );
      let message = '';
      try {
        optionalAppToken(undefined);
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).not.toContain('SECRET');
    }
  });
});
