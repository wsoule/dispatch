import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import {
  claimConflictsWithWrites,
  isDoneStatus,
  isSatisfiedForDispatchStatus,
} from '@dispatch-foo/core/browser';
import type { ReadinessReading, RunMeta } from '@dispatch/client';

import type { LiveClaim } from './dispatchPreview';
import { isTerminalRunState } from './runState';

/** How one check reads: fine, worth a look, holding the task back, or not known yet. */
export type CheckTone = 'pass' | 'warn' | 'block' | 'pending';

export interface ReadinessCheck {
  id: 'blockers' | 'spec' | 'writes' | 'overlap';
  tone: CheckTone;
  /** A short sentence (`Waits on 2 tasks`). */
  label: string;
  /** The tasks the check is about, for jump links. */
  taskIds?: string[];
}

export interface DispatchReadiness {
  checks: ReadinessCheck[];
  /** The daemon refuses a second live run and a completed or canceled task; nothing else
   * stops a dispatch. */
  canDispatch: boolean;
  /** Completed or canceled: it has to be reopened before an agent can take it. */
  closed: boolean;
  /** Unmet blockers: dispatching now means going ahead of them. */
  blocked: boolean;
  /** Warnings worth reading before sending an agent. */
  warnings: number;
}

export interface ReadinessInput {
  task: TaskListItem;
  /** The task's description and criteria, or null while the body loads. */
  body: { description: string; criteria: string[] } | null;
  tasksById: ReadonlyMap<string, TaskListItem>;
  model: StatusModel;
  liveRun: RunMeta | undefined;
  /** The daemon's judged reading of the spec, when it has one. */
  reading: ReadinessReading | undefined;
  liveClaims: readonly LiveClaim[];
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** The blockers that still hold `task` back. An id naming no task never blocks, as in the
 * daemon's ready queue. */
export function unmetBlockers(
  task: TaskListItem,
  tasksById: ReadonlyMap<string, TaskListItem>,
  model: StatusModel
): string[] {
  return task.meta.blockedBy.filter((id) => {
    const blocker = tasksById.get(id);
    return (
      blocker !== undefined &&
      !isSatisfiedForDispatchStatus(blocker.meta.status, model)
    );
  });
}

function blockersCheck(
  task: TaskListItem,
  tasksById: ReadonlyMap<string, TaskListItem>,
  unmet: string[]
): ReadinessCheck {
  if (unmet.length > 0) {
    return {
      id: 'blockers',
      tone: 'block',
      label: `Waits on ${plural(unmet.length, 'task')}`,
      taskIds: unmet,
    };
  }
  const missing = task.meta.blockedBy.filter((id) => !tasksById.has(id)).length;
  if (missing > 0) {
    return {
      id: 'blockers',
      tone: 'warn',
      label: `${plural(missing, 'blocker')} not found`,
    };
  }
  return {
    id: 'blockers',
    tone: 'pass',
    label: task.meta.blockedBy.length === 0 ? 'No blockers' : 'Blockers done',
  };
}

/** Whether `d` dispatches: whenever the card's button would, except going ahead of
 * blockers, which takes the card's deliberate `Dispatch anyway`. */
export function dispatchesOnKey(readiness: DispatchReadiness): boolean {
  return readiness.canDispatch && !readiness.blocked;
}

function specCheck(input: ReadinessInput): ReadinessCheck {
  const { reading, body } = input;
  // The daemon's judgment wins when it has read this task; 0 is a bare title.
  if (reading !== undefined) {
    return {
      id: 'spec',
      tone: reading.level <= 1 ? 'warn' : 'pass',
      label: reading.level === 0 ? 'Only a title' : reading.label,
    };
  }
  if (body === null) {
    return { id: 'spec', tone: 'pending', label: 'Reading the spec…' };
  }
  const hasDescription = body.description.trim() !== '';
  const criteria = body.criteria.length;
  if (!hasDescription && criteria === 0) {
    return { id: 'spec', tone: 'warn', label: 'Only a title' };
  }
  if (criteria === 0) {
    return { id: 'spec', tone: 'warn', label: 'No acceptance criteria' };
  }
  return {
    id: 'spec',
    tone: 'pass',
    label: criteria === 1 ? '1 criterion' : `${criteria} criteria`,
  };
}

/**
 * What stands between a task and an agent: unmet blockers, a thin spec, no declared
 * writes (the fan-out then runs it alone, since an undeclared write conflicts with every
 * live claim), and live runs elsewhere already claiming the files it writes. A live run of
 * its own or a closed status stops a dispatch outright; everything else is advice.
 */
export function dispatchReadiness(input: ReadinessInput): DispatchReadiness {
  const { task, tasksById, model, liveRun, liveClaims } = input;
  const checks: ReadinessCheck[] = [];

  const unmet = unmetBlockers(task, tasksById, model);
  checks.push(blockersCheck(task, tasksById, unmet));

  checks.push(specCheck(input));

  const writes = task.meta.writes;
  checks.push(
    writes.length === 0
      ? { id: 'writes', tone: 'warn', label: 'No declared writes' }
      : {
          id: 'writes',
          tone: 'pass',
          label: `Writes ${plural(writes.length, 'path')}`,
        }
  );

  // With no declared writes the writes check already says it runs alone; naming every
  // live run as an overlap would only repeat that.
  const overlapping = (writes.length === 0 ? [] : liveClaims)
    .filter(
      (live) =>
        live.taskId !== task.meta.id &&
        claimConflictsWithWrites(live.claims, writes)
    )
    .map((live) => live.taskId);
  if (overlapping.length > 0) {
    checks.push({
      id: 'overlap',
      tone: 'warn',
      label: `Overlaps ${plural(overlapping.length, 'live run')}`,
      taskIds: overlapping,
    });
  }

  const live = liveRun !== undefined && !isTerminalRunState(liveRun.state);
  const closed = isDoneStatus(task.meta.status, model);
  return {
    checks,
    canDispatch: !live && !closed,
    closed,
    blocked: unmet.length > 0,
    warnings: checks.filter((c) => c.tone === 'warn').length,
  };
}
