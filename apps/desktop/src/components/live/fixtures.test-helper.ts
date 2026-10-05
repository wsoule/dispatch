import type { EpicProgress, EpicSession, RunMeta } from '@dispatch/client';
import type { TaskListItem } from '@dispatch/core/browser';

// Builders for the Live view's tests: tasks, fan-out progress and runs, with just the
// fields the Live model reads.

export function task(
  id: string,
  overrides: Partial<TaskListItem['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: `Title ${id}`,
      status: 'ready',
      kind: 'task',
      parent: null,
      milestone: null,
      blockedBy: [],
      labels: [],
      priority: 'medium',
      assignee: 'none',
      risk: 'routine',
      writes: [],
      external: null,
      created: '2026-09-01T00:00:00.000Z',
      updated: '2026-09-10T00:00:00.000Z',
      dueDate: null,
      icon: null,
      color: null,
      sortOrder: null,
      ...overrides,
    },
  } as TaskListItem;
}

export function progress(
  epicId: string,
  state: EpicSession['state'],
  session: Partial<EpicSession> = {},
  settledUsd = 0
): EpicProgress {
  return {
    epicId,
    active: state === 'active',
    session: {
      epicId,
      concurrency: 2,
      executor: 'fake',
      state,
      maxSpendUsd: null,
      maxRuns: null,
      startedAt: '2026-09-20T00:00:00.000Z',
      startedBy: null,
      scope: 'plan',
      updatedAt: '2026-09-20T00:00:00.000Z',
      active: state === 'active',
      ...session,
    },
    spend: {
      settledUsd,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 0,
      maxSpendUsd: session.maxSpendUsd ?? null,
      maxRuns: null,
    },
    children: [],
    waves: [],
    liveRuns: [],
  };
}

export function run(taskId: string, overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: `r-${taskId}`,
    taskId,
    taskTitle: `Title ${taskId}`,
    executor: 'claude',
    state: 'running',
    branch: `dispatch/${taskId}`,
    baseBranch: 'main',
    worktreePath: '/tmp',
    createdAt: '2026-09-20T00:00:00.000Z',
    updatedAt: '2026-09-20T00:00:00.000Z',
    ...overrides,
  } as RunMeta;
}

/** Tasks by id, as the view builds it. */
export function byId(
  tasks: readonly TaskListItem[]
): Map<string, TaskListItem> {
  return new Map(tasks.map((t) => [t.meta.id, t]));
}
