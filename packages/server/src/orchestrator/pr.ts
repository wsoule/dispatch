import type { TaskStore } from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

export interface CommandResult {
  ok: boolean;
  stdout: string;
  stderr: string;
}

// The command-runner seam (mirrors worktree.ts's private `runGit`, but
// exposed and injectable here): every `gh`/`git push` call PrManager makes
// goes through this, so tests can stub `gh`/network entirely instead of
// requiring a real GitHub remote and an authenticated `gh` CLI.
//
// Minor fix: async (Bun.spawn + await under defaultCommandRunner, never
// Bun.spawnSync) — a real `gh pr create`/`git push`/`gh pr view` call can
// take a real amount of wall-clock time (network round trips to GitHub),
// and dispatchd is a single process serving every other HTTP request and
// live run on the same event loop; a synchronous shell-out here would stall
// all of that for as long as the git/gh call takes.
export type CommandRunner = (
  cwd: string,
  cmd: string[]
) => Promise<CommandResult>;

// Picks whichever of a failed command's stderr/stdout actually has content,
// preferring stderr — used instead of `stderr.trim() || stdout.trim()` so
// the choice is an explicit length check rather than relying on empty-string
// falsiness.
function commandErrorText(result: CommandResult): string {
  const stderr = result.stderr.trim();
  return stderr.length > 0 ? stderr : result.stdout.trim();
}

export async function defaultCommandRunner(
  cwd: string,
  cmd: string[]
): Promise<CommandResult> {
  const proc = Bun.spawn(cmd, { cwd, stdout: 'pipe', stderr: 'pipe' });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { ok: exitCode === 0, stdout, stderr };
}

// Whether this project can use the PR review action: `gh` must be reachable
// on PATH and the main checkout must have a configured `origin` remote.
// Called once at boot (see index.ts) and cached for the process lifetime —
// `GET /api/health` exposes the result as `pr` so a client can hide/disable
// the PR action without probing per-run.
export async function detectPrCapability(
  rootDir: string,
  run: CommandRunner = defaultCommandRunner
): Promise<boolean> {
  const gh = await run(rootDir, ['gh', '--version']);
  if (!gh.ok) return false;
  const remote = await run(rootDir, ['git', 'remote', 'get-url', 'origin']);
  return remote.ok;
}

export interface PrManagerContext {
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
}

/**
 * The PR review path (spec §5 Review): pushes a finished run's branch and
 * opens a GitHub PR via `gh pr create`, then polls that PR's merge state on
 * an interval, flipping the run to reviewed + the task to `done` the moment
 * GitHub reports it merged. Every `gh`/`git` invocation goes through the
 * injected (async) CommandRunner seam so tests never need a real remote or
 * a logged-in `gh` CLI, and so a slow real call never blocks the process.
 */
export class PrManager {
  private pollTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly ctx: PrManagerContext,
    private readonly capability: boolean,
    private readonly run: CommandRunner = defaultCommandRunner
  ) {}

  // POST /api/runs/:id/review { action: 'pr' }. Pushes the run's branch and
  // opens a PR — the run itself stays un-reviewed (reviewedAt unset) until
  // pollOnce() below sees it merged. 409s outright when this project lacks
  // the `pr` capability, matching the plan's "no remote/gh -> 409 with clear
  // message".
  async openPr(runId: string): Promise<RunMeta> {
    if (!this.capability) {
      throw new OrchestratorConflictError(
        'PR review requires the gh CLI and a configured git remote'
      );
    }
    const result = this.ctx.orchestrator.getRun(runId);
    if (result === null) {
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    }
    const { meta } = result;
    if (!TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(
        `run is not in a terminal state: ${runId} (state: ${meta.state})`
      );
    }
    if (meta.reviewedAt !== undefined) {
      throw new OrchestratorConflictError(
        `run has already been reviewed: ${runId}`
      );
    }
    if (meta.prUrl !== undefined) {
      throw new OrchestratorConflictError(
        `run already has an open PR: ${meta.prUrl}`
      );
    }

    const push = await this.run(meta.worktreePath, [
      'git',
      'push',
      '-u',
      'origin',
      meta.branch,
    ]);
    if (!push.ok) {
      throw new OrchestratorConflictError(
        `git push failed: ${commandErrorText(push)}`
      );
    }
    const body = `Automated PR opened by dispatch for task ${meta.taskId} (run ${meta.id}).`;
    const create = await this.run(meta.worktreePath, [
      'gh',
      'pr',
      'create',
      '--title',
      meta.taskTitle,
      '--body',
      body,
      '--base',
      meta.baseBranch,
      '--head',
      meta.branch,
    ]);
    if (!create.ok) {
      throw new OrchestratorConflictError(
        `gh pr create failed: ${commandErrorText(create)}`
      );
    }
    // `gh pr create`'s only stdout on success is the PR's URL (its last
    // non-empty line, per gh's own documented output contract).
    const url =
      create.stdout
        .split('\n')
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .pop() ?? '';

    const now = new Date().toISOString();
    this.ctx.store.update(
      meta.taskId,
      { appendActivity: `${now} run ${runId} opened PR: ${url}` },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    return this.ctx.orchestrator.setRunPrUrl(runId, url);
  }

  // Starts the merge poller on `intervalMs` (default 60s per the plan;
  // tests pass a much shorter interval via startServer's
  // `prPollIntervalMs`). A no-op if this project lacks the `pr` capability —
  // nothing was ever opened, so nothing needs polling.
  startPolling(intervalMs = 60000): void {
    if (!this.capability) return;
    // setInterval's callback can't be awaited directly; pollOnce() is async
    // now (minor fix), so each tick is fired-and-forgotten with its own
    // rejection handler — a single poll pass failing outright (as opposed
    // to one run's check failing, which pollOnce already isolates) must
    // never crash the timer or the process.
    this.pollTimer = setInterval(() => {
      void this.pollOnce().catch((err: unknown) => {
        console.error(
          `dispatchd: PR poll pass failed: ${(err as Error).message}`
        );
      });
    }, intervalMs);
  }

  stopPolling(): void {
    if (this.pollTimer !== undefined) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }

  // One poll pass: checks every run with an open (un-reviewed) PR via
  // `gh pr view --json state`, and flips it to reviewed+done the moment
  // GitHub reports it merged. A single run's check failing (bad JSON, `gh`
  // erroring for that one call) is skipped rather than aborting the whole
  // pass — one flaky call must never block every other run's poll. Runs
  // are checked sequentially (not Promise.all) — polling is already on a
  // long interval, and sequential checks keep at most one `gh` subprocess
  // in flight at a time.
  async pollOnce(): Promise<void> {
    for (const meta of this.ctx.orchestrator.list()) {
      if (meta.prUrl === undefined || meta.reviewedAt !== undefined) continue;
      const view = await this.run(meta.worktreePath, [
        'gh',
        'pr',
        'view',
        meta.prUrl,
        '--json',
        'state',
      ]);
      if (!view.ok) continue;
      let state: string | undefined;
      try {
        state = (JSON.parse(view.stdout) as { state?: string }).state;
      } catch {
        continue;
      }
      if (state === 'MERGED') {
        this.ctx.orchestrator.markRunMergedViaPr(meta.id);
      }
    }
  }
}
