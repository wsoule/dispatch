import { spawnSync } from 'node:child_process';

export interface SyncSpawnOptions {
  cwd?: string;
  env: Record<string, string | undefined>;
}

export interface SyncSpawnResult {
  /** Exit status, or null when the process never started or was killed. */
  status: number | null;
  stdout: string;
  stderr: string;
  /** Set when the process could not be started at all. */
  error?: Error;
}

export type SyncSpawner = (
  command: string,
  args: readonly string[],
  opts: SyncSpawnOptions
) => SyncSpawnResult;

function nodeSpawner(
  command: string,
  args: readonly string[],
  opts: SyncSpawnOptions
): SyncSpawnResult {
  const result = spawnSync(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: 'utf8',
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
    ...(result.error !== undefined ? { error: result.error } : {}),
  };
}

let spawner: SyncSpawner = nodeSpawner;

/**
 * Every synchronous child process core starts (git config for the merge
 * drivers, the carto probes) goes through here, so a host can choose how.
 *
 * The default is node's spawnSync, which is right for the CLI. The daemon
 * swaps in its own (spawnBlocking in packages/server/src/blockingGit.ts):
 * under Bun, node's spawnSync is Bun.spawnSync, which on bun <= 1.4.2 can
 * lose its child's exit and spin at 100% CPU forever (oven-sh/bun#34069) —
 * fatal to a daemon whose event loop serves every client.
 */
export function spawnSyncText(
  command: string,
  args: readonly string[],
  opts: SyncSpawnOptions
): SyncSpawnResult {
  return spawner(command, args, opts);
}

/** Replaces the process-wide spawner; null restores node's spawnSync. */
export function setSyncSpawner(next: SyncSpawner | null): void {
  spawner = next ?? nodeSpawner;
}
