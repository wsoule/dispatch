import { existsSync, mkdirSync, watch } from 'node:fs';

export interface Watcher {
  close(): void;
}

// Editors and CLI writes both tend to emit several fs events for what a human
// considers one change (e.g. write-then-rename). Collapsing them behind a
// short debounce means one cache rebuild + one broadcast per logical change
// instead of one per raw fs event.
const DEBOUNCE_MS = 100;

// Watches `tasksDir` non-recursively (task files are flat, one level deep)
// and invokes `onChange` at most once per DEBOUNCE_MS-wide burst of activity.
export function watchTasks(tasksDir: string, onChange: () => void): Watcher {
  // `node:fs.watch` throws ENOENT if the directory doesn't exist, which would
  // crash startServer at boot. A daemon can legitimately be pointed at a root
  // whose `.dispatch/tasks` is missing — a stale worktree, a `.dispatch` that
  // was partially removed, or a root initialized without the tasks dir yet — so
  // create it rather than letting the watcher take the process down. This
  // mirrors the "the daemon must never die from file content" invariant to the
  // directory-existence case.
  if (!existsSync(tasksDir)) mkdirSync(tasksDir, { recursive: true });
  let timer: ReturnType<typeof setTimeout> | null = null;
  const fsWatcher = watch(tasksDir, () => {
    if (timer !== null) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      onChange();
    }, DEBOUNCE_MS);
  });
  return {
    close() {
      if (timer !== null) clearTimeout(timer);
      fsWatcher.close();
    },
  };
}
