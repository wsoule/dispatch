import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { EventEmitter } from 'node:events';
import type { FSWatcher } from 'node:fs';
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isSkippedPath } from '../src/depmap.js';
import type { Watcher, WatchFactory } from '../src/watcher.js';
import { watchSourceDirs, watchTasks } from '../src/watcher.js';

// Stands in for an FSWatcher so a test can emit the async 'error' event a real
// one only produces under an OS condition (inotify ENOSPC) darwin cannot stage.
class FakeFSWatcher extends EventEmitter {
  closed = false;

  close(): void {
    this.closed = true;
  }
}

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

describe('watchTasks on a real burst', () => {
  // A git checkout or pull rewrites many task files at once. Bun 1.3 on macOS
  // reports a few of them; every one has to reach the caller.
  it('reports every task file a burst rewrote', async () => {
    const ids = Array.from(
      { length: 30 },
      (_, n) => store.create({ title: `Task ${n}` }).meta.id
    );
    const seen = new Set<string>();
    const complete = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`watcher reported ${seen.size} of 30`)),
        15_000
      );
      watcher = watchTasks(store.tasksDir, (changed) => {
        for (const id of changed ?? ids) seen.add(id);
        if (seen.size === ids.length) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    for (const id of ids) store.update(id, { status: 'working' });
    await complete;
    expect([...seen].sort()).toEqual([...ids].sort());
  }, 30_000);
});

describe('watchTasks ids', () => {
  // Drives the listener directly, so the assertion is about which names map
  // to which ids, not about when macOS delivers the events.
  function watchWithFake(): {
    emit: (filename: string | null | undefined) => void;
    next: () => Promise<string[] | null>;
  } {
    let listener: ((event: string, filename: string | null) => void) | null =
      null;
    const factory: WatchFactory = (_dir, _opts, l) => {
      listener = l;
      return new FakeFSWatcher() as unknown as FSWatcher;
    };
    const calls: (string[] | null)[] = [];
    let wake: (() => void) | null = null;
    watcher = watchTasks(
      store.tasksDir,
      (ids) => {
        calls.push(ids);
        wake?.();
      },
      factory
    );
    return {
      // Node's types say null, but Bun on Linux also passes undefined.
      emit: (filename) => listener?.('rename', filename as string | null),
      next: async () => {
        if (calls.length === 0) {
          await new Promise<void>((resolve) => (wake = resolve));
        }
        return calls.shift() ?? null;
      },
    };
  }

  it('names the tasks whose files a burst touched, once each', async () => {
    const fake = watchWithFake();
    fake.emit('t-00000a-first.md');
    fake.emit('t-00000a-first.md');
    fake.emit('t-00000a-renamed.md');
    fake.emit('e-00000b.md');
    expect((await fake.next())?.sort()).toEqual(['e-00000b', 't-00000a']);
  });

  it('ignores files the store never reads', async () => {
    const fake = watchWithFake();
    fake.emit('.DS_Store');
    fake.emit('t-00000a-first.md.swp');
    fake.emit('t-00000c-real.md');
    expect(await fake.next()).toEqual(['t-00000c']);
  });

  it('finds the changes a burst made that its events did not name', async () => {
    const kept = store.create({ title: 'Kept' });
    const gone = store.create({ title: 'Gone' });
    const fake = watchWithFake();
    store.update(kept.meta.id, { title: 'Kept, retitled' });
    store.remove(gone.meta.id);
    const added = store.create({ title: 'Added' });
    // Bun 1.3 on macOS can name one file for a burst that touched several.
    fake.emit(`${added.meta.id}-added.md`);
    expect((await fake.next())?.sort()).toEqual(
      [kept.meta.id, gone.meta.id, added.meta.id].sort()
    );
  });

  it('asks for a full rescan when an unnamed change is to a file naming no task', async () => {
    const fake = watchWithFake();
    writeFileSync(join(store.tasksDir, 'notes.md'), 'scratch\n');
    fake.emit('t-00000a-first.md');
    expect(await fake.next()).toBeNull();
  });

  it('asks for a full rescan when an event names no task', async () => {
    const fake = watchWithFake();
    fake.emit('t-00000a-first.md');
    fake.emit('notes.md');
    expect(await fake.next()).toBeNull();
    // The next burst starts over.
    fake.emit('t-00000d-later.md');
    expect(await fake.next()).toEqual(['t-00000d']);
    fake.emit(null);
    expect(await fake.next()).toBeNull();
  });

  // Bun on Linux can pass no filename at all rather than null.
  it('asks for a full rescan when an event carries no filename', async () => {
    const fake = watchWithFake();
    fake.emit(undefined);
    expect(await fake.next()).toBeNull();
  });
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

describe('a watch that fails after it started', () => {
  // An inotify ENOSPC while a recursive watch registers a new subdirectory
  // arrives this way. It cannot be staged on darwin, so the watcher is faked.
  it('is logged and closed by watchSourceDirs rather than rethrown', () => {
    const fake = new FakeFSWatcher();
    const factory: WatchFactory = () => fake as unknown as FSWatcher;
    // Unguarded, an EventEmitter rethrows an 'error' nobody listens for — which
    // is what makes a missing listener a dead daemon rather than a dead watch.
    expect(() => fake.emit('error', new Error('ENOSPC'))).toThrow('ENOSPC');

    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      watcher = watchSourceDirs(
        [root],
        () => {},
        () => false,
        factory
      );
      expect(() =>
        fake.emit('error', new Error('ENOSPC: inotify watch limit reached'))
      ).not.toThrow();
      expect(String(errors.mock.calls[0]?.[0])).toContain(root);
      expect(String(errors.mock.calls[0]?.[0])).toContain('ENOSPC');
    } finally {
      errors.mockRestore();
    }
    expect(fake.closed).toBe(true);
  });

  it('is logged and closed by watchTasks rather than rethrown', () => {
    const fake = new FakeFSWatcher();
    const factory: WatchFactory = () => fake as unknown as FSWatcher;
    const errors = spyOn(console, 'error').mockImplementation(() => {});
    try {
      watcher = watchTasks(store.tasksDir, () => {}, factory);
      expect(() =>
        fake.emit('error', new Error('EMFILE: too many open files'))
      ).not.toThrow();
      expect(String(errors.mock.calls[0]?.[0])).toContain(store.tasksDir);
    } finally {
      errors.mockRestore();
    }
    expect(fake.closed).toBe(true);
  });
});
