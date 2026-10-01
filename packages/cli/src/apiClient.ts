import type {
  CommandEvidence,
  CreateInput,
  Finding,
  LedgerEntry,
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
  /** ActorRef of the human who dispatched this run — see the server's RunMeta. */
  dispatchedBy?: string;
  model?: string;
  reviewedAt?: string;
  reviewAction?: 'merge' | 'discard' | 'pr';
  mergeCommit?: string;
  // Why the last merge/discard attempt threw and left the run unreviewed.
  reviewFailure?: { action: 'merge' | 'discard'; reason: string; at: string };
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
  // How many sub-agents the run's agent fanned out into and where they
  // stand — mirrors RunMeta.subagents server-side.
  subagents?: {
    total: number;
    running: number;
    done: number;
    failed: number;
    stopped: number;
  };
}

export interface NormalizedEntry {
  ts: string;
  kind:
    | 'assistant'
    | 'tool'
    | 'thinking'
    | 'system'
    | 'usage'
    | 'message'
    | 'agent';
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  status?: 'running' | 'done' | 'error';
  // Set on entries a sub-agent made rather than the run's own agent.
  parentToolUseId?: string;
  // `kind: 'agent'` only: one lifecycle event of a spawned sub-agent —
  // mirrors SubagentEvent in @dispatch/core.
  agent?: {
    id: string;
    phase: 'started' | 'progress' | 'finished';
    status: 'running' | 'done' | 'failed' | 'stopped';
    label?: string;
    type?: string;
    summary?: string;
  };
  // `kind: 'message'` only: this run's human (`user`), another agent
  // (`fromLabel`), or a message this run sent to a human (`toUser`).
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

// Mirrors EpicSessionState / EpicPauseReason in
// packages/server/src/orchestrator/epic.ts.
type EpicSessionState = 'active' | 'paused' | 'stopped' | 'complete';
type EpicPauseReason = 'human' | 'budget' | 'runs' | 'fill-failed';

// Mirrors EpicSession in packages/server/src/orchestrator/epic.ts — the body
// of `POST /api/epics/:id/dispatch`, `/pause`, `/resume` and `/stop`.
export interface EpicSession {
  epicId: string;
  concurrency: number;
  executor: string;
  state: EpicSessionState;
  // Set while paused, cleared on resume.
  pausedReason?: EpicPauseReason;
  // The message behind a `fill-failed` pause.
  pausedDetail?: string;
  // `null` = no ceiling.
  maxSpendUsd: number | null;
  maxRuns: number | null;
  startedAt: string;
  updatedAt: string;
  completedAt?: string;
  // `state === 'active'` — what `formatEpicProgress` and `--watch` key on.
  active: boolean;
}

// Mirrors EpicSpend in packages/server/src/orchestrator/epicPhase.ts: what
// one session has spent and started, against its ceilings.
export interface EpicSpend {
  // Σ `RunMeta.costUsd` over the session's runs (stamped at finish).
  settledUsd: number;
  // Non-terminal session runs, any kind.
  liveCount: number;
  // `liveCount × orchestrator.runCostEstimateUsd`.
  estimatedLiveUsd: number;
  // Session runs of every kind — what `maxRuns` bounds.
  runsStarted: number;
  maxSpendUsd: number | null;
  maxRuns: number | null;
}

// Mirrors EpicChildPhase in packages/server/src/orchestrator/epicPhase.ts:
// where a child stands inside its epic's fan-out, derived server-side so the
// CLI and desktop agree.
type EpicChildPhase =
  | 'draft'
  | 'waiting'
  | 'queued'
  | 'held'
  | 'working'
  | 'reviewing'
  | 'fixing'
  | 'needs-review'
  | 'capped'
  | 'failed'
  | 'blocked'
  | 'landing'
  | 'landed'
  | 'dropped';

// Mirrors EpicProgressChild in packages/server/src/orchestrator/epicPhase.ts.
export interface EpicProgressChild {
  id: string;
  title: string;
  status: string;
  phase: EpicChildPhase;
  // Depth along `blockedBy` edges inside the epic, 1-based.
  wave: number;
  reason?: string;
  // The live run, else the latest one.
  runId?: string;
  // The latest run's cost.
  costUsd?: number;
  openFindings: number;
}

// Mirrors EpicWave in packages/server/src/orchestrator/epicPhase.ts.
interface EpicWave {
  index: number;
  total: number;
  byPhase: Partial<Record<EpicChildPhase, number>>;
}

// Mirrors EpicProgress in packages/server/src/orchestrator/epic.ts — the
// body of `GET /api/epics/:id/progress`.
export interface EpicProgress {
  epicId: string;
  active: boolean;
  concurrency?: number;
  // `null` until the epic's first `startEpic`.
  session: EpicSession | null;
  // For the session's runs, or for every child run when there is none.
  spend: EpicSpend;
  children: EpicProgressChild[];
  waves: EpicWave[];
  liveRuns: RunMeta[];
}

// The optional body `startEpic` and `resumeEpic` take. `null` lifts a
// ceiling; the server ranges every value and 400s out of range.
interface EpicSessionOptions {
  concurrency?: number;
  executor?: string;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
}

// The subset of packages/server/src/events.ts's ServerEvent union that
// `--watch` acts on — deliberately partial; any other event is ignored.
export type ServerEvent =
  | { type: 'task.changed' }
  | { type: 'hello'; version: string }
  | { type: 'run.changed' }
  | { type: 'run.log'; runId: string; entry: NormalizedEntry }
  | { type: 'message.new'; message: Message }
  | { type: 'plan.changed'; planId: string }
  | { type: 'epic.changed'; epicId: string }
  | { type: 'epic.paused'; epicId: string; reason: EpicPauseReason };

// Mirrors Message in packages/protocol/src/envelope.ts. A gate is a blocking
// question whose `data.type` names what answering it decides.
export interface Message {
  id: string;
  thread: string;
  replyTo: string | null;
  from: string;
  session?: string;
  to: string[];
  kind: string;
  body: string;
  refs: { type: string; id: string; at?: string }[];
  data?: unknown;
  urgent: boolean;
  blocking: boolean;
  choices?: string[];
  choice?: string;
  wake: 'none' | 'request';
  createdAt: string;
}

// Mirrors SendResult in packages/protocol/src/engine.ts.
interface SendResult {
  message: Message;
  deliveries: {
    id: string;
    recipient: string;
    runId: string | null;
    state: string;
  }[];
  downgraded: boolean;
}

/** Where a request goes and which daemon token it presents. */
interface ApiTarget {
  baseUrl: string;
  token: string;
}

// The ceiling on one daemon request. Every route the CLI calls answers from
// memory, SQLite or a local git command; the two that kick off real work
// (POST /api/plan, POST /api/tasks/:id/runs) hand back an id and let the
// client poll, so nothing here is legitimately slow. Without a deadline a
// daemon that is alive with a blocked event loop takes the CLI down with it
// — `dispatch runs` sat past 120s that way on 2026-08-23 — because fetch on
// an accepted-but-unanswered connection waits forever.
export const REQUEST_TIMEOUT_MS = 60_000;

// Throws a CliError carrying the server's own `{ error }` message on any non-2xx, so
// cli.ts renders API failures in the server's wording rather than a bare status code.
/**
 * The daemon could not be reached at all — the request never got an answer.
 *
 * A distinct type rather than a plain CliError because callers must be able to
 * tell "the daemon went away" from "the daemon said no". The `--watch` loops
 * key on exactly that: a refetch failing because the connection died is not
 * fatal (the socket layer's reconnect/give-up is what reports it), while any
 * other failure means the run is genuinely unreadable and must stop the watch.
 * Before this existed those loops tested `err instanceof TypeError` — fetch's
 * own network-failure signal — which this very wrapper had already swallowed,
 * so a daemon killed mid-refetch died with the wrong message (and, on a slow
 * enough machine, beat the right one to it).
 */
export class DaemonUnreachableError extends CliError {}

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
    res = await fetch(`${target.baseUrl}${path}`, {
      ...init,
      headers,
      signal: init?.signal ?? AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    // A timeout and a dropped connection need different advice: the first
    // means the daemon is still there and stuck, so telling the user to start
    // it again sends them to restart something that is already running. Both
    // are still "no answer from the daemon", so the `--watch` loops treat
    // them alike.
    if ((err as Error).name === 'TimeoutError') {
      throw new DaemonUnreachableError(
        `dispatchd accepted the request at ${target.baseUrl} but did not answer within ${String(REQUEST_TIMEOUT_MS / 1000)}s. ` +
          'It is running with a blocked event loop; check its log for an "event loop stalled" line, then restart it.'
      );
    }
    throw new DaemonUnreachableError(
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
   * `GET /api/health`, reduced to what doctor reports: `problems` are records
   * the daemon's last cache rebuild could not read (they never appear in
   * `listTasks`, so a caller that only lists sees a clean board over a
   * damaged one), and the identity fields say which process answered and
   * what model it dispatches — absent on a daemon that predates them.
   */
  health(): Promise<{
    problems: string[];
    pid?: number;
    startedAt?: string;
    executeModel?: string;
  }>;
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
    health: async () => {
      const health = await request<{
        problems?: unknown;
        pid?: unknown;
        startedAt?: unknown;
        models?: { execute?: unknown };
      }>(target, '/api/health');
      return {
        problems: Array.isArray(health.problems)
          ? health.problems.filter((p): p is string => typeof p === 'string')
          : [],
        pid: typeof health.pid === 'number' ? health.pid : undefined,
        startedAt:
          typeof health.startedAt === 'string' ? health.startedAt : undefined,
        executeModel:
          typeof health.models?.execute === 'string'
            ? health.models.execute
            : undefined,
      };
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
// Mirrors packages/server/src/orchestrator/types.ts's ExecutorInfo.
interface ExecutorInfo {
  name: string;
  reportsCost: boolean;
  reportsTurns: boolean;
  enforcesCaps: boolean;
}

interface ExecutorsResponse {
  executors: ExecutorInfo[];
  default: string;
}

/**
 * A Chromium the daemon is driving — see packages/server/src/browser.
 *
 * Mirrored here rather than imported for the same reason RunMeta is: the
 * server package is Bun-only and cannot be imported from this CLI.
 */
interface BrowserInfo {
  id: string;
  url: string;
  headless: boolean;
  startedAt: string;
  picking: boolean;
}

interface PickedElement {
  selector: string;
  tagName: string;
  id: string | null;
  className: string | null;
  text: string;
  outerHTML: string;
  outerHTMLTruncated: boolean;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
  devicePixelRatio: number;
  url: string;
}

export type PickOutcome =
  | { state: 'picked'; element: PickedElement; screenshot: string }
  | { state: 'cancelled' }
  | { state: 'waiting' };

/** One agent a fan-out tried the work with. */
interface FanoutVariantResult {
  executor: string;
  model?: string;
  task: TaskDoc;
  run: RunMeta | null;
  /** Why this variant has no run, when dispatching it failed. */
  error?: string;
}

interface FanoutResult {
  sourceTaskId: string;
  /** The label every clone carries, so the group stays findable. */
  label: string;
  variants: FanoutVariantResult[];
}

export interface ApiClient {
  baseUrl: string;
  /** Clone a task once per agent and dispatch each, for a side-by-side compare. */
  fanoutTask(
    taskId: string,
    variants: (string | { executor: string; model?: string })[]
  ): Promise<FanoutResult>;
  // The browser family. Every one of these needs the daemon APP token, not
  // the agent token: `browserEvaluate` runs arbitrary script in a browser
  // carrying the user's own cookies.
  launchBrowser(opts?: {
    url?: string;
    headless?: boolean;
    width?: number;
    height?: number;
  }): Promise<BrowserInfo>;
  listBrowsers(): Promise<BrowserInfo[]>;
  closeBrowser(id: string): Promise<void>;
  navigateBrowser(id: string, url: string): Promise<BrowserInfo>;
  browserClick(id: string, selector: string): Promise<void>;
  browserFill(id: string, selector: string, value: string): Promise<void>;
  browserText(
    id: string,
    selector: string
  ): Promise<{ selector: string; text: string }>;
  browserEvaluate(id: string, expression: string): Promise<{ value: unknown }>;
  /** A base64 PNG of the whole page. */
  browserScreenshot(id: string): Promise<{ screenshot: string }>;
  /** Arms Design Mode; the next click in the page is captured, not delivered. */
  browserStartPick(id: string): Promise<{ picking: boolean }>;
  browserPickResult(id: string): Promise<PickOutcome>;
  // `fresh` forces a brand-new run. Without it the daemon resumes the task's
  // most recent run when that run failed with its worktree still intact — see
  // createRun in packages/server/src/api.ts.
  createRun(
    taskId: string,
    executor?: string,
    opts?: { fresh?: boolean }
  ): Promise<RunMeta>;
  // Picks a specific terminal run back up in its own worktree and branch, the
  // same endpoint the desktop UI's Resume button posts to.
  resumeRun(runId: string): Promise<RunMeta>;
  listRuns(): Promise<RunMeta[]>;
  getRun(id: string): Promise<RunDetail>;
  cancelRun(runId: string): Promise<void>;
  getRunDiff(runId: string): Promise<DiffResult>;
  /** Findings raised against one task. `dispatch share` folds them into a
   *  run's page; nothing else in the CLI reads them yet. */
  getTaskFindings(taskId: string): Promise<Finding[]>;
  /** Every recorded decision and ruling. Unfiltered: the ledger is
   *  project-wide, and the share page shows what applies to the run's task. */
  getLedger(): Promise<LedgerEntry[]>;
  reviewRun(
    runId: string,
    action: 'merge' | 'discard' | 'pr'
  ): Promise<RunMeta>;
  startPlan(prompt: string, planner?: string): Promise<{ planId: string }>;
  getPlan(planId: string): Promise<PlanRecord>;
  sendPlanMessage(planId: string, text: string): Promise<PlanRecord>;
  confirmPlan(planId: string, proposal: PlanProposal): Promise<ConfirmResult>;
  startEpic(epicId: string, opts?: EpicSessionOptions): Promise<EpicSession>;
  // Holds new dispatches; live runs finish on their own.
  pauseEpic(epicId: string): Promise<EpicSession>;
  // Lifts a pause, optionally setting new ceilings on the way back.
  // `executor` is fixed for a session's life, so resume never takes one.
  resumeEpic(
    epicId: string,
    opts?: Omit<EpicSessionOptions, 'executor'>
  ): Promise<EpicSession>;
  /** `GET /api/executors`: what the daemon can dispatch on and its default. */
  fetchExecutors(): Promise<ExecutorsResponse>;
  stopEpic(epicId: string): Promise<EpicSession>;
  getEpicProgress(epicId: string): Promise<EpicProgress>;
  // The messaging routes refuse the daemon file's agent token: build the
  // client on a human's token (the app token) to call these.
  /** Open blocking questions and gates addressed to a human. */
  openDecisions(): Promise<{ items: Message[] }>;
  getMessage(id: string): Promise<Message>;
  /** The answer to a question, or null while it is open. */
  getAnswer(id: string): Promise<{ answer: Message | null }>;
  replyToMessage(
    id: string,
    input: { body: string; choice?: string }
  ): Promise<SendResult>;
  sendMessage(input: {
    to: string[];
    kind: string;
    body: string;
    wake?: 'none' | 'request';
  }): Promise<SendResult>;
  /** Decide-tier: build the client on the app token. */
  issueTeamToken(input: {
    email?: string;
    handle?: string;
    displayName?: string;
    tier?: TeamTier;
    /** Days until it stops working; `null` for never; absent for the
     *  daemon's default. */
    expiresInDays?: number | null;
  }): Promise<IssuedTeamToken>;
  listTeamTokens(): Promise<TeamTokenHolder[]>;
  /** Revokes whatever token the handle holds; one per person. */
  revokeTeamToken(handle: string): Promise<void>;
  /** Board sync's state — `{ enabled: false, reason }` when it is off. */
  getSyncStatus(): Promise<SyncStatus>;
  /** Runs a sync pass and answers with the state after it. */
  syncNow(): Promise<SyncStatus>;
  /** The plan the project runs on, and how many seats are in use. */
  getLicense(): Promise<LicenseStatus>;
  /** Installs a license key (operator tier). */
  installLicense(key: string): Promise<LicenseStatus>;
  // The signed team roster (decide tier to read, operator tier to change):
  // build the client on the app token.
  getTeamKeys(): Promise<TeamKeys>;
  foundTeam(
    name?: string
  ): Promise<{ teamId: string; recoveryCode: string; fingerprint: string }>;
  trustFounder(fingerprint: string): Promise<void>;
  inviteToTeam(handle: string): Promise<{ code: string; expires: string }>;
  joinTeam(code: string): Promise<void>;
  recoverTeam(code: string): Promise<void>;
  newRecoveryCode(): Promise<{ recoveryCode: string }>;
  shareTeamLicense(): Promise<void>;
  admitReplica(replica: string, body: AdmitBody): Promise<void>;
  revokeReplica(replica: string, reason?: string): Promise<RosterAnswer>;
  setReplicaRole(
    replica: string,
    role: 'member' | 'admin'
  ): Promise<RosterAnswer>;
  setReplicaHosts(replica: string, hosts: string[]): Promise<RosterAnswer>;
  closeLegacy(): Promise<void>;
  /** Takes an op no build reads out of every fold, when this admin may. */
  dismissRosterOp(replica: string, seq: number, hash: string): Promise<void>;
  /** Lets go of the invite this machine joined with. */
  abandonInvite(): Promise<void>;
}

/** What `keys admit` sends. */
interface AdmitBody {
  fingerprint: string;
  handle?: string;
  role?: 'member' | 'admin';
  hosts?: string[];
  observer?: boolean;
}

/** A roster change's answer: a warning when it could not pull first, and
 *  pending while its sync is still running. */
export interface RosterAnswer {
  warning?: string;
  pending?: boolean;
}

/** Mirrors TeamKeys in packages/server/src/team/federation/teamKeys.ts. */
export interface TeamKeys {
  machine: {
    replica: string;
    handle: string;
    device: string;
    fingerprint: string;
  };
  team: {
    id: string;
    name: string;
    founder: { replica: string; handle: string; fingerprint: string };
  } | null;
  foundings: { replica: string; fingerprint: string }[];
  roster: {
    replica: string;
    handle: string;
    device: string;
    build: string;
    role: 'member' | 'admin';
    rank: number | null;
    hosts: string[];
    observer: boolean;
    recovered: boolean;
    fingerprint: string;
    lastSeen: string | null;
    skewMs: number | null;
  }[];
  waiting: {
    replica: string;
    handle: string;
    device: string;
    fingerprint: string;
    invitedBy: string | null;
  }[];
  invites: { handle: string; expires: string; by: string }[];
  legacy: { until: string | null; closed: boolean; olderBuilds: string[] };
  transport: {
    kind: 'git' | 'relay';
    lastExchangeAt: string | null;
    lastError: string | null;
    unpublished: number;
    sizeBytes: number | null;
    acks: Record<string, string>;
  };
  license: {
    seats: number;
    org: string | null;
    sharedBy: string | null;
  } | null;
  pruningBlockers: {
    replica: string;
    handle: string;
    lastAck: string | null;
  }[];
  originWarning: string | null;
  relayDisclosure: string;
  warnings: string[];
  problems: { subject: string; message: string; at: string }[];
}

/** Mirrors SyncStatus in packages/server/src/team/boardSync/service.ts.
 *  `reason` (BoardSyncOffReason in packages/server/src/api.ts) is absent on
 *  daemons older than it. */
export type SyncStatus =
  | { enabled: false; reason?: 'files' | 'off' | 'not-started' }
  | {
      enabled: true;
      replica: string;
      remote: string;
      branch: string;
      lastSyncAt: string | null;
      lastError: string | null;
      pending: number;
      applied: number;
      problems: { task: string; message: string; at: string }[];
      people: number;
      seats: number;
      paused: string | null;
      // From a daemon with federation (FederationStatus); absent on older ones.
      founded?: boolean;
      teamId?: string | null;
      legacyUntil?: string | null;
      transport?: 'git' | 'relay';
      federationProblems?: { subject: string; message: string; at: string }[];
    };

/** Mirrors licenseView in packages/server/src/team/routes.ts. */
export interface LicenseStatus {
  kind: 'free' | 'licensed' | 'expired' | 'invalid';
  seats: number;
  used: number;
  org: string | null;
  expiresAt: string | null;
  reason: string | null;
}

/** Mirrors AuthTier in packages/server/src/tiers.ts. */
export type TeamTier = 'request' | 'decide' | 'operator';

/** A freshly issued teammate credential — the only response that ever carries
 *  one. Mirrors issueTeamToken in packages/server/src/team/routes.ts. */
interface IssuedTeamToken {
  handle: string;
  tier: TeamTier;
  token: string;
  expiresAt: string | null;
}

/** Who holds a credential, without it — mirrors IssuedTokenSummary in
 *  packages/server/src/identity.ts. */
interface TeamTokenHolder {
  handle: string;
  tier: TeamTier;
  builtIn: boolean;
  issuedAt: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  expired: boolean;
}

// `token` is the credential every call presents: the agent token from the
// daemon file, or an app token the user supplied for gates and messages.
export function createApiClient(baseUrl: string, token: string): ApiClient {
  const target: ApiTarget = { baseUrl, token };
  return {
    baseUrl,
    createRun: (taskId, executor, opts = {}) =>
      request(target, `/api/tasks/${taskId}/runs`, {
        ...jsonBody({
          ...(executor !== undefined ? { executor } : {}),
          ...(opts.fresh === true ? { fresh: true } : {}),
        }),
      }),
    resumeRun: (runId) =>
      request(target, `/api/runs/${runId}/resume`, { method: 'POST' }),
    listRuns: () => request(target, '/api/runs'),
    getRun: (id) => request(target, `/api/runs/${id}`),
    cancelRun: (runId) =>
      request(target, `/api/runs/${runId}/cancel`, { ...jsonBody({}) }),
    getRunDiff: (runId) => request(target, `/api/runs/${runId}/diff`),
    getTaskFindings: (taskId) =>
      request(target, `/api/findings?taskId=${encodeURIComponent(taskId)}`),
    getLedger: () => request(target, '/api/ledger'),
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
    pauseEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/pause`, { method: 'POST' }),
    resumeEpic: (epicId, opts = {}) =>
      request(target, `/api/epics/${epicId}/resume`, { ...jsonBody(opts) }),
    fetchExecutors: () => request(target, '/api/executors'),
    stopEpic: (epicId) =>
      request(target, `/api/epics/${epicId}/stop`, { ...jsonBody({}) }),
    fanoutTask: (taskId, variants) =>
      request(
        target,
        `/api/tasks/${encodeURIComponent(taskId)}/fanout`,
        jsonBody({ variants })
      ),
    launchBrowser: (opts = {}) =>
      request(target, '/api/browser', jsonBody(opts)),
    listBrowsers: () => request(target, '/api/browser'),
    closeBrowser: async (id) => {
      await request(target, `/api/browser/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
    },
    navigateBrowser: (id, url) =>
      request(
        target,
        `/api/browser/${encodeURIComponent(id)}/navigate`,
        jsonBody({ url })
      ),
    browserClick: async (id, selector) => {
      await request(
        target,
        `/api/browser/${encodeURIComponent(id)}/click`,
        jsonBody({ selector })
      );
    },
    browserFill: async (id, selector, value) => {
      await request(
        target,
        `/api/browser/${encodeURIComponent(id)}/fill`,
        jsonBody({ selector, value })
      );
    },
    browserText: (id, selector) =>
      request(
        target,
        `/api/browser/${encodeURIComponent(id)}/text?selector=${encodeURIComponent(selector)}`
      ),
    browserEvaluate: (id, expression) =>
      request(
        target,
        `/api/browser/${encodeURIComponent(id)}/evaluate`,
        jsonBody({ expression })
      ),
    browserScreenshot: (id) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/screenshot`),
    browserStartPick: (id) =>
      request(
        target,
        `/api/browser/${encodeURIComponent(id)}/pick`,
        jsonBody({})
      ),
    browserPickResult: (id) =>
      request(target, `/api/browser/${encodeURIComponent(id)}/pick`),
    getEpicProgress: (epicId) =>
      request(target, `/api/epics/${epicId}/progress`),
    openDecisions: () => request(target, '/api/decisions/open'),
    getMessage: (id) =>
      request(target, `/api/messages/${encodeURIComponent(id)}`),
    getAnswer: (id) =>
      request(target, `/api/messages/${encodeURIComponent(id)}/answer`),
    replyToMessage: (id, input) =>
      request(
        target,
        `/api/messages/${encodeURIComponent(id)}/reply`,
        jsonBody(input)
      ),
    sendMessage: (input) => request(target, '/api/messages', jsonBody(input)),
    issueTeamToken: (input) =>
      request(target, '/api/team/tokens', jsonBody(input)),
    listTeamTokens: () => request(target, '/api/team/tokens'),
    getSyncStatus: () => request(target, '/api/board-sync'),
    syncNow: () => request(target, '/api/board-sync/now', { method: 'POST' }),
    getLicense: () => request(target, '/api/license'),
    installLicense: (key) =>
      request(target, '/api/license', {
        ...jsonBody({ key }),
        method: 'PUT',
      }),
    getTeamKeys: () => request(target, '/api/team/keys'),
    foundTeam: (name) =>
      request(
        target,
        '/api/team/found',
        jsonBody(name === undefined ? {} : { name })
      ),
    trustFounder: async (fingerprint) => {
      await request(target, '/api/team/trust', jsonBody({ fingerprint }));
    },
    inviteToTeam: (handle) =>
      request(target, '/api/team/invite', jsonBody({ handle })),
    joinTeam: async (code) => {
      await request(target, '/api/team/join', jsonBody({ code }));
    },
    recoverTeam: async (code) => {
      await request(target, '/api/team/recover', jsonBody({ code }));
    },
    newRecoveryCode: () =>
      request(target, '/api/team/recovery-key', jsonBody({})),
    shareTeamLicense: async () => {
      await request(target, '/api/team/license', jsonBody({}));
    },
    admitReplica: async (replica, body) => {
      await request(target, rosterPath(replica, 'admit'), jsonBody(body));
    },
    revokeReplica: (replica, reason) =>
      request(
        target,
        rosterPath(replica, 'revoke'),
        jsonBody(reason === undefined ? {} : { reason })
      ),
    setReplicaRole: (replica, role) =>
      request(target, rosterPath(replica, 'role'), jsonBody({ role })),
    setReplicaHosts: (replica, hosts) =>
      request(target, rosterPath(replica, 'hosts'), jsonBody({ hosts })),
    closeLegacy: async () => {
      await request(target, '/api/team/close-legacy', jsonBody({}));
    },
    dismissRosterOp: async (replica, seq, hash) => {
      await request(
        target,
        '/api/team/dismiss',
        jsonBody({ replica, seq, hash })
      );
    },
    abandonInvite: async () => {
      await request(target, '/api/team/abandon-invite', jsonBody({}));
    },
    revokeTeamToken: async (handle) => {
      await request(target, `/api/team/tokens/${encodeURIComponent(handle)}`, {
        method: 'DELETE',
      });
    },
  };
}

// A roster action on one replica's key.
function rosterPath(replica: string, action: string): string {
  return `/api/team/keys/${encodeURIComponent(replica)}/${action}`;
}
