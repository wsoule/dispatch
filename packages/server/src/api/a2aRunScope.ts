import type { TaskDoc, TaskStorePort } from '@dispatch-foo/core';

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

// The messaging routes an A2A run uses, by method and path shape ('*' is any
// one segment); the engine's participation and A2A rules still apply.
const MESSAGING: readonly [string, readonly string[]][] = [
  ['POST', ['messages']],
  ['GET', ['messages', '*']],
  ['POST', ['messages', '*', 'reply']],
  ['GET', ['messages', '*', 'answer']],
  ['GET', ['threads']],
  ['GET', ['threads', '*']],
  ['GET', ['mailbox']],
  ['POST', ['deliveries', '*', 'read']],
];

function matches(pattern: readonly string[], segments: readonly string[]) {
  return (
    pattern.length === segments.length &&
    pattern.every((p, i) => p === '*' || p === segments[i])
  );
}

/**
 * XH-R8: the routes an A2A-origin run's own token may use. Messaging; its own
 * task (read, comments, amendments) and run (read, evidence, mutation
 * results); findings on its own task; memory and docs under their A2A rules;
 * and the config its MCP reads. Everything else is refused.
 */
export function a2aRunAllows(
  scope: A2ARunScope,
  method: string,
  segments: readonly string[],
  findingTask: string | null
): boolean {
  const [family, id, sub] = segments;
  if (MESSAGING.some(([m, p]) => m === method && matches(p, segments)))
    return true;
  if (family === 'memory' || family === 'docs') return true;
  if (segments.length === 1 && method === 'GET')
    return family === 'config' || family === 'whoami' || family === 'health';
  if (family === 'tasks' && id === scope.taskId) {
    if (segments.length === 2) return method === 'GET';
    if (sub === 'comments') return true;
    return segments.length === 3 && sub === 'amend' && method === 'POST';
  }
  if (family === 'runs' && id === scope.runId) {
    if (segments.length === 2) return method === 'GET';
    return (
      segments.length === 3 &&
      method === 'POST' &&
      (sub === 'evidence' || sub === 'mutations')
    );
  }
  return (
    family === 'findings' &&
    segments.length === 1 &&
    method === 'POST' &&
    findingTask === scope.taskId
  );
}

/** The `taskId` a JSON body names, read from a clone; null when absent. */
export async function bodyTaskId(req: Request): Promise<string | null> {
  try {
    const body = (await req.clone().json()) as { taskId?: unknown };
    return typeof body.taskId === 'string' ? body.taskId : null;
  } catch {
    return null;
  }
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
      if (prop === 'amend') {
        return (...args: Parameters<TaskStorePort['amend']>): TaskDoc => {
          inherit(args[0]);
          return target.amend(...args);
        };
      }
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
      return typeof value === 'function'
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  });
}
