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
  }

  // The review surface's unified diff: everything committed on the run's
  // branch since it diverged from its base branch, plus per-file status.
  diff(runId: string): DiffResult {
    const meta = this.requireRun(runId);
    return this.worktrees.diff(meta.worktreePath, meta.baseBranch);
  }

  // Terminal review action for a run: 'merge' squash-merges the branch into
  // the main checkout and closes the task; 'discard' just cleans up and
  // reopens the task. Both remove the run's worktree/branch — the worktree
  // stays around until exactly this call, per the plan.
  review(runId: string, action: string): RunMeta {
    const meta = this.requireRun(runId);
    const now = new Date().toISOString();

    if (action === 'merge') {
      // The dirty gate deliberately ignores `.dispatch/` — Activity/status
      // edits dispatchd itself made while running this task (dispatch,
      // finish, prior request-changes) are expected bookkeeping, not
      // unrelated user work. With autoCommit off (the default), those edits
      // ride uncommitted until swept into the squash commit below; a
      // genuinely dirty checkout (the user's own pending changes) still
      // refuses the merge.
      if (this.isMainDirtyOutsideDispatch()) {
        throw new OrchestratorConflictError(
          'main checkout has uncommitted changes'
        );
      }
      this.ctx.store.update(
        meta.taskId,
        {
          status: 'done',
          appendActivity: `${now} run ${runId} merged into ${meta.baseBranch}`,
        },
        now
      );
      // Stage the task-file edit above so the squash-merge commit below
      // absorbs it too — one clean commit on main per merged run, instead
      // of leaving dispatchd's own bookkeeping dangling uncommitted.
      this.stageDispatchDir();
      this.worktrees.mergeSquash(
        meta.branch,
        `dispatch: ${meta.taskTitle} (run ${runId})`
      );
      this.worktrees.remove(meta.worktreePath, meta.branch);
    } else if (action === 'discard') {
      this.worktrees.remove(meta.worktreePath, meta.branch);
      this.ctx.store.update(
        meta.taskId,
        {
          status: 'todo',
          appendActivity: `${now} run ${runId} discarded`,
        },
        now
      );
    } else {
      throw new OrchestratorClientError(`invalid review action: ${action}`);
    }

    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
    this.ctx.events.broadcast({ type: 'run.changed' });
    return this.registry.get(runId)!;
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

  // Stages (but does not commit) pending `.dispatch/` edits in the main
  // checkout, so a subsequent `git commit` — here, always the squash-merge
  // commit in `review()` — picks them up too.
  private stageDispatchDir(): void {
    Bun.spawnSync(['git', 'add', DISPATCH_DIR], { cwd: this.ctx.rootDir });
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
    }
  ): void {
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
    // Stop-hook safety net: an executor (any executor — this runs
    // regardless of which one finished) can stop with uncommitted changes
    // sitting in its worktree, and the review surface's diff only ever
    // shows committed history (`git diff <mergeBase>...HEAD`, run below).
    // Sweeping those changes into one auto-commit here is what makes them
    // reviewable/mergeable at all, instead of silently vanishing when the
    // worktree is eventually removed.
    this.autoCommitIfDirty(meta.worktreePath, runId);
    this.transition(runId, finish.state, finish);

    let filesChanged = 0;
    if (finish.state === 'finished') {
      try {
        filesChanged = this.worktrees.diff(meta.worktreePath, meta.baseBranch)
          .files.length;
      } catch {
        filesChanged = 0;
      }
    }
    const cost = (finish.costUsd ?? 0).toFixed(2);
    const now = new Date().toISOString();
    const task = this.ctx.store.get(meta.taskId);
    if (task === null) return;
    const patch: UpdatePatch = {
      appendActivity: `${now} [run ${runId}] finished: ${finish.state} — ${filesChanged} files, $${cost}`,
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
