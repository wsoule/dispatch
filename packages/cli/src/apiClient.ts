import type { CommandEvidence, MutationEvidence } from '@dispatch/core';

import { CliError } from './context.js';

// Hand-kept mirrors of @dispatch/server's orchestrator types: server is Bun-only and
// unimportable here. CommandEvidence/MutationEvidence are pure core types instead.

export type RunState =
  | 'provisioning'
  | 'running'
  | 'awaiting-approval'
  | 'finished'
  | 'failed'
  | 'cancelled'
  | 'interrupted-dirty';

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
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  prUrl?: string;
}

export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
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

// Mirrors packages/server/src/events.ts's ServerEvent union exactly — the
// WS message shape `--watch` parses.
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

// Throws a CliError carrying the server's own `{ error }` message on any non-2xx, so
// cli.ts renders API failures in the server's wording rather than a bare status code.
async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
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
}

export function createApiClient(baseUrl: string): ApiClient {
  return {
    baseUrl,
    createRun: (taskId, executor) =>
      request(baseUrl, `/api/tasks/${taskId}/runs`, {
        ...jsonBody(executor !== undefined ? { executor } : {}),
      }),
    listRuns: () => request(baseUrl, '/api/runs'),
    getRun: (id) => request(baseUrl, `/api/runs/${id}`),
    approveRun: (runId, requestId, allow) =>
      request(baseUrl, `/api/runs/${runId}/approval`, {
        ...jsonBody({ requestId, allow }),
      }),
    sendRunMessage: (runId, text, opts = {}) =>
      request(baseUrl, `/api/runs/${runId}/message`, {
        ...jsonBody({ text, resume: opts.resume }),
      }),
    cancelRun: (runId) =>
      request(baseUrl, `/api/runs/${runId}/cancel`, { ...jsonBody({}) }),
    getRunDiff: (runId) => request(baseUrl, `/api/runs/${runId}/diff`),
    reviewRun: (runId, action) =>
      request(baseUrl, `/api/runs/${runId}/review`, {
        ...jsonBody({ action }),
      }),
    startPlan: (prompt, planner) =>
      request(baseUrl, '/api/plan', {
        ...jsonBody(planner !== undefined ? { prompt, planner } : { prompt }),
      }),
    getPlan: (planId) => request(baseUrl, `/api/plan/${planId}`),
    sendPlanMessage: (planId, text) =>
      request(baseUrl, `/api/plan/${planId}/message`, {
        ...jsonBody({ text }),
      }),
    confirmPlan: (planId, proposal) =>
      request(baseUrl, `/api/plan/${planId}/confirm`, {
        ...jsonBody({ proposal }),
      }),
    startEpic: (epicId, opts = {}) =>
      request(baseUrl, `/api/epics/${epicId}/dispatch`, { ...jsonBody(opts) }),
    stopEpic: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/stop`, { ...jsonBody({}) }),
    getEpicProgress: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/progress`),
  };
}
