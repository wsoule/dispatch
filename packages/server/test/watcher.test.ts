import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Watcher } from '../src/watcher.js';
import { watchTasks } from '../src/watcher.js';

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

  it('collapses a burst of writes into a single onChange call', async () => {
    let calls = 0;
    const done = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error('watcher did not fire onChange in time')),
        2000
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
  });
});
