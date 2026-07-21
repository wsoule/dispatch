import { loadConfig, readyTasks } from '@dispatch/core';
import type { TaskDoc, TaskStore } from '@dispatch/core';

import type { TaskCache } from '../cache.js';
import type { EventBus } from '../events.js';
import type { Orchestrator } from './orchestrator.js';
import type { RunMeta } from './types.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  TERMINAL_RUN_STATES,
} from './types.js';

// One epic's live dispatch session. Deliberately registry-only — nothing
// here is written to disk beyond the epic Activity lines each transition
// leaves behind — a dispatchd restart simply loses in-flight sessions (any
// children still running keep running; nothing new auto-dispatches for them
// until a fresh `start()` call), the same "machine-local" contract the plan
// gives the epic engine.
interface EpicSessionRecord {
  concurrency: number;
  executor: string;
  active: boolean;
  completedAt?: string;
}

export interface EpicSession {
  epicId: string;
  concurrency: number;
  active: boolean;
  completedAt?: string;
}

export interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
}

export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  children: EpicProgressChild[];
  liveRuns: RunMeta[];
}

export interface EpicEngineContext {
  rootDir: string;
  store: TaskStore;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
}

/**
 * The epic-level parallel dispatch engine (spec §5 Dispatch step 6): starting
 * an epic dispatches its ready children up to a concurrency cap, and every
 * time a child run reaches a terminal state, newly-unblocked siblings
 * auto-dispatch to fill any freed slot — all driven by Orchestrator's
 * `onRunTerminal` push hook, never a poll. `stop()` only halts *new*
 * dispatches; runs already live keep running to their own completion.
 *
 * State lives entirely in an in-memory Map (machine-local, like PlanManager)
 * — the durable trail is the epic Activity lines this class appends via
 * TaskStore, same as every other orchestrator lifecycle event.
 */
export class EpicEngine {
  private readonly sessions = new Map<string, EpicSessionRecord>();

  constructor(private readonly ctx: EpicEngineContext) {
    // Two distinct triggers can make an epic's next dispatch decision stale:
    // a run reaching a terminal state (frees a concurrency slot) and a run
    // being reviewed (can flip a blocker all the way to `done`, which is
    // what core's readyTasks() actually gates a dependent task on — see
    // Orchestrator's onRunReviewed doc comment). Both funnel into the same
    // reaction here.
    ctx.orchestrator.onRunTerminal((meta) => this.onRunLifecycleEvent(meta));
    ctx.orchestrator.onRunReviewed((meta) => this.onRunLifecycleEvent(meta));
  }

  // POST /api/epics/:id/dispatch. `concurrency` defaults to the project's
  // `orchestrator.epicConcurrency` config; `executor` defaults to 'claude'
  // but tests override it (see the Global Constraints note on honoring a
  // body override) to dispatch through FakeExecutor instead.
  start(
    epicId: string,
    opts: { concurrency?: number; executor?: string } = {}
  ): EpicSession {
    const epic = this.requireEpic(epicId);
    const existing = this.sessions.get(epicId);
    if (existing !== undefined && existing.active) {
      throw new OrchestratorConflictError(
        `epic already has an active dispatch session: ${epicId}`
      );
    }
    const concurrency =
      opts.concurrency ??
      loadConfig(this.ctx.rootDir).orchestrator.epicConcurrency;
    if (!Number.isInteger(concurrency) || concurrency < 1) {
      throw new OrchestratorClientError(
        `invalid concurrency: ${String(opts.concurrency)} (expected an integer >= 1)`
      );
    }
    const session: EpicSessionRecord = {
      concurrency,
      executor: opts.executor ?? 'claude',
      active: true,
    };
    this.sessions.set(epicId, session);
    this.appendEpicActivity(
      epicId,
      `epic dispatch started (concurrency ${concurrency})`
    );
    this.fillQueue(epicId);
    return this.publicSession(epic.meta.id, session);
  }

  // POST /api/epics/:id/stop. Halts new dispatches only — anything already
  // live keeps running to its own natural finish/fail/cancel.
  stop(epicId: string): EpicSession {
    this.requireEpic(epicId);
    const session = this.sessions.get(epicId);
    if (session === undefined || !session.active) {
      throw new OrchestratorConflictError(
        `epic has no active dispatch session: ${epicId}`
      );
    }
    session.active = false;
    this.appendEpicActivity(
      epicId,
      'epic dispatch stopped (new dispatches halted; live runs continue)'
    );
    return this.publicSession(epicId, session);
  }

  // GET /api/epics/:id/progress: children grouped by status plus the live
  // runs currently dispatched against any of them.
  progress(epicId: string): EpicProgress {
    this.requireEpic(epicId);
    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveRuns = this.ctx.orchestrator
      .list()
      .filter(
        (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
      );
    const session = this.sessions.get(epicId);
    return {
      epicId,
      active: session?.active ?? false,
      concurrency: session?.concurrency,
      children: children.map((c) => ({
        id: c.meta.id,
        title: c.meta.title,
        status: c.meta.status,
      })),
      liveRuns,
    };
  }

  // Shared reaction to both onRunTerminal and onRunReviewed: check whether
  // the epic containing this run's task is now complete, and otherwise try
  // to fill any freed dispatch slot. A run whose task has no tracked
  // (started) epic session is simply not this engine's concern — most runs
  // in a project are dispatched individually, not through an epic session
  // at all.
  private onRunLifecycleEvent(meta: RunMeta): void {
    const task = this.ctx.store.get(meta.taskId);
    const epicId = task?.meta.parent;
    if (epicId === null || epicId === undefined) return;
    if (!this.sessions.has(epicId)) return;

    if (this.isEpicComplete(epicId)) {
      this.completeEpic(epicId);
      return;
    }
    this.fillQueue(epicId);
  }

  // Dispatches ready children up to the session's concurrency cap. Reads a
  // fresh live-run count on every call (rather than tracking a separate
  // counter that could drift from reality) — cheap at epic scale, and it's
  // the actual registry, not a shadow copy, that the concurrency guarantee
  // has to hold against.
  private fillQueue(epicId: string): void {
    const session = this.sessions.get(epicId);
    if (session === undefined || !session.active) return;

    const children = this.childrenOf(epicId);
    const childIds = new Set(children.map((c) => c.meta.id));
    const liveCount = this.ctx.orchestrator
      .list()
      .filter(
        (r) => childIds.has(r.taskId) && !TERMINAL_RUN_STATES.has(r.state)
      ).length;
    let slots = session.concurrency - liveCount;
    if (slots <= 0) return;

    for (const task of readyTasks(children)) {
      if (slots <= 0) break;
      try {
        this.ctx.orchestrator.dispatch(task.meta.id, session.executor);
        slots--;
      } catch (err) {
        // A task that already picked up a live run between the readiness
        // snapshot above and this dispatch call (e.g. someone manually
        // dispatched it outside the epic session) just gets skipped — every
        // other error is a real bug and must surface, not be swallowed.
        if (err instanceof OrchestratorConflictError) continue;
        throw err;
      }
    }
  }

  // True once none of an epic's children is still pending work: nothing sits
  // at `todo` (unstarted, whether or not it's currently ready) or
  // `in-progress` (a live run). Every child that ever ran has already
  // reached its own terminal run state by the time onRunTerminal calls this
  // (that's the only thing that calls it) and therefore moved to
  // `in-review`/`done`/`cancelled` — this deliberately does NOT wait for a
  // human review action (merge/discard/PR) to flip a task all the way to
  // `done`; the epic's own dispatch work is done once nothing is left
  // running or runnable. An epic with zero children never "completes" on
  // its own (there is nothing to wait on, but also nothing accomplished).
  private isEpicComplete(epicId: string): boolean {
    const children = this.childrenOf(epicId);
    if (children.length === 0) return false;
    return !children.some(
      (c) => c.meta.status === 'todo' || c.meta.status === 'in-progress'
    );
  }

  private completeEpic(epicId: string): void {
    const session = this.sessions.get(epicId);
    if (session === undefined || session.completedAt !== undefined) return;
    session.completedAt = new Date().toISOString();
    session.active = false;
    this.appendEpicActivity(
      epicId,
      'epic dispatch complete — all children done'
    );
  }

  private childrenOf(epicId: string): TaskDoc[] {
    return this.ctx.cache
      .query({ parent: epicId })
      .filter((t) => t.meta.kind === 'task');
  }

  private requireEpic(epicId: string): TaskDoc {
    const epic = this.ctx.store.get(epicId);
    if (epic === null) {
      throw new OrchestratorNotFoundError(`epic not found: ${epicId}`);
    }
    if (epic.meta.kind !== 'epic') {
      throw new OrchestratorClientError(`not an epic: ${epicId}`);
    }
    return epic;
  }

  private appendEpicActivity(epicId: string, text: string): void {
    const now = new Date().toISOString();
    this.ctx.store.update(
      epicId,
      { appendActivity: `${now} [epic] ${text}` },
      now
    );
    this.ctx.cache.rebuild(this.ctx.store);
    this.ctx.events.broadcast({ type: 'task.changed' });
  }

  private publicSession(
    epicId: string,
    session: EpicSessionRecord
  ): EpicSession {
    return {
      epicId,
      concurrency: session.concurrency,
      active: session.active,
      completedAt: session.completedAt,
    };
  }
}
