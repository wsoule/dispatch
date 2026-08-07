import { describe, expect, it } from 'bun:test';

import { TrackedFilesCache, TrackedFilesError } from '../src/trackedFiles.js';
import type { LsFilesRunner } from '../src/trackedFiles.js';

// A fake `git ls-files` runner that counts how many times it's actually
// invoked, so a test can assert the cache reused a result instead of
// re-spawning — the property review flagged as unverified.
function countingRunner(files: string[]): {
  runner: LsFilesRunner;
  calls: () => number;
} {
  let calls = 0;
  const runner: LsFilesRunner = () => {
    calls++;
    return Promise.resolve({
      exitCode: 0,
      stdout: files.join('\0') + '\0',
      stderr: '',
    });
  };
  return { runner, calls: () => calls };
}

function failingRunner(stderr: string): {
  runner: LsFilesRunner;
  calls: () => number;
} {
  let calls = 0;
  const runner: LsFilesRunner = () => {
    calls++;
    return Promise.resolve({ exitCode: 1, stdout: '', stderr });
  };
  return { runner, calls: () => calls };
}

describe('TrackedFilesCache', () => {
  it('memoizes across repeated get() calls until invalidated', async () => {
    const { runner, calls } = countingRunner(['a.ts', 'b.ts']);
    const cache = new TrackedFilesCache('/repo', runner);

    expect(await cache.get()).toEqual(['a.ts', 'b.ts']);
    expect(await cache.get()).toEqual(['a.ts', 'b.ts']);
    expect(calls()).toBe(1);

    cache.invalidate();
    expect(await cache.get()).toEqual(['a.ts', 'b.ts']);
    expect(calls()).toBe(2);
  });

  it('coalesces concurrent get() calls into one spawn', async () => {
    const { runner, calls } = countingRunner(['a.ts']);
    const cache = new TrackedFilesCache('/repo', runner);

    const [first, second] = await Promise.all([cache.get(), cache.get()]);
    expect(first).toEqual(['a.ts']);
    expect(second).toEqual(['a.ts']);
    expect(calls()).toBe(1);
  });

  it('throws TrackedFilesError on a failing git call, never an empty array', async () => {
    const { runner } = failingRunner('fatal: index file corrupt');
    const cache = new TrackedFilesCache('/repo', runner);

    await expect(cache.get()).rejects.toBeInstanceOf(TrackedFilesError);
  });

  it('a failed get() is not cached, so a later call retries', async () => {
    const { runner, calls } = failingRunner('fatal: index file corrupt');
    const cache = new TrackedFilesCache('/repo', runner);

    await expect(cache.get()).rejects.toBeInstanceOf(TrackedFilesError);
    await expect(cache.get()).rejects.toBeInstanceOf(TrackedFilesError);
    expect(calls()).toBe(2);
  });
});
