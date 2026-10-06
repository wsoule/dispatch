import {
  DISPATCH_DIR,
  loadConfig,
  syncSettings,
  updateConfig,
} from '@dispatch-foo/core';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Turning board sync on from `team start` or `team join` (team-easy): sync
// decides how ids are minted and which store everything is handed, so it is
// wired only at boot. Turning it on writes the config, then restarts the
// daemon in its own process with the same port and tokens, so every client
// stays signed in and simply asks again.
//
// Nothing live is cut short and nothing is left half done:
// - work in flight refuses the request, naming what it waits on;
// - from the moment one is accepted until the restart, nothing new starts
//   (the orchestrator is held, and the API refuses requests that change
//   anything), and later requests share the one restart already scheduled;
// - just before the stop, work is checked again; if any began, the restart
//   is abandoned and the config rolled back;
// - a restart that fails rolls the config back and boots as before.

/** What a request that needs sync gets back when sync is off. */
export type SharingAnswer =
  | { ok: true; message: string }
  | { ok: false; status: number; code: string; error: string };

export interface SharingDeps {
  rootDir: string;
  /** This server's own restart mark. */
  state: SharingState;
  /** Only the database backend syncs this way. */
  backend: 'sqlite' | 'files';
  /** What a restart would interrupt, in words; empty when idle. */
  liveWork: () => string[];
  /** Restarts this daemon with the same port and tokens. `rollback` restores
   *  the config as it was; a restart whose new boot fails calls it, then
   *  boots again as before. Absent when the process cannot restart itself. */
  restart?: (rollback: () => void) => Promise<void>;
  /** Where the sync branch would go, or null when nothing resolves. */
  resolveRemote: (
    target: { remote: string } | { repo: string }
  ) => Promise<string | null>;
  /** The clock team actions read (the federation's, which tests set). */
  now: () => Date;
  /** Stops and lets go of every new run start (Orchestrator.hold). */
  hold: (why: string) => void;
  release: () => void;
  /** Tests only: the wait before the restart, and a call once it settled. */
  delayMs?: number;
  settled?: () => void;
}

// How long the answer has to leave before the restart closes the socket.
const RESTART_AFTER_MS = 100;
const HELD =
  'Dispatch is restarting for this project to turn on team sync; try again in a moment.';

/** One server's restart to turn on sync: whether one is scheduled. Each
 *  server owns its own, so a mark can never reach another server in the
 *  same process; stopping the server clears it. */
export class SharingState {
  private scheduled = false;

  get pending(): boolean {
    return this.scheduled;
  }

  /** Marks a restart scheduled; false when one already was. */
  claim(): boolean {
    if (this.scheduled) return false;
    this.scheduled = true;
    return true;
  }

  clear(): void {
    this.scheduled = false;
  }
}

/** Whether the API refuses this request while a restart is pending:
 *  everything but reads and the team start or join that share it. */
export function frozenBySharing(
  state: SharingState | undefined,
  method: string,
  segments: readonly string[]
): boolean {
  if (state?.pending !== true) return false;
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS')
    return false;
  return !(
    segments.length === 2 &&
    segments[0] === 'team' &&
    (segments[1] === 'start' || segments[1] === 'join')
  );
}

/** The refusal the API answers a frozen request with. */
export const FROZEN_MESSAGE = HELD;

/**
 * Turns board sync on and schedules the restart that wires it, or answers
 * why it cannot. The caller answers the request with it, then the client
 * waits for sync to be on and sends the same request again.
 */
export async function turnOnSharing(
  deps: SharingDeps,
  /** What the request can be refused for before anything changes; it
   *  throws, and nothing is written or restarted. */
  precheck: (now: Date) => void = () => {}
): Promise<SharingAnswer> {
  precheck(deps.now());
  const accepted: SharingAnswer = {
    ok: true,
    message:
      'Turned on team sync; Dispatch is restarting for this project. Your request goes through once it is back.',
  };
  // One restart however many ask: a later request rides the scheduled one.
  if (deps.state.pending) return accepted;
  const refuse = (status: number, code: string, error: string) =>
    ({ ok: false, status, code, error }) as const;
  if (deps.backend !== 'sqlite')
    return refuse(
      409,
      'sync_unavailable',
      "This board is kept as files, which board sync can't carry, so it can't join a team."
    );
  const restart = deps.restart;
  if (restart === undefined)
    return refuse(
      409,
      'sync_off',
      'Board sync is off. Turn it on in Settings → Board sync (or set `sync.enabled: true` in .dispatch/config.yml), then restart Dispatch for this project.'
    );
  const busy = (live: string[]) =>
    `Turning on team sync restarts Dispatch for this project, which would stop ${live.join(', ')}. Run this again once they finish.`;
  const live = deps.liveWork();
  if (live.length > 0) return refuse(409, 'busy', busy(live));
  const settings = syncSettings(loadConfig(deps.rootDir));
  const target =
    settings.repo === undefined
      ? { remote: settings.remote }
      : { repo: settings.repo };
  const remote = await deps.resolveRemote(target);
  // Asked again after the await: another request may have got here first.
  if (deps.state.pending) return accepted;
  if (remote === null)
    return refuse(
      409,
      'no_remote',
      settings.repo === undefined
        ? `Team sync rides a branch on this project's "${settings.remote}" git remote, and it has none. Add the remote your teammates push to, then run this again.`
        : `Team sync rides ${settings.repo}, which Dispatch can't reach. Check sync.repo in Settings → Board sync, then run this again.`
    );
  if (!deps.state.claim()) return accepted;
  deps.hold(HELD);
  const rollback = configRollback(deps.rootDir);
  try {
    updateConfig(deps.rootDir, { sync: { enabled: true } });
  } catch (err) {
    rollback();
    deps.release();
    deps.state.clear();
    throw err;
  }
  setTimeout(() => {
    void finish(deps, restart, rollback);
  }, deps.delayMs ?? RESTART_AFTER_MS);
  return accepted;
}

// The restart itself, once the answer has left: work is checked a last time
// (the hold keeps runs from starting, but a terminal or browser opened
// before it would still be cut short), then the daemon restarts.
async function finish(
  deps: SharingDeps,
  restart: (rollback: () => void) => Promise<void>,
  rollback: () => void
): Promise<void> {
  try {
    const live = deps.liveWork();
    if (live.length > 0) {
      rollback();
      deps.release();
      console.error(
        `dispatchd: NOT restarting to turn on team sync: ${live.join(', ')} started meanwhile. Config rolled back; ask again once they finish.`
      );
      return;
    }
    await restart(rollback);
  } catch (err) {
    rollback();
    console.error(
      `dispatchd: RESTART TO TURN ON TEAM SYNC FAILED: ${(err as Error).message}. Config rolled back.`
    );
  } finally {
    deps.state.clear();
    deps.settled?.();
  }
}

// Restores config.yml byte for byte as it is now (or removes it if absent).
function configRollback(rootDir: string): () => void {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  const before = existsSync(path) ? readFileSync(path, 'utf8') : null;
  return () => {
    if (before === null) rmSync(path, { force: true });
    else writeFileSync(path, before);
  };
}
