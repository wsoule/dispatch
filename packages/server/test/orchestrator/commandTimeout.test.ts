import { describe, expect, it } from 'bun:test';

import { defaultCommandRunner } from '../../src/orchestrator/pr.js';

describe('defaultCommandRunner timeout', () => {
  it('returns when a grandchild keeps the pipes open', async () => {
    // The exact shape that wedged a real merge queue: bash exits immediately,
    // but a background descendant inherits stdout/stderr and holds them open.
    // Killing bash does not reap it, so waiting for EOF waits forever — the
    // timeout has to win the race rather than fire and keep waiting.
    const start = Date.now();
    const result = await defaultCommandRunner(
      process.cwd(),
      ['bash', '-lc', 'sleep 30 & echo started; exit 0'],
      { timeoutMs: 700 }
    );

    expect(result.ok).toBe(false);
    expect(result.stderr).toMatch(/timed out/);
    // Must come back on the timeout, not after the descendant finally exits.
    expect(Date.now() - start).toBeLessThan(10_000);
  }, 20_000);

  it('still reports a normal command normally', async () => {
    const result = await defaultCommandRunner(
      process.cwd(),
      ['bash', '-lc', 'echo hello'],
      { timeoutMs: 10_000 }
    );
    expect(result.ok).toBe(true);
    expect(result.stdout.trim()).toBe('hello');
  });

  it('reports a non-zero exit as failure, not a timeout', async () => {
    const result = await defaultCommandRunner(
      process.cwd(),
      ['bash', '-lc', 'exit 3'],
      { timeoutMs: 10_000 }
    );
    expect(result.ok).toBe(false);
    expect(result.stderr).not.toMatch(/timed out/);
  });
});
