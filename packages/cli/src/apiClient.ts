import { CliError } from './context.js';

// ---------------------------------------------------------------------------
// Type mirrors
//
// `@dispatch/server` can't be imported from this package at all (it's
// Bun-only — bun:sqlite, Bun.serve — and its `exports` map intentionally
// hides everything but `package.json`; see commands/daemon.ts's own
// daemon-file-discovery block for the established precedent of duplicating
// just the pieces this package needs rather than reaching across that
// boundary). `@dispatch/client` has the same shapes already, but its only
// export barrel (`index.ts`) re-exports `useTasks`, which imports `react` —
// pulling that in here would give this Node CLI package a real dependency on
// React for a handful of type definitions. So these are hand-kept mirrors of
// packages/server/src/orchestrator/types.ts, planner.ts, epic.ts,
// worktree.ts, and events.ts — keep them in sync by hand if any of those
// shapes change, the same maintenance contract packages/client/src/api.ts's
// own mirrors already carry.
// ---------------------------------------------------------------------------

export type RunState =
  | 'provisioning'
  | 'running'
  | 'awaiting-approval'
  | 'finished'
  | 'failed'
  | 'cancelled';

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
}

export interface PlanProposal {
  epic?: { title: string; description: string };
  tasks: PlannedTask[];
}

export interface PlanRecord {
  id: string;
  prompt: string;
  state: PlanState;
  proposal?: PlanProposal;
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

// Thin fetch wrapper: throws a CliError carrying the server's own `{ error }`
// message (falling back to the raw status code) on any non-2xx response, so
// every command's catch-all in cli.ts renders API failures — including the
// 409 "already reviewed"/"has an open PR"/dirty-checkout style conflicts —
// with the server's own wording, verbatim, and nothing else. Mirrors
// packages/client/src/api.ts's own `request()` almost exactly; duplicated
// rather than imported for the same reason the type mirrors above are (see
// this file's module doc comment).
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

// Bound client shape returned by `createApiClient` — every method already
// carries `baseUrl`, so callers never repeat it. Covers exactly the
// endpoints packages/cli's orchestrate/plan commands need; task CRUD reads
// go straight through `@dispatch/core`'s TaskStore instead (no daemon
// needed for those — see commands/task.ts).
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
