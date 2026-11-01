import {
  clearProjectCredential,
  DEFAULT_LINEAR,
  fieldHash,
  isDoneStatus,
  isOutstanding,
  loadConfig,
  parseLinearExternal,
  resolveLinearApiKey,
  statusModelOf,
  statusType,
  UNRESOLVED_LINEAR_ASSIGNEE,
  writeProjectCredential,
} from '@dispatch-foo/core';
import type {
  CommentStorePort,
  CredentialSource,
  DispatchConfig,
  LinearComment,
  LinearConfig,
  LinearInitiative,
  LinearIssue,
  LinearLabel,
  LinearProject,
  LinearProjectMilestone,
  LinearUser,
  StatusModel,
  TaskDoc,
  TaskListItem,
  TaskMeta,
  TaskStorePort,
} from '@dispatch-foo/core';
import { randomBytes } from 'node:crypto';

import type { TaskCache } from '../cache.js';
import { DocsError } from '../docs/errors.js';
import type {
  LinearDocsAdapter,
  LinearDocsDeps,
  LinearDocsPort,
} from '../docs/linear.js';
import type { DocsActor } from '../docs/service.js';
import type { EventBus } from '../events.js';
import { TaskChangeBatch } from './batch.js';
import type {
  LinearCapacity,
  LinearClient,
  LinearErrorKind,
  LinearFailure,
  LinearIssuePage,
  LinearIssueRef,
  LinearPage,
  LinearProbe,
  LinearResult,
  LinearWorkspace,
} from './client.js';
import { FREE_PLAN_ISSUE_LIMIT, HttpLinearClient } from './client.js';
import { CommentSync } from './comments.js';
import type {
  LinearCoverage,
  LinearCoverageCounts,
  LinearExportPreview,
} from './coverage.js';
import {
  coverageCounts,
  exportCandidates,
  exportPreview,
  linearCoverage,
} from './coverage.js';
import type {
  CreateRemoteResult,
  LinearSyncSummary,
  ReconcileMode,
  RemoteRecord,
} from './reconcile.js';
import { emptySummary, LinearPass } from './reconcile.js';
import type {
  ConflictRecord,
  LinearBulkOutcome,
  LinearCapacityState,
  LinearExportScope,
  LinearIssueLink,
  LinearSyncState,
  PushAttempt,
} from './state.js';
import {
  accountedAt,
  echoTtlMs,
  pruneEchoes,
  readBase,
  readLinearState,
  upgradeBases,
  webhookHooks,
  writeLinearState,
} from './state.js';
import {
  parseWebhook,
  verifyLinearSignature,
  WEBHOOK_RESOURCE_TYPES,
  webhookFresh,
} from './webhook.js';
import type { PassContext } from './workspace.js';
import {
  buildContext,
  refreshPeople,
  regenerateStatuses,
  syncLabels,
  syncPeople,
} from './workspace.js';

export type { LinearSyncSummary } from './reconcile.js';

/** Where a long pass has got to. `total` is null while unknown; an absent
 *  `action` is an import. */
export interface LinearProgress {
  phase: 'containers' | 'issues' | 'applying' | 'creating' | 'archiving';
  done: number;
  total: number | null;
  action?: 'import' | BulkAction;
}

/** A long action run in the background, reported through status. */
type BulkAction = 'export' | 'archive' | 'retry';

/** A start* method's answer: refused, or begun in the background. */
type LinearBulkStart =
  | { ok: true; candidates: number; startedAt: string }
  | { ok: false; status: 409; error: string };

export interface LinearStatus {
  enabled: boolean;
  connected: boolean;
  keySource: CredentialSource;
  /** The primary linked team. */
  teamId: string | null;
  /** Every linked team, primary first. */
  teamIds: string[];
  direction: LinearConfig['direction'];
  intervalSec: number;
  statusMap: Record<string, string>;
  cursor: string | null;
  bootstrappedAt: string | null;
  lastSyncAt: string | null;
  lastError: string | null;
  lastSummary: LinearSyncSummary | null;
  syncing: boolean;
  /** Asked for by request id: the summary that request was answered with,
   *  null until its pass ends. */
  answered?: LinearSyncSummary | null;
  /** Field conflicts resolved since the link, and the latest few. */
  conflicts: { total: number; recent: ConflictRecord[] };
  /** Set while an import or other long pass is running. */
  progress: LinearProgress | null;
  webhook: LinearWebhookStatus;
  /** The usage-limit pause and the counts last measured against the cap. */
  capacity: LinearCapacityState | null;
  /** Which tasks have a Linear record; null while sync is off. */
  coverage: LinearCoverageCounts | null;
  /** An export, archive or retry started and not yet finished. */
  running: { action: BulkAction; startedAt: string } | null;
  lastExport: LinearBulkOutcome | null;
  lastArchive: LinearBulkOutcome | null;
}

/**
 * How changes reach this daemon: `active` when Linear delivers to its
 * webhook, `polling` when it has no public HTTPS URL to deliver to, `error`
 * when registering failed (it polls meanwhile), `off` when sync is off.
 */
export interface LinearWebhookStatus {
  state: 'active' | 'polling' | 'error' | 'off';
  url: string | null;
  lastDeliveryAt: string | null;
  error: string | null;
  /** Seconds between polls as the timer runs them now. */
  pollSec: number;
}

/** A webhook delivery's answer, for the route to send. */
export interface WebhookReply {
  status: number;
  body: Record<string, unknown>;
}

export interface LinearSyncDeps {
  rootDir: string;
  store: TaskStorePort;
  cache: TaskCache;
  events: EventBus;
  /** Task comments; absent, comments are not synced. */
  comments?: CommentStorePort;
  /** A ready-made client, bypassing credential lookup entirely. Tests inject a fake here. */
  client?: LinearClient;
  /** Overridden in tests that need a real client against a stub endpoint. */
  createClient?: (apiKey: string) => LinearClient;
  /** Debounce for the push triggered by a local task change. */
  pushDebounceMs?: number;
  /** The local human's person ref; the API key's Linear user maps to it. */
  localHumanRef?: string;
  /** Where Linear can deliver webhooks (a public HTTPS URL), or null to poll. */
  webhookUrl?: string | null;
  /** Delay before a webhook's changes are fetched, coalescing a burst. */
  webhookDebounceMs?: number;
  /** Linear documents; absent, documents are not synced. */
  documents?: LinearDocsBinding;
  /** Tasks whose newest execute run has ended (tasksWithFinishedRun), for
   *  moving them when a review state splits off the dispatched one. */
  finishedRuns?: () => ReadonlySet<string>;
}

/** How the pass reaches the docs side: an adapter over a mapping it builds. */
interface LinearDocsBinding {
  adapter(link: Omit<LinearDocsDeps, 'service'>): LinearDocsAdapter;
  /** Linear-origin docs with local changes to push. */
  outstanding(): string[];
}

// A Linear read or write that failed; the document step stops for this pass.
class DocumentCallFailed extends Error {}

// 'both' is the ordinary pass; 'push' is the debounced local-edit trigger;
// 'import' is the explicit "bring existing Linear issues down" action;
// 'webhook' applies what deliveries named, and nothing else; 'export' creates
// the named tasks' records with no pull; 'archive' archives closed issues.
type SyncMode = 'both' | 'push' | 'import' | 'webhook' | 'export' | 'archive';

interface RunOptions {
  mode: SyncMode;
  taskIds?: string[];
  targets?: WebhookTargets;
  /** A timer pass, which may end at an idle probe (see pollOnce). */
  poll?: boolean;
  /** Named tasks whose new issue is archived as it lands. */
  archiveOnArrival?: ReadonlySet<string>;
  /** An archive pass takes canceled issues too, beside completed ones. */
  includeCanceled?: boolean;
  /** The background action this pass carries out; its outcome is recorded. */
  bulk?: BulkRun;
}

interface BulkRun {
  action: BulkAction;
  startedAt: string;
  /** What the start counted; an archive pass replaces it with what it found. */
  candidates: number;
  scope?: LinearExportScope;
  includeCanceled?: boolean;
}

/** What webhook deliveries named since the last targeted pass. */
interface WebhookTargets {
  issues: Set<string>;
  removedIssues: Set<string>;
  comments: Set<string>;
  removedComments: Set<string>;
  /** A project changed: containers are re-read from the cursor. */
  containers: boolean;
  /** Linear documents created or edited. */
  documents: Set<string>;
}

function emptyTargets(): WebhookTargets {
  return {
    issues: new Set(),
    removedIssues: new Set(),
    comments: new Set(),
    removedComments: new Set(),
    containers: false,
    documents: new Set(),
  };
}

interface Session {
  client: LinearClient;
  config: DispatchConfig;
  linear: LinearConfig;
  /** The primary linked team: new records go here unless placed elsewhere. */
  teamId: string;
  /** Every linked team, primary first. */
  teamIds: string[];
  /** The primary team's workspace: the viewer and project statuses. */
  workspace: LinearWorkspace;
  /** Each linked team's workspace, primary first. */
  teams: LinearWorkspace[];
  /** The linked teams' labels plus the workspace's, primary team first. */
  labels: LinearLabel[];
  /** Everyone on any linked team. */
  members: LinearUser[];
}

/** Everything one pass holds while it runs. */
interface Run {
  pass: LinearPass;
  session: Session;
  state: LinearSyncState;
  ctx: PassContext;
  docs: Map<string, TaskDoc>;
  /** Tasks the pull already reconciled; the push skips them. */
  touched: Set<string>;
  comments: CommentSync | null;
  mayPull: boolean;
  /** Whether a pair may push: every task, or only those an explicit push names. */
  canPush: (id: string) => boolean;
  importing: boolean;
  taskIds: string[] | undefined;
  /** The ids an explicit push names, or null on an ordinary pass. */
  named: ReadonlySet<string> | null;
  archiveOnArrival: ReadonlySet<string>;
  bulk: BulkRun | null;
  /** Closed issues an archive pass found to archive. */
  found: number | null;
  /** The poll's probe, when one already ran this pass. */
  probe: LinearProbe | null;
}

/** Everything the pull fetched, by kind. */
interface Fetched {
  initiatives: LinearInitiative[];
  projects: LinearProject[];
  milestones: LinearProjectMilestone[];
  issues: LinearIssue[];
  comments: LinearComment[];
}

const DEFAULT_PUSH_DEBOUNCE_MS = 5_000;
const DEFAULT_WEBHOOK_DEBOUNCE_MS = 250;
const WORKSPACE_TTL_MS = 5 * 60_000;
const AUDIT_EVERY_MS = 30 * 60_000;
// With deliveries arriving, polling is only a safety net.
const WEBHOOK_POLL_SEC = 300;
// A failed registration (often: the key's user is not a workspace admin) is
// retried this rarely, rather than on every pass.
const WEBHOOK_RETRY_MS = 60 * 60_000;
// How long applying pulled issues runs before handing the event loop back.
const APPLY_SLICE_MS = 10;
// How long GET /capacity reuses its last measurement.
const CAPACITY_CACHE_MS = 60_000;
// How long a paid plan's closed counts are reused between measurements.
const CLOSED_COUNTS_MS = 15 * 60_000;
// Tagged requests whose summaries status keeps (see LinearSync.answer).
const ANSWERED_KEPT = 20;
// Archive failures in a row that end an archive pass: a key that cannot
// archive fails every issue alike.
const ARCHIVE_FAILURE_RUN = 5;
// A queued create's retry delay doubles per attempt from here, up to the cap.
const QUEUE_RETRY_BASE_MS = 5 * 60_000;
const QUEUE_RETRY_MAX_MS = 6 * 60 * 60_000;
const NOT_LINKED = 'Linear is not linked yet; sync once first';

// Returns a function to await between units of synchronous work: it yields
// to the event loop once APPLY_SLICE_MS has passed since the last yield, so
// an import applying thousands of issues leaves the daemon answering.
function sliceYielder(): () => Promise<void> {
  let sliceStart = performance.now();
  return async () => {
    if (performance.now() - sliceStart < APPLY_SLICE_MS) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
    sliceStart = performance.now();
  };
}

// A second before the newest record seen: `gt` would otherwise drop any
// record sharing that exact timestamp, and re-reading one is free.
function rewind(high: string | null): string | null {
  return high === null ? null : new Date(Date.parse(high) - 1000).toISOString();
}

function newest(
  records: readonly { updatedAt: string }[],
  start: string | null
): string | null {
  let high = start;
  for (const r of records) {
    if (high === null || r.updatedAt > high) high = r.updatedAt;
  }
  return high;
}

function earliest(a: string | null, b: string | null): string | null {
  if (a === null) return b;
  if (b === null) return a;
  return a < b ? a : b;
}

// One team-scoped page walk run for every linked team, the pages merged by
// record id (a project shared by two linked teams comes back from both).
// The Linear project or issue a task mirrors, as documentCreate takes it.
function containerOf(
  external: string | null | undefined
): { projectId: string } | { issueId: string } | null {
  const ref = parseLinearExternal(external);
  if (ref?.entity === 'issue') return { issueId: ref.id };
  if (ref?.entity === 'project') return { projectId: ref.id };
  return null;
}

async function acrossTeams<T extends { id: string }>(
  teamIds: readonly string[],
  walk: (teamId: string) => Promise<LinearResult<LinearPage<T>>>
): Promise<LinearResult<LinearPage<T>>> {
  const byId = new Map<string, T>();
  let truncated = false;
  for (const teamId of teamIds) {
    const page = await walk(teamId);
    if (!page.ok) return page;
    for (const node of page.data.nodes) {
      if (!byId.has(node.id)) byId.set(node.id, node);
    }
    truncated = truncated || page.data.truncated;
  }
  return { ok: true, data: { nodes: [...byId.values()], truncated } };
}

// Whether an issue sits in one of the linked teams (one with no team does).
function inLinkedTeam(
  issue: LinearIssue,
  session: Pick<Session, 'teamIds'>
): boolean {
  return issue.team === null || session.teamIds.includes(issue.team.id);
}

// Every linked team's issue chips, for the audit.
async function issueLinksAcrossTeams(
  session: Pick<Session, 'client' | 'teamIds'>
): Promise<LinearResult<LinearIssueRef[]>> {
  const refs: LinearIssueRef[] = [];
  for (const teamId of session.teamIds) {
    const page = await session.client.issueLinks(teamId);
    if (!page.ok) return page;
    refs.push(...page.data);
  }
  return { ok: true, data: refs };
}

// Every linked team's issues updated since `since`, reporting a running count
// across the teams for progress.
async function issuesAcrossTeams(
  session: Pick<Session, 'client' | 'teamIds'>,
  since: string | null,
  onPage: (fetched: number) => void
): Promise<LinearResult<LinearIssuePage>> {
  const issues: LinearIssue[] = [];
  let truncated = false;
  for (const teamId of session.teamIds) {
    const before = issues.length;
    const page = await session.client.issuesUpdatedSince(teamId, since, (n) =>
      onPage(before + n)
    );
    if (!page.ok) return page;
    issues.push(...page.data.issues);
    truncated = truncated || page.data.truncated;
  }
  return { ok: true, data: { issues, truncated } };
}

// The idle probe for every linked team: a kind moved if it moved in any.
async function probeTeams(
  session: Pick<Session, 'client' | 'teamIds'>,
  since: string,
  documentsSince: string
): Promise<LinearResult<LinearProbe>> {
  const out: LinearProbe = {
    issues: false,
    comments: false,
    projects: false,
    milestones: false,
    initiatives: false,
    documents: false,
  };
  for (const teamId of session.teamIds) {
    const probed = await session.client.probe(teamId, since, documentsSince);
    if (!probed.ok) return probed;
    for (const key of Object.keys(out) as (keyof LinearProbe)[]) {
      out[key] = out[key] || probed.data[key];
    }
  }
  return { ok: true, data: out };
}

// Records a create that did not land. Refused over the issue limit, it
// waits out the pause uncounted; any other failure backs off, except an
// automatic create, which the next pass retries anyway.
function recordAttempt(
  state: LinearSyncState,
  id: string,
  result: { error: string; capped: boolean },
  kind: LinearErrorKind | null,
  now: number
): void {
  const at = new Date(now).toISOString();
  const prior: PushAttempt = state.pushQueue[id] ?? {
    origin: 'auto',
    queuedAt: at,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    lastErrorKind: null,
    retryAt: null,
  };
  if (result.capped) {
    state.pushQueue[id] = {
      ...prior,
      lastError: result.error,
      lastErrorKind: 'usage-limit',
    };
    return;
  }
  const attempts = prior.attempts + 1;
  state.pushQueue[id] = {
    ...prior,
    attempts,
    lastAttemptAt: at,
    lastError: result.error,
    lastErrorKind: kind,
    retryAt:
      prior.origin === 'auto'
        ? null
        : new Date(now + retryDelay(attempts)).toISOString(),
  };
}

// Whether ordinary passes are waiting out Linear's usage limit.
function capacityPaused(state: LinearSyncState, now: number): boolean {
  const retryAt = state.capacity?.retryAt ?? null;
  return retryAt !== null && now < Date.parse(retryAt);
}

// Ends the usage-limit pause, keeping when it last hit and what was measured.
function clearPause(state: LinearSyncState): void {
  const capacity = state.capacity;
  if (capacity === null || capacity.retryAt === null) return;
  state.capacity = { ...capacity, retryAt: null, message: null };
}

// Whether a measurement shows room under `limit` that ends the pause. It
// must have begun after Linear refused the create; and since it counts only
// the teams the key can see, it must also be lower than the count measured
// before, unless that one showed no room (or there was none). A count taken
// before the limit was known is held to the limit now in force.
function measuredRoom(
  prior: LinearCapacityState | null,
  active: number | null,
  limit: number | null,
  startedAt: number
): boolean {
  if (active === null || limit === null || active >= limit) return false;
  const limitedAt = prior?.limitedAt ?? null;
  if (limitedAt !== null && Date.parse(limitedAt) >= startedAt) return false;
  const before = prior?.active ?? null;
  if (before === null || before >= (prior?.limit ?? limit)) return true;
  return active < before;
}

// The stored capacity a measurement begun at `startedAt` leaves, ending the
// pause when it shows room (see measuredRoom).
function nextCapacity(
  prior: LinearCapacityState | null,
  m: LinearCapacity,
  startedAt: number
): LinearCapacityState {
  const limitedAt = prior?.limitedAt ?? null;
  // Linear refused a create while the plan could not be read: the only
  // issue limit it has is the Free plan's.
  const observed =
    m.limit === null && m.plan === 'unknown' && limitedAt !== null;
  const limit = observed ? FREE_PLAN_ISSUE_LIMIT : m.limit;
  const room = measuredRoom(prior, m.active, limit, startedAt);
  return {
    limitedAt,
    retryAt: room ? null : (prior?.retryAt ?? null),
    message: room ? null : (prior?.message ?? null),
    active: m.active,
    limit,
    limitSource: observed ? 'observed' : m.limitSource,
    plan: m.plan,
    checkedAt: m.checkedAt,
  };
}

function retryReady(entry: PushAttempt, now: number): boolean {
  return entry.retryAt === null || Date.parse(entry.retryAt) <= now;
}

// Five minutes after the first failure, doubling, at most six hours.
function retryDelay(attempts: number): number {
  return Math.min(
    QUEUE_RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1),
    QUEUE_RETRY_MAX_MS
  );
}

// Queued creates still waiting: those a push or an export named.
function forcedEntries(state: LinearSyncState): number {
  return Object.values(state.pushQueue).filter((e) => e.origin !== 'auto')
    .length;
}

// Queues each task still without its record for a create, keeping what an
// entry it already has says; an automatic entry takes `origin`.
function queueCreates(
  state: LinearSyncState,
  metas: Iterable<
    Pick<TaskMeta, 'id' | 'derivedFrom' | 'external'> | undefined
  >,
  origin: 'explicit' | 'export',
  archive: ReadonlySet<string>,
  at: string
): void {
  for (const meta of metas) {
    if (meta === undefined || meta.derivedFrom !== undefined) continue;
    if (parseLinearExternal(meta.external) !== null) continue;
    const id = meta.id;
    const prior = state.pushQueue[id];
    const archived = archive.has(id) || prior?.archive === true;
    state.pushQueue[id] = {
      origin:
        prior === undefined || prior.origin === 'auto' ? origin : prior.origin,
      queuedAt: prior?.queuedAt ?? at,
      attempts: prior?.attempts ?? 0,
      lastAttemptAt: prior?.lastAttemptAt ?? null,
      lastError: prior?.lastError ?? null,
      lastErrorKind: prior?.lastErrorKind ?? null,
      retryAt: prior?.retryAt ?? null,
      ...(archived ? { archive: true as const } : {}),
    };
  }
}

// Records an unlinked task as deliberately not sent at this version. One
// that left a linked team keeps its `pushed` entry, which a relink reads.
function holdBack(state: LinearSyncState, id: string, updated: string): void {
  if (state.pushed[id] !== undefined) state.pushed[id] = updated;
  else (state.localOnly ??= {})[id] = updated;
  if (state.pushQueue[id]?.origin === 'auto') delete state.pushQueue[id];
}

// A state written before `localOnly` held back unlinked tasks in `pushed`;
// they move across once. Tasks that left a linked team stay in `pushed`.
function foldLocalOnly(
  state: LinearSyncState,
  items: Iterable<TaskListItem>
): void {
  if (state.localOnly !== undefined) return;
  const localOnly: Record<string, string> = {};
  const movedOut = new Set(Object.values(state.movedOut));
  for (const { meta } of items) {
    const at = state.pushed[meta.id];
    if (at === undefined || movedOut.has(meta.id)) continue;
    if (parseLinearExternal(meta.external) !== null) continue;
    localOnly[meta.id] = at;
    delete state.pushed[meta.id];
  }
  state.localOnly = localOnly;
}

// At most five distinct messages, a repeat counted: 'usage limit exceeded (x44)'.
function dedupeErrors(errors: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const e of errors) counts.set(e, (counts.get(e) ?? 0) + 1);
  return [...counts].slice(0, 5).map(([e, n]) => (n > 1 ? `${e} (x${n})` : e));
}

/**
 * Keeps a project's tasks and one Linear team as two faithful copies: every
 * field both ways, merged field by field against a per-field base in
 * `~/.dispatch/`, with the team's workflow states as the project's statuses,
 * its users as the project's people, and issue comments as task comments.
 * Its own writes are recorded and skipped on the next pull.
 */
export class LinearSync {
  private readonly deps: LinearSyncDeps;
  private timer: ReturnType<typeof setInterval> | null = null;
  private debounce: ReturnType<typeof setTimeout> | null = null;
  private inFlight: Promise<LinearSyncSummary> | null = null;
  private lastSummary: LinearSyncSummary | null = null;
  // The summaries the last few tagged requests were answered with, newest
  // last, for a caller whose request was cut before its pass ended.
  private readonly answered = new Map<string, LinearSyncSummary>();
  private progress: LinearProgress | null = null;
  // Set after a rate-limit failure; the timer and the debounced push both stand
  // down until it passes rather than spending the remaining hourly budget.
  private backoffUntil = 0;
  // Mirrors config.linear.enabled as of the last start(), so a task change on a
  // project with no Linear sync costs nothing and schedules no timer.
  private enabled = false;
  // Set when .dispatch/config.yml cannot be parsed. Sync stands down rather than
  // throwing out of a timer or blocking daemon boot.
  private configError: string | null = null;
  // True while this engine broadcasts its own writes, so they do not schedule
  // a push of what it just wrote.
  private selfBroadcast = false;
  // Local comment changes since the last pass, by task; folded into the
  // persisted queue when the next pass starts.
  private readonly commentChanges = new Map<string, Set<string>>();
  // What webhook deliveries named, waiting for the targeted pass.
  private targets: WebhookTargets = emptyTargets();
  private webhookTimer: ReturnType<typeof setTimeout> | null = null;
  private lastDeliveryAt: string | null = null;
  private pollSec = 0;
  // Whether anything local may have changed since the last full pass; a
  // fresh engine assumes so.
  private localDirty = true;
  // How many Linear users the registry named when placeholder assignees were
  // last re-read (see resolvePlaceholders); -1 so a fresh engine tries once.
  private namedUsers = -1;
  private workspaceCache: {
    key: string;
    at: number;
    teams: LinearWorkspace[];
    labels: LinearLabel[];
  } | null = null;
  // The export, archive or retry a start* method began, until its pass ends.
  private running: { action: BulkAction; startedAt: string } | null = null;
  // GET /capacity's last measurement, reused for CAPACITY_CACHE_MS; `closedAt`
  // is when its closed counts were walked.
  private capacityCache: {
    at: number;
    closedAt: number;
    data: LinearCapacity;
  } | null = null;
  // The measurement running, and whether it walks the closed counts afresh.
  private capacityInFlight: {
    refresh: boolean;
    done: Promise<LinearResult<LinearCapacity>>;
  } | null = null;
  // Bumped by each measurement and each reset; only the newest one caches.
  private capacityEpoch = 0;
  // Labels found blocked in Linear, kept across passes (see PassDeps).
  private readonly blockedLabels = new Map<
    string,
    { reason: string; until: number }
  >();
  // State changes made outside a pass. A pass in flight re-applies them as it
  // writes, so its own write of the state it read earlier keeps them.
  private stateEdits: ((state: LinearSyncState) => unknown)[] = [];

  constructor(deps: LinearSyncDeps) {
    this.deps = deps;
  }

  // Config is read on every pass, from a file a person edits by hand, so a parse
  // failure is a normal state to be in rather than an exception to propagate.
  private safeConfig(): DispatchConfig | null {
    try {
      const config = loadConfig(this.deps.rootDir);
      this.configError = null;
      return config;
    } catch (err) {
      this.configError = `invalid config, Linear sync paused: ${(err as Error).message}`;
      return null;
    }
  }

  status(request?: string): LinearStatus {
    const config = this.safeConfig();
    const linear = config?.linear ?? DEFAULT_LINEAR;
    const state = readLinearState(this.deps.rootDir);
    const { source } = resolveLinearApiKey(this.deps.rootDir);
    const enabled = config !== null && linear.enabled;
    // The pause's message outlives the pass that hit the limit: paused passes
    // never call Linear, so they record no error of their own.
    const pausedBy = capacityPaused(state, Date.now())
      ? (state.capacity?.message ?? null)
      : null;
    return {
      enabled,
      connected: this.deps.client !== undefined || source !== null,
      keySource: source,
      teamId: linear.teamId,
      teamIds: linear.teamIds,
      direction: linear.direction,
      intervalSec: linear.intervalSec,
      statusMap: linear.statusMap,
      cursor: state.cursor,
      bootstrappedAt: state.bootstrappedAt,
      lastSyncAt: state.lastSyncAt,
      lastError: this.configError ?? pausedBy ?? state.lastError,
      lastSummary: this.lastSummary,
      syncing: this.inFlight !== null,
      ...(request === undefined
        ? {}
        : { answered: this.answered.get(request) ?? null }),
      conflicts: { total: state.conflictTotal, recent: state.conflicts },
      progress: this.progress,
      webhook: this.webhookStatus(linear, state),
      capacity: state.capacity,
      // From the task cache, never the store: status is read on every refresh.
      coverage: enabled
        ? coverageCounts(this.deps.cache.allItems(), state, {
            direction: linear.direction,
            model: statusModelOf(config),
          })
        : null,
      running: this.running,
      lastExport: state.lastExport,
      lastArchive: state.lastArchive,
    };
  }

  private webhookStatus(
    linear: LinearConfig,
    state: LinearSyncState
  ): LinearWebhookStatus {
    const lastDeliveryAt = this.lastDeliveryAt ?? state.lastWebhookAt;
    const pollSec = this.pollSec === 0 ? linear.intervalSec : this.pollSec;
    const base = { lastDeliveryAt, pollSec };
    if (!linear.enabled) {
      return { ...base, state: 'off', url: null, error: null };
    }
    if (state.webhook !== null) {
      return { ...base, state: 'active', url: state.webhook.url, error: null };
    }
    const url = this.deps.webhookUrl ?? null;
    if (url !== null && state.webhookError !== null) {
      return { ...base, state: 'error', url, error: state.webhookError };
    }
    return { ...base, state: 'polling', url, error: null };
  }

  /** Record UUID -> display identifier and URL, for clients holding only `TaskMeta.external`. */
  links(): Record<string, LinearIssueLink> {
    return readLinearState(this.deps.rootDir).links;
  }

  /** Builds a client for ad-hoc reads (the team/state pickers), or null when no key is available. */
  client(): LinearClient | null {
    if (this.deps.client !== undefined) return this.deps.client;
    const { apiKey } = resolveLinearApiKey(this.deps.rootDir);
    if (apiKey === null) return null;
    const make =
      this.deps.createClient ?? ((key: string) => new HttpLinearClient(key));
    return make(apiKey);
  }

  /** Stores an API key for this project only — the daemon's own `rootDir` is the credential's
   *  key. The machine-wide key is never written, staying a read-only fallback. */
  connect(apiKey: string): void {
    this.workspaceCache = null;
    this.resetCapacity();
    writeProjectCredential(this.deps.rootDir, 'linear', { apiKey });
  }

  /** Forgets this project's key, first removing the webhook the key registered.
   *  An env or machine-wide key still resolves afterwards, which
   *  `status().keySource` makes visible. */
  async disconnect(): Promise<void> {
    const state = readLinearState(this.deps.rootDir);
    const client = this.client();
    if (state.webhook !== null && client !== null) {
      await client.deleteWebhook(state.webhook.id);
    }
    if (state.webhook !== null) {
      state.webhook = null;
      writeLinearState(this.deps.rootDir, state);
    }
    this.workspaceCache = null;
    this.resetCapacity();
    clearProjectCredential(this.deps.rootDir, 'linear');
  }

  /** Starts the poll timer when the config enables it. Safe to call repeatedly. */
  start(): void {
    this.stopTimers();
    this.workspaceCache = null;
    this.blockedLabels.clear();
    const config = this.safeConfig();
    this.enabled = config?.linear.enabled ?? false;
    if (config === null) return;
    if (!config.linear.enabled) {
      void this.dropWebhook().catch(() => undefined);
      return;
    }
    this.localDirty = true;
    this.schedulePolls(config.linear.intervalSec);
  }

  // Turning sync off takes the webhook down with it, best effort.
  private async dropWebhook(): Promise<void> {
    const state = readLinearState(this.deps.rootDir);
    const client = state.webhook === null ? null : this.client();
    if (state.webhook === null || client === null) return;
    const done = await client.deleteWebhook(state.webhook.id);
    if (!done.ok) return;
    state.webhook = null;
    writeLinearState(this.deps.rootDir, state);
  }

  // Polls at the configured interval, or as a slow safety net while a
  // webhook delivers changes as they happen.
  private schedulePolls(
    intervalSec: number,
    hooked = readLinearState(this.deps.rootDir).webhook !== null
  ): void {
    const sec = hooked ? Math.max(intervalSec, WEBHOOK_POLL_SEC) : intervalSec;
    if (this.timer !== null && sec === this.pollSec) return;
    if (this.timer !== null) clearInterval(this.timer);
    this.pollSec = sec;
    this.timer = setInterval(() => {
      void this.pollOnce().catch(() => undefined);
    }, sec * 1000);
  }

  private stopTimers(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
    this.pollSec = 0;
    if (this.debounce !== null) clearTimeout(this.debounce);
    this.debounce = null;
    if (this.webhookTimer !== null) clearTimeout(this.webhookTimer);
    this.webhookTimer = null;
  }

  /**
   * One webhook delivery. Answers 404 while no webhook is registered, 401 for
   * a bad signature or a stale timestamp, 400 for a body that is not a
   * delivery; otherwise notes what changed and applies it moments later, in
   * one targeted pass for a whole burst of deliveries.
   */
  handleWebhook(rawBody: string, signature: string | null): WebhookReply {
    const state = readLinearState(this.deps.rootDir);
    const secret = state.webhook?.secret;
    if (secret === undefined) {
      return {
        status: 404,
        body: { error: 'no Linear webhook is registered' },
      };
    }
    if (!verifyLinearSignature(rawBody, signature, secret)) {
      return { status: 401, body: { error: 'bad signature' } };
    }
    const event = parseWebhook(rawBody);
    if (event === null) {
      return { status: 400, body: { error: 'not a Linear delivery' } };
    }
    if (!webhookFresh(event.webhookTimestamp, Date.now())) {
      return { status: 401, body: { error: 'stale delivery' } };
    }
    this.lastDeliveryAt = new Date().toISOString();
    // Acknowledged either way, so Linear does not retry or disable the hook.
    if (!this.enabled) return { status: 200, body: { ok: true } };
    const echo =
      event.updatedAt !== null &&
      state.echoes.some(
        (e) => e.issueId === event.id && e.updatedAt === event.updatedAt
      );
    if (!echo) this.target(event.type, event.action, event.id);
    return { status: 200, body: { ok: true } };
  }

  private target(type: string, action: string, id: string): void {
    const t = this.targets;
    const removed = action === 'remove';
    if (type === 'Issue') (removed ? t.removedIssues : t.issues).add(id);
    else if (type === 'Comment') {
      (removed ? t.removedComments : t.comments).add(id);
    } else if (type === 'Project') t.containers = true;
    // A deleted Linear document leaves its Dispatch doc as it is.
    else if (type === 'Document') {
      if (removed) return;
      t.documents.add(id);
    } else if (type === 'IssueLabel' || type === 'Cycle') {
      this.workspaceCache = null;
      this.blockedLabels.clear();
    } else return;
    if (this.webhookTimer !== null) clearTimeout(this.webhookTimer);
    this.webhookTimer = setTimeout(() => {
      this.webhookTimer = null;
      const targets = this.targets;
      this.targets = emptyTargets();
      void this.enqueue({ mode: 'webhook', targets }).catch(() => undefined);
    }, this.deps.webhookDebounceMs ?? DEFAULT_WEBHOOK_DEBOUNCE_MS);
  }

  /** Resolves once no pass is running or queued. */
  async idle(): Promise<void> {
    while (this.inFlight !== null) {
      await this.inFlight.catch(() => undefined);
    }
  }

  // Clears both timers and waits for any pass already running, so shutdown cannot
  // race a sync that is still writing task files and broadcasting.
  async stop(): Promise<void> {
    this.stopTimers();
    const pending = this.inFlight;
    if (pending !== null) await pending.catch(() => undefined);
  }

  // A local task changed: push it up shortly, coalescing a burst of edits into
  // one call. Pull is left to the timer — a local edit says nothing about Linear.
  notifyTaskChanged(): void {
    if (!this.enabled || this.selfBroadcast) return;
    this.localDirty = true;
    this.schedulePush();
  }

  /** A label color changed locally: the next push carries it to Linear. */
  notifyLabelsChanged(): void {
    this.notifyTaskChanged();
  }

  /** Local comments changed (added, edited or removed): queue them for the next push. */
  notifyCommentChanged(taskId: string, commentIds: readonly string[]): void {
    if (!this.enabled || this.selfBroadcast) return;
    if (this.deps.comments === undefined) return;
    const ids = this.commentChanges.get(taskId) ?? new Set<string>();
    for (const id of commentIds) ids.add(id);
    this.commentChanges.set(taskId, ids);
    this.localDirty = true;
    this.schedulePush();
  }

  /**
   * The poll timer's pass. When nothing local changed since the last pass,
   * no audit or webhook work is due, and the probe says Linear is idle, it
   * ends there — without reading the task store, which on the markdown
   * backend means parsing every task file on the daemon's one thread.
   */
  pollOnce(): Promise<LinearSyncSummary> {
    if (this.inFlight !== null) return this.inFlight;
    return this.enqueue({ mode: 'both', poll: true });
  }

  private schedulePush(): void {
    if (this.debounce !== null) clearTimeout(this.debounce);
    const delay = this.deps.pushDebounceMs ?? DEFAULT_PUSH_DEBOUNCE_MS;
    this.debounce = setTimeout(() => {
      this.debounce = null;
      const config = this.safeConfig();
      if (config === null) return;
      if (!config.linear.enabled || config.linear.direction === 'pull') return;
      void this.enqueue({ mode: 'push' }).catch(() => undefined);
    }, delay);
  }

  /**
   * Pull then push, per the configured direction. Concurrent callers share
   * one pass. A `request` id keeps the answer for status to hand back.
   */
  async syncOnce(
    taskIds?: string[],
    request?: string
  ): Promise<LinearSyncSummary> {
    // An explicit push carries tasks the in-flight pass never considered, so it
    // queues behind that pass instead of being answered by it.
    const pass =
      taskIds === undefined && this.inFlight !== null
        ? this.inFlight
        : this.enqueue({ mode: 'both', taskIds });
    return this.answer(pass, request);
  }

  // Keeps the summary a tagged request is answered with, the last
  // ANSWERED_KEPT of them, so status can say which pass it got.
  private answer(
    pass: Promise<LinearSyncSummary>,
    request: string | undefined
  ): Promise<LinearSyncSummary> {
    if (request === undefined) return pass;
    return pass.then((summary) => {
      this.answered.delete(request);
      this.answered.set(request, summary);
      for (const old of this.answered.keys()) {
        if (this.answered.size <= ANSWERED_KEPT) break;
        this.answered.delete(old);
      }
      return summary;
    });
  }

  /**
   * "Share to Linear": a decide-tier human's team doc becomes a Linear document
   * under the project or issue its task mirrors. The docs side refuses before
   * any Linear call; nothing but this action sends a doc to Linear.
   */
  async shareDocument(actor: DocsActor, ref: string): Promise<string> {
    const binding = this.deps.documents;
    if (binding === undefined)
      throw new DocsError('unavailable', 'Linear documents are off');
    let client: LinearClient | null = null;
    const adapter = binding.adapter({
      port: this.documentsPort(
        () => {
          client ??= this.client();
          if (client === null)
            throw new DocsError('unavailable', 'no Linear API key configured');
          return client;
        },
        [],
        '',
        (failure) => {
          throw new DocsError('unavailable', this.note(failure));
        }
      ),
      taskFor: () => null,
      containerFor: (taskId) =>
        containerOf(this.deps.store.get(taskId)?.meta.external),
      personFor: () => null,
      problem: () => undefined,
    });
    return adapter.share(actor, ref);
  }

  /** Brings the team's whole backlog down: containers, issues, comments, links. */
  async importIssues(request?: string): Promise<LinearSyncSummary> {
    return this.answer(this.enqueue({ mode: 'import' }), request);
  }

  /** How many tasks each export scope would send. Reads only the task cache. */
  exportPreview(): LinearExportPreview {
    return exportPreview(
      this.deps.cache.allItems(),
      this.statusModel(),
      readLinearState(this.deps.rootDir)
    );
  }

  /**
   * Creates Linear records for the unlinked tasks `scope` covers, in the
   * background: an explicit push with no pull, queued like one so a create
   * the pass does not land is retried. Progress and the outcome arrive
   * through status and events.
   */
  startExport(scope: LinearExportScope): LinearBulkStart {
    const refused = this.bulkRefusal('export');
    if (refused !== null) return { ok: false, status: 409, error: refused };
    const startedAt = new Date().toISOString();
    const items = this.deps.cache.allItems();
    const plan = exportCandidates(
      items,
      scope,
      this.statusModel(),
      readLinearState(this.deps.rootDir)
    );
    const candidates = plan.taskIds.length;
    if (candidates === 0) return { ok: true, candidates, startedAt };
    // Queued now, so a pass that stops before its creates (a throttle, a
    // failed session) still leaves every one for later passes to send.
    const metas = new Map(items.map((i) => [i.meta.id, i.meta]));
    this.editState((state) =>
      queueCreates(
        state,
        plan.taskIds.map((id) => metas.get(id)),
        'export',
        new Set(plan.archiveOnArrival),
        startedAt
      )
    );
    this.startBulk({
      mode: 'export',
      taskIds: plan.taskIds,
      archiveOnArrival: new Set(plan.archiveOnArrival),
      bulk: { action: 'export', startedAt, candidates, scope },
    });
    return { ok: true, candidates, startedAt };
  }

  /** Every task's Linear coverage, and why each unlinked one is unlinked. */
  coverage(): LinearCoverage {
    const config = this.safeConfig();
    return linearCoverage(
      this.deps.cache.allItems(),
      readLinearState(this.deps.rootDir),
      {
        direction: (config?.linear ?? DEFAULT_LINEAR).direction,
        model: statusModelOf(config),
      }
    );
  }

  /**
   * Retries `taskIds` now, or every queued create: their backoff is reset
   * and the usage-limit pause cleared, then they are pushed by name in the
   * background.
   */
  startRetry(taskIds?: readonly string[]): LinearBulkStart {
    const refused = this.bulkRefusal('retry');
    if (refused !== null) return { ok: false, status: 409, error: refused };
    const startedAt = new Date().toISOString();
    const ids = [
      ...new Set(
        taskIds ?? Object.keys(readLinearState(this.deps.rootDir).pushQueue)
      ),
    ];
    const metas = new Map(
      this.deps.cache.allItems().map((i) => [i.meta.id, i.meta])
    );
    this.editState((state) => {
      // A named task not queued yet is queued, as an export's are.
      queueCreates(
        state,
        ids.map((id) => metas.get(id)),
        'explicit',
        new Set(),
        startedAt
      );
      for (const id of ids) {
        const entry = state.pushQueue[id];
        if (entry !== undefined) {
          state.pushQueue[id] = { ...entry, attempts: 0, retryAt: null };
        }
      }
      clearPause(state);
    });
    const candidates = ids.length;
    if (candidates === 0) return { ok: true, candidates, startedAt };
    this.startBulk({
      mode: 'export',
      taskIds: ids,
      bulk: { action: 'retry', startedAt, candidates },
    });
    return { ok: true, candidates, startedAt };
  }

  /**
   * Stops retrying these tasks' creates: each queue entry is dropped and an
   * unlinked task is held back at its current version, so only a later edit
   * or a push by name sends it. Answers how many tasks that changed.
   */
  forget(taskIds: readonly string[]): number {
    const items = this.deps.cache.allItems();
    const metas = new Map(items.map((i) => [i.meta.id, i.meta]));
    return this.editState((state) => {
      foldLocalOnly(state, items);
      let n = 0;
      for (const id of new Set(taskIds)) {
        const queued = state.pushQueue[id] !== undefined;
        delete state.pushQueue[id];
        const meta = metas.get(id);
        const unlinked =
          meta !== undefined && parseLinearExternal(meta.external) === null;
        if (unlinked) holdBack(state, id, meta.updated);
        if (queued || unlinked) n++;
      }
      return n;
    });
  }

  /**
   * Issue counts against the workspace's plan cap, measured live at most
   * once a minute unless `refresh`; concurrent callers share a measurement.
   * One with room under the limit ends the usage-limit pause (see
   * measuredRoom).
   */
  async capacity(refresh = false): Promise<LinearResult<LinearCapacity>> {
    const cached = this.capacityCache;
    const fresh = cached !== null && Date.now() - cached.at < CAPACITY_CACHE_MS;
    if (cached !== null && fresh && !refresh) {
      return { ok: true, data: cached.data };
    }
    // A refresh never shares one that may reuse the closed counts.
    const running = this.capacityInFlight;
    if (running !== null && (running.refresh || !refresh)) return running.done;
    const done = this.measureCapacity(refresh).finally(() => {
      if (this.capacityInFlight?.done === done) this.capacityInFlight = null;
    });
    this.capacityInFlight = { refresh, done };
    return done;
  }

  // Forgets the measurement and any running, which no longer caches.
  private resetCapacity(): void {
    this.capacityCache = null;
    this.capacityInFlight = null;
    this.capacityEpoch++;
  }

  private async measureCapacity(
    refresh: boolean
  ): Promise<LinearResult<LinearCapacity>> {
    const cached = this.capacityCache;
    const client = this.client();
    if (client === null) {
      return { ok: false, kind: 'auth', error: 'no Linear API key configured' };
    }
    if (Date.now() < this.backoffUntil) {
      if (cached !== null) return { ok: true, data: cached.data };
      return {
        ok: false,
        kind: 'rate-limit',
        error: 'linear rate limit backoff in effect',
        retryAfterMs: this.backoffUntil - Date.now(),
      };
    }
    const teamIds = this.safeConfig()?.linear.teamIds ?? [];
    // A paid plan has no cap, so its closed counts (which only the archive
    // action reads) are walked again at most every CLOSED_COUNTS_MS.
    const reuse =
      !refresh &&
      cached !== null &&
      cached.data.plan === 'paid' &&
      Date.now() - cached.closedAt < CLOSED_COUNTS_MS
        ? cached
        : null;
    const startedAt = Date.now();
    const epoch = ++this.capacityEpoch;
    const measured = await client.capacity(
      teamIds.length > 0 ? teamIds : undefined,
      reuse?.data
    );
    if (!measured.ok) {
      this.note(measured);
      return measured;
    }
    // One a newer measurement or a reset superseded answers its caller, but
    // leaves the stored counts and the pause to the newer one.
    const current = epoch === this.capacityEpoch;
    const counted = current
      ? this.editState(
          (state) =>
            (state.capacity = nextCapacity(
              state.capacity,
              measured.data,
              startedAt
            ))
        )
      : nextCapacity(
          readLinearState(this.deps.rootDir).capacity,
          measured.data,
          startedAt
        );
    const data: LinearCapacity = {
      ...measured.data,
      limit: counted.limit,
      limitSource: counted.limitSource,
      limitHitAt: counted.limitedAt,
    };
    if (current) {
      this.capacityCache = {
        at: Date.now(),
        closedAt: reuse?.closedAt ?? Date.now(),
        data,
      };
    }
    return { ok: true, data };
  }

  /**
   * Archives the linked teams' closed issues in Linear, completed ones and
   * canceled ones too when asked, in the background. Their local tasks take
   * the archive the way they would from an archive made in Linear.
   */
  startArchiveClosed(opts: { includeCanceled: boolean }): LinearBulkStart {
    const refused = this.bulkRefusal('archiving closed issues');
    if (refused !== null) return { ok: false, status: 409, error: refused };
    if (readLinearState(this.deps.rootDir).bootstrappedAt === null) {
      return { ok: false, status: 409, error: NOT_LINKED };
    }
    const startedAt = new Date().toISOString();
    const candidates = this.closedEstimate(opts.includeCanceled);
    this.startBulk({
      mode: 'archive',
      includeCanceled: opts.includeCanceled,
      bulk: {
        action: 'archive',
        startedAt,
        candidates,
        includeCanceled: opts.includeCanceled,
      },
    });
    return { ok: true, candidates, startedAt };
  }

  // Why a background action cannot start now, or null when it can.
  private bulkRefusal(what: string): string | null {
    const config = this.safeConfig();
    if (config === null) return this.configError ?? 'invalid config';
    if (config.linear.teamIds[0] === undefined) {
      return 'no Linear team selected';
    }
    if (this.client() === null) return 'no Linear API key configured';
    if (config.linear.direction === 'pull') {
      return `sync direction is pull only; ${what} needs push`;
    }
    if (this.running !== null) return 'an export or archive is already running';
    return null;
  }

  private startBulk(opts: RunOptions & { bulk: BulkRun }): void {
    const { action, startedAt } = opts.bulk;
    this.running = { action, startedAt };
    void this.enqueue(opts)
      .catch(() => undefined)
      .finally(() => {
        if (this.running?.startedAt === startedAt) this.running = null;
      });
  }

  // Applies a state change now, answering what it returns, and again to the
  // state a pass in flight writes, so that write cannot undo it.
  private editState<T>(edit: (state: LinearSyncState) => T): T {
    const state = readLinearState(this.deps.rootDir);
    const result = edit(state);
    writeLinearState(this.deps.rootDir, state);
    if (this.inFlight !== null) this.stateEdits.push(edit);
    return result;
  }

  private statusModel(): StatusModel {
    return statusModelOf(this.safeConfig());
  }

  // How many closed issues an archive would take: the last measurement's
  // counts for the linked teams, or else the linked local tasks that are closed.
  private closedEstimate(includeCanceled: boolean): number {
    const teamIds = this.safeConfig()?.linear.teamIds ?? [];
    const measured = this.capacityCache?.data.teams.filter((t) =>
      teamIds.includes(t.id)
    );
    if (measured !== undefined && measured.length > 0) {
      return measured.reduce(
        (n, t) => n + t.completed + (includeCanceled ? t.canceled : 0),
        0
      );
    }
    const model = this.statusModel();
    return this.deps.cache.allItems().filter(({ meta }) => {
      if (meta.archivedAt !== undefined) return false;
      if (parseLinearExternal(meta.external)?.entity !== 'issue') return false;
      const type = statusType(meta.status, model);
      return type === 'completed' || (includeCanceled && type === 'canceled');
    }).length;
  }

  private enqueue(opts: RunOptions): Promise<LinearSyncSummary> {
    const previous = this.inFlight;
    const settled =
      previous === null
        ? Promise.resolve()
        : previous.then(
            () => undefined,
            () => undefined
          );
    // Cleared inside the chain the caller awaits, so a caller that starts
    // another pass right after this one resolves never gets this one back.
    const next: Promise<LinearSyncSummary> = settled
      .then(() => this.run(opts))
      .finally(() => {
        if (this.inFlight === next) this.inFlight = null;
      });
    this.inFlight = next;
    return next;
  }

  // Pulls Linear documents changed since the document cursor, then pushes
  // Linear-origin docs changed locally; an import reads every document once.
  // `delivered` set, it folds only those documents (a webhook pass).
  private async syncDocuments(
    run: Run,
    delivered?: ReadonlySet<string>
  ): Promise<void> {
    const binding = this.deps.documents;
    if (binding === undefined) return;
    const { pass, session, state, ctx } = run;
    const summary = pass.summary;
    const adapter = binding.adapter({
      port: this.documentsPort(
        () => session.client,
        session.teamIds,
        session.workspace.viewer.id,
        (failure) => {
          if (pass.take(failure) === null) throw new DocumentCallFailed();
        }
      ),
      taskFor: (parent) =>
        parent !== null &&
        (parent.kind === 'issue' ||
          parent.kind === 'project' ||
          parent.kind === 'initiative')
          ? (ctx.taskByRemote.get(parent.id) ?? null)
          : null,
      containerFor: (taskId) => containerOf(ctx.tasks.get(taskId)?.external),
      personFor: (userId) =>
        userId === null ? null : (ctx.people.refByUser.get(userId) ?? null),
      problem: (_docId, detail) => summary.errors.push(detail),
    });
    try {
      if (delivered !== undefined) {
        if (run.mayPull) await adapter.pullIds([...delivered]);
        return;
      }
      if (run.mayPull) {
        // A link made before documents synced starts at the issue cursor, so
        // it does not pull the team's whole document history unasked.
        const from = run.importing
          ? null
          : state.documentCursor !== undefined
            ? state.documentCursor
            : state.cursor;
        const pulled = await adapter.pull(from);
        state.documentCursor = pulled.cursor;
      }
      // An explicit task push and an import send no documents.
      const pushes =
        session.linear.direction !== 'pull' &&
        run.taskIds === undefined &&
        !run.importing;
      if (pushes) {
        for (const docId of binding.outstanding()) await adapter.push(docId);
      }
    } catch (err) {
      if (pass.stopped) throw err;
      if (!(err instanceof DocumentCallFailed)) {
        summary.errors.push(
          `Linear documents: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  // The adapter's view of Linear over a client; `fail` records a failed call
  // and throws, so a document step never acts on a half-read state.
  private documentsPort(
    client: () => LinearClient,
    teamIds: readonly string[],
    viewerId: string,
    fail: (failure: LinearFailure) => void
  ): LinearDocsPort {
    const unwrap = <T>(result: LinearResult<T>): T => {
      if (result.ok) return result.data;
      fail(result);
      throw new DocumentCallFailed();
    };
    return {
      documentsUpdatedSince: async (cursor) =>
        unwrap(
          await acrossTeams(teamIds, (id) => client().documents(id, cursor))
        ).nodes,
      document: async (id) => unwrap(await client().document(id)),
      documentUpdate: async (id, content) => {
        unwrap(await client().updateDocument(id, content));
      },
      documentCreate: async (input) =>
        unwrap(await client().createDocument(input)),
      contentHistory: async (id) =>
        unwrap(await client().documentContentHistory(id)),
      integrationUserId: () => viewerId,
    };
  }

  // Keeps the session's label list (the workspace cache's own array) in step
  // with a label this engine wrote, so the next pass does not read it stale.
  private cacheLabel(session: Session, label: LinearLabel): void {
    const at = session.labels.findIndex((l) => l.id === label.id);
    if (at < 0) session.labels.push(label);
    else session.labels[at] = label;
  }

  // Turns a client failure into a summary message, arming the backoff clock when
  // the failure was a throttle.
  private note(failure: LinearFailure): string {
    if (failure.kind === 'rate-limit') {
      this.backoffUntil = Date.now() + (failure.retryAfterMs ?? 60_000);
    }
    return failure.error;
  }

  private setProgress(progress: LinearProgress | null): void {
    this.progress = progress;
    if (progress !== null) {
      this.deps.events.broadcast({ type: 'linear.progress', progress });
    }
  }

  // Broadcasts this engine's own writes without queueing a push of them.
  private quietly(send: () => void): void {
    this.selfBroadcast = true;
    try {
      send();
    } finally {
      this.selfBroadcast = false;
    }
  }

  private async openSession(
    force: boolean
  ): Promise<{ ok: true; session: Session } | { ok: false; error: string }> {
    const config = this.safeConfig();
    if (config === null) {
      return { ok: false, error: this.configError ?? 'invalid config' };
    }
    const teamIds = config.linear.teamIds;
    const teamId = teamIds[0];
    if (teamId === undefined) {
      return { ok: false, error: 'no Linear team selected' };
    }
    const client = this.client();
    if (client === null) {
      return { ok: false, error: 'no Linear API key configured' };
    }
    const key = teamIds.join(',');
    const cached = this.workspaceCache;
    const fresh =
      !force &&
      cached !== null &&
      cached.key === key &&
      Date.now() - cached.at < WORKSPACE_TTL_MS;
    if (!fresh) {
      const teams: LinearWorkspace[] = [];
      const labels = new Map<string, LinearLabel>();
      for (const id of teamIds) {
        const workspace = await client.workspace(id);
        if (!workspace.ok) return { ok: false, error: this.note(workspace) };
        teams.push(workspace.data);
        const teamLabels = await client.labels(id);
        if (!teamLabels.ok) return { ok: false, error: this.note(teamLabels) };
        for (const l of teamLabels.data)
          if (!labels.has(l.id)) labels.set(l.id, l);
      }
      this.workspaceCache = {
        key,
        at: Date.now(),
        teams,
        labels: [...labels.values()],
      };
    }
    const current = this.workspaceCache;
    const primary = current?.teams[0];
    if (current === null || primary === undefined) {
      return { ok: false, error: 'no Linear workspace' };
    }
    const members = new Map<string, LinearUser>();
    for (const team of current.teams) {
      for (const m of team.members)
        if (!members.has(m.id)) members.set(m.id, m);
    }
    return {
      ok: true,
      session: {
        client,
        config,
        linear: config.linear,
        teamId,
        teamIds,
        workspace: primary,
        teams: current.teams,
        labels: current.labels,
        members: [...members.values()],
      },
    };
  }

  private async run(opts: RunOptions): Promise<LinearSyncSummary> {
    const summary = emptySummary(new Date().toISOString());
    const bulk = opts.bulk ?? null;
    // A background action that never got going still records how it ended.
    const stopped = () =>
      bulk === null ? {} : { outcome: this.outcome(bulk, summary, 0) };
    if (Date.now() < this.backoffUntil) {
      summary.rateLimited = true;
      summary.errors.push('linear rate limit backoff in effect');
      const state = readLinearState(this.deps.rootDir);
      return this.finish(summary, state, null, undefined, stopped());
    }
    const opened = await this.openSession(opts.mode === 'import');
    if (!opened.ok) {
      summary.errors.push(opened.error);
      // Persisted so `status().lastError` explains a misconfiguration, not just the summary.
      const state = readLinearState(this.deps.rootDir);
      return this.finish(summary, state, null, undefined, stopped());
    }
    const session = opened.session;
    const { store, cache, rootDir } = this.deps;
    const state = readLinearState(rootDir);
    const archiving = opts.mode === 'archive';
    if (archiving && state.bootstrappedAt === null) {
      summary.errors.push(NOT_LINKED);
      return this.finish(
        summary,
        state,
        null,
        session.linear.intervalSec,
        stopped()
      );
    }
    this.takeCommentChanges(state);
    let probe: LinearProbe | null = null;
    if (opts.poll === true && state.bootstrappedAt !== null) {
      const pulls = session.linear.direction !== 'push';
      const from = earliest(state.cursor, state.commentCursor);
      if (pulls && from !== null) {
        // Cursors sit a second behind the newest record seen; the probe asks
        // about anything after that record itself, or an idle team never looks idle.
        const seen = new Date(Date.parse(from) + 1000).toISOString();
        const probed = await probeTeams(
          session,
          seen,
          state.documentCursor ?? seen
        );
        if (!probed.ok) {
          summary.errors.push(this.note(probed));
          summary.rateLimited = probed.kind === 'rate-limit';
          return this.finish(summary, state, null, session.linear.intervalSec);
        }
        probe = probed.data;
      }
      const moved =
        probe !== null &&
        (probe.issues ||
          probe.projects ||
          probe.milestones ||
          probe.initiatives ||
          probe.comments ||
          (probe.documents && this.deps.documents !== undefined));
      const idle =
        !moved &&
        (!pulls || probe !== null) &&
        !(pulls && state.milestoneWalk === true) &&
        !this.localDirty &&
        (this.deps.documents?.outstanding().length ?? 0) === 0 &&
        !this.auditDue(state) &&
        this.webhookSettled(state, session) &&
        !(session.linear.direction !== 'pull' && this.retryDue(state));
      if (idle) {
        return this.finish(summary, state, null, session.linear.intervalSec, {
          quiet: true,
        });
      }
    }
    this.localDirty = false;
    const docs = new Map(store.listSafe().docs.map((d) => [d.meta.id, d]));
    this.foldLegacyWatermark(state, docs);
    foldLocalOnly(state, docs.values());
    const batch = new TaskChangeBatch(
      store,
      cache,
      (id) => docs.get(id),
      (ids) => {
        this.quietly(() =>
          this.deps.events.broadcast({ type: 'task.changed', ids })
        );
        // Only an import's progress counts writes; an export or archive
        // line keeps its own phase.
        const progress = this.progress;
        if (
          progress !== null &&
          (progress.phase === 'applying' ||
            (progress.action ?? 'import') === 'import')
        ) {
          this.setProgress({
            ...progress,
            phase: 'applying',
            done: batch.count(),
          });
        }
      }
    );

    // The teams' workflows are the project's status vocabulary, and their
    // users are the project's people; both are refreshed before anything maps.
    const regenerated = regenerateStatuses(
      rootDir,
      store,
      docs,
      state,
      session.teams.map((t) => ({
        id: t.team.id,
        key: t.team.key,
        states: t.states,
      })),
      this.deps.finishedRuns?.()
    );
    for (const id of regenerated.migrated) batch.add(id);
    summary.migrated = regenerated.migrated.length;
    upgradeBases(state, state.stateNames);
    const localRef = this.deps.localHumanRef ?? 'human:me';
    const people = syncPeople(
      rootDir,
      regenerated.config,
      session.members,
      session.workspace.viewer.id,
      localRef
    );
    const direction = session.linear.direction;
    const mayPull = direction !== 'push';
    const mayPush = direction !== 'pull';
    // Labels too: the registry follows Linear's labels, colors both ways.
    const labelBase = { ...state.labelColors };
    const labels = syncLabels(rootDir, people.config, session.labels, state, {
      mayPull,
      mayPush,
    });
    if (labels.error !== null) summary.errors.push(labels.error);
    if (regenerated.configChanged || people.changed || labels.changed) {
      this.deps.events.broadcast({ type: 'config.changed' });
    }
    const config = labels.config;
    const ctx = buildContext(
      rootDir,
      config,
      state,
      docs,
      session.labels,
      session.workspace.projectStatuses,
      localRef,
      session.teams.map((t) => ({ id: t.team.id, states: t.states }))
    );
    const pass = new LinearPass({
      store,
      client: session.client,
      config,
      teamId: session.teamId,
      teamByKey: new Map(session.teams.map((t) => [t.team.key, t.team.id])),
      state,
      summary,
      ctx,
      docs,
      batch,
      note: (failure) => this.note(failure),
      onLabel: (label) => this.cacheLabel(session, label),
      blockedLabels: this.blockedLabels,
    });
    // A color write that did not land keeps its old base, so it retries.
    for (const id of await pass.pushLabelColors(labels.push)) {
      const was = labelBase[id];
      if (was === undefined) delete state.labelColors[id];
      else state.labelColors[id] = was;
    }
    const changedComments = new Map<string, Set<string>>();
    const named = opts.taskIds === undefined ? null : new Set(opts.taskIds);
    const run: Run = {
      pass,
      session,
      state,
      ctx,
      docs,
      touched: new Set(),
      comments:
        this.deps.comments === undefined
          ? null
          : new CommentSync({
              comments: this.deps.comments,
              client: session.client,
              state,
              ctx,
              pass,
              changed: changedComments,
            }),
      mayPull,
      // An explicit push writes only the tasks it names; others a pull meets
      // take Linear's changes and keep their own for an ordinary pass. An
      // archive pass only takes Linear's archive.
      canPush: (id) =>
        mayPush && !archiving && (named === null || named.has(id)),
      importing: opts.mode === 'import',
      taskIds: opts.taskIds,
      named,
      archiveOnArrival: opts.archiveOnArrival ?? new Set(),
      bulk,
      found: null,
      probe,
    };

    // A first sync reconciles nothing — no task to create, no link to update — so it
    // takes a cursor instead of scanning a whole team it has no use for.
    const baselining = state.bootstrappedAt === null && !run.importing;
    const webhook = opts.mode === 'webhook';
    // An export or archive does its one job; the next ordinary pass catches
    // up on the pull, documents, audit and webhook.
    const upkeep = !webhook && opts.mode !== 'export' && !archiving;
    if (webhook) {
      if (!baselining && mayPull) {
        await pass.guarded(() => this.applyTargets(run, opts.targets));
        const delivered = opts.targets?.documents;
        if (delivered !== undefined && delivered.size > 0 && !pass.stopped)
          await pass.guarded(() => this.syncDocuments(run, delivered));
      }
    } else if (archiving) {
      await pass.guarded(() =>
        this.archiveClosed(run, opts.includeCanceled === true)
      );
    } else if (baselining) {
      const now = new Date().toISOString();
      state.cursor = rewind(now);
      state.commentCursor = rewind(now);
      // Everything on disk is accounted for BEFORE the push: nothing local has been
      // reconciled yet, so a fresh clone must send none of it over a linked issue.
      this.accountForAll(state, docs);
      state.bootstrappedAt = now;
      await pass.guarded(() => this.audit(run, true));
    } else if (run.importing || (mayPull && opts.mode === 'both')) {
      if (run.importing) {
        this.setProgress({ phase: 'containers', done: 0, total: null });
      }
      await pass.guarded(() => this.pull(run));
      await pass.guarded(() => this.resolvePlaceholders(run));
    }

    const pushing = baselining ? opts.taskIds !== undefined : !run.importing;
    if (!webhook && !archiving && pushing && mayPush && !pass.stopped) {
      await pass.guarded(() => this.push(run));
    }

    if (upkeep && !baselining && !pass.stopped) {
      await pass.guarded(() => this.audit(run, run.importing));
    }
    if (upkeep && !baselining && !pass.stopped) {
      await pass.guarded(() => this.syncDocuments(run));
    }
    if (upkeep && !pass.stopped) {
      await pass.guarded(() => this.ensureWebhook(run));
      if (this.timer !== null) {
        this.schedulePolls(session.linear.intervalSec, state.webhook !== null);
      }
    }

    if (pass.withheld > 0) {
      summary.errors.push(
        `withheld ${pass.withheld} issue update(s): Linear holds a newer copy, or its version could not be checked`
      );
    }

    // The link is established once the team answered, not once a data pass came back
    // clean — otherwise one persistent error would freeze the integration forever.
    if (state.bootstrappedAt === null) {
      // An import establishes the link without ever pushing, so the same rule as the
      // baseline path applies: nothing already on disk goes up automatically.
      this.accountForAll(state, docs);
      state.bootstrappedAt = new Date().toISOString();
    }
    // A create a throttle stopped after its record landed is linked now.
    this.pruneQueue(state, docs);
    summary.queued = forcedEntries(state);
    // Archiving freed room, so creates queued behind the limit go next.
    if (archiving && summary.archivedIssues > 0 && this.retryDue(state)) {
      this.schedulePush();
    }
    this.quietly(() => {
      for (const [taskId, ids] of changedComments) {
        this.deps.events.broadcast({
          type: 'comment.changed',
          taskId,
          commentIds: [...ids],
        });
      }
    });
    return this.finish(
      summary,
      state,
      batch,
      session.linear.intervalSec,
      bulk === null ? {} : { outcome: this.passOutcome(run, bulk) }
    );
  }

  /**
   * Applies what webhook deliveries named: those issues and comments fetched
   * by id and run through the same mapping as a pull, deletions applied
   * straight away, and containers re-read from the cursor when a project
   * changed. Cursors stay put; the next poll reads past these again cheaply.
   */
  private async applyTargets(
    run: Run,
    targets: WebhookTargets = emptyTargets()
  ): Promise<void> {
    const { pass, session, state, ctx, docs } = run;
    const { client, teamIds } = session;
    const fetched: Fetched = {
      initiatives: [],
      projects: [],
      milestones: [],
      issues: [],
      comments: [],
    };
    if (targets.containers) {
      fetched.projects =
        pass.take(
          await acrossTeams(teamIds, (id) => client.projects(id, state.cursor))
        )?.nodes ?? [];
      fetched.milestones =
        pass.take(
          await acrossTeams(teamIds, (id) =>
            client.projectMilestones(id, state.cursor)
          )
        )?.nodes ?? [];
      fetched.initiatives =
        pass.take(await client.initiatives(state.cursor))?.nodes ?? [];
    }
    if (targets.issues.size > 0) {
      fetched.issues =
        pass.take(await client.issuesByIds([...targets.issues])) ?? [];
    }
    if (targets.comments.size > 0 && run.comments !== null) {
      fetched.comments =
        pass.take(await client.commentsByIds([...targets.comments])) ?? [];
    }
    await this.fillReferences(run, fetched);
    await this.learnUsers(run, fetched);
    await this.applyContainers(run, fetched);
    await this.applyIssues(run, fetched.issues);
    for (const id of targets.removedIssues) {
      const doc = docs.get(ctx.taskByRemote.get(id) ?? '');
      if (doc !== undefined) pass.unlinkDeleted(doc);
    }
    if (run.comments !== null) {
      await run.comments.pull(fetched.comments);
      for (const id of targets.removedComments) run.comments.removeRemote(id);
    }
  }

  /**
   * Keeps the webhook registration in step with the daemon: one hook per
   * linked team, all signing with one secret, registered while sync pulls and
   * the daemon has a public HTTPS URL, re-registered when that URL or the set
   * of teams changes, removed otherwise. A failed registration (the key's user
   * must be a workspace admin) waits an hour before retrying, keeping any
   * hooks that did register, and the sync polls meanwhile.
   */
  private async ensureWebhook(run: Run): Promise<void> {
    const { state, session, mayPull, pass } = run;
    const url = this.deps.webhookUrl ?? null;
    if (this.webhookSettled(state, session)) {
      if (url === null || !mayPull) {
        state.webhookError = null;
        state.webhookRetryAt = null;
      }
      return;
    }
    const current = state.webhook;
    if (current !== null) {
      for (const hook of webhookHooks(current)) {
        pass.take(await session.client.deleteWebhook(hook.id));
      }
      state.webhook = null;
    }
    if (url === null || !mayPull) {
      state.webhookError = null;
      state.webhookRetryAt = null;
      return;
    }
    if (this.retrying(state)) return;
    const secret = randomBytes(32).toString('hex');
    const hooks: { teamId: string; id: string }[] = [];
    for (const teamId of session.teamIds) {
      const created = await session.client.createWebhook({
        url,
        teamId,
        secret,
        label: 'Dispatch',
        resourceTypes: WEBHOOK_RESOURCE_TYPES,
      });
      if (!created.ok) {
        state.webhookError = this.note(created);
        state.webhookRetryAt = new Date(
          Date.now() + WEBHOOK_RETRY_MS
        ).toISOString();
        break;
      }
      hooks.push({ teamId, id: created.data });
    }
    const [first, ...more] = hooks;
    if (first === undefined) return;
    state.webhook = {
      id: first.id,
      url,
      secret,
      teamId: first.teamId,
      createdAt: new Date().toISOString(),
      ...(more.length === 0 ? {} : { more }),
      resourceTypes: [...WEBHOOK_RESOURCE_TYPES],
    };
    if (hooks.length === session.teamIds.length) {
      state.webhookError = null;
      state.webhookRetryAt = null;
    }
  }

  // Whether a failed registration is still waiting out its retry delay.
  private retrying(state: LinearSyncState): boolean {
    return (
      state.webhookRetryAt !== null &&
      Date.now() < Date.parse(state.webhookRetryAt)
    );
  }

  // Moves comment changes noted since the last pass into the persisted queue.
  private takeCommentChanges(state: LinearSyncState): void {
    for (const [taskId, ids] of this.commentChanges) {
      state.pendingComments[taskId] = [
        ...new Set([...(state.pendingComments[taskId] ?? []), ...ids]),
      ];
    }
    this.commentChanges.clear();
  }

  // Records every task on disk at its current version, so establishing the link leaves
  // nothing outstanding for the push to send: a linked task as what Linear
  // holds, an unlinked one as held back.
  private accountForAll(
    state: LinearSyncState,
    docs: Map<string, TaskDoc>
  ): void {
    for (const doc of docs.values()) {
      const { id, updated } = doc.meta;
      if (parseLinearExternal(doc.meta.external) === null) {
        (state.localOnly ??= {})[id] = updated;
      } else state.pushed[id] = updated;
    }
  }

  // A state file written before per-task accounting carries only a watermark. Everything at
  // or before it is recorded once, so an upgrade neither re-sends work nor strands it.
  private foldLegacyWatermark(
    state: LinearSyncState,
    docs: Map<string, TaskDoc>
  ): void {
    if (state.lastPushAt === null) return;
    if (Object.keys(state.pushed).length === 0) {
      const mark = Date.parse(state.lastPushAt);
      // Ids in `pushRetry` were outstanding despite the watermark covering them.
      const queued = new Set(state.pushRetry ?? []);
      for (const doc of docs.values()) {
        if (queued.has(doc.meta.id)) continue;
        if (Date.parse(doc.meta.updated) <= mark) {
          state.pushed[doc.meta.id] = doc.meta.updated;
        }
      }
    }
    delete state.pushRetry;
    state.lastPushAt = null;
  }

  // Records the pass: flushes the task batch, persists cursor/echo state, and
  // tells connected clients the sync ran.
  private finish(
    summary: LinearSyncSummary,
    state: LinearSyncState,
    batch: TaskChangeBatch | null,
    intervalSec = 300,
    {
      quiet = false,
      outcome,
    }: { quiet?: boolean; outcome?: LinearBulkOutcome } = {}
  ): LinearSyncSummary {
    batch?.flush();
    this.progress = null;
    state.lastSyncAt = summary.at;
    state.lastError = summary.errors[0] ?? null;
    state.lastWebhookAt = this.lastDeliveryAt ?? state.lastWebhookAt;
    state.echoes = pruneEchoes(
      state.echoes,
      Date.now(),
      echoTtlMs(intervalSec)
    );
    // Written before linear.changed goes out, so a client refreshing on it
    // sees the outcome and nothing running.
    if (outcome !== undefined) {
      if (outcome.action === 'archive') state.lastArchive = outcome;
      else state.lastExport = outcome;
      this.running = null;
      this.resetCapacity();
    }
    for (const edit of this.stateEdits.splice(0)) edit(state);
    writeLinearState(this.deps.rootDir, state);
    this.lastSummary = summary;
    // An idle poll changed nothing a client shows, so it stays silent.
    if (!quiet) this.deps.events.broadcast({ type: 'linear.changed', summary });
    return summary;
  }

  // A background action's outcome. `done` is what landed; `candidates`
  // defaults to what the start counted.
  private outcome(
    bulk: BulkRun,
    summary: LinearSyncSummary,
    done: number,
    extra: { candidates?: number; archivedOnArrival?: number } = {}
  ): LinearBulkOutcome {
    const candidates = extra.candidates ?? bulk.candidates;
    return {
      action: bulk.action,
      startedAt: bulk.startedAt,
      at: new Date().toISOString(),
      ...(bulk.scope === undefined ? {} : { scope: bulk.scope }),
      ...(bulk.includeCanceled === undefined
        ? {}
        : { includeCanceled: bulk.includeCanceled }),
      candidates,
      done,
      ...(extra.archivedOnArrival === undefined
        ? {}
        : { archivedOnArrival: extra.archivedOnArrival }),
      remaining: Math.max(0, candidates - done),
      halted: summary.usageLimited
        ? 'usage-limit'
        : summary.rateLimited
          ? 'rate-limit'
          : null,
      errors: dedupeErrors(summary.errors),
    };
  }

  // How a pass that ran ended: an archive by issues archived, an export or
  // retry by named tasks that now have their record.
  private passOutcome(run: Run, bulk: BulkRun): LinearBulkOutcome {
    const summary = run.pass.summary;
    if (bulk.action === 'archive') {
      return this.outcome(bulk, summary, summary.archivedIssues, {
        candidates: run.found ?? bulk.candidates,
      });
    }
    const ids = run.taskIds ?? [];
    const linked = ids.filter(
      (id) => parseLinearExternal(run.docs.get(id)?.meta.external) !== null
    );
    if (bulk.action === 'retry') {
      return this.outcome(bulk, summary, linked.length);
    }
    const archived = fieldHash(true);
    const archivedOnArrival = linked.filter(
      (id) =>
        run.archiveOnArrival.has(id) &&
        readBase(run.state, id, 'issue')?.remote.archived === archived
    ).length;
    return this.outcome(bulk, summary, linked.length, { archivedOnArrival });
  }

  // Whether a queued create is due, so an idle poll still runs the push.
  private retryDue(state: LinearSyncState): boolean {
    const now = Date.now();
    if (capacityPaused(state, now)) return false;
    return Object.values(state.pushQueue).some(
      (e) => e.origin !== 'auto' && retryReady(e, now)
    );
  }

  private auditDue(state: LinearSyncState): boolean {
    return (
      state.lastAuditAt === null ||
      Date.now() - Date.parse(state.lastAuditAt) > AUDIT_EVERY_MS
    );
  }

  // Whether the webhook registration already matches what ensureWebhook wants.
  private webhookSettled(state: LinearSyncState, session: Session): boolean {
    const url = this.deps.webhookUrl ?? null;
    const wanted = url !== null && session.linear.direction !== 'push';
    const current = state.webhook;
    if (!wanted) return current === null;
    if (current === null) return this.retrying(state);
    if (current.url !== url) return false;
    // A registration missing a resource type we now subscribe to is redone.
    const types = current.resourceTypes ?? [];
    if (!WEBHOOK_RESOURCE_TYPES.every((t) => types.includes(t))) return false;
    const hooked = webhookHooks(current).map((h) => h.teamId);
    const covers =
      hooked.length === session.teamIds.length &&
      session.teamIds.every((id) => hooked.includes(id));
    // A partial registration stands until its retry is due.
    return covers || this.retrying(state);
  }

  private async pull(run: Run): Promise<void> {
    const { pass, session, state, importing } = run;
    const { client, teamIds } = session;
    const summary = pass.summary;
    // A complete read that saw nothing newer still moves the cursor here: without
    // one, an empty team's every poll would skip the probe and re-read it all.
    const startedAt = new Date().toISOString();
    let records = true;
    let comments = true;
    const walk = state.milestoneWalk === true;
    // An idle poll is one cheap probe. When any record moved, every kind is
    // read against the same cursor, so no kind's change can fall behind it.
    const probeFrom = earliest(state.cursor, state.commentCursor);
    if (!importing && probeFrom !== null) {
      // Cursors sit a second behind the newest record seen; the probe asks
      // about anything after that record itself, or an idle team never looks idle.
      const seen = new Date(Date.parse(probeFrom) + 1000).toISOString();
      const probe =
        run.probe ??
        pass.take(
          await probeTeams(session, seen, state.documentCursor ?? seen)
        );
      if (probe === null) return;
      records =
        walk ||
        probe.issues ||
        probe.projects ||
        probe.milestones ||
        probe.initiatives;
      comments = probe.comments;
      if (!records && !comments) return;
    }
    const fetched: Fetched = {
      initiatives: [],
      projects: [],
      milestones: [],
      issues: [],
      comments: [],
    };
    const since = importing ? null : state.cursor;
    let recordsOk = true;
    let issuesTruncated = false;
    if (records) {
      const projects = pass.take(
        await acrossTeams(teamIds, (id) => client.projects(id, since))
      );
      const milestones = pass.take(
        await acrossTeams(teamIds, (id) =>
          client.projectMilestones(id, walk ? null : since)
        )
      );
      const initiatives = pass.take(await client.initiatives(since));
      if (importing)
        this.setProgress({ phase: 'issues', done: 0, total: null });
      const page = pass.take(
        await issuesAcrossTeams(session, since, (n) => {
          if (importing) {
            this.setProgress({ phase: 'issues', done: n, total: null });
          }
        })
      );
      fetched.initiatives = initiatives?.nodes ?? [];
      fetched.projects = projects?.nodes ?? [];
      // A walk reads every milestone but brings in only linked ones and
      // those the cursor would have, so it resurrects nothing deleted here.
      fetched.milestones = (milestones?.nodes ?? []).filter(
        (m) =>
          !walk ||
          since === null ||
          m.updatedAt > since ||
          run.ctx.taskByRemote.has(m.id)
      );
      fetched.issues = page?.issues ?? [];
      const pages: (LinearPage<unknown> | null)[] = [
        projects,
        milestones,
        initiatives,
      ];
      recordsOk =
        page !== null && pages.every((p) => p !== null && !p.truncated);
      issuesTruncated = page?.truncated ?? false;
    }
    let commentPage: LinearPage<LinearComment> | null = null;
    if (comments && run.comments !== null) {
      const from = importing ? null : state.commentCursor;
      commentPage = pass.take(
        await acrossTeams(teamIds, (id) => client.comments(id, from))
      );
      fetched.comments = commentPage?.nodes ?? [];
    }

    await this.fillReferences(run, fetched);
    await this.learnUsers(run, fetched);

    if (importing) {
      this.setProgress({
        phase: 'applying',
        done: 0,
        total: fetched.issues.length + fetched.projects.length,
      });
    }
    await this.applyContainers(run, fetched);
    if (walk && records && recordsOk) delete state.milestoneWalk;
    await this.applyIssues(run, fetched.issues);
    if (run.comments !== null && commentPage !== null) {
      // An import read every comment of the team, so a twin missing from it
      // was deleted in Linear.
      const complete = importing
        ? new Set(fetched.issues.map((i) => i.id))
        : new Set<string>();
      await run.comments.pull(fetched.comments, complete);
      if (!commentPage.truncated) {
        state.commentCursor = rewind(
          newest(fetched.comments, state.commentCursor) ?? startedAt
        );
      }
    }

    if (issuesTruncated) {
      // The cursor must not move past issues this walk never reached.
      summary.errors.push(
        'linear returned more issues than one sync could page through; cursor held'
      );
    } else if (records && recordsOk) {
      state.cursor = rewind(
        newest(
          [
            ...fetched.issues,
            ...fetched.projects,
            ...fetched.milestones,
            ...fetched.initiatives,
          ],
          state.cursor
        ) ?? startedAt
      );
    }
  }

  // A pulled record naming a container this project has never seen (a delta
  // after the link, or a project added to an initiative) brings that
  // container, and its own parents, down too.
  private async fillReferences(run: Run, fetched: Fetched): Promise<void> {
    const { pass, session, ctx } = run;
    const known = (id: string | null) =>
      id === null || ctx.taskByRemote.has(id);
    const have = new Set([
      ...fetched.projects.map((p) => p.id),
      ...fetched.milestones.map((m) => m.id),
    ]);
    const wantsContainers = fetched.issues.some(
      (i) =>
        (!known(i.projectId) && !have.has(i.projectId ?? '')) ||
        (!known(i.projectMilestoneId) && !have.has(i.projectMilestoneId ?? ''))
    );
    if (wantsContainers) {
      const { client, teamIds } = session;
      const projects = pass.take(
        await acrossTeams(teamIds, (id) => client.projects(id, null))
      );
      const milestones = pass.take(
        await acrossTeams(teamIds, (id) => client.projectMilestones(id, null))
      );
      const byId = new Map(fetched.projects.map((p) => [p.id, p]));
      for (const p of projects?.nodes ?? []) {
        if (!byId.has(p.id)) byId.set(p.id, p);
      }
      fetched.projects = [...byId.values()];
      const msById = new Map(fetched.milestones.map((m) => [m.id, m]));
      for (const m of milestones?.nodes ?? []) {
        if (!msById.has(m.id)) msById.set(m.id, m);
      }
      fetched.milestones = [...msById.values()];
    }
    const initiativeIds = new Set(
      fetched.projects.flatMap((p) => p.initiatives.map((i) => i.initiativeId))
    );
    const fetchedInitiatives = new Set(fetched.initiatives.map((i) => i.id));
    const missing = [...initiativeIds].filter(
      (id) => !known(id) && !fetchedInitiatives.has(id)
    );
    if (missing.length > 0) {
      const all = pass.take(await session.client.initiatives(null));
      for (const i of all?.nodes ?? []) {
        if (missing.includes(i.id)) fetched.initiatives.push(i);
      }
    }
    // Only the teams' initiatives: ones a team project belongs to, or already linked.
    fetched.initiatives = fetched.initiatives.filter(
      (i) => initiativeIds.has(i.id) || ctx.taskByRemote.has(i.id)
    );
  }

  // Users a record names who are not team members (a guest, someone from
  // another team) are looked up and added to the people registry, so an
  // assignment or a comment never silently maps to nobody.
  private async learnUsers(
    run: Pick<Run, 'session' | 'ctx'>,
    fetched: Partial<Fetched>
  ): Promise<void> {
    const { session, ctx } = run;
    const ids = new Set<string>();
    const want = (id: string | null) => {
      if (id !== null && !ctx.people.refByUser.has(id)) ids.add(id);
    };
    for (const i of fetched.issues ?? []) {
      want(i.assigneeId);
      want(i.creatorId);
    }
    for (const p of fetched.projects ?? []) want(p.leadId);
    for (const i of fetched.initiatives ?? []) want(i.ownerId);
    for (const c of fetched.comments ?? []) want(c.userId);
    if (ids.size === 0) return;
    const users = await session.client.users([...ids]);
    if (!users.ok || users.data.length === 0) return;
    const merged: LinearUser[] = [...session.members, ...users.data];
    const result = syncPeople(
      this.deps.rootDir,
      loadConfig(this.deps.rootDir),
      merged,
      session.workspace.viewer.id,
      ctx.people.localRef
    );
    if (result.changed) {
      refreshPeople(this.deps.rootDir, ctx, result.config);
      this.deps.events.broadcast({ type: 'config.changed' });
    }
  }

  // Re-reads the issues of tasks still assigned to UNRESOLVED_LINEAR_ASSIGNEE
  // when the registry may name someone new (it grew since the last try, or the
  // audit is due), so the person replaces the placeholder without waiting for
  // the issue to change in Linear. The pull already re-read any it touched.
  private async resolvePlaceholders(run: Run): Promise<void> {
    const { pass, session, state, ctx, docs, touched, mayPull } = run;
    const named = ctx.people.refByUser.size;
    if (named === this.namedUsers && !this.auditDue(state)) return;
    const held = new Map<string, string>();
    for (const doc of docs.values()) {
      if (doc.meta.assignee !== UNRESOLVED_LINEAR_ASSIGNEE) continue;
      if (touched.has(doc.meta.id)) continue;
      const ref = parseLinearExternal(doc.meta.external);
      if (ref?.entity === 'issue') held.set(ref.id, doc.meta.id);
    }
    if (held.size > 0) {
      const fresh = pass.take(
        await session.client.issuesByIds([...held.keys()])
      );
      if (fresh === null) return;
      await this.learnUsers(run, { issues: fresh });
      for (const issue of fresh) {
        const doc = docs.get(held.get(issue.id) ?? '');
        if (doc === undefined || !inLinkedTeam(issue, session)) continue;
        touched.add(doc.meta.id);
        await pass.reconcileIssue(doc, issue, {
          mayPull,
          mayPush: run.canPush(doc.meta.id),
        });
      }
    }
    this.namedUsers = ctx.people.refByUser.size;
  }

  private async applyContainers(run: Run, fetched: Fetched): Promise<void> {
    const { pass, ctx, docs, touched, mayPull, canPush } = run;
    const ready = ctx.model.roles.ready;
    // Created first, all of them, so every reference among them resolves.
    const pairs: [
      TaskDoc,
      RemoteRecord,
      'initiative' | 'project' | 'milestone',
    ][] = [];
    const lists: ['initiative' | 'project' | 'milestone', RemoteRecord[]][] = [
      ['initiative', fetched.initiatives],
      ['project', fetched.projects],
      ['milestone', fetched.milestones],
    ];
    for (const [entity, records] of lists) {
      for (const r of records) {
        const taskId = ctx.taskByRemote.get(r.id);
        if (taskId === undefined) {
          if (r.archivedAt !== null || !mayPull) continue;
          pairs.push([pass.createLocal(entity, r, ready), r, entity]);
          continue;
        }
        const doc = docs.get(taskId);
        if (doc === undefined) continue;
        if (pass.isEcho(r.id, r.updatedAt)) {
          pass.recordChip(r);
          continue;
        }
        pairs.push([doc, r, entity]);
      }
    }
    for (const [doc, r, entity] of pairs) {
      const current = docs.get(doc.meta.id) ?? doc;
      touched.add(current.meta.id);
      const mode = { mayPull, mayPush: canPush(current.meta.id) };
      if (entity === 'initiative') {
        await pass.reconcileInitiative(current, r as LinearInitiative, mode);
      } else if (entity === 'project') {
        await pass.reconcileProject(current, r as LinearProject, mode);
      } else {
        await pass.reconcileMilestone(
          current,
          r as LinearProjectMilestone,
          mode
        );
      }
    }
  }

  private async applyIssues(run: Run, issues: LinearIssue[]): Promise<void> {
    const { pass, session, state, ctx, docs, touched, mayPull, canPush } = run;
    const sorted = [...issues].sort((a, b) =>
      a.updatedAt.localeCompare(b.updatedAt)
    );
    const pairs: [TaskDoc, LinearIssue][] = [];
    const yieldLoop = sliceYielder();
    for (const issue of sorted) {
      await yieldLoop();
      const taskId = ctx.taskByRemote.get(issue.id);
      // A move between linked teams is followed like any other change; only
      // leaving all of them unlinks the task.
      const inTeam = inLinkedTeam(issue, session);
      if (taskId === undefined) {
        if (issue.archivedAt !== null || !inTeam || !mayPull) continue;
        const returning = state.movedOut[issue.id];
        const relinked =
          returning === undefined ? null : pass.relink(returning, issue);
        pairs.push([relinked ?? pass.createLocal('issue', issue, ''), issue]);
        continue;
      }
      const doc = docs.get(taskId);
      if (doc === undefined) continue;
      pass.recordLink(issue.id, issue.identifier, issue.url);
      if (!inTeam) {
        pass.unlinkMoved(doc, issue.id, issue.team?.key ?? 'another team');
        continue;
      }
      if (pass.isEcho(issue.id, issue.updatedAt)) continue;
      pairs.push([doc, issue]);
    }
    for (const [doc, issue] of pairs) {
      await yieldLoop();
      const current = docs.get(doc.meta.id) ?? doc;
      touched.add(current.meta.id);
      await pass.reconcileIssue(current, issue, {
        mayPull,
        mayPush: canPush(current.meta.id),
      });
    }
  }

  private async push(run: Run): Promise<void> {
    const { pass, session, state, docs, touched, named, mayPull } = run;
    const explicit = named !== null;
    const summary = pass.summary;
    const now = Date.now();
    const at = new Date(now).toISOString();
    this.pruneQueue(state, docs);
    if (named !== null) this.queueNamed(run, named, at);
    // Ordinary passes create nothing while the issue limit's pause runs; a
    // push by name tries anyway, and its first refusal caps the pass.
    const paused = !explicit && capacityPaused(state, now);
    // Creates a push or an export named, due again: an ordinary pass sends
    // them as if named.
    const forced = new Set<string>();
    if (!explicit && !paused) {
      for (const [id, entry] of Object.entries(state.pushQueue)) {
        if (entry.origin !== 'auto' && retryReady(entry, now)) forced.add(id);
      }
    }
    // A derived task's description is the artifact's own prose (a PR body),
    // and it exists only to anchor a local review — so it never becomes an
    // issue, not even on an explicit push, which is still a request to
    // publish it to a whole team's tracker.
    const candidates = [...docs.values()].filter((doc) => {
      const id = doc.meta.id;
      if (doc.meta.derivedFrom !== undefined) return false;
      if (named !== null) return named.has(id);
      if (forced.has(id)) return true;
      return (
        !touched.has(id) &&
        isOutstanding(doc.meta.updated, accountedAt(state, id))
      );
    });
    const linked = candidates.filter(
      (d) => parseLinearExternal(d.meta.external) !== null
    );
    const unlinked = candidates.filter(
      (d) => parseLinearExternal(d.meta.external) === null
    );

    // Linked tasks are reconciled against a fresh copy, so a push is a real
    // three-way merge and never a blind overwrite.
    const issueIds = linked.flatMap((d) => {
      const ref = parseLinearExternal(d.meta.external);
      return ref?.entity === 'issue' ? [ref.id] : [];
    });
    if (issueIds.length > 0) {
      const fresh = pass.take(await session.client.issuesByIds(issueIds));
      if (fresh === null) {
        summary.errors.push(
          `skipped ${issueIds.length} issue update(s): their current copy could not be fetched`
        );
      } else {
        const byId = new Map(fresh.map((i) => [i.id, i]));
        await this.learnUsers(run, { issues: fresh });
        for (const doc of linked) {
          const ref = parseLinearExternal(doc.meta.external);
          if (ref?.entity !== 'issue') continue;
          const issue = byId.get(ref.id);
          if (issue === undefined) continue;
          const current = docs.get(doc.meta.id) ?? doc;
          if (!inLinkedTeam(issue, session)) {
            pass.unlinkMoved(
              current,
              issue.id,
              issue.team?.key ?? 'another team'
            );
            continue;
          }
          const asked = named?.has(current.meta.id) === true;
          // A named update that does not land is left outstanding, so the
          // next ordinary pass sends it again.
          if (asked) delete state.pushed[current.meta.id];
          await pass.reconcileIssue(current, issue, {
            mayPull,
            mayPush: true,
            explicit: asked,
          });
        }
      }
    }
    const containers = linked.filter((d) => {
      const entity = parseLinearExternal(d.meta.external)?.entity;
      return entity !== undefined && entity !== 'issue';
    });
    if (containers.length > 0) {
      await this.pushContainers(run, containers, {
        mayPull,
        mayPush: true,
        explicit,
      });
    }

    await this.retryArrivalArchives(run);

    const order = pass.creationOrder(unlinked);
    const bulk = run.bulk;
    const report = (done: number): void => {
      if (bulk === null || bulk.action === 'archive') return;
      this.setProgress({
        phase: 'creating',
        done,
        total: order.length,
        action: bulk.action,
      });
    };
    report(0);
    let attempted = 0;
    for (const doc of order) {
      const current = docs.get(doc.meta.id) ?? doc;
      const id = current.meta.id;
      const asked = explicit || forced.has(id);
      if (!asked && !this.mayAutoCreate(state, current)) {
        holdBack(state, id, current.meta.updated);
        continue;
      }
      // An archived task that never reached Linear stays local.
      if (!asked && current.meta.archivedAt !== undefined) {
        holdBack(state, id, current.meta.updated);
        continue;
      }
      // Left outstanding, or queued, until the pause ends.
      if (paused) continue;
      const archive =
        run.archiveOnArrival.has(id) || state.pushQueue[id]?.archive === true;
      let result: CreateRemoteResult;
      try {
        result = await pass.createRemote(current, { archive });
      } catch (err) {
        // A throttle after the create linked the task: it is no longer held
        // back, so its unsent follow-ups stay outstanding, and its comments
        // wait in the queue for a later pass.
        if (parseLinearExternal(docs.get(id)?.meta.external) !== null) {
          delete state.localOnly?.[id];
          clearPause(state);
          run.comments?.queueAll(id);
        }
        throw err;
      }
      report(++attempted);
      if (result.created) {
        delete state.pushQueue[id];
        delete state.localOnly?.[id];
        clearPause(state);
      } else {
        summary.failedTaskIds.push(id);
        recordAttempt(state, id, result, pass.lastFailureKind, now);
        continue;
      }
      // A task that just got its issue takes its comments along, queued
      // first so a throttle or a failed send leaves them for a later pass.
      const linkedNow = docs.get(id);
      if (
        run.comments !== null &&
        parseLinearExternal(linkedNow?.meta.external)?.entity === 'issue'
      ) {
        run.comments.queueAll(id);
        const retry = await run.comments.push(
          id,
          state.pendingComments[id] ?? []
        );
        if (retry.length > 0) state.pendingComments[id] = retry;
        else delete state.pendingComments[id];
      }
    }

    if (run.comments !== null) {
      for (const [taskId, ids] of Object.entries(state.pendingComments)) {
        const retry = await run.comments.push(taskId, ids);
        if (retry.length > 0) state.pendingComments[taskId] = retry;
        else delete state.pendingComments[taskId];
      }
    }
  }

  // Archives the issues an export meant to land archived whose archive
  // failed then, while each task is still linked to its issue and finished
  // or archived. Stops as archiveClosed does; a refused one goes to the back.
  private async retryArrivalArchives(run: Run): Promise<void> {
    const { pass, state, docs, ctx } = run;
    const pending = state.pendingArchives ?? {};
    let failedInRow = 0;
    for (const [taskId, issueId] of Object.entries(pending)) {
      const doc = docs.get(taskId);
      const ref = parseLinearExternal(doc?.meta.external);
      const wanted =
        doc !== undefined &&
        ref?.entity === 'issue' &&
        ref.id === issueId &&
        (doc.meta.archivedAt !== undefined ||
          isDoneStatus(doc.meta.status, ctx.model));
      if (!wanted || (await pass.archiveOnArrival(taskId, issueId))) {
        if (wanted) failedInRow = 0;
        delete pending[taskId];
        continue;
      }
      delete pending[taskId];
      pending[taskId] = issueId;
      if (
        pass.lastFailureKind === 'auth' ||
        ++failedInRow >= ARCHIVE_FAILURE_RUN
      ) {
        break;
      }
    }
  }

  // Drops queue entries whose task is gone, now derived, or has its record.
  private pruneQueue(
    state: LinearSyncState,
    docs: ReadonlyMap<string, TaskDoc>
  ): void {
    for (const id of Object.keys(state.pushQueue)) {
      const doc = docs.get(id);
      if (
        doc === undefined ||
        doc.meta.derivedFrom !== undefined ||
        parseLinearExternal(doc.meta.external) !== null
      ) {
        delete state.pushQueue[id];
      }
    }
  }

  // Queues every named task still without its record before any create, so
  // one a halt never reaches is retried by later passes.
  private queueNamed(run: Run, named: ReadonlySet<string>, at: string): void {
    const { state, docs } = run;
    const origin = run.bulk?.action === 'export' ? 'export' : 'explicit';
    queueCreates(
      state,
      [...named].map((id) => docs.get(id)?.meta),
      origin,
      run.archiveOnArrival,
      at
    );
  }

  /**
   * Archives the linked teams' closed issues in Linear, then pulls the
   * archive onto the tasks linked to them, as a pull would after an archive
   * made in Linear. Nothing local is pushed.
   */
  private async archiveClosed(
    run: Run,
    includeCanceled: boolean
  ): Promise<void> {
    const { pass, session, ctx, state } = run;
    const types: ('completed' | 'canceled')[] = includeCanceled
      ? ['completed', 'canceled']
      : ['completed'];
    const closed = pass.take(
      await acrossTeams(session.teamIds, (id) =>
        session.client.closedIssues(id, types)
      )
    );
    if (closed === null) return;
    const total = closed.nodes.length;
    run.found = total;
    const archived: LinearIssue[] = [];
    this.setProgress({ phase: 'archiving', done: 0, total, action: 'archive' });
    let failedInRow = 0;
    for (const [i, ref] of closed.nodes.entries()) {
      const issue = pass.take(await session.client.archiveIssue(ref.id));
      if (issue !== null) {
        failedInRow = 0;
        archived.push(issue);
        pass.summary.archivedIssues++;
        // Room under the cap again, so queued creates may go.
        clearPause(state);
      } else if (
        pass.lastFailureKind === 'auth' ||
        ++failedInRow >= ARCHIVE_FAILURE_RUN
      ) {
        pass.recordFailure(
          `stopped archiving after ${i + 1} of ${total}: Linear refused the archive`
        );
        break;
      }
      this.setProgress({
        phase: 'archiving',
        done: i + 1,
        total,
        action: 'archive',
      });
    }
    const mine = archived.filter((i) => ctx.taskByRemote.has(i.id));
    if (mine.length === 0 || !run.mayPull) return;
    const fetched: Fetched = {
      initiatives: [],
      projects: [],
      milestones: [],
      issues: mine,
      comments: [],
    };
    await this.fillReferences(run, fetched);
    await this.learnUsers(run, fetched);
    await this.applyContainers(run, fetched);
    await this.applyIssues(run, fetched.issues);
  }

  private async pushContainers(
    run: Run,
    containers: TaskDoc[],
    mode: ReconcileMode
  ): Promise<void> {
    const { pass, session, docs } = run;
    const { client, teamIds } = session;
    const [projects, milestones, initiatives] = [
      pass.take(await acrossTeams(teamIds, (id) => client.projects(id, null))),
      pass.take(
        await acrossTeams(teamIds, (id) => client.projectMilestones(id, null))
      ),
      pass.take(await client.initiatives(null)),
    ];
    const byId = new Map<string, RemoteRecord>();
    for (const r of [
      ...(projects?.nodes ?? []),
      ...(milestones?.nodes ?? []),
      ...(initiatives?.nodes ?? []),
    ]) {
      byId.set(r.id, r);
    }
    for (const doc of containers) {
      const ref = parseLinearExternal(doc.meta.external);
      const remote = ref === null ? undefined : byId.get(ref.id);
      if (ref === null || remote === undefined) continue;
      const current = docs.get(doc.meta.id) ?? doc;
      if (ref.entity === 'project') {
        await pass.reconcileProject(current, remote as LinearProject, mode);
      } else if (ref.entity === 'milestone') {
        await pass.reconcileMilestone(
          current,
          remote as LinearProjectMilestone,
          mode
        );
      } else if (ref.entity === 'initiative') {
        await pass.reconcileInitiative(
          current,
          remote as LinearInitiative,
          mode
        );
      }
    }
  }

  /**
   * Every so often (and on every import) checks each linked issue is still in
   * a linked team: one moved out of all of them is unlinked, one deleted is
   * archived and unlinked. The same walk refreshes every chip's identifier,
   * which a move between linked teams changes.
   */
  private async audit(run: Run, force: boolean): Promise<void> {
    const { pass, session, state, docs } = run;
    if (!force && !this.auditDue(state)) return;
    const linked = new Map<string, TaskDoc>();
    for (const doc of docs.values()) {
      const ref = parseLinearExternal(doc.meta.external);
      if (ref?.entity === 'issue') linked.set(ref.id, doc);
    }
    if (linked.size === 0) {
      state.lastAuditAt = new Date().toISOString();
      return;
    }
    const refs = pass.take(await issueLinksAcrossTeams(session));
    if (refs === null) return;
    const inTeam = new Set<string>();
    for (const ref of refs) {
      inTeam.add(ref.id);
      if (linked.has(ref.id)) pass.recordLink(ref.id, ref.identifier, ref.url);
    }
    const missing = [...linked.keys()].filter((id) => !inTeam.has(id));
    if (missing.length > 0) {
      const found = pass.take(await session.client.issuesByIds(missing));
      if (found === null) return;
      const byId = new Map(found.map((i) => [i.id, i]));
      for (const id of missing) {
        const doc = docs.get(linked.get(id)?.meta.id ?? '');
        if (doc === undefined) continue;
        const issue = byId.get(id);
        if (issue === undefined) pass.unlinkDeleted(doc);
        else if (!inLinkedTeam(issue, session)) {
          pass.recordLink(issue.id, issue.identifier, issue.url);
          pass.unlinkMoved(doc, id, issue.team?.key ?? 'another team');
        }
      }
    }
    state.lastAuditAt = new Date().toISOString();
  }

  // Whether an unlinked task may be auto-created in Linear. Tasks predating the link
  // are left alone so connecting a tracker does not dump a whole backlog; explicit pushes still do.
  private mayAutoCreate(state: LinearSyncState, doc: TaskDoc): boolean {
    if (state.bootstrappedAt === null) return false;
    return Date.parse(doc.meta.updated) >= Date.parse(state.bootstrappedAt);
  }
}
