import type { TaskDoc, TaskStorePort } from '@dispatch/core';

import type { ApiContext } from '../api.js';

/** The A2A-origin run a request came from, by its own token, and its task. */
export interface A2ARunScope {
  runId: string;
  taskId: string;
}

type ScopeContext = Pick<ApiContext, 'a2a' | 'orchestrator'>;

/** The scope of an A2A-origin run presenting its own token, or null for any
 *  other caller, including an ordinary run. */
export function a2aRunScope(
  ctx: ScopeContext,
  runId: string
): A2ARunScope | null {
  const taskId = ctx.orchestrator.taskIdOfRun(runId);
  if (taskId === null || ctx.a2a?.taskOrigin(taskId) !== 'a2a') return null;
  return { runId, taskId };
}

/**
 * Whether an A2A-origin run may see `taskId`: its own task, a task it made
 * A2A-origin itself, or a task that is not A2A-origin at all. Another client's
 * handoff, or another A2A run's work, it never sees.
 */
export function visibleToA2ARun(
  ctx: ScopeContext,
  scope: A2ARunScope,
  taskId: string
): boolean {
  if (taskId === scope.taskId) return true;
  if (ctx.a2a?.taskOrigin(taskId) !== 'a2a') return true;
  return ctx.a2a.lineage.markedBy(taskId) === scope.runId;
}

/**
 * XH-R2: the task store an A2A-origin run's request writes through. Every task
 * it creates or updates, by any route (POST /api/tasks, fan-out, subtasks,
 * promoting a note), inherits its provenance before the write lands.
 */
export function lineageStore(
  store: TaskStorePort,
  inherit: (taskId: string) => void
): TaskStorePort {
  return new Proxy(store, {
    get(target, prop) {
      if (prop === 'create') {
        return (...args: Parameters<TaskStorePort['create']>): TaskDoc => {
          const doc = target.create(...args);
          inherit(doc.meta.id);
          return doc;
        };
      }
      if (prop === 'update') {
        return (...args: Parameters<TaskStorePort['update']>): TaskDoc => {
          inherit(args[0]);
          return target.update(...args);
        };
      }
      const value: unknown = Reflect.get(target, prop, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
