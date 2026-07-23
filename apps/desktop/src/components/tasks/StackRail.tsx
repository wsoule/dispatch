import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import { computeStack } from '@dispatch/core/graph';
import type { TaskStack } from '@dispatch/core/graph';
import { GitPullRequest, Layers2 } from 'lucide-react';

import { RunStatePill } from '../runs/RunStatePill';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';

export interface StackRailProps {
  /** Full project task list — the stack is derived from it internally (see
   * `getStackByTaskId` below), so callers never precompute or pass a `TaskStack` of
   * their own. */
  tasks: TaskDoc[];
  /** The task whose stack to render — this task's own row is highlighted in the rail. */
  taskId: string;
  /** Per-task latest run, for the small run-state/PR chip next to each stack row's title. */
  latestRunByTaskId: Map<string, RunMeta>;
  /** Re-points the caller at a different task in the stack (e.g. re-peeks the detail
   * dialog at the clicked row). Omitted renders every title as plain, non-clickable text. */
  onOpenTask?: (taskId: string) => void;
}

// Per-(tasks array identity) cache of every task's `TaskStack`, keyed by task id — shared by
// every `StackRail`/`StackBadge` instance rendered against the same `tasks` reference (e.g.
// one `StackBadge` per row in a single `TasksListView` render). See `getStackByTaskId`'s own
// comment for why a plain per-call `computeStack` isn't used here.
const stackCache = new WeakMap<TaskDoc[], Map<string, TaskStack>>();

/**
 * Every task's `TaskStack`, keyed by task id, derived from `tasks` in one pass rather than
 * calling `computeStack` (which rebuilds the whole project's blockedBy adjacency list every
 * call) once per row — with dozens of rows all asking about the same `tasks` array in one
 * render, that would be an O(rows * tasks) rescan of the project. `computeStack` itself is
 * only ever invoked once per connected component of the blockedBy graph — every task in that
 * component is filled in from that single result — and a task with no real blockedBy edge at
 * all (the common case: a plain, unblocked, unblocking task) skips `computeStack` entirely,
 * since it can never be part of a multi-task stack. Each member is stored with the shared
 * `order` array but its own `index` within that array. Cached in a `WeakMap` keyed by the
 * `tasks` array's own identity, so a fresh task list (e.g. after a refetch) naturally
 * invalidates the old entry instead of ever serving a stale one.
 */
function getStackByTaskId(tasks: TaskDoc[]): Map<string, TaskStack> {
  const cached = stackCache.get(tasks);
  if (cached !== undefined) return cached;

  const idSet = new Set(tasks.map((t) => t.meta.id));
  // Ids that participate in at least one real (non-dangling, non-self) blockedBy edge —
  // everything else is a singleton and can be skipped without ever touching `computeStack`.
  const linked = new Set<string>();
  for (const t of tasks) {
    for (const dep of t.meta.blockedBy) {
      if (dep !== t.meta.id && idSet.has(dep)) {
        linked.add(t.meta.id);
        linked.add(dep);
      }
    }
  }

  const result = new Map<string, TaskStack>();
  const visited = new Set<string>();
  for (const id of linked) {
    if (visited.has(id)) continue;
    const stack = computeStack(tasks, id);
    if (stack === null) {
      visited.add(id);
      continue;
    }
    stack.order.forEach((memberId, memberIndex) => {
      visited.add(memberId);
      result.set(memberId, { order: stack.order, index: memberIndex });
    });
  }

  stackCache.set(tasks, result);
  return result;
}

/**
 * The right-hand-rail companion to a task's "Blocked by" section: the full chain of tasks
 * this one is connected to through blockedBy edges (its "stack"), topologically ordered
 * blocker before dependent — one row per task with a status dot, a connector line down to the
 * next row, the title (clickable when `onOpenTask` is given), and, if that task has ever had a
 * run, a small run-state chip (plus a PR glyph once it has an open PR). The current task's own
 * row is highlighted. Renders nothing for a task with no stack — a lone task isn't a "stack"
 * of one.
 */
export function StackRail({
  tasks,
  taskId,
  latestRunByTaskId,
  onOpenTask,
}: StackRailProps) {
  const stack = getStackByTaskId(tasks).get(taskId);
  if (stack === undefined) return null;

  const byId = new Map(tasks.map((t) => [t.meta.id, t]));

  return (
    <div className="flex flex-col px-2">
      {stack.order.map((id, i) => {
        const rowDoc = byId.get(id);
        // `order` only ever contains ids that were present in `tasks` when the stack was
        // computed — this guards the (should-never-happen, but caller-supplied `tasks` could
        // in principle race a stale prop) case of an id the current `tasks` no longer has.
        if (rowDoc === undefined) return null;
        const isCurrent = id === taskId;
        const run = latestRunByTaskId.get(id);
        const isLast = i === stack.order.length - 1;
        return (
          <div key={id} className="flex gap-2">
            <div className="flex flex-col items-center pt-1">
              <StatusIcon status={rowDoc.meta.status} />
              {!isLast && (
                <span
                  className="bg-border my-0.5 w-px flex-1"
                  aria-hidden="true"
                />
              )}
            </div>
            <div
              className={cn(
                'mb-0.5 flex min-w-0 flex-1 items-center justify-between gap-2 rounded-md px-1.5 py-1',
                isCurrent && 'bg-accent/60'
              )}
            >
              {onOpenTask !== undefined ? (
                <button
                  type="button"
                  onClick={() => onOpenTask(id)}
                  className="min-w-0 flex-1 truncate text-left text-[13px] hover:underline"
                  title={rowDoc.meta.title}
                >
                  {rowDoc.meta.title}
                </button>
              ) : (
                <span
                  className="min-w-0 flex-1 truncate text-[13px]"
                  title={rowDoc.meta.title}
                >
                  {rowDoc.meta.title}
                </span>
              )}
              {run !== undefined && (
                <span className="flex shrink-0 items-center gap-1">
                  <RunStatePill state={run.state} />
                  {run.prUrl !== undefined && (
                    <GitPullRequest className="text-primary size-3" />
                  )}
                </span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}

/**
 * A compact "N/M" pill for a task's position within its stack (e.g. "2/4") — used on board
 * cards and list rows so a stacked task's place in its chain reads at a glance without opening
 * the detail dialog. Renders nothing for a task with no stack.
 */
export function StackBadge({
  tasks,
  taskId,
}: {
  tasks: TaskDoc[];
  taskId: string;
}) {
  const stack = getStackByTaskId(tasks).get(taskId);
  if (stack === undefined) return null;
  return (
    <span
      className="text-muted-foreground border-border/60 inline-flex shrink-0 items-center gap-0.5 rounded-full border px-1.5 py-0 font-mono text-[10px]"
      title={`Stack position ${stack.index + 1} of ${stack.order.length}`}
    >
      <Layers2 className="size-2.5" />
      {stack.index + 1}/{stack.order.length}
    </span>
  );
}
