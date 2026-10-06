import type { DispatchConfig, PackageManager } from '@dispatch-foo/core';
import {
  childEnv,
  detectPackageManager,
  detectPreviewCommand,
  previewEnv,
  previewSettings,
} from '@dispatch-foo/core';
import { spawn } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';

// The per-run dev-server supervisor: what turns a finished run from a diff you
// read into an app you look at. One dev server per run, started inside that
// run's own worktree, reachable through the daemon at /preview/<runId>/.
//
// Everything that touches the outside world — spawning, probing, the clock —
// is injectable, so the tests drive the whole lifecycle without starting a
// real server or waiting on a real timeout.

/** What a preview is doing right now. */
type PreviewStatus = 'starting' | 'ready' | 'failed' | 'stopped';

/** One run's preview, as clients see it. */
export interface PreviewState {
  runId: string;
  status: PreviewStatus;
  /** The loopback port the dev server was told to bind. */
  port: number;
  /** Where the app should point an iframe. Always daemon-relative: the dev
   *  server's own port is an implementation detail clients never need, and
   *  keeping it private is what stops a preview being linked to directly. */
  url: string;
  /** The command that was run, so a failure names what actually ran. */
  command: string;
  /** Why a `failed` preview failed. Absent in every other status. */
  error?: string;
  startedAt: string;
  /** When the proxy last served a request for this preview. The idle sweep
   *  reads it; without it a preview left open in a background tab runs a dev
   *  server forever. */
  lastRequestedAt: string;
}

/** The one thing the supervisor needs from a real child process. */
interface PreviewProcess {
  /** Terminates the process and everything it spawned. */
  kill: () => void;
}

/** How a preview command becomes a running process. Injected so tests never
 *  spawn anything. */
export type PreviewSpawn = (input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** Called when the process exits on its own — a dev server that dies of a
   *  config error must not leave the preview claiming to be starting. */
  onExit: (code: number | null) => void;
}) => PreviewProcess;

/** Whether anything is answering on a port yet. */
type PreviewProbe = (port: number) => Promise<boolean>;

export interface PreviewSupervisorOptions {
  /** Read fresh per start, so editing `preview:` does not need a restart. */
  loadConfig: () => DispatchConfig;
  spawn?: PreviewSpawn;
  probe?: PreviewProbe;
  allocatePort?: () => number;
  now?: () => Date;
  /** Wait between readiness probes. Injected so tests do not really sleep. */
  sleep?: (ms: number) => Promise<void>;
  /** Called whenever a preview stops — asked to, swept as idle, or at
   *  shutdown — so anything serving it (the team-local gateway) goes with it
   *  rather than holding a port open onto a dead dev server. */
  onStop?: (runId: string) => void;
}

/** Why `ensure` produced no preview. Separate from a `failed` state because
 *  "this repo has no dev script" is an ordinary fact about a repo, not a
 *  fault, and a surface should say so differently from a crash. */
type PreviewRefusal =
  | { reason: 'disabled' }
  | { reason: 'no-command' }
  | { reason: 'no-worktree' };

export type EnsurePreviewResult =
  | { ok: true; preview: PreviewState }
  | { ok: false; refusal: PreviewRefusal };

// 250ms between readiness probes: fast enough that a warm dev server feels
// instant, slow enough that a cold one is not probed hundreds of times.
const PROBE_INTERVAL_MS = 250;

/**
 * Asks the OS for a free loopback port by binding one and letting go.
 *
 * Inherently racy — something else can take the port between the close and
 * the dev server's bind. That is why `detectPreviewCommand` passes
 * `--strictPort` where it can: losing the race then fails the preview loudly
 * instead of leaving the proxy pointed at a stranger's server.
 */
function allocateLoopbackPort(): number {
  const server = createServer();
  server.listen(0, '127.0.0.1');
  const address = server.address();
  server.close();
  if (address === null || typeof address === 'string') {
    throw new Error('could not allocate a preview port');
  }
  return address.port;
}

/** Spawns the command in its own process group, so killing the preview kills
 *  the whole tree. A dev server is usually a package-manager script that
 *  spawns the real server as a child: signalling only the direct child would
 *  orphan that grandchild, leaving the port held and the preview unable to
 *  restart. `detached` plus a negative-pid kill is what avoids it. */
function spawnDetached(input: {
  command: string;
  cwd: string;
  env: Record<string, string>;
  onExit: (code: number | null) => void;
}): PreviewProcess {
  const child = spawn('bash', ['-lc', input.command], {
    cwd: input.cwd,
    env: childEnv(input.env),
    detached: true,
    stdio: 'ignore',
  });
  child.on('exit', (code) => input.onExit(code));
  // A spawn that never started has no pid to signal; `error` fires instead
  // of `exit` in that case, so both have to reach the same handler or the
  // preview sits in `starting` until its timeout.
  child.on('error', () => input.onExit(null));
  return {
    kill: () => {
      if (child.pid === undefined) return;
      try {
        // Negative pid = the whole process group (see spawnDetached's note).
        process.kill(-child.pid, 'SIGTERM');
      } catch {
        // Already gone. Killing a dead process is the outcome we wanted.
      }
    },
  };
}

/** The default readiness check: anything that answers counts, including a 404
 *  or a 500. The question is whether a server is listening, not whether the
 *  app's routes are right — a dev server returning 500 on `/` is still a
 *  preview worth showing, and waiting for a 200 would hang on every app whose
 *  root path redirects to a login. */
async function probePort(port: number): Promise<boolean> {
  try {
    await fetch(`http://127.0.0.1:${port}/`, {
      signal: AbortSignal.timeout(2000),
    });
    return true;
  } catch {
    return false;
  }
}

/** One live preview: what clients see, plus the handle needed to stop it. */
interface LivePreview {
  state: PreviewState;
  process: PreviewProcess;
}

export class PreviewSupervisor {
  private readonly previews = new Map<string, LivePreview>();
  private readonly opts: Required<PreviewSupervisorOptions>;

  constructor(opts: PreviewSupervisorOptions) {
    this.opts = {
      loadConfig: opts.loadConfig,
      spawn: opts.spawn ?? spawnDetached,
      probe: opts.probe ?? probePort,
      allocatePort: opts.allocatePort ?? allocateLoopbackPort,
      now: opts.now ?? (() => new Date()),
      sleep:
        opts.sleep ??
        ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
      onStop: opts.onStop ?? (() => {}),
    };
  }

  /** This run's preview, or undefined when it has none. */
  get(runId: string): PreviewState | undefined {
    return this.previews.get(runId)?.state;
  }

  /** Every preview the daemon is holding, for the runs list and the sweep. */
  list(): PreviewState[] {
    return [...this.previews.values()].map((live) => live.state);
  }

  /**
   * Records that the proxy just served a request for this preview.
   *
   * Idle previews are swept, so this is what keeps one a reviewer is actually
   * looking at alive. Called on every proxied request, so it stays a map
   * lookup and a date write and nothing else.
   */
  touch(runId: string): void {
    const live = this.previews.get(runId);
    if (live === undefined) return;
    live.state.lastRequestedAt = this.opts.now().toISOString();
  }

  /**
   * Starts this run's preview if it has none, and returns it either way.
   *
   * Deliberately on demand rather than eagerly for every run that reaches a
   * reviewable state: a dev server per finished run would install and boot N
   * checkouts nobody has asked to look at, which is the cost the direction
   * doc flagged. A reviewer opening the preview pane is the signal that one
   * is wanted.
   *
   * A preview that is already starting or ready is returned as is — two
   * reviewers opening the same run must not start two dev servers on two
   * ports.
   */
  async ensure(
    runId: string,
    worktreePath: string
  ): Promise<EnsurePreviewResult> {
    const existing = this.previews.get(runId);
    if (existing !== undefined && existing.state.status !== 'failed') {
      this.touch(runId);
      return { ok: true, preview: existing.state };
    }

    const settings = previewSettings(this.opts.loadConfig());
    if (!settings.enabled)
      return { ok: false, refusal: { reason: 'disabled' } };
    // A worktree that has been cleaned up (merged, discarded) cannot be
    // previewed, and saying so beats spawning a command in a missing cwd.
    if (!existsSync(worktreePath)) {
      return { ok: false, refusal: { reason: 'no-worktree' } };
    }

    const port = this.opts.allocatePort();
    const command = this.commandFor(worktreePath, settings.command, port);
    if (command === null)
      return { ok: false, refusal: { reason: 'no-command' } };

    // The install runs inside the same shell as the dev server rather than as
    // a separate supervised step: a run's worktree is a fresh checkout, so
    // most dev servers cannot boot without it, and chaining the two keeps one
    // process group to kill and one readiness deadline to honour.
    const full =
      settings.installCommand !== undefined &&
      !existsSync(join(worktreePath, 'node_modules'))
        ? `${settings.installCommand} && ${command}`
        : command;

    const startedAt = this.opts.now().toISOString();
    const state: PreviewState = {
      runId,
      status: 'starting',
      port,
      url: `/preview/${runId}/`,
      command: full,
      startedAt,
      lastRequestedAt: startedAt,
    };
    const process = this.opts.spawn({
      command: full,
      cwd: worktreePath,
      env: previewEnv(port),
      onExit: (code) => this.onProcessExit(runId, code),
    });
    this.previews.set(runId, { state, process });

    await this.waitForReady(runId, settings.readyTimeoutSec);
    return { ok: true, preview: this.previews.get(runId)?.state ?? state };
  }

  /** Stops one preview and forgets it. Safe to call for a run that has none —
   *  every caller (review, worktree cleanup, the sweep) would otherwise have
   *  to check first. */
  stop(runId: string): void {
    const live = this.previews.get(runId);
    if (live === undefined) return;
    live.process.kill();
    live.state.status = 'stopped';
    this.previews.delete(runId);
    this.opts.onStop(runId);
  }

  /** Stops everything. The daemon calls this on shutdown: a dev server that
   *  outlives the daemon holds a port nothing will ever reclaim. */
  stopAll(): void {
    for (const runId of [...this.previews.keys()]) this.stop(runId);
  }

  /**
   * Stops every preview that has had no request for longer than the
   * configured idle window. Returns the run ids it stopped, so the caller can
   * log or broadcast rather than this having to know how.
   */
  sweepIdle(): string[] {
    const { idleTimeoutSec } = previewSettings(this.opts.loadConfig());
    const cutoff = this.opts.now().getTime() - idleTimeoutSec * 1000;
    const swept: string[] = [];
    for (const [runId, live] of this.previews) {
      if (Date.parse(live.state.lastRequestedAt) > cutoff) continue;
      this.stop(runId);
      swept.push(runId);
    }
    return swept;
  }

  /** The configured command, or one detected from the worktree's own
   *  package.json. Null when the checkout names no dev script — an ordinary
   *  state for a library or a non-JS repo, not a failure. */
  private commandFor(
    worktreePath: string,
    configured: string | undefined,
    port: number
  ): string | null {
    if (configured !== undefined) return configured;
    const manifest = join(worktreePath, 'package.json');
    if (!existsSync(manifest)) return null;
    let scripts: Record<string, string> | undefined;
    try {
      scripts = (
        JSON.parse(readFileSync(manifest, 'utf8')) as {
          scripts?: Record<string, string>;
        }
      ).scripts;
    } catch {
      // A package.json that does not parse is the repo's problem to fix; here
      // it simply means nothing was detected.
      return null;
    }
    const manager: PackageManager = detectPackageManager(
      readdirSync(worktreePath)
    );
    return detectPreviewCommand(scripts, manager, port)?.command ?? null;
  }

  /** Polls until the dev server answers, the deadline passes, or the process
   *  dies. A preview that never became ready is marked failed rather than
   *  left claiming to be starting forever. */
  private async waitForReady(runId: string, timeoutSec: number): Promise<void> {
    const deadline = this.opts.now().getTime() + timeoutSec * 1000;
    for (;;) {
      const live = this.previews.get(runId);
      // Stopped, swept, or exited while we waited — all three mean there is
      // nothing left to mark ready.
      if (live === undefined || live.state.status !== 'starting') return;
      if (await this.opts.probe(live.state.port)) {
        live.state.status = 'ready';
        return;
      }
      if (this.opts.now().getTime() >= deadline) {
        this.fail(
          runId,
          `preview did not answer on port ${live.state.port} within ${timeoutSec}s`
        );
        return;
      }
      await this.opts.sleep(PROBE_INTERVAL_MS);
    }
  }

  /** A preview's process exited on its own. Before it was ready that is a
   *  startup failure worth reporting; after it was ready it is a dev server
   *  that crashed, which is the same thing from the reviewer's side. */
  private onProcessExit(runId: string, code: number | null): void {
    const live = this.previews.get(runId);
    if (live === undefined || live.state.status === 'stopped') return;
    this.fail(
      runId,
      code === null
        ? 'preview command could not be started'
        : `preview command exited with code ${code}`
    );
  }

  /** Marks a preview failed, keeping the entry so a client can read why. The
   *  next `ensure` replaces it — that is what makes a failed preview
   *  retryable without an explicit reset. */
  private fail(runId: string, error: string): void {
    const live = this.previews.get(runId);
    if (live === undefined) return;
    live.process.kill();
    live.state.status = 'failed';
    live.state.error = error;
  }
}
