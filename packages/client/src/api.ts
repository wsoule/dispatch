import type {
  CreateInput,
  DispatchConfig,
  Priority,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core';

// Extracted from @dispatch/web (Phase 2R Slice R2) so the same dispatchd
// client can serve both @dispatch/web (baseUrl '' == same origin, since
// dispatchd serves its own static files) and the Tauri desktop app (an
// explicit http://127.0.0.1:<port> the Rust sidecar hands back from
// `ensure_dispatchd`). Every function below takes `baseUrl` as its first
// argument — "baseUrl-first" — rather than reading it from `import.meta.env`,
// which was web-only and not something this package can depend on.

export interface HealthPayload {
  ok: boolean;
  version: string;
  rootDir: string;
  // Phase 5 P1: whether this project can use the PR review action (gh on
  // PATH + a configured git remote) — gates whether the desktop UI shows
  // the "Open PR" action at all.
  pr: boolean;
}

export interface TaskFilter {
  status?: string;
  kind?: string;
  parent?: string;
}

// Mirrors packages/server/src/orchestrator/types.ts's RunState exactly —
// dispatchd is the source of truth for these strings, this is just the
// client-side copy of the same contract (the client package can't import
// server internals across the package boundary).
export type RunState =
  | 'provisioning'
  | 'running'
  | 'awaiting-approval'
  | 'finished'
  | 'failed'
  | 'cancelled';

// Mirrors RunMeta in packages/server/src/orchestrator/types.ts.
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
  // Phase 5 P1: set once a run has been reviewed (merge/discard/pr) or its PR
  // has merged — mirrors RunMeta's own one-way markers in
  // packages/server/src/orchestrator/types.ts.
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  // Set once the PR review action has pushed the branch and opened a GitHub
  // PR — stays set (and `reviewedAt` stays unset) until the PR poller sees it
  // merged.
  prUrl?: string;
}

// Mirrors NormalizedEntry in packages/server/src/orchestrator/types.ts — the
// one log-entry shape every executor streams, real or fake. `kind: 'message'`
// is the agent-comms identified chat channel: `from: 'user'` is the run's own
// human via the Session composer, `from: 'agent'` is either another live
// run's `agent_message` (sender named in `fromLabel`) or this run's own
// `message_user` call raised to the human.
export interface NormalizedEntry {
  ts: string;
  kind: 'assistant' | 'tool' | 'thinking' | 'system' | 'usage' | 'message';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  from?: 'user' | 'agent';
  fromLabel?: string;
  // Set on this run's own `message_user` call — the agent flagging something
  // UP to the human — so the app can badge it distinctly from an inbound
  // `agent_message` (which has no `toUser` and whose `fromLabel` names a
  // different run). See the server-side NormalizedEntry for the full note.
  toUser?: boolean;
}

// The body of `GET /api/runs/:id`.
export interface RunDetail {
  meta: RunMeta;
  entries: NormalizedEntry[];
}

export interface DiffFile {
  path: string;
  status: string;
}

// The body of `GET /api/runs/:id/diff`.
export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

// GitHub PR status + conversation for a run's PR — mirrors PrStatus /
// PrConversationItem / PrDetail in packages/server/src/orchestrator/pr.ts. The
// body of `GET /api/runs/:id/pr` (and what the review/comment POSTs return).
export interface PrCheckSummary {
  passed: number;
  failed: number;
  pending: number;
  total: number;
}

export interface PrStatus {
  number: number;
  url: string;
  title: string;
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  isDraft: boolean;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' | null;
  checks: PrCheckSummary;
  additions: number;
  deletions: number;
  changedFiles: number;
}

export interface PrConversationItem {
  kind: 'review' | 'comment' | 'line-comment';
  author: string;
  body: string;
  createdAt: string;
  state?: 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED';
  path?: string;
  line?: number;
}

export interface PrDetail {
  status: PrStatus;
  conversation: PrConversationItem[];
}

export type PrReviewEvent = 'approve' | 'request-changes' | 'comment';

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
  // Phase 5 P2: a plan's state (running -> ready|failed) changed, or it was
  // just confirmed. Same "go refetch" contract as the other *.changed events
  // — mirrors packages/server/src/events.ts exactly.
  | { type: 'plan.changed'; planId: string };

// Mirrors PlannedTask in packages/server/src/orchestrator/planner.ts.
// `blockedByIndices` refers to *other entries in this same proposal's
// `tasks` array* (0-based) — never a real task id, since ids are minted only
// at confirm time.
export interface PlannedTask {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  blockedByIndices: number[];
  priority: Priority;
}

// Mirrors PlanProposal in packages/server/src/orchestrator/planner.ts.
export interface PlanProposal {
  epic?: { title: string; description: string };
  tasks: PlannedTask[];
}

export type PlanState = 'running' | 'ready' | 'failed';

// Mirrors PlanRecord in packages/server/src/orchestrator/plan.ts — the body
// of `GET /api/plan/:id`.
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

// The body of `POST /api/plan/:id/confirm`.
export interface ConfirmResult {
  epicId?: string;
  taskIds: string[];
}

// Mirrors EpicSession in packages/server/src/orchestrator/epic.ts.
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

// The body of `GET /api/epics/:id/progress`.
export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  children: EpicProgressChild[];
  liveRuns: RunMeta[];
}

// Shared fetch wrapper: resolves against `baseUrl`, throws with the server's
// `{ error }` message (falling back to the status code) on any non-2xx
// response, and parses the body as JSON on success. Every typed fetcher below
// is a thin wrapper around this.
async function request<T>(
  baseUrl: string,
  path: string,
  init?: RequestInit
): Promise<T> {
  const res = await fetch(`${baseUrl}${path}`, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error ?? `request failed: ${res.status}`);
  }
  return (await res.json()) as T;
}

function jsonBody(value: unknown): RequestInit {
  return {
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(value),
  };
}

// Pure helper (no fetch involved) so the query-string shape is unit
// testable without a network layer: `?` + params when any filter is set, ''
// otherwise, in the same status/kind/parent order the server accepts.
export function taskQueryString(filter: TaskFilter = {}): string {
  const params = new URLSearchParams();
  if (filter.status !== undefined) params.set('status', filter.status);
  if (filter.kind !== undefined) params.set('kind', filter.kind);
  if (filter.parent !== undefined) params.set('parent', filter.parent);
  return params.size > 0 ? `?${params.toString()}` : '';
}

// Pure helper (no DOM involved): swaps an http(s) origin for its ws(s)
// equivalent and appends `/ws`.
export function httpToWs(origin: string): string {
  return `${origin.replace(/^http/, 'ws')}/ws`;
}

// Resolves the WS URL for a given baseUrl, falling back to the current
// page's own origin when baseUrl is empty — the same-origin default case
// (dispatchd serving its own static UI).
export function wsUrl(baseUrl: string): string {
  return httpToWs(baseUrl !== '' ? baseUrl : window.location.origin);
}

// The subset of the DOM `WebSocket` interface `connectEvents` needs, so
// tests can pass a plain fake object instead of a real socket (there is no
// real WS server to connect to in a unit test).
export interface SocketLike {
  addEventListener(
    type: 'message',
    listener: (event: { data: unknown }) => void
  ): void;
  addEventListener(type: 'close' | 'error', listener: () => void): void;
  close(): void;
}

export interface ConnectEventsOptions {
  // Defaults to `(url) => new WebSocket(url)`. Overridden in tests to inject
  // a fake socket instead of opening a real network connection.
  createSocket?: (url: string) => SocketLike;
  // Defaults to 1000ms. Overridden in tests so reconnect assertions don't
  // have to wait a full second.
  reconnectDelayMs?: number;
  // Called for every successfully parsed ServerEvent, including
  // `task.changed` and `hello` — the orchestrator UI (Phase 4 Slice O3) needs
  // `run.changed`/`run.log`/`approval.requested` too, which `onChange` alone
  // can't carry (it fires only for `task.changed`, unchanged from Phase 2R,
  // so existing callers keep their exact behavior). A malformed frame never
  // reaches this callback — see the `try/catch` around `JSON.parse` below.
  onEvent?: (event: ServerEvent) => void;
}

// Opens a WS connection to dispatchd and calls `onChange` for every
// `task.changed` event. Reconnects on close/error with a fixed backoff — the
// protocol is "go refetch," not a diff, so a connection dropping briefly just
// means the UI is briefly less live, never wrong. Returns a disposer that
// stops reconnecting and closes the current socket.
export function connectEvents(
  baseUrl: string,
  onChange: () => void,
  options: ConnectEventsOptions = {}
): () => void {
  const createSocket = options.createSocket ?? ((url) => new WebSocket(url));
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;

  let closed = false;
  let socket: SocketLike | null = null;
  // A failed browser WebSocket fires 'error' then 'close' on the same
  // socket, and both listeners below call scheduleReconnect — without this
  // guard that queues two reconnect timers per failure, each of which can
  // fail the same way and double again next generation. `scheduled` caps it
  // at one pending reconnect per socket generation; connect() resets it for
  // the next one.
  let scheduled = false;

  function scheduleReconnect() {
    if (closed || scheduled) return;
    scheduled = true;
    setTimeout(connect, reconnectDelayMs);
  }

  function connect() {
    if (closed) return;
    scheduled = false;
    socket = createSocket(wsUrl(baseUrl));
    socket.addEventListener('message', (event) => {
      // A malformed frame (bad JSON, or JSON that isn't a ServerEvent) should
      // never take down the UI's reconnect loop — ignore it and wait for the
      // next message rather than letting JSON.parse throw out of this
      // handler.
      let data: ServerEvent;
      try {
        data = JSON.parse(event.data as string) as ServerEvent;
      } catch {
        return;
      }
      if (data.type === 'task.changed') onChange();
      options.onEvent?.(data);
    });
    socket.addEventListener('close', scheduleReconnect);
    socket.addEventListener('error', scheduleReconnect);
  }

  connect();
  return () => {
    closed = true;
    socket?.close();
  };
}

// Bound client shape returned by `createApiClient` — every method already
// carries `baseUrl`, so callers never repeat it.
export interface ApiClient {
  baseUrl: string;
  fetchHealth(): Promise<HealthPayload>;
  fetchConfig(): Promise<DispatchConfig>;
  fetchTasks(filter?: TaskFilter): Promise<TaskDoc[]>;
  fetchReadyTasks(): Promise<TaskDoc[]>;
  fetchTask(id: string): Promise<TaskDoc>;
  createTask(input: CreateInput): Promise<TaskDoc>;
  updateTask(id: string, patch: UpdatePatch): Promise<TaskDoc>;
  // Orchestrator run endpoints (Phase 4 Slice O1/O2 API, Slice O3 client) —
  // see packages/server/src/api.ts for the exact request/response shapes
  // these mirror. `executor` defaults to 'claude' server-side when omitted;
  // 'fake' stays reachable for the dev-only manual-smoke toggle the desktop
  // UI gates behind a localStorage flag (see apps/desktop/src/lib/devTools.ts).
  createRun(taskId: string, executor?: 'fake' | 'claude'): Promise<RunMeta>;
  fetchRuns(): Promise<RunMeta[]>;
  fetchRun(id: string): Promise<RunDetail>;
  approveRun(runId: string, requestId: string, allow: boolean): Promise<void>;
  sendRunMessage(
    runId: string,
    text: string,
    opts?: { resume?: boolean }
  ): Promise<RunMeta>;
  cancelRun(runId: string): Promise<void>;
  fetchRunDiff(runId: string): Promise<DiffResult>;
  reviewRun(
    runId: string,
    action: 'merge' | 'discard' | 'pr'
  ): Promise<RunMeta>;
  // GitHub PR review surface (items 3+4): read a run's PR status + conversation,
  // submit a review verdict (approve/request-changes/comment), or add a
  // PR-level comment — each POST returns the refreshed PrDetail. All 409 a run
  // with no open PR.
  fetchPrDetail(runId: string): Promise<PrDetail>;
  reviewPr(
    runId: string,
    event: PrReviewEvent,
    body?: string
  ): Promise<PrDetail>;
  commentPr(runId: string, body: string): Promise<PrDetail>;
  // Phase 5 P2: the messaging half (`agent_message`'s daemon-side landing
  // spot) — injects a message into a *running* run, prefixed
  // `[message from <sender>]` server-side (a generic "another agent" label
  // when `fromRunId` is omitted or doesn't resolve to a known run). 409s
  // when the run isn't currently `running`.
  injectRun(runId: string, text: string, fromRunId?: string): Promise<RunMeta>;
  // agent-comms: the agent->human channel (`message_user`'s daemon-side
  // landing spot) — records a `from: 'agent'` message on the run's OWN
  // transcript rather than delivering into any executor. 409s when the run
  // isn't currently `running`.
  messageUser(runId: string, text: string): Promise<RunMeta>;
  // Phase 5 P2: the big-prompt plan flow. `startPlan` returns immediately
  // (202) with the plan's id — poll `fetchPlan`/watch `plan.changed` over WS
  // for it to move to `ready`/`failed`. `confirmPlan` sends the (possibly
  // client-edited) proposal back verbatim; the server re-validates it from
  // scratch and is the only place that actually writes the epic/tasks.
  startPlan(prompt: string): Promise<{ planId: string }>;
  fetchPlan(planId: string): Promise<PlanRecord>;
  confirmPlan(planId: string, proposal: PlanProposal): Promise<ConfirmResult>;
  // Phase 5 P2: epic-level concurrent dispatch. `concurrency` defaults
  // server-side to the project's `orchestrator.epicConcurrency` config.
  startEpic(
    epicId: string,
    opts?: { concurrency?: number; executor?: 'fake' | 'claude' }
  ): Promise<EpicSession>;
  stopEpic(epicId: string): Promise<EpicSession>;
  fetchEpicProgress(epicId: string): Promise<EpicProgress>;
  wsUrl(): string;
  connectEvents(
    onChange: () => void,
    options?: ConnectEventsOptions
  ): () => void;
}

// Builds a dispatchd API client bound to one base URL. `baseUrl` is empty for
// same-origin use (the web app, served by dispatchd itself) or an explicit
// `http://127.0.0.1:<port>` for the desktop app pointing at a sidecar
// dispatchd on some other port.
export function createApiClient(baseUrl: string): ApiClient {
  return {
    baseUrl,
    fetchHealth: () => request(baseUrl, '/api/health'),
    fetchConfig: () => request(baseUrl, '/api/config'),
    fetchTasks: (filter = {}) =>
      request(baseUrl, `/api/tasks${taskQueryString(filter)}`),
    fetchReadyTasks: () => request(baseUrl, '/api/tasks/ready'),
    fetchTask: (id) => request(baseUrl, `/api/tasks/${id}`),
    createTask: (input) =>
      request(baseUrl, '/api/tasks', { method: 'POST', ...jsonBody(input) }),
    updateTask: (id, patch) =>
      request(baseUrl, `/api/tasks/${id}`, {
        method: 'PATCH',
        ...jsonBody(patch),
      }),
    createRun: (taskId, executor) =>
      request(baseUrl, `/api/tasks/${taskId}/runs`, {
        method: 'POST',
        ...jsonBody(executor !== undefined ? { executor } : {}),
      }),
    fetchRuns: () => request(baseUrl, '/api/runs'),
    fetchRun: (id) => request(baseUrl, `/api/runs/${id}`),
    approveRun: async (runId, requestId, allow) => {
      await request(baseUrl, `/api/runs/${runId}/approval`, {
        method: 'POST',
        ...jsonBody({ requestId, allow }),
      });
    },
    sendRunMessage: (runId, text, opts = {}) =>
      request(baseUrl, `/api/runs/${runId}/message`, {
        method: 'POST',
        ...jsonBody({ text, ...opts }),
      }),
    cancelRun: async (runId) => {
      await request(baseUrl, `/api/runs/${runId}/cancel`, { method: 'POST' });
    },
    fetchRunDiff: (runId) => request(baseUrl, `/api/runs/${runId}/diff`),
    reviewRun: (runId, action) =>
      request(baseUrl, `/api/runs/${runId}/review`, {
        method: 'POST',
        ...jsonBody({ action }),
      }),
    fetchPrDetail: (runId) => request(baseUrl, `/api/runs/${runId}/pr`),
    reviewPr: (runId, event, body) =>
      request(baseUrl, `/api/runs/${runId}/pr/review`, {
        method: 'POST',
        ...jsonBody({ event, body: body ?? '' }),
      }),
    commentPr: (runId, body) =>
      request(baseUrl, `/api/runs/${runId}/pr/comment`, {
        method: 'POST',
        ...jsonBody({ body }),
      }),
    injectRun: (runId, text, fromRunId) =>
      request(baseUrl, `/api/runs/${runId}/inject`, {
        method: 'POST',
        ...jsonBody(fromRunId !== undefined ? { text, fromRunId } : { text }),
      }),
    messageUser: (runId, text) =>
      request(baseUrl, `/api/runs/${runId}/message-user`, {
        method: 'POST',
        ...jsonBody({ text }),
      }),
    startPlan: (prompt) =>
      request(baseUrl, '/api/plan', {
        method: 'POST',
        ...jsonBody({ prompt }),
      }),
    fetchPlan: (planId) => request(baseUrl, `/api/plan/${planId}`),
    confirmPlan: (planId, proposal) =>
      request(baseUrl, `/api/plan/${planId}/confirm`, {
        method: 'POST',
        ...jsonBody({ proposal }),
      }),
    startEpic: (epicId, opts = {}) =>
      request(baseUrl, `/api/epics/${epicId}/dispatch`, {
        method: 'POST',
        ...jsonBody(opts),
      }),
    stopEpic: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/stop`, { method: 'POST' }),
    fetchEpicProgress: (epicId) =>
      request(baseUrl, `/api/epics/${epicId}/progress`),
    wsUrl: () => wsUrl(baseUrl),
    connectEvents: (onChange, options) =>
      connectEvents(baseUrl, onChange, options),
  };
}
