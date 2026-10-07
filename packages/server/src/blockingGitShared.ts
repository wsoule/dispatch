// Messages between spawnGitSync (blockingGit.ts) and the worker thread that
// actually runs git (blockingGitWorker.ts). Kept in its own module so the
// worker entry imports no daemon code.
//
// The `signal` SharedArrayBuffer the two share holds two Int32 slots:
//   [0] READY_SLOT  set to 1 once the worker module has loaded
//   [1] DONE_SLOT   the id of the last request the worker finished
export const READY_SLOT = 0;
export const DONE_SLOT = 1;
export const SIGNAL_SLOTS = 2;

export interface BlockingGitWorkerData {
  signal: SharedArrayBuffer;
  /** Where finished results go; the main thread drains it synchronously. */
  results: MessagePort;
}

export type BlockingGitRequest =
  | {
      type: 'run';
      id: number;
      cmd: string[];
      cwd: string;
      env: Record<string, string | undefined>;
      /** SIGKILL the child after this long; undefined means never. */
      timeoutMs: number | undefined;
    }
  // The main thread stopped waiting for `id` (its own backstop expired): kill
  // the child so an abandoned git does not run on unobserved.
  | { type: 'cancel'; id: number };

export interface BlockingGitResponse {
  id: number;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  /**
   * Set when git could not be started at all (a missing cwd, no git on
   * PATH). spawnGitSync rethrows it, as Bun.spawnSync threw.
   */
  spawnError?: string;
}
