import {
  isMergeDriverResolvable,
  registerMergeDriverGitConfig,
  setSyncSpawner,
} from '@dispatch-foo/core';
import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  blockingGitStatus,
  installBlockingSpawner,
  spawnGitSync,
} from '../src/blockingGit.js';
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
      quiet: true,
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

  // Bun.spawnSync can lose a child's exit and spin at 100% CPU forever
  // (oven-sh/bun#34069); git must go through the worker instead.
  it('runs git on its worker, never through Bun.spawnSync', () => {
    const spy = spyOn(Bun, 'spawnSync');
    try {
      const result = spawnGitSync(tmpdir(), ['--version']);
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toStartWith('git version');
      expect(spy).not.toHaveBeenCalled();
      expect(blockingGitStatus()).toBe('worker');
    } finally {
      spy.mockRestore();
    }
  });

  it('returns output larger than any pipe buffer intact', () => {
    const result = spawnGitSync(tmpdir(), [
      '-c',
      'alias.big=!head -c 3000000 /dev/zero | tr "\\0" a',
      'big',
    ]);
    expect(result.exitCode).toBe(0);
    expect(result.stdout.length).toBe(3_000_000);
  });

  it('reports a failing command with its exit code and stderr', () => {
    const result = spawnGitSync(tmpdir(), ['no-such-subcommand']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain('no-such-subcommand');
    expect(result.timedOut).toBe(false);
  });

  it('throws when git cannot be started, as Bun.spawnSync did', () => {
    expect(() =>
      spawnGitSync(join(tmpdir(), 'dispatch-no-such-dir-here'), ['status'])
    ).toThrow();
  });
});

describe('installBlockingSpawner', () => {
  afterEach(() => setSyncSpawner(null));

  // Core's merge-driver check runs on every GET /api/sync; under Bun its
  // default spawner is Bun.spawnSync.
  it("routes core's synchronous spawns through the worker", () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-blocking-git-'));
    installBlockingSpawner();
    const spy = spyOn(Bun, 'spawnSync');
    try {
      spawnGitSync(dir, ['init', '-q']);
      expect(registerMergeDriverGitConfig(dir)).toBe(true);
      expect(
        spawnGitSync(dir, [
          'config',
          '--local',
          '--get',
          'merge.dispatch-task.driver',
        ]).stdout.trim()
      ).toBe('dispatch merge-task %O %A %B');
      // `dispatch` is not on the test's PATH; what matters is the route.
      isMergeDriverResolvable(dir);
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('reports a command that cannot start on the result, as node does', () => {
    installBlockingSpawner();
    // A missing cwd: registration must report false, not throw.
    expect(
      registerMergeDriverGitConfig(join(tmpdir(), 'dispatch-no-such-dir-here'))
    ).toBe(false);
  });
});
