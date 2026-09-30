import type { RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';
import { computeStack } from '@dispatch/core/graph';
import type { TaskStack } from '@dispatch/core/graph';
import { GitPullRequest } from 'lucide-react';

import { RunStatePill } from '../runs/RunStatePill';
import { StatusIcon } from './StatusIcon';
import { ListRow } from '@/ui/ai/list-row';

interface StackRailProps {
  /** Full project task list — the stack is derived from it internally (see
   * `getStackByTaskId` below), so callers never precompute or pass a `TaskStack` of
   * their own. */
  tasks: TaskListItem[];
  /** The task whose stack to render — this task's own row is highlighted in the rail. */
  taskId: string;
  /** Per-task latest run, for the small run-state/PR mark next to each stack row's title. */
  latestRunByTaskId: Map<string, RunMeta>;
  /** Re-points the caller at a different task in the stack (e.g. re-peeks the detail
   * dialog at the clicked row). Omitted renders every row as plain, non-clickable text. */
  onOpenTask?: (taskId: string) => void;
}

// Per-(tasks array identity) cache of every task's `TaskStack`, keyed by task id — shared by
// every `StackRail` instance rendered against the same `tasks` reference. See
// `getStackByTaskId`'s own comment for why a plain per-call `computeStack` isn't used here.
const stackCache = new WeakMap<TaskListItem[], Map<string, TaskStack>>();

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
export function getStackByTaskId(
  tasks: TaskListItem[]
): Map<string, TaskStack> {
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
 * The rail's companion to "Blocked by": the full chain of tasks this one is connected to
 * through blockedBy edges (its "stack"), topologically ordered blocker before dependent, as
 * 36px `ListRow`s — the first at the root, every later one nested a step in with the tree
 * connector so the chain reads top-down. Each row carries the status glyph, the title
 * (clickable when `onOpenTask` is given), and, if that task has ever had a run, the
 * compact run-state mark (plus a PR glyph once it has an open PR). The current task's own
 * row is the selected one. Renders nothing for a task with no stack — a lone task isn't a
 * "stack" of one.
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
    <div data-slot="stack-rail" className="flex flex-col">
      {stack.order.map((id, i) => {
        const rowDoc = byId.get(id);
        // `order` only ever contains ids that were present in `tasks` when the stack was
        // computed — this guards the (should-never-happen, but caller-supplied `tasks` could
        // in principle race a stale prop) case of an id the current `tasks` no longer has.
        if (rowDoc === undefined) return null;
        const isCurrent = id === taskId;
        const run = latestRunByTaskId.get(id);
        return (
          <ListRow
            key={id}
            data-stack-id={id}
            indent={i === 0 ? 0 : 1}
            selected={isCurrent}
            status={<StatusIcon status={rowDoc.meta.status} />}
            title={<span title={rowDoc.meta.title}>{rowDoc.meta.title}</span>}
            trailing={
              run !== undefined ? (
                <>
                  <RunStatePill meta={run} compact />
                  {run.prUrl !== undefined && (
                    <span title="Has a pull request" className="flex">
                      <GitPullRequest className="text-muted-foreground size-3.5" />
                      <span className="sr-only">Has a pull request</span>
                    </span>
                  )}
                </>
              ) : undefined
            }
            onClick={
              onOpenTask !== undefined && !isCurrent
                ? () => onOpenTask(id)
                : undefined
            }
            className="px-2"
          />
        );
      })}
    </div>
  );
}
