import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSkippedPath } from '../src/depmap.js';
import type { Watcher } from '../src/watcher.js';
import { watchSourceDirs, watchTasks } from '../src/watcher.js';

let root: string;
let store: TaskStore;
let watcher: Watcher;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-watcher-'));
  store = TaskStore.init(root);
});

afterEach(() => {
  watcher.close();
});

// Waits for onChange, rejecting after `timeoutMs`. The default is a hang-guard,
// not a latency assertion: it clears macOS's fs-event delays under suite load.
function waitForChange(tasksDir: string, timeoutMs = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('watcher did not fire onChange in time')),
      timeoutMs
    );
    watcher = watchTasks(tasksDir, () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

describe('watchTasks', () => {
  it('fires onChange after a debounce window when a task file is written', async () => {
    const changed = waitForChange(store.tasksDir);
    store.create({ title: 'New task' });
    await changed;
  }, 30_000);

  it('does not throw when the tasks dir is missing (creates it instead)', () => {
    // A daemon can be pointed at a root whose .dispatch/tasks doesn't exist
    // (stale worktree, partially-removed .dispatch). watch() would throw ENOENT
    // and crash startServer; watchTasks must survive it.
    const bare = mkdtempSync(join(tmpdir(), 'dispatch-watcher-bare-'));
    const missing = join(bare, '.dispatch', 'tasks');
    expect(existsSync(missing)).toBe(false);
    watcher = watchTasks(missing, () => {});
    expect(existsSync(missing)).toBe(true);
  });

  // The assertion under test is `calls === 1` — that a burst collapses into one
  // callback. The timer below is only a hang-guard so a regression fails fast
  // instead of stalling the suite; it is not a latency assertion. It was 2s,
  // which is 20x DEBOUNCE_MS but still not enough on a machine running the whole
  // workspace's suites at once: macOS delays fs event delivery under I/O
  // pressure, so this failed only in `bun run test` and passed every time in
  // isolation. Raised well clear of that, with an `it` timeout above it (bun's
  // default is 5s, which would otherwise cut the guard off first).
  it('collapses a burst of writes into a single onChange call', async () => {
    let calls = 0;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('watcher did not fire onChange in time')),
        15_000
      );
      watcher = watchTasks(store.tasksDir, () => {
        calls += 1;
        clearTimeout(timer);
        // Give any further debounced events a moment to (not) arrive before
        // asserting there was only one call for the whole burst.
        setTimeout(resolve, 300);
      });
    });
    store.create({ title: 'One' });
    store.create({ title: 'Two' });
    store.create({ title: 'Three' });
    await done;
    expect(calls).toBe(1);
  }, 30_000);
});

describe('watchSourceDirs', () => {
  it('fires onChange after a debounce window when a file is written', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-source-watch-'));
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('watcher did not fire onChange in time')),
        3000
      );
      watcher = watchSourceDirs([dir], () => {
        clearTimeout(timer);
        resolve();
      });
    });
    writeFileSync(join(dir, 'a.ts'), 'export const x = 1;\n');
    await changed;
  });

  // A watched root can include .dispatch, which the daemon writes to
  // continuously — those writes must never trigger a rescan.
  it('ignores changes under a skipped directory but still watches for real ones', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'dispatch-source-watch-skip-'));
    mkdirSync(join(dir, '.dispatch', 'runs'), { recursive: true });
    const realFile = join(dir, 'real.ts');
    let calls = 0;
    let sawRealFile = false;
    watcher = watchSourceDirs(
      [dir],
      () => {
        calls += 1;
        // onChange carries no path, so the real write is told apart by its file
        // existing; a late .dispatch event would satisfy the wait below alone.
        if (existsSync(realFile)) sawRealFile = true;
      },
      isSkippedPath
    );
    writeFileSync(join(dir, '.dispatch', 'runs', 'r-1.jsonl'), '{}\n');
    // Several debounce windows, so a delayed fs event has to be very late
    // indeed to land after it and read as a pass.
    await new Promise((resolve) => setTimeout(resolve, 1000));
    expect(calls).toBe(0);

    // A real source change still reaches onChange — the watcher is alive,
    // it just filtered the .dispatch write above.
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('watcher did not fire onChange in time')),
        15_000
      );
      const check = setInterval(() => {
        if (sawRealFile) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 20);
    });
    writeFileSync(realFile, 'export const x = 1;\n');
    await changed;
  }, 30_000);
});
