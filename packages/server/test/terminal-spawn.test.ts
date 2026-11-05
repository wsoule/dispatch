import { describe, expect, it } from 'bun:test';

import { ignoreClosedPipe, isClosedPipe } from '../src/closedPipe.js';
import { spawnInThread } from '../src/terminalSpawn.js';

// An error shaped like the ones Bun's stdin sink raises.
function errno(code: string): Error {
  return Object.assign(new Error(`${code}: test`), { code });
}

describe('a piped terminal whose child has exited', () => {
  // A keystroke sent just as the child exits meets a closed pipe. If Bun has
  // not yet seen the exit, which needs the daemon (or the terminal host) to
  // get no CPU between the two, flush() throws EPIPE synchronously; that used
  // to escape write() and take the terminal host down with every session in
  // it. The pause after the spawn makes the child exit unobserved every run.
  it('drops keystrokes without throwing, and still reports the exit', async () => {
    const child = spawnInThread({
      command: ['sh', '-c', 'exit 3'],
      cwd: process.cwd(),
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      pty: false,
      cols: 80,
      rows: 24,
    });
    Bun.sleepSync(200);
    try {
      for (let i = 0; i < 3; i++) {
        expect(() => child.write('echo still typing\n')).not.toThrow();
      }
      expect(await child.exited).toBe(3);
      // A write after the exit was observed is dropped the same way.
      expect(() => child.write('x')).not.toThrow();
      // A rejected write would surface as an unhandled rejection by now.
      await Bun.sleep(20);
    } finally {
      child.forceKill?.();
    }
  });
});

describe('ignoreClosedPipe', () => {
  it('swallows EPIPE thrown by the write', () => {
    expect(() =>
      ignoreClosedPipe(() => {
        throw errno('EPIPE');
      })
    ).not.toThrow();
  });

  it('rethrows any other error the write throws', () => {
    expect(() =>
      ignoreClosedPipe(() => {
        throw errno('EBADF');
      })
    ).toThrow('EBADF');
  });

  it('swallows EPIPE from a write that rejects later', async () => {
    const unhandled: unknown[] = [];
    const record = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', record);
    try {
      ignoreClosedPipe(() => Promise.reject(errno('EPIPE')));
      await Bun.sleep(10);
    } finally {
      process.off('unhandledRejection', record);
    }
    expect(unhandled).toEqual([]);
  });

  it('recognises EPIPE by its code alone', () => {
    expect(isClosedPipe(errno('EPIPE'))).toBe(true);
    expect(isClosedPipe(errno('ECONNRESET'))).toBe(false);
    expect(isClosedPipe('EPIPE')).toBe(false);
    expect(isClosedPipe(null)).toBe(false);
  });
});
