import { loadConfig, syncSettings, updateConfig } from '@dispatch-foo/core';

// Turning board sync on from `team start` or `team join` (team-easy): sync
// decides how ids are minted and which store everything is handed, so it is
// wired only at boot. Turning it on writes the config, then restarts the
// daemon in its own process with the same port and tokens, so every client
// stays signed in and simply asks again. Nothing live is ever cut short: a
// daemon with work in flight refuses and says what it is waiting on.

/** What a request that needs sync gets back when sync is off. */
export type SharingAnswer =
  | { ok: true; message: string }
  | { ok: false; status: number; code: string; error: string };

export interface SharingDeps {
  rootDir: string;
  /** Only the database backend syncs this way. */
  backend: 'sqlite' | 'files';
  /** What a restart would interrupt, in words; empty when idle. */
  liveWork: () => string[];
  /** Restarts this daemon with the same port and tokens; absent when the
   *  process that runs it cannot (a daemon embedded without one). */
  restart?: () => Promise<void>;
  /** Where the sync branch would go, or null when nothing resolves. */
  resolveRemote: (
    target: { remote: string } | { repo: string }
  ) => Promise<string | null>;
  /** The clock team actions read (the federation's, which tests set). */
  now: () => Date;
}

// How long the answer has to leave before the restart closes the socket.
const RESTART_AFTER_MS = 100;

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
  const refuse = (status: number, code: string, error: string) =>
    ({ ok: false, status, code, error }) as const;
  if (deps.backend !== 'sqlite')
    return refuse(
      409,
      'sync_unavailable',
      "This board is kept as files, which board sync can't carry, so it can't join a team."
    );
  if (deps.restart === undefined)
    return refuse(
      409,
      'sync_off',
      'Board sync is off. Turn it on in Settings → Board sync (or set `sync.enabled: true` in .dispatch/config.yml), then restart Dispatch for this project.'
    );
  const live = deps.liveWork();
  if (live.length > 0)
    return refuse(
      409,
      'busy',
      `Turning on team sync restarts Dispatch for this project, which would stop ${live.join(', ')}. Run this again once they finish.`
    );
  const settings = syncSettings(loadConfig(deps.rootDir));
  const target =
    settings.repo === undefined
      ? { remote: settings.remote }
      : { repo: settings.repo };
  if ((await deps.resolveRemote(target)) === null)
    return refuse(
      409,
      'no_remote',
      settings.repo === undefined
        ? `Team sync rides a branch on this project's "${settings.remote}" git remote, and it has none. Add the remote your teammates push to, then run this again.`
        : `Team sync rides ${settings.repo}, which Dispatch can't reach. Check sync.repo in Settings → Board sync, then run this again.`
    );
  updateConfig(deps.rootDir, { sync: { enabled: true } });
  const restart = deps.restart;
  setTimeout(() => {
    restart().catch((err: unknown) => {
      console.error(
        `dispatchd: could not restart to turn on board sync: ${(err as Error).message}`
      );
    });
  }, RESTART_AFTER_MS);
  return {
    ok: true,
    message:
      'Turned on team sync; Dispatch is restarting for this project. Your request goes through once it is back.',
  };
}
