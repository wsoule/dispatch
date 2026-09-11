import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { spawnGitSync } from '../src/blockingGit.js';
import type { StallReport } from '../src/watchdog.js';
import { EventLoopWatchdog } from '../src/watchdog.js';

let watchdog: EventLoopWatchdog | null = null;

afterEach(() => {
  watchdog?.stop();
  watchdog = null;
});

describe('spawnGitSync', () => {
  it('runs git in the given directory and returns its streams', () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-blocking-git-'));
    try {
      spawnGitSync(dir, ['init', '-q']);
      const result = spawnGitSync(dir, ['rev-parse', '--is-inside-work-tree']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout.trim()).toBe('true');
      expect(result.timedOut).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('names the command to the watchdog before blocking on it', async () => {
    const reports: StallReport[] = [];
    watchdog = new EventLoopWatchdog({
      thresholdMs: 150,
      heartbeatMs: 20,
      checkMs: 20,
      onStall: (report) => reports.push(report),
    });
    watchdog.start();
    await new Promise((resolve) => setTimeout(resolve, 120));

    // `git` here is a real spawn that blocks the loop for longer than the
    // threshold — a hung `git pull` in miniature.
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-blocking-git-'));
    try {
      spawnGitSync(dir, ['-c', 'alias.nap=!sleep 0.4', 'nap']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(reports.length).toBeGreaterThanOrEqual(1);
    expect(reports[0].section).toBe(
      `git -c alias.nap=!sleep 0.4 nap (cwd ${dir})`
    );
  });

  it('kills a command that outlives its deadline even when it ignores SIGTERM', () => {
    const started = Date.now();
    const result = spawnGitSync(
      tmpdir(),
      ['-c', 'alias.hang=!trap "" TERM; sleep 20', 'hang'],
      { timeoutMs: 300 }
    );
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(result.timedOut).toBe(true);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('killed after 300ms');
  });
});
