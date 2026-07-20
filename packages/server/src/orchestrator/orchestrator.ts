import {
  DISPATCH_DIR,
  generateRunId,
  loadConfig,
  slugify,
  TaskParseError,
  TaskStore,
} from '@dispatch/core';
import type { OrchestratorConfig, TaskDoc, UpdatePatch } from '@dispatch/core';
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import {
  runsDir,
  transcriptPath,
  worktreePath,
  worktreesDir,
} from './paths.js';
import { buildTaskPrompt } from './prompt.js';
import { RunRegistry } from './registry.js';
import { replayTranscript, Transcript } from './transcript.js';
import type {
  Executor,
  ExecutorEvents,
  NormalizedEntry,
  RunMeta,
  RunState,
} from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';
import type { DiffResult } from './worktree.js';
import { WorktreeManager } from './worktree.js';

export interface OrchestratorContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
}

/**
 * Coordinates the full lifecycle of orchestrator runs for one dispatch
 * project: provisioning a git worktree, starting an Executor, recording its
 * NormalizedEntry stream + state transitions to a per-run transcript, and
 * applying the resulting Task Activity/status writes the plan requires.
 *
 * The registry (in-memory) is the fast path for anything about a live or
 * recently-created run; transcripts on disk are the durable record that
 * survives a dispatchd restart (see `reconcileOnBoot` and `getRun`'s
 * fallback path).
 */
export class Orchestrator {
  private readonly registry = new RunRegistry();
  private readonly worktrees: WorktreeManager;
  private readonly executors = new Map<string, Executor>();

  constructor(private readonly ctx: OrchestratorContext) {
    this.worktrees = new WorktreeManager(ctx.rootDir);
  }

  registerExecutor(name: string, executor: Executor): void {
    this.executors.set(name, executor);
  }

  // M6: api.ts derives its own "is this executor name even valid" 400
  // message from exactly what's registered here, instead of maintaining a
  // separately hardcoded list that can silently drift from it.
  registeredExecutorNames(): string[] {
    return [...this.executors.keys()];
  }

  list(): RunMeta[] {
    return this.registry.list();
  }

  // Live runs (and anything hydrated by reconcileOnBoot) come straight from
  // the in-memory registry; a run this process has never seen — the same
  // rootDir after a restart with no reconciliation yet — falls back to
  // replaying its transcript file directly, since that's the only place its
  // state still exists.
  getRun(id: string): { meta: RunMeta; entries: NormalizedEntry[] } | null {
    const meta = this.registry.get(id);
    if (meta !== undefined) {
      const entries = this.transcriptFor(id)
        .read()
        .filter((line) => line.type === 'entry')
        .map((line) => line.entry);
      return { meta, entries };
    }
    return replayTranscript(transcriptPath(this.ctx.rootDir, id));
  }

  // Starts a new run for `taskId` on `executorName`. Refuses (409) if the
  // task already has a live run, and (400) if the executor name isn't
  // registered — O1 only ever registers 'fake'; 'claude' arrives in O2.
  dispatch(taskId: string, executorName: string): RunMeta {
    const task = this.ctx.store.get(taskId);
    if (task === null) {
      throw new OrchestratorNotFoundError(`task not found: ${taskId}`);
    }
    const live = this.registry.liveRunForTask(taskId);
    if (live !== undefined) {
      throw new OrchestratorConflictError(
        `task already has a live run: ${live.id}`
      );
    }
    const executor = this.executors.get(executorName);
    if (executor === undefined) {
      throw new OrchestratorClientError(`unknown executor: ${executorName}`);
    }

    const baseBranch = this.worktrees.defaultBaseBranch();
    const now = new Date().toISOString();
    const runId = generateRunId(now);
    // Suffixed with the run's own hex tag (stripping its `r-` prefix) so two
    // runs against the same task never collide on branch name — a task can
    // have several finished-but-unreviewed runs sitting in parallel until
    // each is merged/discarded, each keeping its own worktree/branch until
    // then. `sendMessage(..., { resume: true })` intentionally reuses the
    // *same* branch/worktree instead of generating a new one here.
    const branch = `dispatch/${taskId}-${slugify(task.meta.title)}-${runId.slice(2)}`;
    const wtPath = worktreePath(this.ctx.rootDir, runId);

    this.worktrees.add(wtPath, branch, baseBranch);

    const meta: RunMeta = {
      id: runId,
      taskId,
      taskTitle: task.meta.title,
      executor: executorName,
      state: 'provisioning',
      branch,
      baseBranch,
      worktreePath: wtPath,
      createdAt: now,
      updatedAt: now,
    };
    this.registry.create(meta);
    this.transcriptFor(runId).writeHeader(meta);

    this.ctx.store.update(
      taskId,
      {
        status: 'in-progress',
        appendActivity: `${now} dispatched (${executorName}, branch ${branch})`,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    this.transition(runId, 'running');
    const caps = this.orchestratorCaps();
    const executorRun = executor.start(
      {
        cwd: wtPath,
        prompt: this.promptForTask(task),
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
      },
      this.makeEvents(runId)
    );
    this.registry.setExecutorRun(runId, executorRun);

    return this.registry.get(runId)!;
  }

  // Answers a pending approval request. Only valid while the run is
  // `awaiting-approval` and `requestId` matches the one it's actually
  // waiting on — both mismatches are 400s, not 404s, since the run itself
  // does exist.
  approve(runId: string, requestId: string, allow: boolean): void {
    const meta = this.requireRun(runId);
    if (meta.state !== 'awaiting-approval') {
      throw new OrchestratorClientError(
        `run is not awaiting approval: ${runId}`
      );
    }
    const pending = this.registry.getPendingApproval(runId);
    if (pending === undefined || pending.requestId !== requestId) {
      throw new OrchestratorClientError(
        `unknown approval request: ${requestId}`
      );
    }
    const executorRun = this.registry.getExecutorRun(runId);
    if (executorRun === undefined) {
      throw new OrchestratorClientError(`run has no live executor: ${runId}`);
    }
    this.registry.setPendingApproval(runId, undefined);
    executorRun.approve(requestId, allow);
    this.transition(runId, 'running');
  }

  // `resume: true` is the request-changes path: only valid on a finished
  // run, and re-dispatches into the *same* worktree/branch rather than
  // provisioning a new one. Otherwise this is a plain mid-run message to a
  // live run's executor.
  sendMessage(
    runId: string,
    text: string,
    opts: { resume?: boolean } = {}
  ): RunMeta {
    const meta = this.requireRun(runId);

    if (opts.resume === true) {
      if (meta.state !== 'finished') {
        throw new OrchestratorClientError(`run is not finished: ${runId}`);
      }
      // C2: a reviewed run's worktree/branch may already be gone (merge) or
      // intentionally abandoned (discard) — either way there is nothing left
      // to resume into, and resuming would either fail on a missing cwd or
      // silently resurrect a run the user already closed out.
      if (meta.reviewedAt !== undefined) {
        throw new OrchestratorConflictError(
          `run has already been reviewed: ${runId}`
        );
      }
      return this.requestChanges(meta, text);
    }

    if (TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorClientError(`run is not live: ${runId}`);
    }
    const executorRun = this.registry.getExecutorRun(runId);
    if (executorRun === undefined) {
      throw new OrchestratorClientError(`run has no live executor: ${runId}`);
    }
    this.transcriptFor(runId).appendEntry({
      ts: new Date().toISOString(),
      kind: 'system',
      text: `user: ${text}`,
    });
    executorRun.send(text);
    return meta;
  }

  // Interrupts a live run's executor and marks it cancelled. The worktree is
  // deliberately left in place — per the plan, only a review action
  // (merge/discard) removes a run's worktree.
  async cancel(runId: string): Promise<void> {
    const meta = this.requireRun(runId);
    if (TERMINAL_RUN_STATES.has(meta.state)) {
      throw new OrchestratorConflictError(`run already finished: ${runId}`);
    }
    const executorRun = this.registry.getExecutorRun(runId);
    if (executorRun !== undefined) await executorRun.interrupt();
    this.transition(runId, 'cancelled');

    // M2: record the cancellation as a durable Activity line, same as every
    // other run-lifecycle event this task's file already tracks. The task's
    // own status is deliberately left as-is — cancelling a run says nothing
    // about whether the task itself should move (the user may immediately
    // re-dispatch it, or may have cancelled specifically to edit the task
    // first) — only a review action (merge/discard) or a fresh dispatch
    // changes task status.
    const now = new Date().toISOString();
    this.ctx.store.update(
      meta.taskId,
      { appendActivity: `${now} [run ${runId}] cancelled` },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  // The review surface's unified diff: everything committed on the run's
  // branch since it diverged from its base branch, plus per-file status.
  diff(runId: string): DiffResult {
    const meta = this.requireRun(runId);
    // Important #7: a reviewed run's worktree is gone (merge removes it
    // outright; discard too) — check both the review marker and the
    // worktree's actual existence (a defensive belt-and-suspenders: either
    // one alone can lag behind reality after a crash) rather than letting
    // `git diff` run against a cwd that no longer exists and surface as an
    // opaque internal error.
    if (meta.reviewedAt !== undefined || !existsSync(meta.worktreePath)) {
      throw new OrchestratorConflictError(
        `run has no worktree to diff: ${runId}`
      );
    }
    return this.worktrees.diff(meta.worktreePath, meta.baseBranch);
  }

  // Terminal review action for a run: 'merge' squash-merges the branch into
  // the main checkout and closes the task; 'discard' just cleans up and
  // reopens the task. Both remove the run's worktree/branch — the worktree
  // stays around until exactly this call, per the plan.
  //
  // C2: review is only valid on a terminal run (nothing to review while a
  // run is still live), and only once per run — a run that already has a
  // `reviewedAt` has already been merged or discarded, and doing either
  // again would double-apply the task-status change or double-remove an
  // already-gone worktree/branch.
  review(runId: string, action: string): RunMeta {
    if (action !== 'merge' && action !== 'discard') {
      throw new OrchestratorClientError(`invalid review action: ${action}`);
    }
    const meta = this.requireRun(runId);
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
    const now = new Date().toISOString();

    if (action === 'merge') {
      this.mergeRun(meta, now);
    } else {
      this.worktrees.remove(meta.worktreePath, meta.branch);
      this.ctx.store.update(
        meta.taskId,
        {
          status: 'todo',
          appendActivity: `${now} run ${runId} discarded`,
        },
        now
      );
    }

    // Record the review marker as its own state-line append (transition()
    // to the *same* state — reviewing a run never changes its RunState,
    // only that it's now been reviewed).
    this.transition(runId, meta.state, {
      reviewedAt: now,
      reviewAction: action,
    });
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    this.ctx.events.broadcast({ type: 'run.changed' });
    return this.registry.get(runId)!;
  }

  // C1: squash-merges `meta.branch` into the main checkout and folds this
  // run's own task-file bookkeeping into that same commit. Ordering is load-
  // bearing here: the squash-merge runs *before* any task-file edit, so a
  // failed merge (a real content conflict, or main having moved in a way
  // that no longer fast-forwards/merges cleanly) never leaves the task
  // marked done for work that was never actually merged in — and the task
  // file itself never sits uncommitted-and-staged fighting the merge for the
  // same path (see the back-to-back-merge regression this ordering fixes:
  // the previous order staged the *edited* task file before merging, so git
  // refused the second run's merge with "local changes ... would be
  // overwritten").
  private mergeRun(meta: RunMeta, now: string): void {
    // The dirty gate deliberately ignores `.dispatch/` — Activity/status
    // edits dispatchd itself made while running this task (dispatch,
    // finish, prior request-changes) are expected bookkeeping, not
    // unrelated user work; a genuinely dirty checkout (the user's own
    // pending changes elsewhere) still refuses the merge.
    if (this.isMainDirtyOutsideDispatch()) {
      throw new OrchestratorConflictError(
        'main checkout has uncommitted changes'
      );
    }
    // C4: refuse outright if the main checkout isn't actually sitting on
    // the branch this run was based on — merging here would land the run's
    // changes on whatever branch the user happens to have checked out,
    // silently, which is worse than just refusing.
    const currentBranch = this.currentMainBranch();
    if (currentBranch !== meta.baseBranch) {
      throw new OrchestratorConflictError(
        `merge target is ${currentBranch}, expected ${meta.baseBranch}`
      );
    }

    const message = `dispatch: ${meta.taskTitle} (run ${meta.id})`;
    // A run whose branch never diverged in content from its base (a chatty
    // run that made no file changes) has nothing to squash — skip
    // mergeSquash entirely rather than let its trailing `git commit` fail
    // with "nothing to commit" on an otherwise perfectly valid merge.
    const hasChanges =
      this.worktrees.diff(meta.worktreePath, meta.baseBranch).files.length > 0;
    if (hasChanges) {
      try {
        this.worktrees.mergeSquash(meta.branch, message);
      } catch (err) {
        // A failed `git merge --squash` (a real conflict) leaves the main
        // checkout mid-merge — conflict markers in the working tree, a
        // partially-populated index. `git reset --merge` restores it to a
        // clean HEAD so a retry (after the user resolves things by hand, or
        // just discards the run) starts from a sane state instead of a
        // permanently wedged checkout.
        Bun.spawnSync(['git', 'reset', '--merge'], { cwd: this.ctx.rootDir });
        // git's own stderr (already folded into err.message by
        // WorktreeManager.mergeSquash) is the useful part here — a content
        // conflict is a 409 the user can act on, never an opaque 500.
        throw new OrchestratorConflictError((err as Error).message);
      }
    }

    // Only now — once the squash-merge commit genuinely exists (or there was
    // nothing to squash in the first place) — record the task as done.
    // Stage *only* this run's own task file (not the whole `.dispatch/`
    // directory, Important #5) so an unrelated pending edit elsewhere under
    // `.dispatch/` (the user's own `config.yml` change, which the dirty gate
    // above deliberately let through) never rides along into this commit.
    this.ctx.store.update(
      meta.taskId,
      {
        status: 'done',
        appendActivity: `${now} run ${meta.id} merged into ${meta.baseBranch}`,
      },
      now
    );
    this.stageTaskFile(meta.taskId);
    // Fold the task-file bookkeeping into the squash commit when one exists;
    // otherwise this task-only commit *is* the merge's entire effect.
    const commitArgs = hasChanges
      ? ['commit', '--amend', '--no-edit']
      : ['commit', '-m', message];
    Bun.spawnSync(['git', ...commitArgs], { cwd: this.ctx.rootDir });

    this.worktrees.remove(meta.worktreePath, meta.branch);
  }

  // Boot-time hygiene: any transcript whose last recorded state isn't
  // terminal represents a run dispatchd crashed mid-flight on — mark it
  // `failed` (both on disk and in the freshly-hydrated registry) so clients
  // never see a run stuck "running" forever with nothing actually running
  // it. Every transcript's worktreePath is then used as the keep-set for
  // pruning orphan worktree directories left by a crash before a transcript
  // header was even written.
  reconcileOnBoot(): void {
    const dir = runsDir(this.ctx.rootDir);
    const keepPaths = new Set<string>();
    if (existsSync(dir)) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith('.jsonl')) continue;
        const path = join(dir, file);
        // One transcript that fails to read at all (not just to parse —
        // e.g. a directory sitting where a file is expected, an unreadable
        // file left by a partial crash) must never take down boot
        // reconciliation for every other run; skip just this entry.
        try {
          const replay = replayTranscript(path);
          if (replay === null) continue;
          let meta = replay.meta;
          if (!TERMINAL_RUN_STATES.has(meta.state)) {
            const now = new Date().toISOString();
            new Transcript(path).appendState('failed', now);
            meta = { ...meta, state: 'failed', updatedAt: now };
          }
          this.registry.create(meta);
          keepPaths.add(meta.worktreePath);
        } catch (err) {
          console.error(
            `dispatchd: skipping unreadable transcript ${path}: ${(err as Error).message}`
          );
        }
      }
    }
    this.worktrees.pruneOrphans(worktreesDir(this.ctx.rootDir), keepPaths);
  }

  private requireRun(runId: string): RunMeta {
    const meta = this.registry.get(runId);
    if (meta === undefined)
      throw new OrchestratorNotFoundError(`run not found: ${runId}`);
    return meta;
  }

  private transcriptFor(runId: string): Transcript {
    return new Transcript(transcriptPath(this.ctx.rootDir, runId));
  }

  // True when the main checkout has pending changes outside `.dispatch/` —
  // see the long comment at its one call site in `review()` for why
  // `.dispatch/` itself is excluded from this particular check.
  private isMainDirtyOutsideDispatch(): boolean {
    const result = Bun.spawnSync(
      ['git', 'status', '--porcelain', '--', '.', `:!${DISPATCH_DIR}`],
      { cwd: this.ctx.rootDir, stdout: 'pipe', stderr: 'pipe' }
    );
    return result.stdout.toString('utf8').trim().length > 0;
  }

  // C4: the branch actually checked out in the main checkout right now —
  // compared against a run's `baseBranch` before mergeRun() touches anything,
  // so a merge attempted while main is sitting on some other branch is
  // refused outright rather than landing on the wrong branch.
  private currentMainBranch(): string {
    const result = Bun.spawnSync(['git', 'rev-parse', '--abbrev-ref', 'HEAD'], {
      cwd: this.ctx.rootDir,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    return result.stdout.toString('utf8').trim();
  }

  // Stages (but does not commit) *only* the one task file belonging to
  // `taskId` — never the whole `.dispatch/` directory (Important #5) — so
  // `git commit --amend` right after this in mergeRun() folds in exactly
  // this run's own bookkeeping and nothing else pending under `.dispatch/`.
  private stageTaskFile(taskId: string): void {
    const file = this.ctx.store.taskFilePath(taskId);
    if (file === null) return;
    Bun.spawnSync(['git', 'add', file], { cwd: this.ctx.rootDir });
  }

  // The onFinish safety net (see its call site's comment): commits whatever
  // is sitting uncommitted in a run's worktree under a clearly-marked `wip`
  // message. A no-op when the worktree is already clean — the common case,
  // since every executor is expected to commit its own work per the prompt's
  // explicit instruction.
  private autoCommitIfDirty(worktreePath: string, runId: string): void {
    const status = Bun.spawnSync(['git', 'status', '--porcelain'], {
      cwd: worktreePath,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    if (status.stdout.toString('utf8').trim() === '') return;
    Bun.spawnSync(['git', 'add', '-A'], { cwd: worktreePath });
    Bun.spawnSync(
      [
        'git',
        'commit',
        '-m',
        `wip(dispatch): uncommitted changes from run ${runId}`,
      ],
      { cwd: worktreePath }
    );
  }

  // Moves a run to `state`, updating the registry, appending a transcript
  // state line, and broadcasting `run.changed` — the one place all three of
  // those always happen together, so no caller can update one without the
  // others.
  private transition(
    runId: string,
    state: RunState,
    finish?: {
      costUsd?: number;
      turns?: number;
      sessionId?: string;
      error?: string;
      reviewedAt?: string;
      reviewAction?: 'merge' | 'discard';
    }
  ): void {
    const meta = this.registry.get(runId);
    // I6: once a run is terminal, nothing may transition it to a *different*
    // state — a stray/duplicate onFinish, an approval response racing a
    // cancel, etc. must never resurrect a run clients have already been told
    // is done. This is a no-op, not a throw: transition() is called from
    // fire-and-forget executor event callbacks that have nothing useful to
    // do with an exception. Reviewing a run (which calls transition() with
    // its own already-terminal `state`, just to attach reviewedAt/
    // reviewAction) is explicitly exempt — that's staying in place, not
    // leaving the terminal state.
    if (
      meta !== undefined &&
      TERMINAL_RUN_STATES.has(meta.state) &&
      meta.state !== state
    ) {
      console.error(
        `dispatchd: ignoring transition out of terminal state '${meta.state}' -> '${state}' for run ${runId}`
      );
      return;
    }
    const now = new Date().toISOString();
    this.registry.updateMeta(runId, { state, updatedAt: now, ...finish });
    this.transcriptFor(runId).appendState(state, now, finish);
    this.ctx.events.broadcast({ type: 'run.changed' });
  }

  // Builds the ExecutorEvents callbacks for one run, closing over its runId
  // so the Executor implementation never has to know it.
  private makeEvents(runId: string): ExecutorEvents {
    return {
      onEntry: (entry) => {
        this.transcriptFor(runId).appendEntry(entry);
        this.registry.updateMeta(runId, {
          updatedAt: new Date().toISOString(),
        });
        this.ctx.events.broadcast({ type: 'run.log', runId, entry });
      },
      onApprovalRequest: (request) => {
        this.registry.setPendingApproval(runId, request);
        this.transition(runId, 'awaiting-approval');
        this.ctx.events.broadcast({
          type: 'approval.requested',
          runId,
          requestId: request.requestId,
          toolName: request.toolName,
        });
      },
      onFinish: (finish) => this.handleFinish(runId, finish),
    };
  }

  // Applies a run's terminal state: transitions it, computes the changed
  // file count for the Activity line (best-effort — a diff failure never
  // blocks recording the finish), and only flips the task to `in-review`
  // when it's still `in-progress` (it may have been moved elsewhere by a
  // human in the meantime).
  private handleFinish(
    runId: string,
    finish: {
      state: 'finished' | 'failed';
      costUsd?: number;
      turns?: number;
      sessionId?: string;
      error?: string;
    }
  ): void {
    const meta = this.registry.get(runId);
    if (meta === undefined) return;
    // I6: this whole block runs from inside an executor's fire-and-forget
    // event plumbing (see makeEvents/onFinish) — there is no caller left to
    // catch an escaped throw, so one would either crash the process or (with
    // Bun's fire-and-forget async chains) silently vanish, leaving the run
    // stuck non-terminal forever: a zombie run that looks "running" with
    // nothing left driving it. Any failure in this run's own git bookkeeping
    // (most commonly: its worktree was deleted out from under it before it
    // finished) must downgrade the finish to `failed` instead.
    let effectiveFinish = finish;
    try {
      // Stop-hook safety net: an executor (any executor — this runs
      // regardless of which one finished) can stop with uncommitted changes
      // sitting in its worktree, and the review surface's diff only ever
      // shows committed history (`git diff <mergeBase>...HEAD`, run below).
      // Sweeping those changes into one auto-commit here is what makes them
      // reviewable/mergeable at all, instead of silently vanishing when the
      // worktree is eventually removed.
      this.autoCommitIfDirty(meta.worktreePath, runId);
    } catch (err) {
      effectiveFinish = {
        state: 'failed',
        error: `finish failed: ${(err as Error).message}`,
      };
    }
    this.transition(runId, effectiveFinish.state, effectiveFinish);

    let filesChanged = 0;
    if (effectiveFinish.state === 'finished') {
      try {
        filesChanged = this.worktrees.diff(meta.worktreePath, meta.baseBranch)
          .files.length;
      } catch {
        filesChanged = 0;
      }
    }
    const cost = (effectiveFinish.costUsd ?? 0).toFixed(2);
    const now = new Date().toISOString();
    const task = this.ctx.store.get(meta.taskId);
    if (task === null) return;
    const patch: UpdatePatch = {
      appendActivity: `${now} [run ${runId}] finished: ${effectiveFinish.state} — ${filesChanged} files, $${cost}`,
    };
    if (task.meta.status === 'in-progress') patch.status = 'in-review';
    this.ctx.store.update(meta.taskId, patch, now);
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  // The request-changes path: same task/branch/worktree as `oldMeta`, but a
  // fresh run id and transcript, resuming the executor's prior session.
  private requestChanges(oldMeta: RunMeta, text: string): RunMeta {
    const executor = this.executors.get(oldMeta.executor);
    if (executor === undefined) {
      throw new OrchestratorClientError(
        `unknown executor: ${oldMeta.executor}`
      );
    }
    const now = new Date().toISOString();
    const runId = generateRunId(now);
    const meta: RunMeta = {
      id: runId,
      taskId: oldMeta.taskId,
      taskTitle: oldMeta.taskTitle,
      executor: oldMeta.executor,
      state: 'provisioning',
      branch: oldMeta.branch,
      baseBranch: oldMeta.baseBranch,
      worktreePath: oldMeta.worktreePath,
      createdAt: now,
      updatedAt: now,
      sessionId: oldMeta.sessionId,
    };
    this.registry.create(meta);
    this.transcriptFor(runId).writeHeader(meta);

    this.ctx.store.update(
      oldMeta.taskId,
      {
        status: 'in-progress',
        appendActivity: `${now} requested changes (run ${runId}): ${text}`,
      },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });

    this.transition(runId, 'running');
    const caps = this.orchestratorCaps();
    const executorRun = executor.start(
      {
        cwd: meta.worktreePath,
        prompt: text,
        resumeSessionId: oldMeta.sessionId,
        permissionMode: caps.permissionMode,
        maxTurns: caps.maxTurns,
        maxBudgetUsd: caps.maxBudgetUsd,
      },
      this.makeEvents(runId)
    );
    this.registry.setExecutorRun(runId, executorRun);
    return this.registry.get(runId)!;
  }

  // Reads the project's `.dispatch/config.yml` `orchestrator:` block fresh on
  // every dispatch/resume — same rationale as the MCP tools re-resolving
  // config on every call: a config edit takes effect on the next dispatch
  // without a dispatchd restart.
  private orchestratorCaps(): OrchestratorConfig {
    return loadConfig(this.ctx.rootDir).orchestrator;
  }

  // Prompt handed to the executor: the task's own content plus its parent
  // epic's, assembled by the pure buildTaskPrompt() (see prompt.ts) so the
  // exact text is unit-testable independent of the orchestrator. A corrupt
  // parent epic file degrades to "no epic context" rather than failing the
  // whole dispatch — the task being dispatched is still perfectly valid.
  private promptForTask(task: TaskDoc): string {
    let parentEpic: TaskDoc | null = null;
    if (task.meta.parent !== null) {
      try {
        parentEpic = this.ctx.store.get(task.meta.parent);
      } catch (err) {
        if (!(err instanceof TaskParseError)) throw err;
      }
    }
    return buildTaskPrompt(task, parentEpic);
  }
}
