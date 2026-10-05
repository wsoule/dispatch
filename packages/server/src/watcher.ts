import { taskIdFromFilename } from '@dispatch-foo/core';
import type { FSWatcher, Stats } from 'node:fs';
import { existsSync, mkdirSync, readdirSync, statSync, watch } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

export interface Watcher {
  close(): void;
}

// How a watcher is created, injectable so a test can drive the failure path
// below without needing the OS to produce a real watch error.
export type WatchFactory = (
  dir: string,
  options: { recursive?: boolean },
  listener: (event: string, filename: string | Buffer | null) => void
) => FSWatcher;

// A live watch that fails (an inotify limit hit registering a subdirectory)
// emits 'error', which an FSWatcher with no listener rethrows uncaught.
function reportWatchFailures(watcher: FSWatcher, dir: string): FSWatcher {
  watcher.on('error', (err: Error) => {
    console.error(`dispatchd: watch on ${dir} stopped: ${err.message}`);
    try {
      watcher.close();
    } catch {
      // A watcher that just died is allowed to fail its own close too.
    }
  });
  return watcher;
}

// Editors and CLI writes both tend to emit several fs events for what a human
// considers one change (e.g. write-then-rename). Collapsing them behind a
// short debounce means one cache refresh + one broadcast per logical change
// instead of one per raw fs event.
const DEBOUNCE_MS = 100;

// What one file name says about the task set: the id of the task it holds,
// `null` when only a full rescan can tell (no filename, or a `.md` file that
// names no task), or `undefined` for a file the store never reads (an
// editor's swap file, .DS_Store).
function taskIdOfFile(
  filename: string | Buffer | null | undefined
): string | null | undefined {
  // Linux can report a change with no filename at all, as null or undefined.
  if (filename === null || filename === undefined) return null;
  const name = typeof filename === 'string' ? filename : filename.toString();
  if (!name.endsWith('.md')) return undefined;
  return taskIdFromFilename(name.slice(0, -'.md'.length));
}

// Each `.md` file in the tasks dir mapped to a stamp that moves whenever the
// file is rewritten (ctime/mtime, size) or replaced by a rename (inode).
type Listing = Map<string, string>;

function stampOf(stats: Stats): string {
  return `${stats.ino}:${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}`;
}

// A file gone between the listing and its stat is left out: it is removed.
function listTaskFilesSync(dir: string): Listing {
  const listing: Listing = new Map();
  for (const name of readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    try {
      listing.set(name, stampOf(statSync(join(dir, name))));
    } catch {
      // Removed mid-listing.
    }
  }
  return listing;
}

// listTaskFilesSync off the event loop; null when the directory can't be read.
async function listTaskFiles(dir: string): Promise<Listing | null> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.md'));
  } catch {
    return null;
  }
  const stamped = await Promise.all(
    names.map(async (name) => {
      const stats = await stat(join(dir, name)).catch(() => null);
      return stats === null ? [] : [[name, stampOf(stats)] as const];
    })
  );
  return new Map(stamped.flat());
}

// The ids of the tasks whose files were added, removed or rewritten between
// two listings, or null when one of those files names no task.
function changedTaskIds(before: Listing, after: Listing): Set<string> | null {
  const ids = new Set<string>();
  const note = (name: string): boolean => {
    const id = taskIdOfFile(name);
    if (id === null || id === undefined) return false;
    ids.add(id);
    return true;
  };
  for (const [name, stamp] of after) {
    if (before.get(name) !== stamp && !note(name)) return null;
  }
  for (const name of before.keys()) {
    if (!after.has(name) && !note(name)) return null;
  }
  return ids;
}

// Watches `tasksDir` non-recursively (task files are flat, one level deep)
// and invokes `onChange` at most once per DEBOUNCE_MS-wide burst of activity,
// with the ids of the tasks whose files changed — or null when some change
// could not be tied to a task. Event names are only hints (Bun 1.3 on macOS
// names a few files for a git checkout's hundreds), so each burst also diffs
// a stat listing of the directory, first taken here: load the task set after.
export function watchTasks(
  tasksDir: string,
  onChange: (ids: string[] | null) => void,
  createWatcher: WatchFactory = watch
): Watcher {
  // `node:fs.watch` throws ENOENT if the directory doesn't exist, which would
  // crash startServer at boot. A daemon can legitimately be pointed at a root
  // whose `.dispatch/tasks` is missing — a stale worktree, a `.dispatch` that
  // was partially removed, or a root initialized without the tasks dir yet — so
  // create it rather than letting the watcher take the process down. This
  // mirrors the "the daemon must never die from file content" invariant to the
  // directory-existence case.
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  let named: Set<string> | null = new Set();
  let listing = listTaskFilesSync(tasksDir);
  let closed = false;
  // One burst at a time, so each diffs against the listing the last one left.
  let settling: Promise<void> = Promise.resolve();

  const settle = async (): Promise<void> => {
    const hints = named;
    named = new Set();
    const next = await listTaskFiles(tasksDir);
    if (closed) return;
    const moved = next === null ? null : changedTaskIds(listing, next);
    if (next !== null) listing = next;
    onChange(
      hints === null || moved === null
        ? null
        : [...new Set([...hints, ...moved])]
    );
  };

  const fsWatcher = reportWatchFailures(
    createWatcher(tasksDir, {}, (_event, filename) => {
      const id = taskIdOfFile(filename);
      if (id === undefined) return;
      if (id === null) named = null;
      else named?.add(id);
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        settling = settling.then(settle).catch((err: unknown) => {
          console.error(
            `dispatchd: task watcher refresh failed: ${(err as Error).message}`
          );
        });
      }, DEBOUNCE_MS);
    }),
    tasksDir
  );
  return {
    close() {
      closed = true;
      if (timer !== null) clearTimeout(timer);
      fsWatcher.close();
    },
  };
}

// Watches each of `dirs` recursively; a dir that fails to watch is skipped.
// `shouldIgnore` filters events by path, e.g. a build's own dist/ output.
export function watchSourceDirs(
  dirs: string[],
  onChange: () => void,
  shouldIgnore: (changedPath: string) => boolean = () => false,
  createWatcher: WatchFactory = watch
): Watcher {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const schedule = () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, DEBOUNCE_MS);
  };
  const watchers = dirs.flatMap((dir) => {
    if (!existsSync(dir)) return [];
    try {
      return [
        reportWatchFailures(
          createWatcher(dir, { recursive: true }, (_event, filename) => {
            if (typeof filename === 'string' && shouldIgnore(filename)) return;
            schedule();
          }),
          dir
        ),
      ];
    } catch (err) {
      // Logged, not swallowed: a dropped watch (e.g. an inotify limit) leaves
      // the depmap silently stale otherwise.
      console.error(
        `dispatchd: failed to watch ${dir} for source changes: ${(err as Error).message}`
      );
      return [];
    }
  });
  return {
    close() {
      if (timer !== null) clearTimeout(timer);
      for (const w of watchers) w.close();
    },
  };
}
