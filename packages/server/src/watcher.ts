import type { FSWatcher } from 'node:fs';
import { existsSync, mkdirSync, watch } from 'node:fs';

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
// short debounce means one cache rebuild + one broadcast per logical change
// instead of one per raw fs event.
const DEBOUNCE_MS = 100;

// Watches `tasksDir` non-recursively (task files are flat, one level deep)
// and invokes `onChange` at most once per DEBOUNCE_MS-wide burst of activity.
export function watchTasks(
  tasksDir: string,
  onChange: () => void,
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
  const fsWatcher = reportWatchFailures(
    createWatcher(tasksDir, {}, () => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(() => {
        timer = null;
        onChange();
      }, DEBOUNCE_MS);
    }),
    tasksDir
  );
  return {
    close() {
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
