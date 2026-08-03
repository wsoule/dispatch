import type { CommandEvidence, MutationEvidence } from '@dispatch/core';

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

export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

export type PlanState = 'running' | 'ready' | 'failed';

export interface PlannedTask {
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

export interface PlanMessage {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}

export interface PlannerQuestion {
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

export interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
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
export interface ScopeRequest {
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
  const res = await fetch(`${target.baseUrl}${path}`, { ...init, headers });
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

// Bound client returned by `createApiClient` — every method carries `baseUrl` already.
// Task CRUD reads go straight through `@dispatch/core`'s TaskStore instead.
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
