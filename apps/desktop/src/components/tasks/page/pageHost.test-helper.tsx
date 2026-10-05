import type { ApiClient, RunMeta } from '@dispatch/client';
import type {
  TaskComment,
  TaskDoc,
  TaskListItem,
  UpdatePatch,
} from '@dispatch/core/browser';
import { defaultTaskFields } from '@dispatch/core/browser';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { useState } from 'react';

import {
  type ShellActions,
  ShellActionsProvider,
} from '../../shell/ShellActionsContext';
import { ToastProvider } from '../../shell/Toasts';
import type { TaskPageHost, TaskPageProject } from './TaskPageHost';
import { TaskPageHostContext } from './TaskPageHost';

// Test scaffolding for the task page: a task factory, a recording fake host, and the
// providers the page reads. The page imports the Pierre review diff, whose Vite-only
// worker import each test file stubs with `mock.module` before importing the page.

export function task(
  id: string,
  overrides: Partial<TaskDoc['meta']> = {}
): TaskListItem {
  return {
    meta: {
      id,
      title: `Title of ${id}`,
      status: 'ready',
      kind: 'task',
      priority: 'none',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      created: '2026-08-10T12:00:00.000Z',
      updated: '2026-09-13T12:00:00.000Z',
      external: null,
      selfReview: true,
      writes: [],
      risk: 'routine',
      model: null,
      exercised: false,
      ...defaultTaskFields(),
      ...overrides,
    },
  } as TaskListItem;
}

export function run(overrides: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Title of t-1',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/wt',
    createdAt: '2026-09-23T10:00:00.000Z',
    updatedAt: '2026-09-23T10:05:00.000Z',
    ...overrides,
  };
}

/** Every write the page made through the host, in order. */
export interface HostLog {
  updates: { id: string; patch: UpdatePatch }[];
  moves: { id: string; status: string }[];
  dispatches: { taskId: string; stayInPlace: boolean; effort?: string }[];
  peeks: string[];
  comments: string[];
}

export function newLog(): HostLog {
  return { updates: [], moves: [], dispatches: [], peeks: [], comments: [] };
}

// A promise that never settles: a fetch still in flight.
const pending = <T,>() => new Promise<T>(() => {});

export function fakeHost(
  log: HostLog,
  {
    tasks,
    runs = [],
    body,
    comments = [],
    me = 'human:wyat',
    client: extra = {},
    project: projectOverrides = {},
  }: {
    tasks: TaskListItem[];
    runs?: RunMeta[];
    /** The fetched body; omitted keeps the fetch in flight. */
    body?: string;
    comments?: TaskComment[];
    me?: string;
    client?: Partial<ApiClient>;
    /** Replaces the fake project's own fields. */
    project?: Partial<TaskPageProject>;
  }
): TaskPageHost {
  const client = {
    fetchTask: (id: string) =>
      body === undefined
        ? pending<TaskDoc>()
        : Promise.resolve({
            meta: tasks.find((t) => t.meta.id === id)?.meta,
            body,
          } as TaskDoc),
    fetchTaskComments: () => Promise.resolve(comments),
    addTaskComment: (_id: string, input: { body: string }) => {
      log.comments.push(input.body);
      return pending<TaskComment>();
    },
    fetchRun: () => pending(),
    fetchRunDiff: () => pending(),
    fetchReviewComments: () => Promise.resolve([]),
    getTaskPresence: () => pending(),
    ...extra,
  } as unknown as ApiClient;
  const latestRunByTaskId = new Map<string, RunMeta>();
  for (const r of runs) latestRunByTaskId.set(r.taskId, r);
  const project = {
    client,
    port: 1,
    daemonBaseUrl: null,
    me,
    config: null,
    executors: null,
    health: undefined,
    tasksIncludingArchived: tasks,
    tasksReady: true,
    runs,
    latestRunByTaskId,
    readinessById: new Map(),
    linearLinks: {},
    linearStatus: null,
    presence: [],
    mergeQueue: null,
    epicProgressById: new Map(),
    pendingApprovals: new Map(),
    openQuestions: new Map(),
    pendingScopeRequests: new Map(),
    scopeDecide: { available: true },
    enrichTaskId: null,
    enrichPlanRecord: undefined,
    handleUpdate: (id: string, patch: UpdatePatch) => {
      log.updates.push({ id, patch });
      return Promise.resolve();
    },
    moveTaskStatus: (id: string, status: string) => {
      log.moves.push({ id, status });
      return Promise.resolve();
    },
    handleEnrichTask: () => Promise.resolve(),
    handleDismissEnrich: () => {},
    ...projectOverrides,
  } as unknown as TaskPageProject;
  return {
    projectName: 'demo',
    project,
    peekTask: (id) => log.peeks.push(id),
    openTaskPage: () => {},
    dispatchTask: (taskId, _executor, _model, stayInPlace, effort) => {
      log.dispatches.push({
        taskId,
        stayInPlace,
        ...(effort === undefined ? {} : { effort }),
      });
      return Promise.resolve();
    },
    openPr: () => {},
    openImpact: () => {},
  };
}

const noop = () => {};
export const SHELL: ShellActions = {
  openTask: noop,
  openThread: noop,
  peekTask: noop,
  openCreateTask: noop,
  createPreset: null,
  closeCreateTask: noop,
  openPalette: noop,
  toggleSidebar: noop,
  sidebarHidden: false,
  openOverseer: noop,
  setProjectView: noop,
  setGlobalView: noop,
  openShortcuts: noop,
  copyTaskId: noop,
};

export function PageProviders({
  host,
  shell = SHELL,
  children,
}: {
  host: TaskPageHost | null;
  /** Replaces the default shell, whose verbs do nothing. */
  shell?: ShellActions;
  children: ReactNode;
}) {
  const [queryClient] = useState(
    () => new QueryClient({ defaultOptions: { queries: { retry: false } } })
  );
  return (
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <ShellActionsProvider value={shell}>
          <TaskPageHostContext.Provider value={host}>
            {children}
          </TaskPageHostContext.Provider>
        </ShellActionsProvider>
      </ToastProvider>
    </QueryClientProvider>
  );
}
