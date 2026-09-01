import type {
  CommandEvidence,
  CreateInput,
  MutationEvidence,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';

import { CliError } from './context.js';

// Hand-kept mirrors of @dispatch/server's orchestrator types: server is Bun-only and
// unimportable here. CommandEvidence/MutationEvidence are pure core types instead.

// An array, not a bare union, so the member list exists at runtime for
// run-state-mirror.test.ts to compare against the server's own RunState.
export const RUN_STATES = [
  'provisioning',
  'running',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
] as const;

export type RunState = (typeof RUN_STATES)[number];

export interface RunMeta {
  id: string;
  taskId: string;
  taskTitle: string;
  executor: string;
  state: RunState;
  branch: string;
  baseBranch: string;
  worktreePath: string;
  createdAt: string;
  updatedAt: string;
  costUsd?: number;
  turns?: number;
  sessionId?: string;
  error?: string;
  model?: string;
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  mergeCommit?: string;
  prUrl?: string;
  archivedAt?: string;
  resumedFrom?: string;
  stackParents?: string[];
  stackBaseCommit?: string;
  baseDiscarded?: boolean;
  baseDiscardedReason?: string;
  // What a `failed`/`interrupted-dirty` run left uncommitted. Loosely typed:
  // no CLI surface reads inside it yet.
  survey?: unknown;
  kind?: 'execute' | 'review' | 'verify';
  claims?: string[];
}

export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage' | 'message';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  // `kind: 'message'` only: this run's human (`user`), another run's
  // agent_message (`fromLabel`), or this run's own message_user (`toUser`).
  from?: 'user' | 'agent';
  fromLabel?: string;
  toUser?: boolean;
}

export interface RunDetail {
  meta: RunMeta;
  entries: NormalizedEntry[];
  evidence: CommandEvidence[];
  mutations: MutationEvidence[];
}

export interface DiffFile {
  path: string;
  status: string;
}

interface DiffResult {
  patch: string;
  files: DiffFile[];
}

type PlanState = 'running' | 'ready' | 'failed';

interface PlannedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIndices: number[];
  priority: string;
  writes?: string[];
  risk?: string;
}

export interface PlanProposal {
  epic?: { title: string; description: string };
  tasks: PlannedTask[];
}

interface PlanMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

interface PlannerQuestion {
  id: string;
  question: string;
  options: string[];
}

export interface PlanRecord {
  id: string;
  prompt: string;
  state: PlanState;
  messages: PlanMessage[];
  proposal?: PlanProposal;
  // Clarifying questions from the latest assistant turn. A plan can settle
  // 'ready' with questions and no proposal — answer them to keep going.
  questions: PlannerQuestion[];
  error?: string;
  createdAt: string;
  updatedAt: string;
  confirmedAt?: string;
}

interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
}

interface EpicSession {
  epicId: string;
  concurrency: number;
  active: boolean;
  completedAt?: string;
}

interface EpicProgressChild {
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

// The subset of packages/server/src/events.ts's ServerEvent union that
// `--watch` acts on — deliberately partial; any other event is ignored.
export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string }
  | { type: 'run.changed' }
  | { type: 'run.log'; runId: string; entry: NormalizedEntry }
  | {
      type: 'approval.requested';
      runId: string;
      requestId: string;
      toolName: string;
    }
  | { type: 'plan.changed'; planId: string };

// Mirrors RunScopeRequest in packages/server/src/orchestrator/scopeRequests.ts:
// an out-of-fence edit an agent asked for, blocked until someone decides it.
interface ScopeRequest {
  id: string;
  runId: string;
  paths: string[];
  reason: string;
  requestedAt: string;
  granted: boolean | null;
  decisionReason: string | null;
  decidedAt: string | null;
}

/** Where a request goes and which daemon token it presents. */
interface ApiTarget {
  baseUrl: string;
  token: string;
}

// Throws a CliError carrying the server's own `{ error }` message on any non-2xx, so
// cli.ts renders API failures in the server's wording rather than a bare status code.
async function request<T>(
  target: ApiTarget,
  path: string,
  init?: RequestInit
): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set('authorization', `Bearer ${target.token}`);
  // A transport failure is caught and named. There is a real gap between the
  // daemon-file health probe that chose this route and the request itself, and
  // a daemon exiting inside it is ordinary — a restart, a crash, the desktop
  // app quitting. Letting fetch's own rejection escape surfaced to the user as
  // a bare `TypeError: fetch failed`, which names neither the cause nor the
  // fix.
  let res: Response;
  try {
    res = await fetch(`${target.baseUrl}${path}`, { ...init, headers });
  } catch (err) {
    throw new CliError(
      `dispatchd stopped responding at ${target.baseUrl} (${(err as Error).message}). ` +
        'It answered a health check moments ago, so it has probably just exited — start it again with: dispatch serve'
    );
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new CliError(body.error ?? `request failed: ${res.status}`);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

/**
 * Filter for `listTasks`, mirroring core's own `ListFilter` — which is what
 * callers actually pass, so this stays module-local rather than exported.
 */
interface TaskListQuery {
  status?: string;
  kind?: string;
  parent?: string;
}

/**
 * The daemon's task surface, kept separate from `ApiClient` below rather than
 * folded into it.
 *
 * dispatchd is a project's single writer, so when one is running the CLI asks
 * it for task CRUD instead of opening the store itself (see commands/task.ts
 * for what happens when none is). That is a different concern from the run /
 * plan / epic surface `ApiClient` covers, and separating them means a caller
 * — or a test double — only has to satisfy the half it actually uses.
 */
export interface TaskApiClient {
  listTasks(query?: TaskListQuery): Promise<TaskDoc[]>;
  readyTasks(): Promise<TaskDoc[]>;
  getTask(id: string): Promise<TaskDoc>;
  createTask(input: CreateInput): Promise<TaskDoc>;
  updateTask(id: string, patch: UpdatePatch): Promise<TaskDoc>;
  /**
   * Records the daemon's last cache rebuild could not read, from
   * `GET /api/health`. These never appear in `listTasks`, so a caller that
   * only lists sees a clean board over a damaged one — which is exactly what
   * `dispatch doctor` is for.
   */
  healthProblems(): Promise<string[]>;
}

/** Builds the task half of the daemon API, bound to one daemon + token. */
export function createTaskApiClient(
  baseUrl: string,
  token: string
): TaskApiClient {
  const target: ApiTarget = { baseUrl, token };
  return {
    listTasks: (query = {}) => {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined) params.set(key, value);
      }
      // `GET /api/tasks` hides archived tasks unless asked; `TaskStore.list`,
      // which `dispatch task list` used to call, has no archived filter at
      // all. Asking for them keeps the command's output the same whether or
      // not a daemon happens to be running.
      params.set('archived', '1');
      return request(target, `/api/tasks?${params.toString()}`);
    },
    readyTasks: () => request(target, '/api/tasks/ready'),
    healthProblems: async () => {
      const health = await request<{ problems?: unknown }>(
        target,
        '/api/health'
      );
      return Array.isArray(health.problems)
        ? health.problems.filter((p): p is string => typeof p === 'string')
        : [];
    },
    getTask: (id) => request(target, `/api/tasks/${encodeURIComponent(id)}`),
    createTask: (input) => request(target, '/api/tasks', jsonBody(input)),
    updateTask: (id, patch) =>
      request(target, `/api/tasks/${encodeURIComponent(id)}`, {
        ...jsonBody(patch),
        method: 'PATCH',
      }),
  };
}

// Bound client returned by `createApiClient` — every method carries `baseUrl` already.
// Task CRUD lives on `TaskApiClient` above instead.
export interface ApiClient {
  baseUrl: string;
  createRun(taskId: string, executor?: string): Promise<RunMeta>;
  listRuns(): Promise<RunMeta[]>;
  getRun(id: string): Promise<RunDetail>;
  approveRun(runId: string, requestId: string, allow: boolean): Promise<void>;
  sendRunMessage(
    runId: string,
    text: string,
    opts?: { resume?: boolean }
  ): Promise<RunMeta>;
  cancelRun(runId: string): Promise<void>;
  getRunDiff(runId: string): Promise<DiffResult>;
  reviewRun(
    runId: string,
    action: 'merge' | 'discard' | 'pr'
  ): Promise<RunMeta>;
  startPlan(prompt: string, planner?: string): Promise<{ planId: string }>;
  getPlan(planId: string): Promise<PlanRecord>;
  sendPlanMessage(planId: string, text: string): Promise<PlanRecord>;
  confirmPlan(planId: string, proposal: PlanProposal): Promise<ConfirmResult>;
  startEpic(
    epicId: string,
    opts?: { concurrency?: number; executor?: string }
  ): Promise<EpicSession>;
  stopEpic(epicId: string): Promise<EpicSession>;
  getEpicProgress(epicId: string): Promise<EpicProgress>;
  getScopeRequest(runId: string, requestId: string): Promise<ScopeRequest>;
  // Decide-tier: only a client built on the app token can call this.
  decideScopeRequest(
    runId: string,
    requestId: string,
    granted: boolean,
    reason: string
  ): Promise<ScopeRequest>;
}

// `token` is the credential every call presents — the agent token from the
// daemon file for ordinary commands, and only for `dispatch scope decide` an
// app token the user supplied explicitly.
export function createApiClient(baseUrl: string, token: string): ApiClient {
  const target: ApiTarget = { baseUrl, token };
  return {
    baseUrl,
    createRun: (taskId, executor) =>
      request(target, `/api/tasks/${taskId}/runs`, {
        ...jsonBody(executor !== undefined ? { executor } : {}),
      }),
    listRuns: () => request(target, '/api/runs'),
    getRun: (id) => request(target, `/api/runs/${id}`),
    approveRun: (runId, requestId, allow) =>
      request(target, `/api/runs/${runId}/approval`, {
        ...jsonBody({ requestId, allow }),
      }),
    sendRunMessage: (runId, text, opts = {}) =>
      request(target, `/api/runs/${runId}/message`, {
        ...jsonBody({ text, resume: opts.resume }),
      }),
    cancelRun: (runId) =>
      request(target, `/api/runs/${runId}/cancel`, { ...jsonBody({}) }),
    getRunDiff: (runId) => request(target, `/api/runs/${runId}/diff`),
    reviewRun: (runId, action) =>
      request(target, `/api/runs/${runId}/review`, {
        ...jsonBody({ action }),
      }),
    startPlan: (prompt, planner) =>
      request(target, '/api/plan', {
        ...jsonBody(planner !== undefined ? { prompt, planner } : { prompt }),
      }),
    getPlan: (planId) => request(target, `/api/plan/${planId}`),
    sendPlanMessage: (planId, text) =>
      request(target, `/api/plan/${planId}/message`, {
        ...jsonBody({ text }),
      }),
    confirmPlan: (planId, proposal) =>
      request(target, `/api/plan/${planId}/confirm`, {
        ...jsonBody({ proposal }),
      }),
    startEpic: (epicId, opts = {}) =>
      request(target, `/api/epics/${epicId}/dispatch`, { ...jsonBody(opts) }),
    stopEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/stop`, { ...jsonBody({}) }),
    getEpicProgress: (epicId) =>
      request(target, `/api/epics/${epicId}/progress`),
    getScopeRequest: (runId, requestId) =>
      request(target, `/api/runs/${runId}/scope-requests/${requestId}`),
    decideScopeRequest: (runId, requestId, granted, reason) =>
      request(
        target,
        `/api/runs/${runId}/scope-requests/${requestId}/decide`,
        jsonBody({ granted, reason })
      ),
  };
}
