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

// Waits for onChange to fire, rejecting after `timeoutMs` so a broken watcher
// fails the test loudly instead of hanging.
function waitForChange(tasksDir: string, timeoutMs = 2000): Promise<void> {
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
  });

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
    let calls = 0;
    watcher = watchSourceDirs(
      [dir],
      () => {
        calls += 1;
      },
      isSkippedPath
    );
    writeFileSync(join(dir, '.dispatch', 'runs', 'r-1.jsonl'), '{}\n');
    // Give the ignored write a full debounce window to (not) fire.
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(calls).toBe(0);

    // A real source change still reaches onChange — the watcher is alive,
    // it just filtered the .dispatch write above.
    const changed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('watcher did not fire onChange in time')),
        3000
      );
      const check = setInterval(() => {
        if (calls > 0) {
          clearInterval(check);
          clearTimeout(timer);
          resolve();
        }
      }, 20);
    });
    writeFileSync(join(dir, 'real.ts'), 'export const x = 1;\n');
    await changed;
  });
});
