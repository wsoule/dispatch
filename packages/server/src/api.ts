import {
  ACCEPTED_KINDS,
  ASSIGNEES,
  canonicalStatus,
  ConfigError,
  CredentialsUnreadableError,
  describeValue,
  EFFORT_LEVELS,
  getSection,
  isDoneStatus,
  isEffortLevel,
  isValidAssignee,
  loadConfig,
  PRIORITIES,
  TaskParseError,
  untrustedFenced,
  updateConfig,
} from '@dispatch/core';
import type {
  CommentStorePort,
  ConfigPatch,
  CreateInput,
  DispatchConfig,
  FixLoopConfig,
  LinearConfig,
  ModelConfig,
  QueueWeights,
  TaskStoreBackend,
  UpdatePatch,
  VerifyConfig,
} from '@dispatch/core';
import type {
  ActorContext,
  EffortLevel,
  TaskDoc,
  TaskStorePort,
} from '@dispatch/core';
import { MemoryBusyError, MemoryError } from '@dispatch/memory';
import type { Sender } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';

import { isA2AClientToken } from './a2a/auth.js';
import type { A2ABridge } from './a2a/bridge.js';
import { handleA2ARoute } from './a2a/routes.js';
import type { AiTaskFilterPort } from './aiTaskFilter.js';
import { aiFilterTasks } from './api/aiFilter.js';
import { amendTask } from './api/amendments.js';
import {
  downloadTaskAttachment,
  listTaskAttachments,
  removeTaskAttachment,
  uploadTaskAttachments,
} from './api/attachments.js';
import {
  clickInBrowser,
  closeBrowser,
  evaluateInBrowser,
  fillInBrowser,
  launchBrowser,
  navigateBrowser,
  readBrowserPick,
  readBrowserText,
  screenshotBrowser,
  startBrowserPick,
} from './api/browser.js';
import { humanActor, humanOperator } from './api/caller.js';
import {
  addComment,
  addLegacyTaskNote,
  deleteComment,
  listComments,
  updateComment,
} from './api/comments.js';
import { fanoutTask } from './api/fanout.js';
import {
  listDirectory,
  rawFile,
  readFile as readWorkspaceFile,
  searchFiles,
  writeFile as writeWorkspaceFile,
} from './api/files.js';
import {
  createFinding,
  listFindings,
  listLedger,
  updateFinding,
} from './api/findings.js';
import {
  adjudicateFinding,
  advanceFixLoop,
  getFixLoop,
  listFixLoops,
  startFixLoop,
  stopFixLoop,
} from './api/fixLoop.js';
import {
  errorResponse,
  jsonResponse,
  jsonTextResponse,
  readJsonBody,
  readJsonBodyOptional,
} from './api/http.js';
import { getImpact } from './api/impact.js';
import { listLabels, putLabelColor } from './api/labels.js';
import {
  legacyMilestoneParent,
  withoutLegacyMilestone,
} from './api/legacyMilestone.js';
import { isLinearWebhook, linearWebhook } from './api/linearWebhook.js';
import { migrateMilestones } from './api/migrations.js';
import { listPeople } from './api/people.js';
import {
  a2aParentRefusal,
  decidingHuman,
  markA2AChild,
  proposalWriteRefusal,
} from './api/proposalFence.js';
import { getQueue } from './api/queue.js';
import { listTaskFindings, startTaskReview } from './api/review.js';
import { listRunClaims } from './api/runClaims.js';
import { createRunEvidence, createRunMutation } from './api/runEvidence.js';
import { storageErrorResponse } from './api/storageErrors.js';
import {
  closeTerminal,
  createTerminal,
  deleteTerminal,
  readTerminalOutput,
  resizeTerminal,
  writeTerminalInput,
} from './api/terminals.js';
import { getTaskVerification, startTaskVerification } from './api/verify.js';
import type { BrowserRegistry } from './browser/registry.js';
import type { TaskCache } from './cache.js';
import type { ConversationStore } from './conversations.js';
import { isSnippet, isSubjectRef } from './conversations.js';
import { checkDaemonIdentity } from './daemonfile.js';
import type { DecisionDisposition, DecisionFeed } from './decisionFeed.js';
import type { DepMapCache } from './depmap.js';
import { handleDocsRoute } from './docs/routes.js';
import type { DocsService } from './docs/service.js';
import type { EventBus } from './events.js';
import type { FindingStorePort } from './findings.js';
import {
  COMMIT_SHA_UNRESOLVED_PREFIX,
  CONFIRM_REQUIRED_ERROR,
  INVALID_REF_ERROR,
  INVALID_REMOTE_ERROR,
  INVALID_STASH_INDEX_ERROR,
  PATH_ESCAPE_ERROR,
  resolveWorktreeFilePath,
} from './git/commands.js';
import type { GitOutcome } from './git/commands.js';
import { GitRepo } from './git/commands.js';
import { CommitMessageGenerator } from './git/commitMessage.js';
import type { GitBranch } from './git/parse.js';
import { expiredTokenMessage, sha256 } from './identity.js';
import type { TokenIdentity, TokenRegistry } from './identity.js';
import type { InboxKind } from './inbox.js';
import { INBOX_KINDS, type InboxStore } from './inbox.js';
import {
  filterGroupsToLocalItems,
  InboxClusterer,
  InboxClusterSnapshotStore,
} from './inboxClusterer.js';
import type { JudgmentClient } from './judgments/client.js';
import {
  InboxTriageSnapshotStore,
  splitCapture,
  untriagedForClustering,
} from './judgments/inboxTriage.js';
import type { InboxTriageScheduler } from './judgments/inboxTriage.js';
import {
  checklistSummary,
  readChecklist,
} from './judgments/landingChecklist.js';
import type { ChecklistSummary } from './judgments/landingChecklist.js';
import { readinessFor, ReadinessStore } from './judgments/readiness.js';
import type { ReadinessReading } from './judgments/readiness.js';
import { buildLandingSnapshot } from './landing.js';
import type { LedgerStorePort } from './ledger.js';
import { HttpLinearClient } from './linear/client.js';
import type { LinearSync } from './linear/sync.js';
import {
  acceptIngestProblemRoute,
  completeLinkRoute,
  deleteMemoryRoute,
  getMemory,
  getProposalRoute,
  importClaudeRoute,
  importLedgerRoute,
  ingestProblemsRoute,
  listMemory,
  listProposalsRoute,
  memoryActionRoute,
  memoryActivityRoute,
  memoryHealthRoute,
  memoryIdentityRoute,
  memoryIndexRoute,
  memoryRecallsRoute,
  saveMemoryRoute,
  searchMemory,
  startLinkRoute,
} from './memory/routes.js';
import type { MemoryService } from './memory/service.js';
import type { Principal } from './messaging/principal.js';
import { resolvePrincipal } from './messaging/principal.js';
import {
  approveAgent,
  getMailbox,
  getMessageById,
  getThreadById,
  joinChannel,
  leaveChannel,
  listAgentRoster,
  listChannels,
  listOpenDecisions,
  listRecentThreads,
  markDeliveryRead,
  muteAgent,
  registerAgent,
  replyToMessage,
  revokeAgent,
  sendMessage,
  unmuteAgent,
  waitForAnswer,
} from './messaging/routes.js';
import type { Messaging } from './messaging/service.js';
import type { Note, NoteKind } from './notes.js';
import { NOTE_KINDS, type NoteStore } from './notes.js';
import { buildAgentSessions } from './orchestrator/agentSessions.js';
import type { EpicEngine } from './orchestrator/epic.js';
import type { FixLoop } from './orchestrator/fixLoop.js';
import type { MergeQueue } from './orchestrator/mergeQueue.js';
import type { Orchestrator } from './orchestrator/orchestrator.js';
import type { OverseerManager } from './orchestrator/overseer.js';
import type { PlanManager } from './orchestrator/plan.js';
import type { PrManager, PrReviewEvent, RepoPr } from './orchestrator/pr.js';
import {
  closedPrReviewMessage,
  forkConfirmMessage,
  parsePrUrl,
} from './orchestrator/pr.js';
import {
  buildPrReviewTask,
  isPrReviewTaskFor,
} from './orchestrator/prReviewTask.js';
import type { PrWorktreeManager } from './orchestrator/prWorktree.js';
import { toLandingWorktree } from './orchestrator/prWorktree.js';
import type { ReviewRunner } from './orchestrator/review.js';
import type { TaskAuthorship } from './orchestrator/taskAuthorship.js';
import {
  OrchestratorClientError,
  OrchestratorConflictError,
  OrchestratorNotFoundError,
  runMessageRefusal,
  TERMINAL_RUN_STATES,
} from './orchestrator/types.js';
import type { RunMeta } from './orchestrator/types.js';
import type { VerificationRunner } from './orchestrator/verify.js';
import type { PresenceTracker } from './presence.js';
import type { PreviewState, PreviewSupervisor } from './preview.js';
import type { PreviewGateway } from './previewGateway.js';
import type { ReceiptsPush, ReceiptsScheduler } from './receipts/scheduler.js';
import {
  formatCommentsForAgent,
  resolveAnchor,
  ReviewCommentStore,
  spliceSuggestion,
} from './reviewComments.js';
import type { AddCommentInput, ReviewComment } from './reviewComments.js';
import type { ReviewTarget } from './reviewTarget.js';
import { redactSecretUrls } from './secretUrls.js';
import {
  clearedSessionCookie,
  sessionCookie,
  sessionToken,
} from './session.js';
import { statusModelFor } from './statuses.js';
import type { SyncResult } from './sync/boardSyncer.js';
import type { BoardSyncScheduler } from './sync/scheduler.js';
import type { BoardSyncService } from './team/boardSync/service.js';
import type { Team } from './team/index.js';
import {
  getLicense,
  installLicense,
  issueTeamToken,
  listTeamTokens,
  revokeTeamToken,
} from './team/routes.js';
import type { TerminalRegistry } from './terminals.js';
import type { AuthTier } from './tiers.js';
import { tierAllows } from './tiers.js';
import type { TrackedFilesCache } from './trackedFiles.js';
import type { WatchdogStatus } from './watchdog.js';

// Everything a request handler needs, bundled so `handleApi` stays a pure
// function of (request, context) instead of reaching for module-level state —
// this is what makes it easy to hit with plain fetch() in tests.
export interface ApiContext {
  rootDir: string;
  // The port, not a concrete TaskStore: this daemon owns whichever backend
  // the project was opened with (markdown files or its SQLite database), and
  // every handler below works the same against either. A handler that needs
  // a path on disk has to narrow to `TaskStore` itself — see
  // Orchestrator.stageTaskFile, the one place that does.
  store: TaskStorePort;
  cache: TaskCache;
  events: EventBus;
  orchestrator: Orchestrator;
  version: string;
  // Phase 5 P1.
  planManager: PlanManager;
  // The project-assistant chat (see orchestrator/overseer.ts) — assembled
  // alongside PlanManager in index.ts against the same shared peers.
  overseerManager: OverseerManager;
  epicEngine: EpicEngine;
  /** Who created and last wrote each task; absent in hand-built test contexts. */
  taskAuthorship?: TaskAuthorship;
  // dispatchd's own messaging engine host — messaging routes read/write
  // through it directly.
  messaging: Messaging;
  // The docs service (docs/service.ts); unavailable when docs.db did not open.
  docs: DocsService;
  /** The memory store and engine (memory/service.ts). */
  memory: MemoryService;
  /** The A2A bridge; absent in hand-built test contexts. */
  a2a?: A2ABridge;
  prManager: PrManager;
  // Task 7: PR review worktrees — cut on demand, kept in sync by
  // PrManager's poll, listed here for GET /api/landing's worktree column.
  prWorktrees: PrWorktreeManager;
  mergeQueue: MergeQueue;
  noteStore: NoteStore;
  inboxStore: InboxStore;
  findingStore: FindingStorePort;
  ledgerStore: LedgerStorePort;
  // Task comments on whichever backend the project uses; absent (a test
  // context) falls back to the file store.
  commentStore?: CommentStorePort;
  reviewRunner: ReviewRunner;
  verificationRunner: VerificationRunner;
  fixLoop: FixLoop;
  // Shared with ReviewRunner (see index.ts) so a burst of impact/review
  // requests reuses one dependency scan instead of each paying for its own.
  depMapCache: DepMapCache;
  // The tracked-file list behind a task-subject impact query; memoized the
  // same way (see index.ts's wiring for its invalidation signal).
  trackedFilesCache: TrackedFilesCache;
  inboxClusterer?: InboxClusterer;
  // The sentence-to-filter-clauses port behind POST /api/tasks/filter/ai;
  // absent means the Claude-backed one is built per request.
  aiTaskFilter?: AiTaskFilterPort;
  // The TypeSafe judgment client, or null when no key is configured — every
  // consumer falls back to its pre-judgment behaviour on null.
  judgments: JudgmentClient | null;
  // Keeps `.dispatch/inbox-triage.json` current in the background: pinged on
  // every capture and text edit, so a row is judged moments after it lands.
  inboxTriage: InboxTriageScheduler;
  reviewComments: ReviewCommentStore;
  conversations: ConversationStore;
  // The one feed of everything awaiting a human — see decisionFeed.ts.
  decisionFeed: DecisionFeed;
  linearSync: LinearSync;
  // Cached once at boot (see pr.ts's detectPrCapability) — exposed at
  // GET /api/health as `pr` so a client can hide/disable the PR action
  // without probing per-run.
  prCapability: boolean;
  // When this daemon process started, captured once in startServer — the
  // same value the daemon file records, surfaced at GET /api/health so a
  // client can tell which process is answering.
  startedAt: string;
  // Shell sessions the desktop attaches to — see terminals.ts. Owned by the
  // daemon rather than the app so a session survives the window closing, and
  // so its scrollback is written once, in one place.
  // Chromium instances the daemon drives — see browser/registry.ts. Owned
  // here so a browser opened on a dev server outlives the app window, and so
  // shutdown has something to kill.
  browsers: BrowserRegistry;
  terminals: TerminalRegistry;
  // The Git page's backend — see packages/server/src/git/commands.ts.
  gitRepo: GitRepo;
  // The two tokens this daemon accepts — see DaemonTokens.
  tokens: DaemonTokens;
  // Test-injection seam only, same as `inboxClusterer` above.
  commitMessageGenerator?: CommitMessageGenerator;
  // Who this daemon acts as, resolved once at boot from git config.
  actorContext: ActorContext;
  // The file backend's board syncer (it commits task files to the main
  // branch while autoCommit is on), or `null` on the database backend or when
  // no trunk was resolvable at boot (see index.ts) — GET /api/sync synthesizes
  // a `disabled` status in that case, since no real SyncResult reports it.
  boardSyncScheduler: BoardSyncScheduler | null;
  // Which backend this project's state lives in. GET /api/sync needs it to
  // tell the two reasons `boardSyncScheduler` is null apart: no trunk (a
  // setup problem worth warning about) versus a database-backed project
  // (which has no task files to sync and is not broken at all).
  storeBackend: TaskStoreBackend;
  // The receipts exporter's scheduler, or `null` on the file backend, whose
  // task files the board syncer commits to the main branch instead.
  receiptsScheduler: ReceiptsScheduler | null;
  // Whether `dispatch merge-task` actually resolves on this daemon's PATH.
  // Surfaced at GET /api/sync as `mergeDriverWarning` so a broken setup is
  // visible somewhere, since git itself never reports it as an error.
  //
  // A function, not a boolean: the fix ("run `dispatch init`") happens in a
  // terminal, so a value snapshotted at boot keeps telling the user to run a
  // command they already ran successfully. See index.ts.
  mergeDriverOk: () => boolean;
  // Whether this daemon wrote the per-root daemon file at boot (index.ts's
  // `writeDaemonFile` option). GET /api/health checks that file on every
  // probe to notice when another daemon has overwritten or removed it — a
  // daemon that never claimed one has nothing to be displaced from.
  claimsDaemonFile: boolean;
  // The event-loop watchdog's state, read per probe. `failed` is the one to
  // watch for: a compiled daemon whose worker module was left out of the
  // build boots fine and reports that here, and nowhere else.
  watchdogStatus: () => WatchdogStatus;
  // Per-run dev-server previews. Held by the daemon rather than the
  // orchestrator because its lifetime is the daemon's, not any one run's:
  // the idle sweep and the shutdown stop belong to the process that owns the
  // port allocations.
  previews: PreviewSupervisor;
  /** Teammates' way into previews, in team-local mode; null on loopback. */
  previewGateway: PreviewGateway | null;
  /** Board sync between replicas (team/boardSync/); null when it is off. */
  boardSync: BoardSyncService | null;
  /** Teammates' credentials and the license that says how many people may
   *  use this project together — team/, under the Elastic License 2.0. */
  team: Team;
  /** Who is connected right now; see presence.ts. */
  presence: PresenceTracker;
  /** The daemon's own network origins in team-local mode, empty otherwise.
   *  The same Set instance the HTTP layer fills once the port is bound. */
  ownOrigins: ReadonlySet<string>;
  /** Origins a session cookie is honoured from — ownOrigins plus this
   *  daemon's own loopback origin. See session.ts. */
  sessionOrigins: ReadonlySet<string>;
  /** Whether this daemon is bound beyond loopback — see shared.ts. */
  shared: boolean;
  /** Who made the request being handled, when their credential resolved.
   *  Set per request by handleApi — never on the daemon-wide context. */
  caller?: TokenIdentity;
  /** True when the request presented the shared agentToken: `caller` names
   *  the owner, but no human is behind it. Set per request by handleApi. */
  viaAgentToken?: boolean;
  /** True when the request presented the owner's app token. Set per request
   *  by handleApi. */
  ownerCredential?: boolean;
  /** The messaging caller (run, agent or human) handleApi resolved; messaging
   *  handlers read this, never `caller`. */
  principal?: Principal;
}

// Mirrors the CLI's own enum check (packages/cli/src/commands/task.ts
// `validate`), including its exact message shape, without importing across
// the cli/server package boundary — cli is the one that depends on server
// for `dispatch serve`, not the other way around, and this check is small
// enough that duplicating it beats introducing a dependency edge for it.
// Used for status (against the project's configured list), kind, priority,
// and assignee (against core's fixed enums) — `undefined` means the field
// was omitted, which every caller here treats as "no change requested."
function validateEnumField(
  value: unknown,
  allowed: readonly string[],
  label: string
): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string' || !allowed.includes(value)) {
    return `invalid ${label}: ${describeValue(value)} (expected ${allowed.join('|')})`;
  }
  return null;
}

// Validates that an optional field, if present, is an array of strings —
// used for `labels` and `blockedBy`, both of which core's TaskParseError
// would otherwise only catch after the bad value had already been written to
// a task file (see taskfile.ts's matching `invalid ${key}: expected a list of
// strings`, which this mirrors).
function validateStringArrayField(
  value: unknown,
  label: string
): string | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || !value.every((v) => typeof v === 'string')) {
    return `invalid ${label}: expected a list of strings`;
  }
  return null;
}

// Validates that an optional field, if present, is a string — used for the
// free-text body sections (description, acceptanceCriteria) that flow through
// to the markdown body rather than the frontmatter.
function validateStringField(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'string') {
    return `invalid ${label}: expected a string`;
  }
  return null;
}

// Validates that an optional field, if present, is a boolean — used for
// `selfReview`, mirroring core's taskfile.ts `self-review` boolean check so a
// bad value is rejected here rather than only after it's already written.
function validateBooleanField(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  if (typeof value !== 'boolean') {
    return `invalid ${label}: expected a boolean`;
  }
  return null;
}

// Validates that an optional field, if present, is a string or null — used
// for `archivedAt` (a string sets it, null clears it), rejecting bad values
// here rather than letting them corrupt the task's YAML frontmatter.
function validateStringOrNullField(
  value: unknown,
  label: string
): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') {
    return `invalid ${label}: expected a string or null`;
  }
  return null;
}

// The Linear-parity fields (see TaskMeta): nullable scalars, string lists,
// and the cycle object. `creator` is create-only in spirit but harmless here.
function validateLinearFields(value: Record<string, unknown>): string | null {
  for (const key of [
    'dueDate',
    'startDate',
    'duplicateOf',
    'color',
    'icon',
  ] as const) {
    const error = validateStringOrNullField(value[key], key);
    if (error) return error;
  }
  for (const key of ['relatedTo', 'initiatives'] as const) {
    const error = validateStringArrayField(value[key], key);
    if (error) return error;
  }
  const { creator, cycle } = value;
  for (const key of ['estimate', 'sortOrder'] as const) {
    const n = value[key];
    if (
      n !== undefined &&
      n !== null &&
      (typeof n !== 'number' || !Number.isFinite(n))
    ) {
      return `invalid ${key}: expected a number or null`;
    }
  }
  if (
    creator !== undefined &&
    creator !== null &&
    (typeof creator !== 'string' || !isValidAssignee(creator))
  ) {
    return 'invalid creator: expected an actor ref or null';
  }
  if (cycle !== undefined && cycle !== null) {
    const c = cycle as Record<string, unknown>;
    if (
      typeof cycle !== 'object' ||
      typeof c.id !== 'string' ||
      typeof c.number !== 'number' ||
      typeof c.startsAt !== 'string' ||
      typeof c.endsAt !== 'string' ||
      (c.name !== undefined && c.name !== null && typeof c.name !== 'string')
    ) {
      return 'invalid cycle: expected { id, number, name, startsAt, endsAt } or null';
    }
  }
  return null;
}

// Validates every field createTask/updateTask accept beyond title, entirely
// before either one touches the store — a request that fails here writes no
// file. `includeKind` is create-only: UpdatePatch has no `kind` field, since
// a task's kind is fixed at creation. `includeBody` is update-only for the
// mirror-image reason: CreateInput builds its body from the template.
function validateTaskFields(
  value: Record<string, unknown>,
  config: DispatchConfig,
  { includeKind, includeBody }: { includeKind: boolean; includeBody: boolean }
): string | null {
  if (includeKind) {
    // ACCEPTED_KINDS keeps the legacy `epic` valid; the store reads it as a
    // milestone.
    const kindError = validateEnumField(value.kind, ACCEPTED_KINDS, 'kind');
    if (kindError) return kindError;
  }
  if (includeBody) {
    // Same reason as the section fields above: normalizeBody trims the value
    // before storing it, so a non-string reaches `.trim()` and 500s instead of
    // being reported as the bad request it is.
    const bodyError = validateStringField(value.body, 'body');
    if (bodyError) return bodyError;
  } else if (value.body !== undefined) {
    // Rejected rather than ignored: `body` is a real field on PATCH, so a
    // caller sending it to POST is assuming a symmetry that doesn't exist and
    // would otherwise get the template back with their text silently dropped.
    return 'invalid body: a new task builds its body from the template — set it with PATCH instead';
  }
  // Canonicalized before the membership check so callers speaking the
  // pre-rename names ('done', 'in-progress', …) stay valid forever — the
  // store canonicalizes again at write, so the alias never reaches disk.
  const statusError = validateEnumField(
    typeof value.status === 'string'
      ? canonicalStatus(value.status)
      : value.status,
    config.statuses,
    'status'
  );
  if (statusError) return statusError;
  const priorityError = validateEnumField(
    value.priority,
    PRIORITIES,
    'priority'
  );
  if (priorityError) return priorityError;
  const assigneeError = validateEnumField(
    value.assignee,
    ASSIGNEES,
    'assignee'
  );
  if (assigneeError) return assigneeError;
  const parentError = validateStringOrNullField(value.parent, 'parent');
  if (parentError) return parentError;
  const labelsError = validateStringArrayField(value.labels, 'labels');
  if (labelsError) return labelsError;
  const blockedByError = validateStringArrayField(value.blockedBy, 'blockedBy');
  if (blockedByError) return blockedByError;
  const selfReviewError = validateBooleanField(value.selfReview, 'selfReview');
  if (selfReviewError) return selfReviewError;
  const fixLoopError = validateBooleanField(value.fixLoop, 'fixLoop');
  if (fixLoopError) return fixLoopError;
  const archivedAtError = validateStringOrNullField(
    value.archivedAt,
    'archivedAt'
  );
  if (archivedAtError) return archivedAtError;
  const linearFieldsError = validateLinearFields(value);
  if (linearFieldsError) return linearFieldsError;
  // Free-text body sections — validated as optional strings before they reach
  // setSection, which would otherwise `.trim()` a non-string and throw.
  const descriptionError = validateStringField(
    value.description,
    'description'
  );
  if (descriptionError) return descriptionError;
  const acceptanceError = validateStringField(
    value.acceptanceCriteria,
    'acceptanceCriteria'
  );
  if (acceptanceError) return acceptanceError;
  // Rejected outright rather than validated: `derivedFrom` says the server
  // synthesized this task from an external artifact (see TaskMeta), which no
  // request can make true of a task a client is asking it to write.
  if (value.derivedFrom !== undefined) {
    return 'invalid derivedFrom: only the server sets it, when it synthesizes a task';
  }
  // Likewise `attachments`: the list names files under .dispatch/attachments,
  // and only the upload/delete routes that write those files may change it.
  if (value.attachments !== undefined) {
    return 'invalid attachments: only the attachment routes set it';
  }
  return null;
}

// The title and field checks POST /api/tasks runs, shared with A2A handoffs.
export function validateTaskInput(
  rootDir: string,
  input: Record<string, unknown>
): string | null {
  if (typeof input.title !== 'string' || input.title.trim() === '')
    return 'invalid title: title is required';
  return validateTaskFields(input, loadConfig(rootDir), {
    includeKind: true,
    includeBody: false,
  });
}

// Creates a task as POST /api/tasks does: checked, a legacy `milestone`
// resolved to a parent, stored, cached and broadcast as task.changed.
export function createTaskChecked(
  ctx: Pick<ApiContext, 'rootDir' | 'store' | 'cache' | 'events'> &
    Partial<Pick<ApiContext, 'a2a'>>,
  input: CreateInput
): { ok: true; doc: TaskDoc } | { ok: false; error: string } {
  const error = validateTaskInput(ctx.rootDir, { ...input });
  if (error !== null) return { ok: false, error };
  const legacy = legacyMilestoneParent(
    ctx,
    { ...input } as Record<string, unknown>,
    input.kind ?? 'task'
  );
  if (!legacy.ok) return { ok: false, error: legacy.error };
  const doc = ctx.store.create({
    ...withoutLegacyMilestone(input),
    ...(legacy.parent === undefined ? {} : { parent: legacy.parent }),
    // Omitted, a task starts in the project's ready role.
    status: input.status ?? statusModelFor(ctx.rootDir).roles.ready,
  });
  markA2AChild(ctx, doc.meta.id, doc.meta.parent);
  ctx.cache.refresh(ctx.store, [doc.meta.id]);
  ctx.events.broadcast({ type: 'task.changed', ids: [doc.meta.id] });
  return { ok: true, doc };
}

async function createTask(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const input = parsed.value as CreateInput;
  const refused = a2aParentRefusal(ctx, input.parent);
  if (refused !== null) return refused;
  // Credit whoever made the request unless the caller names a creator (a
  // sync importing someone else's issue).
  const created = createTaskChecked(ctx, {
    ...input,
    creator: input.creator ?? humanActor(ctx),
  });
  if (!created.ok) return errorResponse(400, created.error);
  // A task imported on someone else's behalf is not the caller's writing.
  ctx.taskAuthorship?.created(
    created.doc,
    input.creator === undefined || input.creator === humanActor(ctx)
      ? humanOperator(ctx)
      : null
  );
  return jsonResponse(created.doc, 201);
}

// POST /api/tasks/draft — starts a background planner turn and returns the
// DraftRecord immediately (202); `planner` follows createRun's `executor` contract.
async function draftTask(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    prompt?: unknown;
    planner?: unknown;
    parent?: unknown;
  };
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    return errorResponse(400, 'invalid prompt: prompt is required');
  }
  // The container a "+" started this draft in, checked now so a stale id
  // fails here rather than at save.
  const parent = body.parent ?? null;
  if (parent !== null && typeof parent !== 'string') {
    return errorResponse(400, 'invalid parent: expected a task id or null');
  }
  if (parent !== null && ctx.cache.get(parent) === null) {
    return errorResponse(400, `invalid parent: no task ${parent}`);
  }
  const knownPlannerNames = ctx.planManager.registeredPlannerNames();
  if (
    body.planner !== undefined &&
    (typeof body.planner !== 'string' ||
      !knownPlannerNames.includes(body.planner))
  ) {
    return errorResponse(
      400,
      `invalid planner: ${describeValue(body.planner)} (expected ${knownPlannerNames.join('|')})`
    );
  }
  const plannerName =
    typeof body.planner === 'string' ? body.planner : 'claude';
  const draft = ctx.planManager.startDraft(body.prompt, plannerName, parent);
  return jsonResponse(draft, 202);
}

// GET /api/tasks/drafts — every draft currently held in memory (running,
// ready, or failed — until dismissed), newest first.
function listDrafts(ctx: ApiContext): Response {
  return jsonResponse(ctx.planManager.listDrafts());
}

// GET /api/tasks/drafts/:id — one draft record, 404 for an unknown id (via
// handleApi's outer OrchestratorNotFoundError catch).
function getDraft(ctx: ApiContext, id: string): Response {
  return jsonResponse(ctx.planManager.getDraft(id));
}

// DELETE /api/tasks/drafts/:id — dismisses a draft; getDraft() below 404s
// an unknown id before dismissDraft runs.
function dismissDraft(ctx: ApiContext, id: string): Response {
  ctx.planManager.getDraft(id);
  ctx.planManager.dismissDraft(id);
  return jsonResponse({ ok: true });
}

// POST /api/tasks/drafts/:id/message — mirrors sendPlanMessage's shape for a draft.
async function sendDraftMessage(
  req: Request,
  ctx: ApiContext,
  draftId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const record = ctx.planManager.sendDraftMessage(draftId, body.text);
  return jsonResponse(record, 202);
}

async function updateTask(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const existing = ctx.store.get(id);
  if (existing === null) {
    return errorResponse(404, `task not found: ${id}`);
  }

  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const requested = parsed.value as UpdatePatch;
  const config = loadConfig(ctx.rootDir);
  const fieldsError = validateTaskFields(
    parsed.value as Record<string, unknown>,
    config,
    { includeKind: false, includeBody: true }
  );
  if (fieldsError) return errorResponse(400, fieldsError);
  const legacy = legacyMilestoneParent(
    ctx,
    parsed.value as Record<string, unknown>,
    requested.kind ?? existing.meta.kind
  );
  if (!legacy.ok) return errorResponse(400, legacy.error);
  const patch: UpdatePatch = {
    ...withoutLegacyMilestone(requested),
    ...(legacy.parent === undefined ? {} : { parent: legacy.parent }),
  };

  // A gated A2A draft moves only through its gate; a decide-tier status
  // change answers it.
  if (ctx.a2a !== undefined) {
    const caller = ctx.caller ?? {
      tier: 'request' as const,
      ref: humanActor(ctx),
    };
    const guard = await ctx.a2a.guardTaskPatch(id, patch, {
      tier: decidingHuman(ctx) ? caller.tier : 'request',
      ref: caller.ref,
    });
    if (!guard.ok) return errorResponse(guard.status, guard.error);
  }

  // Moving a task under an A2A task makes it one: a decider's call.
  if (patch.parent !== undefined && patch.parent !== existing.meta.parent) {
    const refused = a2aParentRefusal(ctx, patch.parent);
    if (refused !== null) return refused;
  }

  // A publish task's elevated risk is what keeps a human on its merge, so only
  // decide tier (never the shared agent token) may change it while it publishes.
  if (
    patch.risk !== undefined &&
    patch.risk !== existing.meta.risk &&
    ctx.docs.publishing(id) &&
    !decidingHuman(ctx)
  ) {
    return errorResponse(
      403,
      `${id} is publishing a doc; changing its risk needs the decide tier`
    );
  }

  // PATCH /api/tasks/:id is only ever reached by a human — the web/desktop
  // task drawer, or a direct API call — so any Activity line it appends is
  // credited to the human whose credential made the call, never whatever the
  // client sent (an untrusted body must not be able to forge attribution).
  if (typeof patch.appendActivity === 'string' && patch.appendActivity !== '') {
    patch.activityActor = humanActor(ctx);
  }

  const doc = ctx.store.update(id, patch);
  markA2AChild(ctx, id, doc.meta.parent);
  ctx.taskAuthorship?.edited(existing, doc, humanOperator(ctx));
  ctx.cache.refresh(ctx.store, [id]);
  ctx.events.broadcast({ type: 'task.changed', ids: [id] });
  return jsonResponse(doc);
}

// POST /api/tasks/:id/runs — dispatches a new orchestrator run for the task.
// `executor` is optional (defaults to 'claude'); a name outside what's
// actually registered on this Orchestrator instance (M6: derived live via
// `registeredExecutorNames()`, not a separately hardcoded list) is a 400
// here.
//
// A task whose most recent run failed with its worktree and branch intact is
// RESUMED rather than started over (see Orchestrator.resumableRunForTask).
// Losing a nearly-finished run because a re-dispatch quietly began again from
// nothing is the expensive mistake; resuming when the caller wanted a clean
// slate costs one discard. So resume is the default and `fresh: true` opts out.
//
// A resume keeps the failed run's own model, so a `model` sent alongside one is
// not applied — handing the rest of a conversation to a different model is what
// requestChanges' `model` comment exists to prevent. A caller that specifically
// wants a different model wants `fresh: true`.
async function createRun(
  req: Request,
  ctx: ApiContext,
  taskId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const executorField = parsed.value.executor;
  const knownExecutorNames = ctx.orchestrator.registeredExecutorNames();
  if (
    executorField !== undefined &&
    (typeof executorField !== 'string' ||
      !knownExecutorNames.includes(executorField))
  ) {
    return errorResponse(
      400,
      `invalid executor: ${describeValue(executorField)} (expected ${knownExecutorNames.join('|')})`
    );
  }

  // M1: a task that's already closed out (done/cancelled) is almost
  // certainly a stale UI action, not a genuine request to redo the work —
  // refuse it outright rather than quietly starting a new run against a
  // task nobody expects to still be moving. `null` (task not found) falls
  // through to orchestrator.dispatch()'s own 404 below.
  const task = ctx.store.get(taskId);
  if (
    task !== null &&
    isDoneStatus(task.meta.status, statusModelFor(ctx.rootDir))
  ) {
    return errorResponse(409, `cannot dispatch a ${task.meta.status} task`);
  }

  const modelField = parsed.value.model;
  if (modelField !== undefined && typeof modelField !== 'string') {
    return errorResponse(400, 'invalid model: expected a string');
  }

  const effort = readOptionalEffort(parsed.value.effort);
  if (!effort.ok) return effort.response;

  const freshField = parsed.value.fresh;
  if (freshField !== undefined && typeof freshField !== 'boolean') {
    return errorResponse(400, 'invalid fresh: expected a boolean');
  }
  // Named vs defaulted is the whole distinction dispatchOrResume turns on, so
  // the raw fields go through untouched; the orchestrator resolves the
  // executor's own default model for a fresh run.
  const meta = await ctx.orchestrator.dispatchOrResume(taskId, {
    executor: typeof executorField === 'string' ? executorField : undefined,
    model: typeof modelField === 'string' ? modelField : undefined,
    effort: effort.effort,
    fresh: freshField === true,
    // Whoever pressed dispatch, so the run — and its claims, and the
    // decisions it later parks on — is theirs rather than the operator's.
    actor: humanActor(ctx),
    // Who the run acts for: the credential's own human (the owner only on
    // the app token), never the shared agentToken.
    operator: humanOperator(ctx),
  });
  return jsonResponse(meta, 201);
}

/**
 * The one run-preview endpoint, three methods.
 *
 * GET reports what the daemon is holding for this run and never starts
 * anything, so a UI can poll it without side effects. POST is the only thing
 * that starts a dev server, and it is deliberately the reviewer opening the
 * pane rather than the run finishing: a dev server per finished run would
 * install and boot checkouts nobody asked to look at.
 *
 * A refusal ("this repo has no dev script", "previews are off") comes back
 * 200 with a reason rather than as an error. It is an ordinary fact about a
 * repo, and a surface should render it as an empty state, not a failure.
 */
async function handleRunPreview(
  req: Request,
  ctx: ApiContext,
  runId: string,
  method: string
): Promise<Response> {
  // In team-local mode a ready preview also carries `remoteUrl`, the signed
  // link a teammate's app frames (previewGateway.ts). Built from the host the
  // caller reached the daemon by, so it works from where they are; access
  // rests on the signature in it, never on that host.
  const withRemote = (preview: PreviewState | null) => {
    if (preview === null || ctx.previewGateway === null) return preview;
    const remoteUrl = ctx.previewGateway.link(runId, new URL(req.url).hostname);
    return remoteUrl === null ? preview : { ...preview, remoteUrl };
  };
  if (method === 'GET') {
    return jsonResponse({
      preview: withRemote(ctx.previews.get(runId) ?? null),
    });
  }
  if (method === 'DELETE') {
    ctx.previews.stop(runId);
    return jsonResponse({ ok: true });
  }
  if (method !== 'POST') {
    return errorResponse(405, `method not allowed: ${method}`);
  }
  const run = ctx.orchestrator.getRun(runId);
  if (run === null) return errorResponse(404, `run not found: ${runId}`);

  const result = await ctx.previews.ensure(runId, run.meta.worktreePath);
  if (!result.ok) {
    return jsonResponse({ preview: null, reason: result.refusal.reason });
  }
  return jsonResponse({ preview: withRemote(result.preview) });
}

// Phase 5 P1: `action: 'pr'` is routed to PrManager.openPr rather than
// Orchestrator.review — pushing a branch and opening a GitHub PR is a
// different kind of "review" than the local merge/discard actions
// Orchestrator itself owns, and keeping it in its own module is what lets
// tests inject a stubbed gh/git CommandRunner (see pr.ts) without pulling
// that seam into Orchestrator's own constructor.
async function reviewRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { action?: unknown };
  if (
    typeof body.action !== 'string' ||
    (body.action !== 'merge' &&
      body.action !== 'discard' &&
      body.action !== 'pr')
  ) {
    return errorResponse(
      400,
      `invalid action: ${String(body.action)} (expected merge|discard|pr)`
    );
  }
  if (body.action === 'pr') {
    const meta = await ctx.prManager.openPr(runId);
    return jsonResponse(meta);
  }
  const meta = ctx.orchestrator.review(runId, body.action);
  return jsonResponse(meta);
}

/**
 * PATCH /api/config — change the settings a person is allowed to change.
 *
 * Deliberately a narrow allow-list rather than a general config write. `statuses` in particular
 * is structural: every task on disk carries one, so editing the list from a settings form would
 * orphan tasks whose status no longer exists. Anything not in ConfigPatch has to be edited in
 * the file, where the consequences are visible.
 */
// The config keys that make the daemon run a command, or send the project's
// data somewhere, named as a patch would carry them. Changing one is acting on
// the host as its owner — the operator tier — however harmless the rest of a
// settings page is: a request-tier caller able to set verifyCommand or
// receipts.repo could run what it liked, or copy the audit log off the
// machine.
//
// Git pushes are covered whole — whether the daemon pushes at all, and to
// which remote, repo and branch — because they run on the owner's own git
// credentials, which nobody handed to Dispatch: the authority POST
// /api/git/push already reserves. autoCommit pushes to origin's main branch
// and sync defaults to origin, so switching either on picks a destination
// nobody chose; receipts.enabled is also the audit trail, which the tier whose
// decisions it records must not switch off. Integrations that run on a
// credential the owner did hand over (the Linear key, the webhook) gate only
// that credential; what flows over it stays policy.
function operatorOnlyKeys(body: Record<string, unknown>): string[] {
  const keys: string[] = [];
  const has = (obj: unknown, field: string) =>
    typeof obj === 'object' && obj !== null && field in obj;
  if ('verifyCommand' in body) keys.push('verifyCommand');
  if ('verifySteps' in body) keys.push('verifySteps');
  if (has(body.verify, 'command')) keys.push('verify.command');
  if ('remotes' in body) keys.push('remotes');
  if ('prWorktreeDir' in body) keys.push('prWorktreeDir');
  if ('autoCommit' in body) keys.push('autoCommit');
  if (has(body.notifications, 'webhook')) keys.push('notifications.webhook');
  for (const field of ['command', 'installCommand']) {
    if (has(body.preview, field)) keys.push(`preview.${field}`);
  }
  for (const field of ['enabled', 'remote', 'repo', 'branch', 'dir']) {
    if (has(body.receipts, field)) keys.push(`receipts.${field}`);
  }
  for (const field of ['enabled', 'remote', 'repo', 'branch']) {
    if (has(body.sync, field)) keys.push(`sync.${field}`);
  }
  if (typeof body.executors === 'object' && body.executors !== null) {
    for (const [name, entry] of Object.entries(body.executors)) {
      if (entry === null || has(entry, 'command')) {
        keys.push(`executors.${name}.command`);
      }
    }
  }
  return keys;
}

// An object-valued patch field, or the 400 to answer with.
function objectField(
  body: Record<string, unknown>,
  key: string
): { ok: true; value: Record<string, unknown> } | { ok: false; res: Response } {
  const value = body[key];
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { ok: false, res: errorResponse(400, `${key} must be an object`) };
  }
  return { ok: true, value: value as Record<string, unknown> };
}

async function patchConfig(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as Record<string, unknown>;

  const needsOperator = operatorOnlyKeys(body);
  if (
    needsOperator.length > 0 &&
    !tierAllows(ctx.caller?.tier ?? 'request', 'operator')
  ) {
    return authErrorResponse(
      403,
      `changing ${needsOperator.join(', ')} needs the operator tier: they run commands on this machine or send its data elsewhere. Ask whoever runs this daemon.`,
      'auth_insufficient_tier'
    );
  }

  const patch: ConfigPatch = {};
  if ('verifyCommand' in body) {
    const v = body.verifyCommand;
    if (v !== null && typeof v !== 'string') {
      return errorResponse(400, 'verifyCommand must be a string or null');
    }
    patch.verifyCommand = v;
  }
  if ('autoCommit' in body) {
    if (typeof body.autoCommit !== 'boolean') {
      return errorResponse(400, 'autoCommit must be a boolean');
    }
    patch.autoCommit = body.autoCommit;
  }
  for (const key of [
    'epicConcurrency',
    'verifyTimeoutSec',
    'maxConcurrency',
    'runCostEstimateUsd',
  ] as const) {
    if (!(key in body)) continue;
    if (typeof body[key] !== 'number') {
      return errorResponse(400, `${key} must be a number`);
    }
    patch[key] = body[key];
  }
  // `null` clears the cap, so these can't join the number-only loop above.
  // Range checking (positive, finite) is core's job — its ConfigError becomes
  // the 400 below, so it isn't duplicated here.
  for (const key of ['maxTurns', 'maxBudgetUsd'] as const) {
    if (!(key in body)) continue;
    const value = body[key];
    if (value !== null && typeof value !== 'number') {
      return errorResponse(400, `${key} must be a number or null`);
    }
    patch[key] = value;
  }
  if ('permissionMode' in body) {
    if (typeof body.permissionMode !== 'string') {
      return errorResponse(400, 'permissionMode must be a string');
    }
    // The valid set lives in core, next to the parser that enforces it — duplicating it here
    // would be a second list to keep in step. updateConfig rejects an unknown one before it
    // writes anything, and that ConfigError becomes the 400 below.
    patch.permissionMode = body.permissionMode;
  }
  if ('models' in body) {
    if (
      typeof body.models !== 'object' ||
      body.models === null ||
      Array.isArray(body.models)
    ) {
      return errorResponse(400, 'models must be an object');
    }
    // Like permissionMode: core's updateConfig rejects an unknown role or bad
    // value before writing, and that ConfigError becomes the 400 below.
    patch.models = body.models as Partial<ModelConfig>;
  }
  if ('effort' in body) {
    if (
      typeof body.effort !== 'object' ||
      body.effort === null ||
      Array.isArray(body.effort)
    ) {
      return errorResponse(400, 'effort must be an object');
    }
    // Same deal as models: core validates each role and level before writing.
    patch.effort = body.effort as NonNullable<ConfigPatch['effort']>;
  }
  if ('executor' in body) {
    if (typeof body.executor !== 'string') {
      return errorResponse(400, 'executor must be a string');
    }
    patch.executor = body.executor;
  }
  if ('executors' in body) {
    if (
      typeof body.executors !== 'object' ||
      body.executors === null ||
      Array.isArray(body.executors)
    ) {
      return errorResponse(400, 'executors must be an object');
    }
    // Like models: core's updateConfig validates each role before writing.
    patch.executors = body.executors as NonNullable<ConfigPatch['executors']>;
  }
  if ('linear' in body) {
    if (
      typeof body.linear !== 'object' ||
      body.linear === null ||
      Array.isArray(body.linear)
    ) {
      return errorResponse(400, 'linear must be an object');
    }
    if ('apiKey' in (body.linear as Record<string, unknown>)) {
      return errorResponse(
        400,
        'the Linear API key is set through POST /api/linear/connect, not config'
      );
    }
    // Same deal as models: core validates each field before writing, and that
    // ConfigError becomes the 400 below.
    patch.linear = body.linear as Partial<LinearConfig>;
  }
  if ('fixLoop' in body) {
    if (
      typeof body.fixLoop !== 'object' ||
      body.fixLoop === null ||
      Array.isArray(body.fixLoop)
    ) {
      return errorResponse(400, 'fixLoop must be an object');
    }
    // Same deal as models/linear: core validates cap/escalation before
    // writing, and that ConfigError becomes the 400 below.
    patch.fixLoop = body.fixLoop as Partial<FixLoopConfig>;
  }
  if ('verify' in body) {
    if (
      typeof body.verify !== 'object' ||
      body.verify === null ||
      Array.isArray(body.verify)
    ) {
      return errorResponse(400, 'verify must be an object');
    }
    // Same deal as models/linear: core validates each field before writing,
    // and that ConfigError becomes the 400 below.
    patch.verify = body.verify as Partial<VerifyConfig>;
  }
  if ('notifications' in body) {
    if (
      typeof body.notifications !== 'object' ||
      body.notifications === null ||
      Array.isArray(body.notifications)
    ) {
      return errorResponse(400, 'notifications must be an object');
    }
    // Same deal again: core rejects an unknown kind or a non-http(s) webhook
    // before writing, and that ConfigError becomes the 400 below.
    patch.notifications = body.notifications as ConfigPatch['notifications'];
  }
  if ('queue' in body) {
    if (
      typeof body.queue !== 'object' ||
      body.queue === null ||
      Array.isArray(body.queue)
    ) {
      return errorResponse(400, 'queue must be an object');
    }
    const { weights } = body.queue as Record<string, unknown>;
    if (weights !== undefined) {
      if (
        typeof weights !== 'object' ||
        weights === null ||
        Array.isArray(weights)
      ) {
        return errorResponse(400, 'queue.weights must be an object');
      }
      // Same deal as models/linear: core validates each factor and weight
      // before writing, and that ConfigError becomes the 400 below.
      patch.queue = { weights: weights as Partial<QueueWeights> };
    }
  }
  if ('policy' in body) {
    if (
      typeof body.policy !== 'object' ||
      body.policy === null ||
      Array.isArray(body.policy)
    ) {
      return errorResponse(400, 'policy must be an object');
    }
    // Same deal as models/linear: core validates the rung and each gate pin
    // before writing, and that ConfigError becomes the 400 below.
    patch.policy = body.policy as ConfigPatch['policy'];
  }

  // The blocks below are validated whole by core before anything is written
  // (updateConfig), so only their outer shape is checked here.
  if ('statuses' in body) {
    const { statuses } = body;
    // Entries are bare names or `{ name, type?, color? }`; core validates
    // the type and color.
    const nameOf = (s: unknown): string | null => {
      const name =
        typeof s === 'string'
          ? s
          : typeof s === 'object' && s !== null
            ? (s as { name?: unknown }).name
            : null;
      return typeof name === 'string' && name.trim() !== ''
        ? name.trim()
        : null;
    };
    if (!Array.isArray(statuses) || statuses.some((s) => nameOf(s) === null)) {
      return errorResponse(400, 'statuses must be a list of names');
    }
    // A status some task still has cannot go: the task would sit in a
    // column the board no longer draws, and its file would fail to load
    // against the new list.
    const kept = new Set(statuses.map((s) => canonicalStatus(nameOf(s) ?? '')));
    const stranded = new Map<string, number>();
    for (const task of ctx.store.list()) {
      const status = canonicalStatus(task.meta.status);
      if (!kept.has(status)) {
        stranded.set(status, (stranded.get(status) ?? 0) + 1);
      }
    }
    if (stranded.size > 0) {
      const which = [...stranded]
        .map(([status, n]) => `${status} (${n} task${n === 1 ? '' : 's'})`)
        .join(', ');
      return errorResponse(
        409,
        `cannot remove ${which}: move those tasks to another status first`
      );
    }
    patch.statuses = statuses as ConfigPatch['statuses'];
  }
  if ('people' in body) {
    const { people } = body;
    if (people !== null && !Array.isArray(people)) {
      return errorResponse(400, 'people must be a list or null');
    }
    // Core validates every entry before writing.
    patch.people = people as ConfigPatch['people'];
  }
  if ('labels' in body) {
    const { labels } = body;
    if (labels !== null && !Array.isArray(labels)) {
      return errorResponse(400, 'labels must be a list or null');
    }
    // Core validates every entry before writing.
    patch.labels = labels as ConfigPatch['labels'];
  }
  if ('statusRoles' in body) {
    const roles = body.statusRoles;
    if (roles !== null && (typeof roles !== 'object' || Array.isArray(roles))) {
      return errorResponse(400, 'statusRoles must be an object or null');
    }
    // Core checks every role names a configured status before writing.
    patch.statusRoles = roles as ConfigPatch['statusRoles'];
  }
  if ('verifySteps' in body) {
    const steps = body.verifySteps;
    if (steps !== null && !Array.isArray(steps)) {
      return errorResponse(400, 'verifySteps must be a list or null');
    }
    patch.verifySteps = steps as ConfigPatch['verifySteps'];
  }
  if ('prWorktreeDir' in body) {
    const dir = body.prWorktreeDir;
    if (dir !== null && typeof dir !== 'string') {
      return errorResponse(400, 'prWorktreeDir must be a string or null');
    }
    patch.prWorktreeDir = dir;
  }
  for (const key of [
    'remotes',
    'carto',
    'repoDigest',
    'receipts',
    'sync',
    'preview',
    'memory',
  ] as const) {
    if (!(key in body)) continue;
    const field = objectField(body, key);
    if (!field.ok) return field.res;
    Object.assign(patch, { [key]: field.value });
  }

  try {
    const config = updateConfig(ctx.rootDir, patch);
    ctx.events.broadcast({ type: 'config.changed' });
    // A changed interval or enabled flag only takes effect once the poll timer is rebuilt.
    ctx.linearSync.start();
    // Turning off "Commit task files to the main branch" (autoCommit) is the
    // natural point to tear the board's private sync worktree back down —
    // otherwise it (and its `git worktree list` entry in the user's repo)
    // outlives the feature it was created for. Unconditional on
    // `patch.autoCommit === false` rather than gated on an actual true→false
    // transition: SyncWorktree.remove() is already a safe no-op when there's
    // nothing to remove.
    if (patch.autoCommit === false) ctx.boardSyncScheduler?.removeWorktree();
    // Echoes the config the same way GET does, masked the same way.
    return jsonResponse(redactSecretUrls(config));
  } catch (err) {
    return errorResponse(400, (err as Error).message);
  }
}

// The body of `GET /api/sync` — the board syncer's last attempt plus what the
// next one would move. `pendingOutgoing`/`pendingIncoming` are computed live
// (BoardSyncer.pendingCounts()) on every request, not cached from the last
// attempt, so they stay accurate between debounced syncs.
interface SyncStatus extends SyncResult {
  pendingOutgoing: number;
  pendingIncoming: number;
  /** When the last sync attempt finished, or `null` before the first one. */
  lastSyncedAt: string | null;
  /**
   * Null when `dispatch merge-task` resolves on the daemon's PATH; otherwise
   * why it doesn't. A broken driver never corrupts anything by itself — git
   * treats it as a genuine conflict — but it silently downgrades every
   * OTHER concurrent same-task edit from a field-level merge to a plain
   * line-based one, with no other diagnostic anywhere.
   */
  mergeDriverWarning: string | null;
  /**
   * The receipt log's last export. Reported here rather than on an endpoint of
   * its own because this is already the "is dispatch keeping git up to date"
   * question, and the two are the file and database halves of one answer: a
   * project has a board syncer or a receipts exporter, never both.
   */
  receipts: ReceiptsStatus;
}

/** The receipt log's last export attempt, or why there wasn't one. */
interface ReceiptsStatus {
  /** `disabled` on the file backend; `idle` before the first export. */
  state: 'committed' | 'clean' | 'failed' | 'idle' | 'disabled';
  detail: string | null;
  /** The commit the last export made, when it made one. */
  commit: string | null;
  changed: number;
  removed: number;
  /** Records the export could not read out of the database. */
  problems: number;
  lastExportedAt: string | null;
  /** The last push to `receipts.remote`; absent or null when there is none. */
  lastPush?: ReceiptsPush | null;
}

// The last receipt export, as a health problem when it failed.
function receiptsProblems(ctx: ApiContext): string[] {
  const last = ctx.receiptsScheduler?.lastResult() ?? null;
  return last?.state === 'failed'
    ? [`receipt log export failed: ${last.detail}`]
    : [];
}

// Reads the exporter's retained last result. Its own null-vs-result
// distinction is preserved: `disabled` means this project has no exporter at
// all, `idle` means it has one that has not yet run.
function receiptsStatus(ctx: ApiContext): ReceiptsStatus {
  const scheduler = ctx.receiptsScheduler;
  if (scheduler === null) {
    return {
      state: 'disabled',
      // The commit path exists only while the file backend's syncer does,
      // which needs a trunk resolved at boot.
      detail:
        ctx.boardSyncScheduler === null
          ? 'this project keeps its tasks as files, so there is no receipt log'
          : 'this project keeps its tasks as files, so there is no receipt ' +
            'log — its task files are committed to the main branch instead ' +
            'while “Commit task files to the main branch” is on',
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    };
  }
  const last = scheduler.lastResult();
  if (last === null) {
    return {
      state: 'idle',
      detail: null,
      commit: null,
      changed: 0,
      removed: 0,
      problems: 0,
      lastExportedAt: null,
    };
  }
  return {
    state: last.state,
    detail: last.detail,
    commit: last.commit,
    changed: last.changed,
    removed: last.removed,
    problems: last.problems,
    lastExportedAt: scheduler.lastExportedAt(),
    // Null when receipts.remote is unset: the log stays on this machine.
    lastPush: scheduler.lastPush(),
  };
}

// The file backend with no branch to commit to. The branch is resolved once
// at boot (SyncWorktree.open), so fixing it takes a restart.
const DISABLED_SYNC_DETAIL =
  "task files can't be committed: this repo has no origin default branch " +
  'and no local main or master branch — add one, then restart Dispatch for ' +
  'this project.';

const DATABASE_SYNC_DETAIL =
  "there are no task files to commit — this project's tasks live in the " +
  "daemon's database. The audit trail is exported to the git receipt log " +
  'instead (see `receipts` below), and Settings → Board sync shares the ' +
  'board with teammates.';

const OFF_SYNC_DETAIL =
  'task files are not being committed to the main branch — turn on ' +
  '“Commit task files to the main branch” in Settings → Board sync to start.';

// Why board sharing (team/boardSync) isn't running: the board is kept as files,
// which it can't share; it is off; or it is on in config.yml but didn't start,
// because its remote didn't resolve at boot or it was turned on since.
type BoardSyncOffReason = 'files' | 'off' | 'not-started';

function boardSyncOffReason(ctx: ApiContext): BoardSyncOffReason {
  if (ctx.storeBackend === 'files') return 'files';
  try {
    return loadConfig(ctx.rootDir).sync?.enabled === true
      ? 'not-started'
      : 'off';
  } catch {
    // Boot reads the same file and turns sharing off when it can't.
    return 'off';
  }
}

// POST /api/board-sync/now's 409, per reason, which `dispatch sync now` prints.
const BOARD_SYNC_OFF_MESSAGE: Record<BoardSyncOffReason, string> = {
  files:
    "board sync isn't available: it shares boards kept in Dispatch's " +
    'database, and this project keeps its tasks as files. They reach ' +
    'teammates through “Commit task files to the main branch” ' +
    '(`autoCommit: true` in .dispatch/config.yml) instead',
  off:
    'board sync is off: it shares a database-backed project with teammates. ' +
    'Turn it on in Settings → Board sync (or set `sync.enabled: true` in ' +
    '.dispatch/config.yml), then restart Dispatch for this project',
  'not-started':
    "board sync is on but isn't running: its remote or repo couldn't be " +
    'resolved when Dispatch started, or it was turned on since. Check ' +
    '`sync.remote` or `sync.repo` in Settings → Board sync, then restart ' +
    'Dispatch for this project',
};

const MERGE_DRIVER_WARNING =
  "the 'dispatch' command isn't resolvable on this daemon's PATH, so " +
  'concurrent edits to the same task will merge line-by-line instead of ' +
  'field-by-field. Run `dispatch init` (or `dispatch doctor`) from a shell ' +
  'that can find `dispatch` to fix this.';

// GET /api/sync — `disabled` and `off` are never states a real
// BoardSyncer.syncOnce() result carries (see boardSyncer.ts's SyncState).
// `disabled` is synthesized because `ctx.boardSyncScheduler` is `null`,
// which happens on the database backend or when no trunk was resolvable at
// boot. `off` is synthesized when a trunk WAS resolvable (the scheduler
// exists) but the project's own config.yml has autoCommit: false — every
// existing project defaults to this, so it must short-circuit before touching
// the scheduler's pendingCounts(), which would otherwise call
// SyncWorktree.ensure() (a synchronous `git worktree add`, often a
// multi-second checkout) on every page load of every never-enabled project.
// Every other state comes straight from the scheduler's retained last result,
// alongside a live pendingCounts() read.
function getSyncStatus(ctx: ApiContext): Response {
  // Asked on every request rather than read off a boot-time snapshot, so
  // fixing the setup clears the warning without a daemon restart. Cheap enough
  // to include regardless of which branch below responds (index.ts's
  // implementation caches), so every state — even `disabled`/`off` — reports
  // the same merge-driver truth.
  const mergeDriverWarning = ctx.mergeDriverOk() ? null : MERGE_DRIVER_WARNING;

  if (ctx.boardSyncScheduler === null) {
    const disabled: SyncStatus = {
      state: 'disabled',
      // Two different reasons, and reporting the wrong one is worse than
      // saying nothing. On the database backend there is no board syncer by
      // design — the receipts exporter carries the audit trail instead — so
      // the trunk warning below would send someone off adding a remote to fix
      // a daemon that is working exactly as intended.
      detail:
        ctx.storeBackend === 'sqlite'
          ? DATABASE_SYNC_DETAIL
          : DISABLED_SYNC_DETAIL,
      pushed: 0,
      pulled: 0,
      pendingOutgoing: 0,
      pendingIncoming: 0,
      lastSyncedAt: null,
      mergeDriverWarning,
      receipts: receiptsStatus(ctx),
    };
    return jsonResponse(disabled);
  }

  let autoCommit: boolean;
  try {
    autoCommit = loadConfig(ctx.rootDir).autoCommit;
  } catch {
    autoCommit = false;
  }
  if (!autoCommit) {
    const off: SyncStatus = {
      state: 'off',
      detail: OFF_SYNC_DETAIL,
      pushed: 0,
      pulled: 0,
      pendingOutgoing: 0,
      pendingIncoming: 0,
      lastSyncedAt: null,
      mergeDriverWarning,
      receipts: receiptsStatus(ctx),
    };
    return jsonResponse(off);
  }

  const last = ctx.boardSyncScheduler.lastResult();
  const pending = ctx.boardSyncScheduler.pendingCounts();
  const status: SyncStatus = {
    state: last?.state ?? 'idle',
    detail: last?.detail ?? null,
    pushed: last?.pushed ?? 0,
    pulled: last?.pulled ?? 0,
    pendingOutgoing: pending.outgoing,
    pendingIncoming: pending.incoming,
    lastSyncedAt: ctx.boardSyncScheduler.lastSyncedAt(),
    mergeDriverWarning,
    receipts: receiptsStatus(ctx),
  };
  return jsonResponse(status);
}

// Maps a Linear client failure onto a status code: a bad key is the caller's
// problem, a throttle is worth surfacing distinctly, anything else is upstream.
function linearErrorResponse(failure: {
  kind: string;
  error: string;
}): Response {
  const status =
    failure.kind === 'auth' ? 401 : failure.kind === 'rate-limit' ? 429 : 502;
  return errorResponse(status, failure.error);
}

// POST /api/linear/connect — check the key against `viewer` before storing it in
// `~/.dispatch/credentials.json`. The response carries the authenticated user, never the key.
async function connectLinear(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { apiKey?: unknown };
  if (typeof body.apiKey !== 'string' || body.apiKey.trim() === '') {
    return errorResponse(400, 'apiKey must be a non-empty string');
  }
  const apiKey = body.apiKey.trim();
  const result = await new HttpLinearClient(apiKey).viewer();
  if (!result.ok) return linearErrorResponse(result);
  ctx.linearSync.connect(apiKey);
  ctx.events.broadcast({ type: 'config.changed' });
  return jsonResponse({ connected: true, viewer: result.data });
}

// POST /api/linear/disconnect — forget this project's key. An environment or
// machine-wide key still resolves afterwards, which `status.keySource` makes visible.
async function disconnectLinear(ctx: ApiContext): Promise<Response> {
  await ctx.linearSync.disconnect();
  ctx.events.broadcast({ type: 'config.changed' });
  return jsonResponse(ctx.linearSync.status());
}

// GET /api/linear/teams — the team picker's options.
async function linearTeams(ctx: ApiContext): Promise<Response> {
  const client = ctx.linearSync.client();
  if (client === null)
    return errorResponse(409, 'no Linear API key configured');
  const result = await client.teams();
  return result.ok ? jsonResponse(result.data) : linearErrorResponse(result);
}

// GET /api/linear/states?teamId= — the workflow states a status map can point at.
async function linearStates(
  ctx: ApiContext,
  teamId: string | null
): Promise<Response> {
  if (teamId === null || teamId.trim() === '') {
    return errorResponse(400, 'teamId is required');
  }
  const client = ctx.linearSync.client();
  if (client === null)
    return errorResponse(409, 'no Linear API key configured');
  const result = await client.workflowStates(teamId);
  return result.ok ? jsonResponse(result.data) : linearErrorResponse(result);
}

// A run's metadata, from the in-memory registry first (boot hydrates every
// run on disk into it); getRun's transcript replay is the fallback, and
// reads the whole file.
function runMetaFor(ctx: ApiContext, runId: string): RunMeta | undefined {
  return (
    ctx.orchestrator.list().find((r) => r.id === runId) ??
    ctx.orchestrator.getRun(runId)?.meta
  );
}

/** Content hash used as the edit precondition — see readRunFile / applyRunEdit. */
export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/**
 * GET /api/runs/:id/file — one side of a file in the run's worktree.
 *
 * Backs the diff renderer's `loadDiffFiles`: a patch alone only carries its own
 * hunks, so expansion and edit mode both need the file's real contents.
 */
async function readRunFile(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const url = new URL(req.url);
  const path = url.searchParams.get('path');
  const side = url.searchParams.get('side') ?? 'new';
  if (path === null || path === '')
    return errorResponse(400, 'path is required');
  if (side !== 'old' && side !== 'new') {
    return errorResponse(400, `invalid side: ${side} (expected old|new)`);
  }
  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) return errorResponse(404, `run not found: ${runId}`);
  const meta = detail.meta;
  if (!existsSync(meta.worktreePath)) {
    return errorResponse(409, 'worktree-missing');
  }
  if (side === 'old') {
    // No strict leaf check on this branch: it never touches the filesystem, and
    // `git show` reads a symlink as an ordinary blob rather than following it,
    // so an in-repo symlink is legitimate content here. GitRepo's own pathspec
    // guard still covers an escaping path.
    const shown = await new GitRepo(meta.worktreePath).show(
      meta.baseBranch,
      path
    );
    if (!shown.ok) return errorResponse(404, shown.stderr);
    return jsonResponse({
      contents: shown.contents,
      sha: sha256Hex(shown.contents),
    });
  }
  // Resolves every parent symlink, and rejects the leaf if it is itself a
  // symlink, so neither a symlinked directory nor a symlinked file inside the
  // worktree can be used to read a file the caller has no business seeing
  // (fs.readFileSync below follows a symlink leaf even though git never
  // does — see resolveWorktreeFilePath).
  const onDisk = resolveWorktreeFilePath(meta.worktreePath, path);
  if (onDisk === null) return errorResponse(400, PATH_ESCAPE_ERROR);
  if (!existsSync(onDisk)) return errorResponse(404, `no such file: ${path}`);
  const contents = readFileSync(onDisk, 'utf8');
  return jsonResponse({ contents, sha: sha256Hex(contents) });
}

/** Trailer marking a commit a human made while reviewing, so an audit export can
 *  separate reviewer corrections from agent work without parsing the subject. */
const REVIEWER_EDIT_TRAILER = 'Dispatch-Reviewer-Edit';

/**
 * Writes `contents` to `onDisk` and commits just that path with `subject` plus the
 * reviewer-edit trailer — scoped to `file` so the commit never carries whatever
 * else the agent left staged, which is what the trailer exists to keep separable.
 *
 * Any failure after the write restores both the file and its previous index entry
 * (not a reset to HEAD, which would drop an agent's staged version), so a rejected
 * commit can't leave a half-applied write for the next attempt to trip over.
 *
 * Shared by applyRunEdit and applySuggestion, which differ only in how the new
 * contents were produced.
 */
async function writeAndCommit(
  ctx: ApiContext,
  meta: RunMeta,
  onDisk: string,
  file: string,
  contents: string,
  previous: string,
  subject: string,
  runId: string
): Promise<Response> {
  const repo = new GitRepo(meta.worktreePath);
  // Captured before anything is staged, so the failure path below can put the
  // index back to exactly this rather than to HEAD.
  const indexBefore = await repo.indexEntry(file);
  if (!indexBefore.ok) {
    return errorResponse(
      indexBefore.stderr === PATH_ESCAPE_ERROR ? 400 : 500,
      indexBefore.stderr
    );
  }
  // The path was already proven to resolve inside the worktree by the caller,
  // so this write can't land outside it; `stage`'s own escape check below is
  // just defense in depth (and still catches a pathspec git itself refuses).
  writeFileSync(onDisk, contents);
  const staged = await repo.stage([file]);
  if (!staged.ok) {
    writeFileSync(onDisk, previous);
    return errorResponse(
      staged.stderr === PATH_ESCAPE_ERROR ? 400 : 500,
      staged.stderr
    );
  }
  const committed = await repo.commit({
    message: `${subject}\n\n${REVIEWER_EDIT_TRAILER}: ${runId}`,
    paths: [file],
  });
  if (!committed.ok) {
    writeFileSync(onDisk, previous);
    await repo.restoreIndexEntry(file, indexBefore.entry);
    return errorResponse(500, committed.stderr);
  }

  ctx.events.broadcast({ type: 'review.changed', runId });
  return jsonResponse({ commit: committed.sha });
}

/**
 * POST /api/runs/:id/edits — write one file into the run's worktree and commit it.
 *
 * Every rejection below is a 409 with a machine-readable `error`, because each
 * one has a different fix and the UI shows a different sentence for each.
 */
async function applyRunEdit(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    file?: unknown;
    contents?: unknown;
    baseSha?: unknown;
  };
  if (typeof body.file !== 'string' || body.file === '') {
    return errorResponse(400, 'file is required');
  }
  if (typeof body.contents !== 'string') {
    return errorResponse(400, 'contents is required');
  }
  if (typeof body.baseSha !== 'string' || body.baseSha === '') {
    return errorResponse(400, 'baseSha is required');
  }

  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) return errorResponse(404, `run not found: ${runId}`);
  const meta = detail.meta;
  if (!existsSync(meta.worktreePath))
    return errorResponse(409, 'worktree-missing');
  if (meta.reviewedAt !== undefined) return errorResponse(409, 'run-reviewed');

  // Resolves every parent symlink and rejects a symlink leaf, so neither a
  // symlinked directory nor a symlinked file inside the worktree can
  // redirect this write — fs.writeFileSync follows a symlink leaf even
  // though git never does (see resolveWorktreeFilePath). This has to happen
  // before anything below touches disk, and it needs the run's real
  // worktree root, so it can't run any earlier than this.
  const onDisk = resolveWorktreeFilePath(meta.worktreePath, body.file);
  if (onDisk === null) return errorResponse(400, PATH_ESCAPE_ERROR);

  // A resumed run shares this exact directory (see orchestrator requestChanges),
  // so "is anything live here" is a real race, not a hypothetical one.
  const busy = ctx.orchestrator
    .list()
    .some(
      (r) =>
        r.worktreePath === meta.worktreePath &&
        !TERMINAL_RUN_STATES.has(r.state)
    );
  if (busy) return errorResponse(409, 'worktree-busy');

  const current = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : '';
  if (sha256Hex(current) !== body.baseSha)
    return errorResponse(409, 'stale-base');
  if (body.contents === '' && current !== '') {
    return errorResponse(409, 'empty-contents');
  }

  return await writeAndCommit(
    ctx,
    meta,
    onDisk,
    body.file,
    body.contents,
    current,
    `review: edit ${body.file}`,
    runId
  );
}

/**
 * POST /api/runs/:id/comments/:commentId/apply — commit a comment's suggestion
 * verbatim onto the run branch.
 *
 * Proceeds only when `resolveAnchor` still says the comment's line is exactly
 * where it was recorded — a moved or outdated anchor means the recorded line
 * range no longer names the code the reviewer meant, so splicing by line
 * number would silently edit the wrong lines. Does not resolve the thread:
 * applying a fix and deciding the conversation is over are different actions.
 */
async function applySuggestion(
  req: Request,
  ctx: ApiContext,
  runId: string,
  commentId: string
): Promise<Response> {
  const detail = ctx.orchestrator.getRun(runId);
  if (detail === null) return errorResponse(404, `run not found: ${runId}`);
  const meta = detail.meta;
  if (!existsSync(meta.worktreePath))
    return errorResponse(409, 'worktree-missing');
  if (meta.reviewedAt !== undefined) return errorResponse(409, 'run-reviewed');

  // Through `commentTargetForRun`, so a run whose comments have moved onto its
  // PR store still finds the suggestion — the run's own file stops being read
  // the moment a PR is open.
  const comment = ctx.reviewComments
    .list(commentTargetForRun(ctx, runId))
    .find((c) => c.id === commentId);
  if (comment === undefined) {
    return errorResponse(404, `review comment not found: ${commentId}`);
  }
  // Absent or empty is a caller error, not a state conflict — there is
  // nothing recorded to apply, regardless of what the file on disk says.
  if (comment.suggestion === undefined || comment.suggestion === '') {
    return errorResponse(400, 'comment has no suggestion');
  }

  const onDisk = resolveWorktreeFilePath(meta.worktreePath, comment.file);
  if (onDisk === null) return errorResponse(400, PATH_ESCAPE_ERROR);

  // Same race as applyRunEdit: a resumed run can share this worktree, and a
  // suggestion must not be a side door around that guard.
  const busy = ctx.orchestrator
    .list()
    .some(
      (r) =>
        r.worktreePath === meta.worktreePath &&
        !TERMINAL_RUN_STATES.has(r.state)
    );
  if (busy) return errorResponse(409, 'worktree-busy');

  const current = existsSync(onDisk) ? readFileSync(onDisk, 'utf8') : '';
  const fileLines = current.split('\n');
  const anchor = resolveAnchor(comment, fileLines);
  if (anchor.kind !== 'exact') {
    return errorResponse(409, 'anchor-drifted');
  }

  const nextLines = spliceSuggestion(fileLines, comment, comment.suggestion);
  const contents = nextLines.join('\n');

  return await writeAndCommit(
    ctx,
    meta,
    onDisk,
    comment.file,
    contents,
    current,
    `review: apply suggestion on ${comment.file}`,
    runId
  );
}

// GET /api/conversations?subject=… — every message on that subject.
function listConversation(req: Request, ctx: ApiContext): Response {
  const subject = new URL(req.url).searchParams.get('subject');
  if (!isSubjectRef(subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  return jsonResponse(ctx.conversations.list(subject));
}

/**
 * POST /api/conversations — append a message.
 *
 * The subject travels in the body rather than the path because a worktree subject contains
 * slashes, which no single path segment can carry without double-encoding.
 */
async function addChatMessage(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    subject?: unknown;
    role?: unknown;
    body?: unknown;
    snippets?: unknown;
    target?: unknown;
  };
  if (!isSubjectRef(body.subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  if (body.role !== 'human' && body.role !== 'agent') {
    return errorResponse(400, 'role must be human or agent');
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  // Rejected rather than stored: a snippet missing a field is not recoverable later, and it
  // reaches the reviewer's chat as `undefined (undefined-undefined)` on a chip.
  const snippets = body.snippets ?? [];
  if (!Array.isArray(snippets) || !snippets.every(isSnippet)) {
    return errorResponse(
      400,
      'snippets must each carry file, text and integer startLine/endLine'
    );
  }
  const message = ctx.conversations.add(body.subject, {
    role: body.role,
    body: body.body.trim(),
    snippets,
    target: typeof body.target === 'string' ? body.target : undefined,
  });
  return jsonResponse(message, 201);
}

// DELETE /api/conversations/:messageId?subject=…
function deleteChatMessage(
  req: Request,
  ctx: ApiContext,
  messageId: string
): Response {
  const subject = new URL(req.url).searchParams.get('subject');
  if (!isSubjectRef(subject)) {
    return errorResponse(400, 'subject must be run:…, worktree:… or pr:…');
  }
  ctx.conversations.remove(subject, messageId);
  return new Response(null, { status: 204 });
}

// Sends the review back to the agent wherever the agent is. A run is
// reviewed AFTER it finishes, so the normal case is terminal — and only
// `{ resume: true }` re-dispatches one; without it sendMessage refuses with
// "run is not live". A still-live run keeps the mid-run message path. A
// resumed run acts for the reviewer's own credential, never the shared token.
function sendReviewToAgent(
  ctx: ApiContext,
  runId: string,
  message: string
): RunMeta {
  const meta = runMetaFor(ctx, runId);
  const resume = meta !== undefined && TERMINAL_RUN_STATES.has(meta.state);
  return ctx.orchestrator.sendMessage(
    runId,
    message,
    resume
      ? {
          resume: true,
          actor: humanActor(ctx),
          operator: humanOperator(ctx),
        }
      : {}
  );
}

// MEM-R8(c): a request-tier reviewer may not send into a live run that acts
// for another human; resuming a finished one acts for the reviewer instead.
function reviewSendRefusal(ctx: ApiContext, runId: string): string | null {
  const meta = runMetaFor(ctx, runId);
  if (meta === undefined || TERMINAL_RUN_STATES.has(meta.state)) return null;
  return runMessageRefusal(
    meta,
    humanOperator(ctx),
    tierAllows(ctx.caller?.tier ?? 'request', 'decide')
  );
}

// Which comment store a run's review verbs use. A run whose work lives on a
// GitHub PR keeps its comments with the PR, so a note reaches the reviewer
// there and still travels back to the agent. Anything written before the PR
// was opened moves across on the first call, since the run's own file stops
// being read the moment this starts answering `pr`.
function commentTargetForRun(ctx: ApiContext, runId: string): ReviewTarget {
  const runTarget: ReviewTarget = { kind: 'run', runId };
  const meta = runMetaFor(ctx, runId);
  const location = meta?.prUrl === undefined ? null : parsePrUrl(meta.prUrl);
  if (location === null) return runTarget;
  const prTarget: ReviewTarget = { kind: 'pr', number: location.number };
  ctx.reviewComments.moveAll(runTarget, prTarget);
  return prTarget;
}

// GET /api/runs/:id/comments — every review comment on this run's diff.
function listReviewComments(ctx: ApiContext, runId: string): Response {
  return jsonResponse(ctx.reviewComments.list(commentTargetForRun(ctx, runId)));
}

type ParsedBody<T> = { ok: true; value: T } | { ok: false; response: Response };

// Shared body validation for POST .../comments on both the run- and
// PR-keyed routes: `anchorText` is required and is the whole point — it
// records what the line said when the comment was written, which is the
// only way to tell later whether the comment still points at the code it
// was about. Without it a comment silently drifts onto unrelated lines as
// the agent (or a fresh push to the PR) moves things around.
//
// `allowPublished` is false on the PR route only: a comment created straight
// to `pending: false` skips the staged-then-submitted flow the PR path is
// built around. The run route has no push step and keeps accepting it.
async function parseAddCommentInput(
  req: Request,
  allowPublished = true
): Promise<ParsedBody<AddCommentInput>> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed;
  const body = parsed.value as {
    file?: unknown;
    line?: unknown;
    startLine?: unknown;
    anchorText?: unknown;
    body?: unknown;
    suggestion?: unknown;
    pending?: unknown;
  };
  if (typeof body.file !== 'string' || body.file === '') {
    return { ok: false, response: errorResponse(400, 'file is required') };
  }
  if (typeof body.line !== 'number' || !Number.isInteger(body.line)) {
    return {
      ok: false,
      response: errorResponse(400, 'line must be an integer'),
    };
  }
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return { ok: false, response: errorResponse(400, 'body is required') };
  }
  if (!allowPublished && body.pending === false) {
    return {
      ok: false,
      response: errorResponse(
        400,
        'pending must be true: a PR comment reaches GitHub only through a review submit'
      ),
    };
  }
  return {
    ok: true,
    value: {
      file: body.file,
      line: body.line,
      startLine:
        typeof body.startLine === 'number' && Number.isInteger(body.startLine)
          ? body.startLine
          : undefined,
      anchorText: typeof body.anchorText === 'string' ? body.anchorText : '',
      body: body.body.trim(),
      // Not trimmed, unlike `body`: a suggestion is code, so its leading
      // indentation is part of what gets written back.
      suggestion:
        typeof body.suggestion === 'string' && body.suggestion !== ''
          ? body.suggestion
          : undefined,
      pending: body.pending !== false,
    },
  };
}

// POST /api/runs/:id/comments — leave a line-level note on the diff.
async function addReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await parseAddCommentInput(req);
  if (!parsed.ok) return parsed.response;
  const comment = ctx.reviewComments.add(
    commentTargetForRun(ctx, runId),
    parsed.value
  );
  ctx.events.broadcast({ type: 'review.changed', runId });
  return jsonResponse(comment, 201);
}

// The comment `target` holds under `commentId`, or undefined. Reply and
// resolve both branch on whether GitHub already knows the record.
function commentOn(
  ctx: ApiContext,
  target: ReviewTarget,
  commentId: string
): ReviewComment | undefined {
  return ctx.reviewComments.list(target).find((c) => c.id === commentId);
}

// Resolves a comment where the reviewer can see it resolved. On a run whose
// work is on a PR, resolution belongs to GitHub's review thread — doing it
// locally would leave the run row and the PR row permanently disagreeing.
// A draft GitHub has never seen, and a PR that is no longer open, have no
// thread to touch and stay local.
async function resolveCommentForRun(
  ctx: ApiContext,
  target: ReviewTarget,
  commentId: string,
  resolved: boolean
): Promise<ReviewComment> {
  const local = (): ReviewComment =>
    ctx.reviewComments.setResolved(target, commentId, resolved);
  if (target.kind !== 'pr') return local();
  const comment = commentOn(ctx, target, commentId);
  if (comment?.githubId === undefined) return local();
  try {
    // Thread ids arrive only through syncReviewThreads, which the run
    // surface never calls — fetch one now so there is something to resolve.
    if (comment.githubThreadId === undefined) {
      await ctx.prManager.syncReviewThreads(target.number);
    }
  } catch (err) {
    if (!(err instanceof OrchestratorNotFoundError)) throw err;
    return local();
  }
  if (commentOn(ctx, target, commentId)?.githubThreadId === undefined) {
    return local();
  }
  return ctx.prManager.resolveComment(target.number, commentId, resolved);
}

// PATCH /api/runs/:id/comments/:commentId — resolve or unresolve a thread.
async function updateReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string,
  commentId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { resolved?: unknown };
  if (typeof body.resolved !== 'boolean') {
    return errorResponse(400, 'resolved must be a boolean');
  }
  try {
    const comment = await resolveCommentForRun(
      ctx,
      commentTargetForRun(ctx, runId),
      commentId,
      body.resolved
    );
    ctx.events.broadcast({ type: 'review.changed', runId });
    return jsonResponse(comment);
  } catch (err) {
    // The store's own miss is a plain Error; a `gh` failure on the PR path
    // is a typed conflict and keeps its own 409 through handleApi.
    if (err instanceof OrchestratorConflictError) throw err;
    return errorResponse(404, (err as Error).message);
  }
}

// Adds to a thread wherever the thread lives. On a run whose work is on a
// PR, a reply to a comment GitHub already knows about is posted there under
// GitHub's own author and id. A pending draft exists nowhere else, so its
// reply stays local and rides along when pushPrReview carries it forward.
async function replyToCommentForRun(
  ctx: ApiContext,
  target: ReviewTarget,
  commentId: string,
  body: string
): Promise<ReviewComment> {
  const local = (): ReviewComment =>
    ctx.reviewComments.reply(target, commentId, body);
  if (target.kind !== 'pr') return local();
  if (commentOn(ctx, target, commentId)?.githubId === undefined) return local();
  try {
    return await ctx.prManager.replyToComment(target.number, commentId, body);
  } catch (err) {
    // Same closed-PR fallback as the push: the record is still local, and a
    // reply the reviewer wrote must not be lost to a PR that has landed.
    if (!(err instanceof OrchestratorNotFoundError)) throw err;
    return local();
  }
}

// POST /api/runs/:id/comments/:commentId/reply — add to a thread.
async function replyReviewComment(
  req: Request,
  ctx: ApiContext,
  runId: string,
  commentId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  try {
    const comment = await replyToCommentForRun(
      ctx,
      commentTargetForRun(ctx, runId),
      commentId,
      body.body.trim()
    );
    ctx.events.broadcast({ type: 'review.changed', runId });
    return jsonResponse(comment);
  } catch (err) {
    if (err instanceof OrchestratorConflictError) throw err;
    return errorResponse(404, (err as Error).message);
  }
}

// Sends a run-with-PR's not-yet-on-GitHub comments as one review instead of
// publishing them locally, returning how many were pushed. GitHub rejects a
// COMMENT/REQUEST_CHANGES review with an empty body, so a note-less submit
// gets a stand-in rather than gh's raw 422. The retry guard that stops an
// identical resubmit duplicating the review lives inside pushPrReview, so
// the PR-keyed route inherits it too.
async function pushRunReviewToPr(
  ctx: ApiContext,
  number: number,
  verdict: PrReviewEvent,
  summary: string
): Promise<number> {
  const body =
    summary === '' && verdict !== 'approve'
      ? 'See the line comments.'
      : summary;
  try {
    const { pushed } = await ctx.prManager.pushPrReview(number, verdict, body);
    return pushed;
  } catch (err) {
    // A closed or merged PR is not in `gh pr list`, so resolving it 404s
    // before anything is posted. The GitHub half is over; publish locally so
    // the comments stop sitting pending and still reach the agent.
    if (!(err instanceof OrchestratorNotFoundError)) throw err;
    return ctx.reviewComments.publishPending({ kind: 'pr', number });
  }
}

/**
 * POST /api/runs/:id/review — submit a review: publish its pending comments, then act on the
 * verdict.
 *
 * The three verdicts map onto what this app can already do with a finished run, rather than
 * inventing a parallel notion of review state:
 *
 *   approve         -> the work is good; the caller enqueues it to land
 *   request-changes -> resume the agent on the same branch with the review attached
 *   comment         -> publish the notes and change nothing
 *
 * Comments are published BEFORE the verdict is acted on, and the count is returned either way,
 * so a verdict action that fails cannot swallow the reviewer's writing.
 *
 * `postToGitHub` (default false) decides whether the batch also reaches the
 * run's PR as one GitHub review. Off, the review is published locally and
 * still travels back to the agent — the choice is about GitHub, not about
 * whether the review happens. Asking for it on a run with no PR is a 400
 * rather than a silent no-op.
 */
async function submitReview(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    verdict?: unknown;
    body?: unknown;
    postToGitHub?: unknown;
  };
  const verdict = body.verdict;
  if (
    verdict !== 'approve' &&
    verdict !== 'request-changes' &&
    verdict !== 'comment'
  ) {
    return errorResponse(
      400,
      "invalid verdict: expected 'approve', 'request-changes' or 'comment'"
    );
  }
  const summary = typeof body.body === 'string' ? body.body.trim() : '';
  const target = commentTargetForRun(ctx, runId);
  const prNumber = target.kind === 'pr' ? target.number : null;
  const postToGitHub = body.postToGitHub === true;
  if (postToGitHub && prNumber === null) {
    return errorResponse(
      400,
      'postToGitHub needs a run whose work is on a pull request'
    );
  }

  if (verdict === 'request-changes') {
    const refusal = reviewSendRefusal(ctx, runId);
    if (refusal !== null) return errorResponse(403, refusal);
  }

  // Requesting changes with nothing to say would resume the agent to tell it nothing, burning a
  // run. The other two verdicts are meaningful on their own.
  const pendingBefore = ctx.reviewComments.pendingCount(target);
  if (verdict === 'request-changes' && summary === '' && pendingBefore === 0) {
    return errorResponse(
      400,
      'nothing to send back — leave a note or a comment first'
    );
  }

  // Only a reviewer who asked for GitHub gets the push path. The two are
  // exclusive on purpose: pushPrReview owns which comments have reached
  // GitHub, and publishPending alongside it would obscure that. Everyone else
  // publishes locally, PR or not, and the send-back below happens either way.
  const published =
    postToGitHub && prNumber !== null
      ? await pushRunReviewToPr(ctx, prNumber, verdict, summary)
      : ctx.reviewComments.publishPending(target);
  ctx.events.broadcast({ type: 'review.changed', runId });

  if (verdict === 'request-changes') {
    const threads = formatCommentsForAgent(ctx.reviewComments.list(target));
    const message = [summary, threads].filter((p) => p !== '').join('\n\n');
    try {
      const meta = sendReviewToAgent(ctx, runId, message);
      return jsonResponse({ verdict, published, run: meta });
    } catch (err) {
      // The comments are already published — say so, so the caller knows the review landed even
      // though the resume did not.
      return jsonResponse(
        { verdict, published, error: (err as Error).message },
        409
      );
    }
  }

  if (verdict === 'approve') {
    try {
      const entry = ctx.mergeQueue.enqueue(runId);
      return jsonResponse({ verdict, published, queued: entry });
    } catch (err) {
      return jsonResponse(
        { verdict, published, error: (err as Error).message },
        409
      );
    }
  }

  return jsonResponse({ verdict, published });
}

/**
 * POST /api/runs/:id/archive — hide a finished run from the default Runs list.
 *
 * `{ "archived": true | false }`. Nothing is deleted: the transcript, the diff
 * snapshot and the review comments all stay. This is a display marker, and it
 * is reversible, which is why the body carries the desired state rather than
 * this being a one-way "archive" verb.
 */
async function archiveRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { archived?: unknown };
  if (typeof body.archived !== 'boolean') {
    return errorResponse(400, 'archived must be a boolean');
  }
  try {
    return jsonResponse(ctx.orchestrator.setRunArchived(runId, body.archived));
  } catch (err) {
    return errorResponse(404, (err as Error).message);
  }
}

/**
 * POST /api/runs/:id/send-back — return the work to the agent with the review attached.
 *
 * This is where the review UI's promise gets kept: the unresolved threads are rendered into the
 * message the agent resumes on, so "the agent reads this when you send the work back" is
 * literally true rather than decorative. A free-text note is optional and leads, since it is the
 * reviewer's framing; the threads follow as specifics.
 *
 * Refuses an empty review outright. Resuming an agent with no instruction burns a run to be told
 * nothing, which is worse than making the user say what they want.
 */
async function sendBackRun(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { note?: unknown };
  const note = typeof body.note === 'string' ? body.note.trim() : '';
  const refusal = reviewSendRefusal(ctx, runId);
  if (refusal !== null) return errorResponse(403, refusal);
  const threads = formatCommentsForAgent(
    ctx.reviewComments.list(commentTargetForRun(ctx, runId))
  );

  if (note === '' && threads === '') {
    return errorResponse(
      400,
      'nothing to send back — leave a note or an unresolved comment first'
    );
  }
  const message = [note, threads].filter((part) => part !== '').join('\n\n');
  try {
    const meta = sendReviewToAgent(ctx, runId, message);
    return jsonResponse(meta);
  } catch (err) {
    return errorResponse(409, (err as Error).message);
  }
}

// POST /api/branches/free-disk — reclaims a branch's worktree directory while
// leaving its branch ref intact, so the work stays recoverable. Returns the
// branch's refreshed BranchEntry rather than a bare 204 so the client can
// re-render one row without re-fetching the whole list.
async function freeBranchDisk(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { branch?: unknown };
  if (typeof body.branch !== 'string' || body.branch === '') {
    return errorResponse(400, 'branch is required');
  }
  return jsonResponse(await ctx.orchestrator.freeWorktreeDisk(body.branch));
}

// DELETE /api/branches/:branch — removes a branch ref and any worktree it
// still has. The branch name is URL-encoded by the client because dispatch
// branch names always contain `/`, so the whole remainder of the path after
// `branches/` is rejoined and decoded rather than read as a single segment.
// `?force=1` opts into deleting a branch whose commits have NOT landed on its
// base — the one irreversible case, which the orchestrator refuses otherwise.
async function deleteBranch(
  ctx: ApiContext,
  branch: string,
  url: URL
): Promise<Response> {
  const force = url.searchParams.get('force') === '1';
  await ctx.orchestrator.deleteBranch(branch, { force });
  return jsonResponse({ ok: true });
}

// A `GitBranch` joined with whatever run claims that name, mirroring
// Orchestrator.listBranches' join but for every branch, not just dispatch/*.
interface GitBranchWithRun extends GitBranch {
  runId?: string;
  taskId?: string;
  taskTitle?: string;
}

// GET /api/git/branches's core: every local/remote branch git knows about,
// annotated with the run that owns it when one does.
async function gitBranches(
  ctx: ApiContext
): Promise<GitOutcome<{ branches: GitBranchWithRun[] }>> {
  const result = await ctx.gitRepo.branches();
  if (!result.ok) return result;
  const runByBranch = new Map(
    ctx.orchestrator.list().map((r) => [r.branch, r])
  );
  const branches = result.branches.map((branch) => {
    const run = runByBranch.get(branch.name);
    return {
      ...branch,
      runId: run?.id,
      taskId: run?.taskId,
      taskTitle: run?.taskTitle,
    };
  });
  return { ok: true, branches };
}

// GitRepo's own pre-flight rejections never touch git, so `alwaysBroadcast`
// below must not fire for them even though they report `ok: false`.
const PRE_FLIGHT_REJECTIONS: ReadonlySet<string> = new Set([
  PATH_ESCAPE_ERROR,
  INVALID_REF_ERROR,
  INVALID_REMOTE_ERROR,
  CONFIRM_REQUIRED_ERROR,
  INVALID_STASH_INDEX_ERROR,
]);

// Shared by every `/api/git/*` mutation route; `alwaysBroadcast` covers ops
// that can mutate the tree even on `ok: false` (a conflicted pull or discard).
function gitMutationResponse(
  ctx: ApiContext,
  result: GitOutcome,
  opts: { alwaysBroadcast?: boolean } = {}
): Response {
  const mutated =
    result.ok ||
    (opts.alwaysBroadcast === true &&
      !PRE_FLIGHT_REJECTIONS.has(result.stderr));
  if (mutated) ctx.events.broadcast({ type: 'git.changed' });
  return jsonResponse(result);
}

// Shared shape check for the routes that take a list of file paths (stage,
// unstage, discard) — requires a non-empty array of non-empty strings.
function requirePathList(value: unknown): string[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    !value.every((v) => typeof v === 'string' && v !== '')
  ) {
    return null;
  }
  return value as string[];
}

async function gitStage(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const paths = requirePathList((parsed.value as { paths?: unknown }).paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  return gitMutationResponse(ctx, await ctx.gitRepo.stage(paths));
}

async function gitUnstage(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const paths = requirePathList((parsed.value as { paths?: unknown }).paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  return gitMutationResponse(ctx, await ctx.gitRepo.unstage(paths));
}

// POST /api/git/discard — destructive (drops uncommitted work with no undo),
// so it 400s outright unless the body carries `confirm: true`.
async function gitDiscard(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { paths?: unknown; confirm?: unknown };
  const paths = requirePathList(body.paths);
  if (paths === null)
    return errorResponse(400, 'paths is required: a non-empty list of strings');
  if (body.confirm !== true) {
    return errorResponse(
      400,
      'discard is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.discard(paths, true), {
    alwaysBroadcast: true,
  });
}

async function gitStageHunk(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = (parsed.value as { patch?: unknown }).patch;
  if (typeof patch !== 'string' || patch === '') {
    return errorResponse(400, 'patch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stageHunk(patch));
}

async function gitUnstageHunk(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const patch = (parsed.value as { patch?: unknown }).patch;
  if (typeof patch !== 'string' || patch === '') {
    return errorResponse(400, 'patch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.unstageHunk(patch));
}

async function gitCommit(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { message?: unknown; amend?: unknown };
  if (typeof body.message !== 'string' || body.message.trim() === '') {
    return errorResponse(400, 'message is required');
  }
  if (body.amend !== undefined && typeof body.amend !== 'boolean') {
    return errorResponse(400, 'amend must be a boolean');
  }
  const result = await ctx.gitRepo.commit({
    message: body.message,
    amend: body.amend === true,
  });
  // The commit itself can still have landed even when this reports `ok:
  // false` (rev-parse failed to confirm the sha) — broadcast that case too.
  const shaUnresolved =
    !result.ok && result.stderr.startsWith(COMMIT_SHA_UNRESOLVED_PREFIX);
  return gitMutationResponse(ctx, result, { alwaysBroadcast: shaUnresolved });
}

// POST /api/git/commit-message — the agent-focused route. 400s when nothing
// is staged; 502s a model failure rather than a generic 500.
async function gitCommitMessage(
  _req: Request,
  ctx: ApiContext
): Promise<Response> {
  const diff = await ctx.gitRepo.diff({ staged: true });
  if (!diff.ok) return errorResponse(409, diff.stderr);
  if (diff.patch.trim() === '') {
    return errorResponse(400, 'no staged changes to summarize');
  }
  const generator =
    ctx.commitMessageGenerator ?? new CommitMessageGenerator(ctx.rootDir);
  try {
    const message = await generator.generate(diff.patch);
    return jsonResponse({ message });
  } catch (err) {
    return errorResponse(502, (err as Error).message);
  }
}

async function gitCheckout(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const branch = (parsed.value as { branch?: unknown }).branch;
  if (typeof branch !== 'string' || branch === '') {
    return errorResponse(400, 'branch is required');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.checkout(branch));
}

async function gitCreateBranch(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { name?: unknown; from?: unknown };
  if (typeof body.name !== 'string' || body.name === '') {
    return errorResponse(400, 'name is required');
  }
  if (body.from !== undefined && typeof body.from !== 'string') {
    return errorResponse(400, 'from must be a string');
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.createBranch(body.name, body.from)
  );
}

// DELETE /api/git/branch/:name — `force: true` (git's `-D`) 400s unless the
// body also carries `confirm: true`; a plain `-d` delete needs no confirm.
async function gitDeleteBranch(
  req: Request,
  ctx: ApiContext,
  name: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { force?: unknown; confirm?: unknown };
  const force = body.force === true;
  if (force && body.confirm !== true) {
    return errorResponse(
      400,
      'deleting an unmerged branch is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.deleteBranch(name, force, body.confirm === true)
  );
}

async function gitStashPush(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const message = (parsed.value as { message?: unknown }).message;
  if (message !== undefined && typeof message !== 'string') {
    return errorResponse(400, 'message must be a string');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stashPush(message));
}

function requireStashIndex(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0
    ? value
    : null;
}

async function gitStashPop(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const index = requireStashIndex((parsed.value as { index?: unknown }).index);
  if (index === null)
    return errorResponse(400, 'index is required: a non-negative integer');
  return gitMutationResponse(ctx, await ctx.gitRepo.stashPop(index), {
    alwaysBroadcast: true,
  });
}

// POST /api/git/stash/drop — destructive (the stash entry is gone for good),
// so it 400s outright unless the body carries `confirm: true`.
async function gitStashDrop(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { index?: unknown; confirm?: unknown };
  const index = requireStashIndex(body.index);
  if (index === null)
    return errorResponse(400, 'index is required: a non-negative integer');
  if (body.confirm !== true) {
    return errorResponse(
      400,
      'dropping a stash is destructive and requires confirm: true'
    );
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.stashDrop(index, true));
}

async function gitFetch(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const remote = (parsed.value as { remote?: unknown }).remote;
  if (remote !== undefined && typeof remote !== 'string') {
    return errorResponse(400, 'remote must be a string');
  }
  return gitMutationResponse(ctx, await ctx.gitRepo.fetch(remote));
}

async function gitPush(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const setUpstream = (parsed.value as { setUpstream?: unknown }).setUpstream;
  if (setUpstream !== undefined && typeof setUpstream !== 'boolean') {
    return errorResponse(400, 'setUpstream must be a boolean');
  }
  return gitMutationResponse(
    ctx,
    await ctx.gitRepo.push({ setUpstream: setUpstream === true })
  );
}

async function gitCherryPick(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const sha = (parsed.value as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || sha === '')
    return errorResponse(400, 'sha is required');
  return gitMutationResponse(ctx, await ctx.gitRepo.cherryPick(sha), {
    alwaysBroadcast: true,
  });
}

async function gitRevert(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const sha = (parsed.value as { sha?: unknown }).sha;
  if (typeof sha !== 'string' || sha === '')
    return errorResponse(400, 'sha is required');
  return gitMutationResponse(ctx, await ctx.gitRepo.revert(sha), {
    alwaysBroadcast: true,
  });
}

// Absent -> undefined; a valid non-negative integer -> that number;
// otherwise -> null so the route can 400 instead of passing NaN to git.
function parseCountParam(raw: string | null): number | undefined | null {
  if (raw === null) return undefined;
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

// GET /api/runs/:id/pr — the run's GitHub PR status + conversation, read live
// via gh (see PrManager.getPrDetail). 409s a run with no open PR.
async function getPr(
  _req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const detail = await ctx.prManager.getPrDetail(runId);
  return jsonResponse(detail);
}

// POST /api/runs/:id/pr/review — submit a GitHub review on the run's PR.
// `approve` may omit a body; `request-changes` and `comment` require one, the
// same rule gh itself enforces.
async function reviewPr(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { event?: unknown; body?: unknown };
  if (
    body.event !== 'approve' &&
    body.event !== 'request-changes' &&
    body.event !== 'comment'
  ) {
    return errorResponse(
      400,
      `invalid event: ${String(body.event)} (expected approve|request-changes|comment)`
    );
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if (body.event !== 'approve' && text.trim() === '') {
    return errorResponse(400, `a ${body.event} review requires a body`);
  }
  const detail = await ctx.prManager.reviewPr(runId, body.event, text);
  return jsonResponse(detail);
}

// POST /api/runs/:id/pr/comment — add a PR-level comment (not a review).
async function commentPr(
  req: Request,
  ctx: ApiContext,
  runId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'invalid body: body is required');
  }
  const detail = await ctx.prManager.commentPr(runId, body.body);
  return jsonResponse(detail);
}

// Resolves a PR number to its RepoPr entry via PrManager.findRepoPr() —
// shared by the /api/prs/:number/* handlers below. Returns `null` (caller
// 404s) when the repo has no such PR, so this can never be used to
// review/comment on an arbitrary PR url a client supplies directly: the
// input is a validated number `gh` resolves against this repo's own remote.
// listRepoPrs() inside it is what 409s when the project lacks pr capability.
//
// Closed and merged PRs resolve too (findRepoPr's `gh pr view` fallback):
// the review surface has to load a merged PR in order to say it is merged.
async function resolveRepoPrByNumber(
  ctx: ApiContext,
  numberParam: string
): Promise<RepoPr | null> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) return null;
  return await ctx.prManager.findRepoPr(number);
}

// GET /api/prs/:number/detail — the in-app detail view for a repo PR
// dispatch never opened itself ("Other open PRs"). Mirrors GET
// /api/runs/:id/pr, but keyed by PR number instead of a run id.
async function getRepoPrDetail(
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const detail = await ctx.prManager.getPrDetailByUrl(pr.url, pr.title);
  return jsonResponse(detail);
}

// GET /api/landing — the unified PR table: runs, the merge queue, and
// open/merged PRs joined into one feed. `mergedPrs` degrades to `[]` when
// the project lacks pr capability or `gh` fails, so a local-only repo (no
// remote at all) still gets a 200 with its queue-local rows intact rather
// than a 409.
async function getLandingSnapshot(ctx: ApiContext): Promise<Response> {
  let mergedPrs: RepoPr[] = [];
  try {
    mergedPrs = await ctx.prManager.listMergedPrs(20);
  } catch (err) {
    if (!(err instanceof OrchestratorConflictError)) throw err;
  }
  // list()'s own `behind` is always false (a disk-only scan has no live PR
  // data to compare against) — recomputed here against the cache's current
  // headRefOid, the freshest answer this route has without paying for
  // another `gh` call (Task 7 review, IMPORTANT 3).
  const openPrs = ctx.prManager.cachedPrs();
  const headRefOidByNumber = new Map(
    openPrs.map((pr) => [pr.number, pr.headRefOid])
  );
  const worktreeStates = await ctx.prWorktrees.list();
  const worktrees = new Map(
    worktreeStates.map((state) => [
      state.prNumber,
      toLandingWorktree(state, headRefOidByNumber.get(state.prNumber)),
    ])
  );
  // One small file read per terminal run; the checklist is written once
  // when the run finishes and never changes after.
  const runs = ctx.orchestrator.list();
  const checklists = new Map<string, ChecklistSummary>();
  for (const run of runs) {
    const checklist = readChecklist(ctx.rootDir, run.id);
    if (checklist !== null) checklists.set(run.id, checklistSummary(checklist));
  }
  const snapshot = buildLandingSnapshot({
    runs,
    queue: ctx.mergeQueue.snapshot(),
    openPrs,
    mergedPrs,
    worktrees,
    checklists,
    now: new Date().toISOString(),
  });
  return jsonResponse(snapshot);
}

// POST /api/prs/:number/review — submit a GitHub review on a repo PR by
// number. Body validation mirrors POST /api/runs/:id/pr/review exactly.
async function reviewRepoPr(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { event?: unknown; body?: unknown };
  if (
    body.event !== 'approve' &&
    body.event !== 'request-changes' &&
    body.event !== 'comment'
  ) {
    return errorResponse(
      400,
      `invalid event: ${String(body.event)} (expected approve|request-changes|comment)`
    );
  }
  const text = typeof body.body === 'string' ? body.body : '';
  if (body.event !== 'approve' && text.trim() === '') {
    return errorResponse(400, `a ${body.event} review requires a body`);
  }
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  // The same refusal pushPrReview makes: this is the other door to the same
  // GitHub POST, and resolveRepoPrByNumber now finds closed PRs — so without
  // this a merged PR reaches GitHub and answers with gh's raw error.
  if (pr.state !== 'OPEN') {
    return errorResponse(409, closedPrReviewMessage(pr, 0));
  }
  const detail = await ctx.prManager.reviewPrByUrl(pr.url, body.event, text);
  return jsonResponse(detail);
}

// POST /api/prs/:number/comment — add a PR-level comment on a repo PR by
// number. Body validation mirrors POST /api/runs/:id/pr/comment exactly.
async function commentRepoPr(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'invalid body: body is required');
  }
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const detail = await ctx.prManager.commentPrByUrl(pr.url, body.body);
  return jsonResponse(detail);
}

// The fork gate (spec Decision 3): an agent review checks the PR's head out
// and runs an agent in it, executing that code here. Same-repo is work the
// user already trusts; a fork is a stranger's. Null means proceed.
//
// PrManager.fetchPrHead refuses the same PR on its own — this is the message
// layer, refusing one `gh` call earlier so nothing downstream even resolves.
function forkGate(pr: RepoPr, confirmFork: boolean): Response | null {
  if (!pr.isCrossRepository || confirmFork) return null;
  return errorResponse(
    409,
    forkConfirmMessage(pr.number, pr.headRepositoryOwner)
  );
}

// The review run already reviewing this PR, if one is still going. Every
// dispatch mints a fresh task, so dispatchAuxRun's per-task live-run guard
// can never fire for these — this is the guard that can.
function liveReviewRunForPr(ctx: ApiContext, number: number): RunMeta | null {
  const taskIds = new Set(
    ctx.store
      .list()
      .filter((doc) => isPrReviewTaskFor(doc.meta, number))
      .map((doc) => doc.meta.id)
  );
  const live = ctx.orchestrator
    .list()
    .find(
      (run) => taskIds.has(run.taskId) && !TERMINAL_RUN_STATES.has(run.state)
    );
  return live ?? null;
}

/**
 * GET /api/prs/:number/findings — what agent reviews of this PR found.
 *
 * A located finding also becomes a line comment on the diff, but an unlocated
 * one (`file`/`line` null — "this approach is wrong") has nowhere to hang, and
 * a PR target has no run behind it to open a findings panel on. This route is
 * the only surface those reach.
 *
 * Every review of a PR mints a fresh task, so findings for the same PR are
 * gathered across all of them, newest review last.
 *
 * Purely local: the task store and the finding store, no `gh`. The number is
 * validated rather than resolved against the repo's open PRs on purpose —
 * the panel refetches this on every mount and focus, and a subprocess per
 * refetch would buy nothing but a 404 for a number the caller read off a PR
 * it is already displaying.
 */
function listPrFindings(ctx: ApiContext, numberParam: string): Response {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  const findings = ctx.store
    .list()
    .filter((doc) => isPrReviewTaskFor(doc.meta, number))
    .flatMap((doc) => ctx.findingStore.list({ taskId: doc.meta.id }));
  return jsonResponse(findings);
}

// PRs whose review dispatch is in flight, keyed `<rootDir>\0<number>`.
// liveReviewRunForPr can only see runs that already exist, and five awaits
// (two `gh` reads, the fetch, the merge-base, the worktree cut) separate that
// check from the first one — a double click lands both requests inside that
// window. Module scope because the window belongs to the process, not to a
// request; the rootDir prefix keeps two daemons in one process apart.
const prReviewDispatchesInFlight = new Set<string>();

function prDispatchKey(ctx: ApiContext, number: number): string {
  return `${ctx.rootDir}\0${number}`;
}

// Takes the PR's dispatch slot, or reports that someone else holds it. Purely
// synchronous, which is what makes it a claim rather than a second check.
function claimPrReviewDispatch(ctx: ApiContext, number: number): boolean {
  const key = prDispatchKey(ctx, number);
  if (prReviewDispatchesInFlight.has(key)) return false;
  prReviewDispatchesInFlight.add(key);
  return true;
}

// POST /api/prs/:number/review-agent — hand a repo PR to a review agent.
// The claim is taken before the first await and released once the dispatch
// has either produced a run or rolled itself back, so a failed dispatch never
// locks the PR out of being reviewed again.
async function startPrAgentReview(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  // A number that cannot name a PR 404s below having created nothing, so
  // there is no dispatch to claim — and every such request would collide on
  // one key if there were.
  if (number === null) return await runPrAgentReview(req, ctx, numberParam);
  if (!claimPrReviewDispatch(ctx, number)) {
    return errorResponse(409, `PR #${number} is already being reviewed`);
  }
  try {
    return await runPrAgentReview(req, ctx, numberParam);
  } finally {
    prReviewDispatchesInFlight.delete(prDispatchKey(ctx, number));
  }
}

// The dispatch itself, with this PR's slot already claimed. The fork gate is
// the first thing past resolution deliberately: when it refuses, no ref,
// worktree, task or run exists yet, so there is nothing to undo.
async function runPrAgentReview(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const confirmFork = parsed.value.confirmFork === true;
  const refused = forkGate(pr, confirmFork);
  if (refused !== null) return refused;
  // Two reviews of one PR file both sets of findings on the same PR, and a
  // later submit would post every line comment to GitHub twice.
  const live = liveReviewRunForPr(ctx, pr.number);
  if (live !== null) {
    return errorResponse(
      409,
      `PR #${pr.number} is already being reviewed by run ${live.id}`
    );
  }
  return jsonResponse(await dispatchPrAgentReview(ctx, pr, confirmFork), 202);
}

// Turns a repo PR into a review run, ordered so a failure leaves nothing
// half-created: the two `gh` reads create nothing, the ref precedes the task,
// and a review that fails to start takes its task with it.
async function dispatchPrAgentReview(
  ctx: ApiContext,
  pr: RepoPr,
  confirmFork: boolean
): Promise<RunMeta> {
  const body = await ctx.prManager.getPrBodyByUrl(pr.url);
  const files = await ctx.prManager.listPrFilesByUrl(pr.url);
  // `resolved: pr` reuses the snapshot the gate decided on — no second `gh
  // pr list`, no window between the two. fetchPrHead reads fork-ness off
  // that RepoPr rather than deriving it, so it must be the real one.
  const { ref, base } = await ctx.prManager.fetchPrHead(pr.number, {
    confirmFork,
    resolved: pr,
  });
  const task = ctx.store.create(buildPrReviewTask({ ...pr, body }, files));
  try {
    ctx.cache.refresh(ctx.store, [task.meta.id]);
    // The worktree is cut here, behind fetchPrHead: any path that cut one
    // from an already-fetched ref would slip past the fork gate entirely.
    const meta = await ctx.reviewRunner.startReview({
      taskId: task.meta.id,
      base,
      head: ref,
      round: 0,
      scope: 'full',
      openFindings: ctx.findingStore.openFor(task.meta.id),
      // Findings belong on the PR, not on a run: this review has no run to
      // comment on — it reads the PR's head straight out of its own worktree.
      target: { kind: 'pr', number: pr.number },
      operator: humanOperator(ctx),
    });
    ctx.events.broadcast({ type: 'task.changed', ids: [task.meta.id] });
    return meta;
  } catch (err) {
    rollbackSynthesizedTask(ctx, task.meta.id);
    throw routableDispatchError(err);
  }
}

// WorktreeManager.add throws a bare Error, which api.ts's typed mapping does
// not route — the 500 it becomes carries no CORS headers, so the webview sees
// only a network failure. Re-raise anything unmapped as the 409 it really is.
function routableDispatchError(err: unknown): Error {
  const mapped =
    err instanceof OrchestratorNotFoundError ||
    err instanceof OrchestratorConflictError ||
    err instanceof OrchestratorClientError ||
    err instanceof TaskParseError ||
    err instanceof ConfigError;
  if (mapped) return err;
  // A thrown non-Error has no `.message`, and reading it off `null` throws
  // inside this catch — escaping to Bun's handler as the CORS-less 500 the
  // mapping above exists to prevent.
  const detail = err instanceof Error ? err.message : String(err);
  return new OrchestratorConflictError(
    `could not start the PR review: ${detail}`
  );
}

// A task whose review never started is debris: nothing links to it and
// nobody would think to look for it. Kept only if a run already references
// it — deleting it then would strand that run's taskId instead.
function rollbackSynthesizedTask(ctx: ApiContext, taskId: string): void {
  if (ctx.orchestrator.list().some((run) => run.taskId === taskId)) return;
  ctx.store.remove(taskId);
  ctx.cache.refresh(ctx.store, [taskId]);
}

// Shared by every /api/prs/:number/comments* route below: the store never
// talks to `gh`, so a bad number would otherwise write/read a nonsense
// `pr-NaN` target slug instead of 400ing. Mirrors PrManager's own private
// `requirePrNumber`, which the routes that DO call `gh` (below) go through
// internally.
function requirePrNumberParam(numberParam: string): number | null {
  const number = Number(numberParam);
  return Number.isInteger(number) && number > 0 ? number : null;
}

// The one wording for refusing to create a worktree for a closed/merged PR
// (Task 7 review, IMPORTANT 9) — such a worktree would just get deleted by
// the very next poll pass (PrManager's syncPrWorktrees), so this refuses up
// front instead of creating something already scheduled for cleanup.
function closedPrWorktreeMessage(pr: RepoPr): string {
  const word = pr.state === 'MERGED' ? 'merged' : 'closed';
  return (
    `PR #${pr.number} is ${word} on GitHub; cannot create a review ` +
    'worktree for a pull request that is no longer open.'
  );
}

// POST /api/prs/:number/worktree — cuts a review worktree for a repo PR,
// running the exact fork gate startPrAgentReview does (mirrors
// dispatchPrAgentReview's confirmFork handling) before anything touches
// disk: fetchPrHead is what actually writes refs/dispatch/pr/<n>, and
// PrWorktreeManager.create assumes that ref already exists. 200 with the
// resulting PrWorktreeState.
async function createPrWorktreeRoute(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  // resolveRepoPrByNumber resolves a closed/merged PR too (findRepoPr's
  // fallback) — refused here rather than left to create a worktree the next
  // poll pass would just delete again.
  if (pr.state !== 'OPEN') {
    return errorResponse(409, closedPrWorktreeMessage(pr));
  }
  const confirmFork = parsed.value.confirmFork === true;
  const refused = forkGate(pr, confirmFork);
  if (refused !== null) return refused;
  await ctx.prManager.fetchPrHead(pr.number, { confirmFork, resolved: pr });
  const state = await ctx.prWorktrees.create(pr.number);
  ctx.events.broadcast({ type: 'landing.changed' });
  return jsonResponse(state);
}

// DELETE /api/prs/:number/worktree — retires a worktree if it's clean; a
// dirty one is kept and reported back as a 409 so the client can say why. A
// path that exists but isn't one this manager created (Task 7 re-review)
// throws OrchestratorConflictError out of removeIfClean, which the router's
// catch-all maps to 409 — never a false `{removed: true}`.
async function removePrWorktreeRoute(
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  const kept = await ctx.prWorktrees.removeIfClean(number);
  if (kept !== null) {
    return jsonResponse(
      { error: 'worktree has uncommitted changes', ...kept },
      409
    );
  }
  ctx.events.broadcast({ type: 'landing.changed' });
  return jsonResponse({ removed: true });
}

/**
 * GET /api/prs/:number/comments — the PR-keyed twin of GET
 * /api/runs/:id/comments, but not a plain local read: a PR's comments can
 * change on github.com between page loads, so this pulls GitHub's current
 * set first (PrManager.syncPrComments — merges via mergeComments' six
 * rules and persists), then tags each with its review-thread id
 * (PrManager.syncReviewThreads) so PATCH .../comments/:id below has
 * something to resolve against. Both calls resolve `number` against
 * listRepoPrs() themselves (see PrManager.resolvePrForComments) — nothing
 * here forwards a caller-supplied URL to `gh`.
 */
async function listPrComments(
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  await ctx.prManager.syncPrComments(number);
  const comments = await ctx.prManager.syncReviewThreads(number);
  return jsonResponse(comments);
}

// POST /api/prs/:number/comments — the PR-keyed twin of POST
// /api/runs/:id/comments: a purely local draft, same as the run-keyed
// route. It stays `pending` on disk until POST
// /api/prs/:number/review-submit publishes it as part of one GitHub
// review — nothing here talks to `gh` beyond resolving `number` itself.
// Body validation runs first and PR resolution second, same order as
// commentRepoPr: with no `gh` call of its own otherwise, skipping
// resolveRepoPrByNumber would make this the only PR-comment route that
// both 201s a draft against a PR that doesn't exist AND never surfaces
// the project's `pr`-capability 409.
async function addPrComment(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const parsed = await parseAddCommentInput(req, false);
  if (!parsed.ok) return parsed.response;
  const pr = await resolveRepoPrByNumber(ctx, numberParam);
  if (pr === null) return errorResponse(404, `PR not found: #${numberParam}`);
  const comment = ctx.reviewComments.add(
    { kind: 'pr', number: pr.number },
    parsed.value
  );
  return jsonResponse(comment, 201);
}

/**
 * PATCH /api/prs/:number/comments/:commentId — resolves or unresolves the
 * comment's GitHub review thread (PrManager.resolveComment). Unlike the
 * run-keyed route's plain local flag flip, this talks to GitHub over
 * GraphQL: resolution lives on the *thread*, not the comment, and REST has
 * no way to touch it. 409s a comment GET hasn't threaded yet (no
 * `githubThreadId`) rather than flipping a local flag GitHub never saw.
 */
async function updatePrComment(
  req: Request,
  ctx: ApiContext,
  numberParam: string,
  commentId: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { resolved?: unknown };
  if (typeof body.resolved !== 'boolean') {
    return errorResponse(400, 'resolved must be a boolean');
  }
  const comment = await ctx.prManager.resolveComment(
    number,
    commentId,
    body.resolved
  );
  return jsonResponse(comment);
}

/**
 * POST /api/prs/:number/comments/:commentId/reply — posts the reply to
 * GitHub via REST's `in_reply_to` (PrManager.replyToComment), then appends
 * it locally under GitHub's own author/timestamp/id rather than the
 * caller's. 409s a comment that was never pushed to GitHub (no
 * `githubId`) — there is no thread there to reply into.
 */
async function replyPrComment(
  req: Request,
  ctx: ApiContext,
  numberParam: string,
  commentId: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { body?: unknown };
  if (typeof body.body !== 'string' || body.body.trim() === '') {
    return errorResponse(400, 'body is required');
  }
  const comment = await ctx.prManager.replyToComment(
    number,
    commentId,
    body.body.trim()
  );
  return jsonResponse(comment);
}

/**
 * POST /api/prs/:number/review-submit — pushes the pending comment batch
 * as one GitHub review (PrManager.pushPrReview).
 *
 * Deliberately NOT named POST /api/prs/:number/review: that path already
 * exists above (reviewRepoPr) as a `gh pr review` one-shot verdict with no
 * comment batch involved at all. Reusing it here would fire both `gh pr
 * review` AND this batch push for one submit action — two separate
 * reviews landing on the same PR. Naming this sibling `-submit` instead
 * mirrors POST /api/runs/:id/review-submit, which sits next to the
 * unrelated POST /api/runs/:id/review for exactly the same reason.
 *
 * GitHub requires a body for `comment`, same as `request-changes` — a
 * `comments[]`-only batch does not satisfy it, and an empty body with
 * nothing pending at all would otherwise 422 from `gh` itself. Both are
 * checked here as one clear 400 instead, before the call.
 */
async function submitPrReview(
  req: Request,
  ctx: ApiContext,
  numberParam: string
): Promise<Response> {
  const number = requirePrNumberParam(numberParam);
  if (number === null) {
    return errorResponse(400, `invalid PR number: ${numberParam}`);
  }
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { verdict?: unknown; body?: unknown };
  const verdict = body.verdict;
  if (
    verdict !== 'approve' &&
    verdict !== 'request-changes' &&
    verdict !== 'comment'
  ) {
    return errorResponse(
      400,
      "invalid verdict: expected 'approve', 'request-changes' or 'comment'"
    );
  }
  const text = typeof body.body === 'string' ? body.body.trim() : '';
  if (verdict === 'request-changes' && text === '') {
    return errorResponse(400, 'a request-changes review requires a body');
  }
  if (verdict === 'comment' && text === '') {
    // GitHub requires a body for a `comment` review the same as it does
    // for `request-changes` — a `comments[]`-only batch is not enough on
    // its own. Checked with the more specific "nothing at all" message
    // first: zero pending comments plus no body really is nothing to
    // submit, versus a body-less submit that does have comments queued,
    // which just needs a body added.
    const pending = ctx.reviewComments.pendingCount({ kind: 'pr', number });
    if (pending === 0) {
      return errorResponse(
        400,
        'nothing to submit — leave a note or a comment first'
      );
    }
    return errorResponse(400, 'a comment review requires a body');
  }
  const result = await ctx.prManager.pushPrReview(number, verdict, text);
  return jsonResponse(result);
}

// Validates an optional `model` body field the way createRun does: absent
// means "the configured role's model"; present must be a non-empty string.
// Returns the 400 to send, or the model (possibly undefined) to pass on.
// An optional `effort` body field: absent is fine, anything but one of the
// SDK's five levels is a 400.
function readOptionalEffort(
  value: unknown
):
  | { ok: true; effort: EffortLevel | undefined }
  | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, effort: undefined };
  if (!isEffortLevel(value)) {
    return {
      ok: false,
      response: errorResponse(
        400,
        `invalid effort: ${describeValue(value)} (expected ${EFFORT_LEVELS.join('|')})`
      ),
    };
  }
  return { ok: true, effort: value };
}

function readOptionalModel(
  value: unknown
): { ok: true; model: string | undefined } | { ok: false; response: Response } {
  if (value === undefined) return { ok: true, model: undefined };
  if (typeof value !== 'string' || value.trim() === '') {
    return {
      ok: false,
      response: errorResponse(
        400,
        'invalid model: expected a non-empty string'
      ),
    };
  }
  return { ok: true, model: value.trim() };
}

// POST /api/plan. `planner` is optional (defaults to 'claude'), same
// contract as createRun's `executor` field above: a name outside what's
// actually registered on this PlanManager instance (Phase 7's
// registerPlanner/registeredPlannerNames, mirroring the orchestrator's own
// executor registry) is a 400 naming every valid option. `model` is optional
// too: the Plans composer's pick for this plan, over the configured `plan`
// role's model.
async function startPlan(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    prompt?: unknown;
    planner?: unknown;
    model?: unknown;
  };
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    return errorResponse(400, 'invalid prompt: prompt is required');
  }
  const model = readOptionalModel(body.model);
  if (!model.ok) return model.response;
  const knownPlannerNames = ctx.planManager.registeredPlannerNames();
  if (
    body.planner !== undefined &&
    (typeof body.planner !== 'string' ||
      !knownPlannerNames.includes(body.planner))
  ) {
    return errorResponse(
      400,
      `invalid planner: ${describeValue(body.planner)} (expected ${knownPlannerNames.join('|')})`
    );
  }
  const plannerName =
    typeof body.planner === 'string' ? body.planner : 'claude';
  const record = ctx.planManager.startPlan(
    body.prompt,
    plannerName,
    undefined,
    'plan',
    undefined,
    model.model
  );
  return jsonResponse({ planId: record.id }, 202);
}

// POST /api/plan/:id/message — send a follow-up user message on an existing
// plan conversation. Returns 202 with the record already flipped back to
// `running`; the assistant's reply + refined proposal land asynchronously via
// the same `plan.changed` broadcast startPlan uses. 404s an unknown plan, and
// 409s a plan mid-turn or already confirmed (both raised by sendMessage).
async function sendPlanMessage(
  req: Request,
  ctx: ApiContext,
  planId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const record = ctx.planManager.sendMessage(planId, body.text);
  return jsonResponse(record, 202);
}

async function confirmPlan(
  req: Request,
  ctx: ApiContext,
  planId: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { proposal?: unknown };
  // Read the record before confirming: a plan started from a note (POST
  // /api/notes/:id/enrich) carries that note's id, and once confirm has
  // written the task the note has to be linked and closed out exactly the way
  // the plain promote path does — otherwise the hub would keep offering to
  // promote a note whose task already exists.
  const sourceNoteId = ctx.planManager.get(planId).sourceNoteId;
  const result = ctx.planManager.confirm(planId, body.proposal);
  // The confirm body is the human's own text, so they wrote these tasks.
  for (const id of [result.epicId, ...result.taskIds]) {
    const doc = id === undefined ? null : ctx.store.get(id);
    if (doc !== null) ctx.taskAuthorship?.created(doc, humanOperator(ctx));
  }
  if (sourceNoteId !== undefined && result.taskIds.length > 0) {
    linkNoteToTask(ctx, sourceNoteId, result.taskIds[0]);
  }
  return jsonResponse(result);
}

// POST /api/overseer — opens a overseer conversation and returns the full
// OverseerRecord immediately (202, state `running`), mirroring draftTask's
// return-the-record shape rather than startPlan's id-only body: the chat UI
// renders the opening user message straight from the response. The assistant's
// reply lands asynchronously via the `overseer.changed` broadcast. `backend`
// follows createRun's `executor` contract: optional, defaults to 'claude', and
// a name outside what's registered is a 400 naming every valid option.
// `model` is optional the same way: the composer's pick for this
// conversation, over the configured `overseer` role's model. `speaker` is the
// human whose lines the bus carries (see overseerSpeaker).
async function startOverseer(
  req: Request,
  ctx: ApiContext,
  speaker: Sender | null
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    prompt?: unknown;
    backend?: unknown;
    model?: unknown;
    effort?: unknown;
  };
  if (typeof body.prompt !== 'string' || body.prompt.trim() === '') {
    return errorResponse(400, 'invalid prompt: prompt is required');
  }
  const model = readOptionalModel(body.model);
  if (!model.ok) return model.response;
  const effort = readOptionalEffort(body.effort);
  if (!effort.ok) return effort.response;
  const knownBackendNames = ctx.overseerManager.registeredBackendNames();
  if (
    body.backend !== undefined &&
    (typeof body.backend !== 'string' ||
      !knownBackendNames.includes(body.backend))
  ) {
    return errorResponse(
      400,
      `invalid backend: ${describeValue(body.backend)} (expected ${knownBackendNames.join('|')})`
    );
  }
  const backendName =
    typeof body.backend === 'string' ? body.backend : 'claude';
  const record = ctx.overseerManager.start(
    body.prompt,
    backendName,
    model.model,
    effort.effort,
    speaker
  );
  return jsonResponse(record, 202);
}

// POST /api/overseer/:id/message — mirrors sendPlanMessage: 202 with the record
// already flipped back to `running`; the reply lands via `overseer.changed`.
// 404s an unknown conversation and 409s one mid-turn or a revoked overseer
// (raised by sendMessage and mapped by handleApi's outer catch).
async function sendOverseerMessage(
  req: Request,
  ctx: ApiContext,
  conversationId: string,
  speaker: Sender | null
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { text?: unknown };
  if (typeof body.text !== 'string' || body.text.trim() === '') {
    return errorResponse(400, 'invalid text: text is required');
  }
  const record = ctx.overseerManager.sendMessage(
    conversationId,
    body.text,
    speaker
  );
  return jsonResponse(record, 202);
}

// Who speaks on an overseer route: a human principal, whose lines the bus
// carries. Any other credential, the shared agent token above all, is null.
function overseerSpeaker(
  ctx: ApiContext,
  presented: string | null
): Sender | null {
  const result = resolvePrincipal(ctx, presented);
  if (!result.ok || result.principal.kind !== 'human') return null;
  return {
    address: result.principal.address,
    canDecide: result.principal.canDecide,
  };
}

// The optional session body POST /api/epics/:id/dispatch and /resume share.
// Only the shapes are checked here; the engine ranges the values (400 via
// OrchestratorClientError) so the CLI and desktop see one wording.
type EpicSessionBody = {
  concurrency?: number;
  executor?: string;
  maxSpendUsd?: number | null;
  maxRuns?: number | null;
};

function parseEpicSessionBody(
  value: unknown
): { ok: true; body: EpicSessionBody } | { ok: false; response: Response } {
  const raw = value as {
    concurrency?: unknown;
    executor?: unknown;
    maxSpendUsd?: unknown;
    maxRuns?: unknown;
  };
  if (raw.concurrency !== undefined && typeof raw.concurrency !== 'number') {
    return {
      ok: false,
      response: errorResponse(400, 'invalid concurrency: expected a number'),
    };
  }
  if (raw.executor !== undefined && typeof raw.executor !== 'string') {
    return {
      ok: false,
      response: errorResponse(400, 'invalid executor: expected a string'),
    };
  }
  // `null` lifts a ceiling, so these accept it alongside a number.
  for (const key of ['maxSpendUsd', 'maxRuns'] as const) {
    const v = raw[key];
    if (v !== undefined && v !== null && typeof v !== 'number') {
      return {
        ok: false,
        response: errorResponse(
          400,
          `invalid ${key}: expected a number or null`
        ),
      };
    }
  }
  return {
    ok: true,
    body: {
      concurrency: raw.concurrency,
      executor: raw.executor,
      maxSpendUsd: raw.maxSpendUsd as number | null | undefined,
      maxRuns: raw.maxRuns as number | null | undefined,
    },
  };
}

async function startEpic(
  req: Request,
  ctx: ApiContext,
  epicId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const checked = parseEpicSessionBody(parsed.value);
  if (!checked.ok) return checked.response;
  // The caller, never the body: their teammates' tasks stay theirs. Only a
  // human credential (the owner's only as the app token) gives the auto-fill
  // runs someone to act for.
  const operator = humanOperator(ctx);
  const session = await ctx.epicEngine.start(epicId, {
    ...checked.body,
    startedBy: humanActor(ctx),
    ...(operator === null ? {} : { operator }),
  });
  return jsonResponse(session, 201);
}

// POST /api/epics/:id/pause — bodyless; live runs keep going, no new ones
// start until /resume.
function pauseEpic(ctx: ApiContext, epicId: string): Response {
  return jsonResponse(ctx.epicEngine.pause(epicId));
}

// POST /api/epics/:id/resume — optionally re-ceilings the session on the way
// back to `active`; `executor` is fixed for the session's life so it is
// dropped here even when sent. The session now acts for whoever resumed it.
async function resumeEpic(
  req: Request,
  ctx: ApiContext,
  epicId: string
): Promise<Response> {
  const parsed = await readJsonBodyOptional(req);
  if (!parsed.ok) return parsed.response;
  const checked = parseEpicSessionBody(parsed.value);
  if (!checked.ok) return checked.response;
  const { concurrency, maxSpendUsd, maxRuns } = checked.body;
  const session = await ctx.epicEngine.resume(epicId, {
    concurrency,
    maxSpendUsd,
    maxRuns,
    operator: humanOperator(ctx),
  });
  return jsonResponse(session);
}

// POST /api/epics/:id/land — the one action that takes a finished epic
// branch to the default base: a PR through PrManager when the project has
// the `pr` capability (and the branch actually carries commits to PR),
// a local merge otherwise. All readiness validation — the partially-done
// refusal above all — lives in Orchestrator.epicLandStatus, which both
// paths run; its typed errors map through handleApi's outer catch.
async function landEpic(ctx: ApiContext, epicId: string): Promise<Response> {
  const status = ctx.orchestrator.epicLandStatus(epicId);
  if (ctx.prCapability && status.hasChanges) {
    const prUrl = await ctx.prManager.openEpicPr(epicId);
    return jsonResponse({ mode: 'pr', prUrl }, 201);
  }
  // No remote/gh — or nothing to PR at all (a no-commits epic still needs
  // closing out, which the local path handles without a merge).
  const result = ctx.orchestrator.landEpicLocally(epicId);
  return jsonResponse({ mode: 'merge', mergeCommit: result.mergeCommit });
}

// POST /api/merge-queue { runId }. Enqueues a finished, unreviewed run for
// the serial rebase -> verify -> merge pipeline. 404/409 map straight from
// MergeQueue.enqueue's typed errors via the shared handler below.
async function enqueueMergeQueue(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { runId?: unknown };
  if (typeof body.runId !== 'string' || body.runId.trim() === '') {
    return errorResponse(400, 'invalid runId: runId is required');
  }
  const entry = ctx.mergeQueue.enqueue(body.runId);
  return jsonResponse(entry, 201);
}

// POST /api/merge-queue/stack { taskId }. Enqueues every reviewable run
// across `taskId`'s stack (its blockedBy-connected component) in dependency
// order — see MergeQueue.enqueueStack's own comment for why that order lets
// the queue's existing waiting-blockers gating serialize the stack for free.
// 409 only when every member of the stack was skipped (nothing reviewable),
// mapped through the same OrchestratorConflictError -> 409 path as every
// other merge-queue action, below.
async function enqueueMergeQueueStack(
  req: Request,
  ctx: ApiContext
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { taskId?: unknown };
  if (typeof body.taskId !== 'string' || body.taskId.trim() === '') {
    return errorResponse(400, 'invalid taskId: taskId is required');
  }
  const entries = ctx.mergeQueue.enqueueStack(body.taskId);
  return jsonResponse(entries, 201);
}

// Routes every `/api/*` request. Called only for paths under `/api` — the
// caller (index.ts) handles `/ws` upgrades and static file serving itself.
// POST /api/notes — create a note/triage/follow-up/todo. Used by the app's
// Notes tab and (via the MCP `dispatch_note` tool) by agents flagging triage
// they find mid-run. `createdByRunId` optionally records which agent added it.
async function createNote(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    kind?: unknown;
    title?: unknown;
    body?: unknown;
    createdByRunId?: unknown;
  };
  if (
    typeof body.kind !== 'string' ||
    !NOTE_KINDS.includes(body.kind as NoteKind)
  ) {
    return errorResponse(
      400,
      `invalid kind: ${String(body.kind)} (expected ${NOTE_KINDS.join('|')})`
    );
  }
  if (typeof body.title !== 'string' || body.title.trim() === '') {
    return errorResponse(400, 'invalid title: title is required');
  }
  const note = ctx.noteStore.create({
    kind: body.kind as NoteKind,
    title: body.title.trim(),
    body: typeof body.body === 'string' ? body.body : undefined,
    createdByRunId:
      typeof body.createdByRunId === 'string' ? body.createdByRunId : undefined,
  });
  ctx.events.broadcast({ type: 'note.changed' });
  return jsonResponse(note, 201);
}

// PATCH /api/notes/:id — edit a note or toggle its done flag.
async function updateNote(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    title?: unknown;
    body?: unknown;
    kind?: unknown;
    done?: unknown;
  };
  if (
    body.kind !== undefined &&
    (typeof body.kind !== 'string' ||
      !NOTE_KINDS.includes(body.kind as NoteKind))
  ) {
    return errorResponse(400, `invalid kind: ${JSON.stringify(body.kind)}`);
  }
  try {
    const note = ctx.noteStore.update(id, {
      title: typeof body.title === 'string' ? body.title : undefined,
      body: typeof body.body === 'string' ? body.body : undefined,
      kind: body.kind as NoteKind | undefined,
      done: typeof body.done === 'boolean' ? body.done : undefined,
    });
    ctx.events.broadcast({ type: 'note.changed' });
    return jsonResponse(note);
  } catch {
    return errorResponse(404, `note not found: ${id}`);
  }
}

// DELETE /api/notes/:id.
function deleteNote(ctx: ApiContext, id: string): Response {
  try {
    ctx.noteStore.delete(id);
    ctx.events.broadcast({ type: 'note.changed' });
    return jsonResponse({ ok: true });
  } catch {
    return errorResponse(404, `note not found: ${id}`);
  }
}

// Marks a note as promoted: points it at the task that now carries its work
// and ticks it done, so the hub shows "→ t-xxxxxx" instead of offering to
// promote it again. Shared by the plain promote path and the AI-drafted one
// (confirmPlan), which reach this point at different times — hence the
// tolerance for the note having been deleted while its plan was in flight:
// the task stands on its own, there is just nothing left to link back to.
function linkNoteToTask(ctx: ApiContext, noteId: string, taskId: string): void {
  try {
    ctx.noteStore.update(noteId, { linkedTaskId: taskId, done: true });
  } catch {
    return;
  }
  ctx.events.broadcast({ type: 'note.changed' });
}

// POST /api/notes/:id/promote — turn a note into a real task (its title +
// body become the task's title + description), and link the note to the new
// task so the hub can show "promoted → t-xxxxxx" instead of offering it again.
function promoteNote(ctx: ApiContext, id: string): Response {
  const note = ctx.noteStore.get(id);
  if (note === null) return errorResponse(404, `note not found: ${id}`);
  if (note.linkedTaskId !== null) {
    return errorResponse(409, `note already promoted: ${note.linkedTaskId}`);
  }
  const task = ctx.store.create({
    title: note.title,
    description: note.body,
    // A triage an agent flagged is real work → default it to a task; everything
    // else (a follow-up/note/todo) becomes a task too, all in the backlog.
    kind: 'task',
  });
  // Cache first, link second: the note's `note.changed` broadcast is what
  // makes the hub render "→ t-xxxxxx", and that id has to already resolve in
  // the task cache by the time a client follows it.
  ctx.cache.refresh(ctx.store, [task.meta.id]);
  ctx.events.broadcast({ type: 'task.changed', ids: [task.meta.id] });
  linkNoteToTask(ctx, id, task.meta.id);
  return jsonResponse(task, 201);
}

// POST /api/inbox — capture raw text as ONE item, however many lines it takes.
// The normalization rule lives server-side in exactly one place rather than
// being reimplemented by every client (the desktop composer, the MCP tool, a
// future CLI).
async function addInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    text?: unknown;
    kind?: unknown;
    createdByRunId?: unknown;
  };
  const text = typeof body.text === 'string' ? body.text : '';
  if (text.trim() === '') return errorResponse(400, 'text is required');

  let kind: InboxKind | undefined;
  if (typeof body.kind === 'string') {
    if (!(INBOX_KINDS as readonly string[]).includes(body.kind)) {
      return errorResponse(400, `unknown inbox kind: ${body.kind}`);
    }
    kind = body.kind as InboxKind;
  }

  // A multi-line paste may hold several thoughts; the judgment says where
  // one ends and the next begins (see splitCapture). One line, no client, or
  // no confident boundary all yield the single item this always made.
  const createdByRunId =
    typeof body.createdByRunId === 'string' ? body.createdByRunId : null;
  const segments = await splitCapture(ctx.judgments, text);
  const created = ctx.inboxStore.addMany(
    segments.map((segment) => ({ text: segment, kind, createdByRunId }))
  );
  // `normalizeCapture` strips the leading bullet or checkbox from the capture's
  // FIRST line (one dump is one item, so only that line is a marker), leaving
  // nothing when the whole capture was that one marker — a 201 there would
  // claim a capture that never was.
  if (created.length === 0) {
    return errorResponse(400, 'text contained no capturable lines');
  }
  ctx.events.broadcast({ type: 'inbox.changed' });
  // The kind, epic and duplicate reading lands a moment later, off the
  // request: the row must appear the instant it is typed.
  ctx.inboxTriage.request();
  return jsonResponse(created, 201);
}

// PATCH /api/inbox/:id — retype an item, fix its wording, or toggle it done.
async function updateInbox(
  req: Request,
  ctx: ApiContext,
  id: string
): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as {
    kind?: unknown;
    text?: unknown;
    done?: unknown;
  };
  if (
    typeof body.kind === 'string' &&
    !(INBOX_KINDS as readonly string[]).includes(body.kind)
  ) {
    return errorResponse(400, `unknown inbox kind: ${body.kind}`);
  }
  try {
    const item = ctx.inboxStore.update(id, {
      kind:
        typeof body.kind === 'string' ? (body.kind as InboxKind) : undefined,
      text: typeof body.text === 'string' ? body.text : undefined,
      done: typeof body.done === 'boolean' ? body.done : undefined,
    });
    ctx.events.broadcast({ type: 'inbox.changed' });
    // New words, new reading — the snapshot is keyed by text hash.
    if (typeof body.text === 'string') ctx.inboxTriage.request();
    return jsonResponse(item);
  } catch (err) {
    return errorResponse(404, (err as Error).message);
  }
}

// POST /api/inbox/dismiss — drop items outright. A dismissed thought should not linger in an
// archive; the point of the inbox is that most of what lands in it is noise.
async function dismissInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return errorResponse(400, 'ids is required');
  ctx.inboxStore.remove(ids);
  ctx.events.broadcast({ type: 'inbox.changed' });
  return jsonResponse({ dismissed: ids.length });
}

/**
 * POST /api/inbox/convert — turn inbox items into real tasks.
 *
 * Spans two stores, so partial failure is a real outcome and is reported rather than swallowed:
 * the response carries a per-item result, and a caller that asked for five conversions and got
 * three has to be able to see which two did not land. Tasks are created first and the inbox is
 * linked afterwards, so an interrupted convert leaves an unlinked task (visible, recoverable)
 * rather than an inbox item pointing at a task that was never written.
 */
async function convertInbox(req: Request, ctx: ApiContext): Promise<Response> {
  const parsed = await readJsonBody(req);
  if (!parsed.ok) return parsed.response;
  const body = parsed.value as { ids?: unknown };
  const ids = Array.isArray(body.ids)
    ? body.ids.filter((v): v is string => typeof v === 'string')
    : [];
  if (ids.length === 0) return errorResponse(400, 'ids is required');

  const items = new Map(ctx.inboxStore.list().map((i) => [i.id, i]));
  // The triage's reading of each item, when it has one: a confident epic
  // becomes the new task's parent, and the strongest duplicate that is a
  // real task is reported back — never a refusal, a person asked for this.
  const triage = new InboxTriageSnapshotStore(ctx.rootDir).load();
  const results: {
    id: string;
    taskId?: string;
    /** An existing task the triage judged this capture a duplicate of. */
    duplicateOf?: string;
    error?: string;
  }[] = [];
  const links: { id: string; taskId: string }[] = [];

  for (const id of ids) {
    const item = items.get(id);
    if (item === undefined) {
      results.push({ id, error: `inbox item not found: ${id}` });
      continue;
    }
    if (item.linkedTaskId !== null) {
      // Already converted — report the existing task rather than making a second one.
      results.push({ id, taskId: item.linkedTaskId });
      continue;
    }
    try {
      // A multiline dump converts as first line -> title, the rest -> the
      // task's description — a paragraph is not a title.
      const [firstLine = '', ...restLines] = item.text.split('\n');
      const description = restLines.join('\n').trim();
      const reading = triage?.items[id];
      const parent =
        reading?.epicId != null && ctx.cache.isContainer(reading.epicId)
          ? reading.epicId
          : null;
      const duplicateOf = reading?.duplicates.find(
        (d) => ctx.cache.get(d.id) !== null
      )?.id;
      const task = ctx.store.create({
        title: firstLine,
        kind: 'task',
        ...(description === '' ? {} : { description }),
        ...(parent === null ? {} : { parent }),
      });
      markA2AChild(ctx, task.meta.id, parent);
      links.push({ id, taskId: task.meta.id });
      results.push({
        id,
        taskId: task.meta.id,
        ...(duplicateOf === undefined ? {} : { duplicateOf }),
      });
    } catch (err) {
      results.push({ id, error: (err as Error).message });
    }
  }

  if (links.length > 0) {
    // Cache first so the ids in the response already resolve for a client that follows them.
    ctx.cache.refresh(
      ctx.store,
      links.map((link) => link.taskId)
    );
    ctx.events.broadcast({
      type: 'task.changed',
      ids: links.map((link) => link.taskId),
    });
    ctx.inboxStore.markConverted(links);
    ctx.events.broadcast({ type: 'inbox.changed' });
  }

  const failed = results.filter((r) => r.error !== undefined).length;
  return jsonResponse({ results, converted: links.length, failed });
}

// The planning prompt behind "draft with AI": what a note is missing is
// context — which files it touches, what the code does today, what "done"
// means — so this asks the planner to go read the repo and spend that
// research on ONE task that keeps the note's original intent, rather than the
// epic-plus-breakdown a free-form plan prompt invites. The surrounding
// planner wrapper (planners/claude.ts) supplies the read-only framing and the
// output schema; this only supplies the request.
function buildNoteEnrichPrompt(note: Note): string {
  const kindLabel = note.kind === 'followup' ? 'follow-up' : note.kind;
  return [
    `Someone captured this one-line ${kindLabel} in a task tracker and wants ` +
      'it turned into a properly specified task before an agent picks it up.',
    `Title: ${note.title}`,
    note.body.trim() === '' ? null : `Notes: ${note.body.trim()}`,
    'Read enough of this repository to ground it: which files and functions ' +
      'are actually involved, what the code does today, and what would have ' +
      'to change. Then propose exactly ONE task, and no epic. Keep the ' +
      "original intent — sharpen the title, don't replace the request — and " +
      'write a description that gives an implementing agent the context this ' +
      'one-liner is missing, naming concrete paths where you found them. ' +
      'Acceptance criteria should be checkable statements about the finished ' +
      'work. Do not invent scope the note never asked for; if the repo ' +
      'contradicts the note, say so in the description rather than silently ' +
      'redesigning the work.',
  ]
    .filter((line): line is string => line !== null)
    .join('\n\n');
}

/**
 * POST /api/inbox/cluster — ask a model which captured items are one piece of
 * work. Always 200 with `error` set, since it runs unattended in the background.
 */
async function clusterInbox(ctx: ApiContext): Promise<Response> {
  const clusterer = ctx.inboxClusterer ?? new InboxClusterer(ctx.rootDir);
  try {
    // listAll(), not list(): clustering has to see every teammate's captures, not just this
    // daemon's own actor file, or two people describing the same work would never group. But
    // the response has to stay local: display (BrainDumpView) and convert both resolve ids
    // against list() only, so a group carrying a teammate's item id would overstate its count,
    // seed selection with an id the UI can't resolve, and fail convert outright. Filtering here
    // — rather than widening display/convert to cross-file reads — also keeps a teammate's
    // private capture text from ever reaching the local UI or a future model call over it.
    const localOpen = ctx.inboxStore.list().filter((i) => !i.done);
    const localIds = new Set(localOpen.map((i) => i.id));
    const all = ctx.inboxStore.listAll();
    // Triage first: an item with a confident epic has its home and never
    // reaches the clusterer, so the model call below only sees the rest. The
    // background scheduler owns the pass; waiting on it here keeps one writer
    // on the snapshot file.
    ctx.inboxTriage.request();
    await ctx.inboxTriage.idle();
    const triage = new InboxTriageSnapshotStore(ctx.rootDir).load();
    const groups = await clusterer.cluster(untriagedForClustering(all, triage));
    const localGroups = filterGroupsToLocalItems(groups, localIds);
    // Persisted so a page load renders this pass instead of billing a new one;
    // a failed pass below deliberately leaves the previous snapshot standing.
    new InboxClusterSnapshotStore(ctx.rootDir).save({
      groups: localGroups,
      itemIds: [...localIds],
      updatedAt: new Date().toISOString(),
    });
    return jsonResponse({ groups: localGroups, error: null });
  } catch (err) {
    return jsonResponse({ groups: [], error: (err as Error).message });
  }
}

// A stored JSON object with `readiness` appended as its last key, which is
// exactly where serializing `{ ...doc, readiness }` would put it.
function withReadiness(
  json: string,
  readiness: ReadinessReading | undefined
): string {
  return readiness === undefined
    ? json
    : `${json.slice(0, -1)},"readiness":${JSON.stringify(readiness)}}`;
}

// GET /api/tasks/ready — the ready set with each task's readiness reading
// attached (`readiness` absent when no judgment client is configured or the
// task could not be judged). Stale tasks are judged here, on demand, so the
// reading is as fresh as the text it describes. `fields=meta` drops the
// bodies and `fields=id` everything but the id, for a client that already
// holds the task list and needs only the queue and its readings.
async function getReadyTasks(
  ctx: ApiContext,
  fields: string | null
): Promise<Response> {
  if (fields !== null && fields !== 'meta' && fields !== 'id') {
    return errorResponse(400, `unknown fields: ${fields}`);
  }
  const ids = ctx.cache.readyIds(statusModelFor(ctx.rootDir));
  // Read before judging awaits, so the rows and readings are one snapshot.
  const stored =
    fields === 'id'
      ? null
      : ctx.cache.storedJson(ids, fields === 'meta' ? 'item' : 'json');
  const readings =
    ctx.judgments === null
      ? {}
      : await readinessFor(
          ctx.judgments,
          ctx.cache.getMany(ids),
          new ReadinessStore(ctx.rootDir)
        );
  const items = ids.flatMap((id) => {
    const json = stored === null ? JSON.stringify({ id }) : stored.get(id);
    return json === undefined ? [] : [withReadiness(json, readings[id])];
  });
  return jsonTextResponse(`[${items.join(',')}]`);
}

// The readiness cache as `{ [taskId]: reading }`, holding only readings still
// judged against their task's current text, and none without a judgment
// client: the ready route's readings, minus its judging.
function cachedReadiness(ctx: ApiContext): Record<string, unknown> {
  if (ctx.judgments === null) return {};
  return new ReadinessStore(ctx.rootDir).loadFresh((id) => ctx.cache.get(id));
}

// GET /api/inbox/clusters — the persisted result of the last clustering pass,
// or null when none has ever run (or the cache was corrupt).
function getInboxClusters(ctx: ApiContext): Response {
  return jsonResponse(new InboxClusterSnapshotStore(ctx.rootDir).load());
}

// GET /api/inbox/triage — the last triage pass (kind, epic, duplicates per
// item), or null when none has run or no judgment client is configured.
function getInboxTriage(ctx: ApiContext): Response {
  return jsonResponse(new InboxTriageSnapshotStore(ctx.rootDir).load());
}

/**
 * The prompt behind "add detail" on a task that already exists.
 *
 * Different job from the two above, and the difference matters: those turn a one-liner INTO a
 * task, while this one deepens a task that is already real and may already have been partly
 * specified by a human. So it is told explicitly to preserve what is there and add to it — the
 * failure mode to avoid is an agent helpfully rewriting a carefully-worded acceptance criterion
 * into something vaguer.
 */
// An A2A task's spec (a2a) is fenced as a client's words.
export function buildTaskEnrichPrompt(task: TaskDoc, a2a = false): string {
  // The two spec sections only — `task.body` verbatim would carry the template's empty
  // headings (so no task ever looks empty) and the agent-written Activity log.
  const existing = [
    getSection(task.body, 'Description'),
    getSection(task.body, 'Acceptance Criteria'),
  ]
    .filter((section) => section !== '')
    .join('\n\n');
  return [
    'A task in this repository is under-specified, and someone wants it fleshed out before an ' +
      'agent picks it up.',
    `Title: ${task.meta.title}`,
    existing === ''
      ? 'It currently has no description at all.'
      : `Its current description and criteria:\n\n${a2a ? untrustedFenced('an A2A client wrote this', existing) : existing}`,
    'Read enough of this repository to ground it: which files and functions are actually ' +
      'involved, what the code does today, and what would have to change. Then propose exactly ' +
      "ONE task, and no epic, keeping this task's title and intent. " +
      'PRESERVE everything already written that is still correct — you are adding the context ' +
      "this task is missing, not rewriting someone else's specification. Name concrete paths " +
      'where you found them. Acceptance criteria should be checkable statements about the ' +
      'finished work; keep any that already exist and add the ones that are missing. If the repo ' +
      'contradicts what the task says, say so in the description rather than silently ' +
      'redesigning the work.',
  ].join('\n\n');
}

// POST /api/tasks/:id/enrich — AI-draft fuller detail for an existing task. The plan only
// carries the draft; the client applies it via PATCH /api/tasks/:id, never confirm (which
// creates new tasks). No sourceNoteId either — that field is for note-derived plans only.
function enrichTask(ctx: ApiContext, id: string): Response {
  const task = ctx.cache.get(id);
  if (task === null || task === undefined) {
    return errorResponse(404, `task not found: ${id}`);
  }
  const record = ctx.planManager.startPlan(
    buildTaskEnrichPrompt(task, ctx.a2a?.taskOrigin(id) === 'a2a'),
    'claude',
    undefined,
    'enrich',
    task.meta.title
  );
  return jsonResponse({ planId: record.id }, 202);
}

// POST /api/notes/:id/enrich — start an AI draft of the task this note should
// become. Returns the plan's id immediately (202, same async contract as
// POST /api/plan): the client polls GET /api/plan/:id for the proposal and
// confirms it through POST /api/plan/:id/confirm, which is still the only
// place a task actually gets written.
function enrichNote(ctx: ApiContext, id: string): Response {
  const note = ctx.noteStore.get(id);
  if (note === null) return errorResponse(404, `note not found: ${id}`);
  if (note.linkedTaskId !== null) {
    return errorResponse(409, `note already promoted: ${note.linkedTaskId}`);
  }
  const record = ctx.planManager.startPlan(
    buildNoteEnrichPrompt(note),
    'claude',
    note.id,
    'enrich',
    note.title
  );
  return jsonResponse({ planId: record.id }, 202);
}

// Methods that only read; everything else counts as a state change, so a route
// added later is guarded by default rather than by opting in.
const READ_ONLY_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

// Origins allowed to drive this daemon — the same set resolveCorsOrigin in
// index.ts uses to decide whether a response may be read.
export function isTrustedOrigin(
  origin: string,
  // The daemon's own network origins, non-empty only in team-local mode (see
  // shared.ts). A teammate's page loaded from http://192.168.1.5:4771 makes
  // same-origin requests from exactly that origin; nothing else is added.
  own: ReadonlySet<string> = NO_OWN_ORIGINS
): boolean {
  return (
    origin === 'tauri://localhost' ||
    origin === 'https://tauri.localhost' ||
    origin === 'http://tauri.localhost' ||
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin) ||
    own.has(origin)
  );
}

const NO_OWN_ORIGINS: ReadonlySet<string> = new Set();

// CORS cannot stop a body-less cross-origin POST (no preflight, and headers go
// on only after the handler ran). Kept alongside the token guard below as
// defence in depth: Origin rejects the browser case, the token the co-resident
// case.
function rejectUntrustedOrigin(
  req: Request,
  own: ReadonlySet<string>
): Response | null {
  if (READ_ONLY_METHODS.has(req.method)) return null;
  const origin = req.headers.get('origin');
  // Browsers always send Origin on a state change; the CLI, MCP and curl never do.
  if (origin === null || isTrustedOrigin(origin, own)) return null;
  return errorResponse(403, 'cross-origin request rejected');
}

// Per-daemon token auth. An agent's Bash runs as the user, so it can read any
// secret at rest and this does not lock it out. What it buys: an agent using
// the credential it was handed cannot record a decision, so self-granting takes
// deliberate exfiltration rather than one curl against a port found in a file.

/**
 * The two tokens a daemon mints at startup. `agentToken` goes in the 0600
 * daemon file because the CLI and MCP have no other channel; `appToken` is
 * emitted once on stdout and never persisted, so there is no file to read it
 * out of.
 */
export interface DaemonTokenPair {
  agentToken: string;
  appToken: string;
}

/**
 * The pair plus the registry that says who each credential speaks for.
 *
 * Minting stays dumb — it makes two random strings and knows nothing about
 * people — and the registry is assembled in `bootServer`, which is where the
 * operator's identity is resolved. That split is why a caller may preset one
 * token (the Playwright harness does) without the registry going stale.
 */
export interface DaemonTokens extends DaemonTokenPair {
  registry: TokenRegistry;
}

export function mintDaemonTokens(): DaemonTokenPair {
  return {
    agentToken: randomBytes(32).toString('hex'),
    appToken: randomBytes(32).toString('hex'),
  };
}

// Every route that needs more than the request tier, by path segments after
// `/api/` (`*` matches one segment). The check runs once in handleApi, so a new
// privileged route is an entry here rather than another call site. See
// tiers.ts for what each tier means.
const ELEVATED_ROUTES: ReadonlyArray<{
  method: string;
  segments: readonly string[];
  tier: Exclude<AuthTier, 'request'>;
}> = [
  // ---- decide: adjudication -------------------------------------------------
  // Starting a preview runs a command out of the run's own worktree — a
  // worktree the agent just wrote to, including its package.json. On the
  // request tier an agent holding the on-disk agent token could use this to
  // execute code of its own choosing in the daemon's process group, outside
  // the sandbox its run was given. Stopping one is paired with it so the
  // control surface is not half-privileged. Decide rather than operator: it
  // runs the project's own dev command, which a reviewer needs to look at a
  // run, not a command of the caller's choosing.
  { method: 'POST', segments: ['runs', '*', 'preview'], tier: 'decide' },
  { method: 'DELETE', segments: ['runs', '*', 'preview'], tier: 'decide' },
  // A parked call's full input is what its approval gate previews; only a
  // human who may answer that gate reads it whole.
  {
    method: 'GET',
    segments: ['runs', '*', 'approvals', '*'],
    tier: 'decide',
  },
  // Handing out a credential is an adjudication: on the request tier an agent
  // holding the on-disk agent token could mint itself a second identity, and
  // listing holders tells it whose to go looking for. team/routes.ts further
  // caps what a caller may issue or revoke at their own tier.
  { method: 'GET', segments: ['team', 'tokens'], tier: 'decide' },
  // Where the daemon is reachable is only useful to someone handing out a
  // token, and it names the operator's network addresses.
  { method: 'GET', segments: ['team', 'address'], tier: 'decide' },
  { method: 'POST', segments: ['team', 'tokens'], tier: 'decide' },
  { method: 'DELETE', segments: ['team', 'tokens', '*'], tier: 'decide' },
  // Settings are the project's policy — autonomy gates, caps, what a run may
  // do — so changing them is an adjudication, never something an agent
  // holding the on-disk token may do to itself. Keys that run commands, send
  // data elsewhere, or decide whether and where the daemon pushes with the
  // owner's git credentials need the operator tier on top (operatorOnlyKeys).
  { method: 'PATCH', segments: ['config'], tier: 'decide' },
  // The label registry lives in config.yml, so coloring a label is a settings
  // write like any other.
  { method: 'PUT', segments: ['labels'], tier: 'decide' },
  // Installing a license key changes who may sign in to this machine's
  // daemon at all — the owner's call, like the rest of the operator tier.
  { method: 'PUT', segments: ['license'], tier: 'operator' },
  // Approving, revoking or (un)muting an agent is an adjudication: on the
  // request tier the shared agentToken could approve itself onto the roster.
  { method: 'POST', segments: ['agents', '*', 'approve'], tier: 'decide' },
  { method: 'POST', segments: ['agents', '*', 'revoke'], tier: 'decide' },
  { method: 'POST', segments: ['agents', '*', 'mute'], tier: 'decide' },
  { method: 'POST', segments: ['agents', '*', 'unmute'], tier: 'decide' },
  // A fresh A2A client token is a credential handed out; an A2A task list
  // names every client's questions, and declining one answers it.
  {
    method: 'POST',
    segments: ['a2a', 'clients', '*', 'rotate'],
    tier: 'decide',
  },
  { method: 'GET', segments: ['a2a', 'tasks'], tier: 'decide' },
  {
    method: 'POST',
    segments: ['a2a', 'tasks', '*', 'decline'],
    tier: 'decide',
  },
  // Registering or changing a peer decides where this machine sends mail;
  // private URLs and --allow-http/--allow-origin need the operator, checked in addPeer.
  { method: 'POST', segments: ['a2a', 'peers'], tier: 'decide' },
  {
    method: 'POST',
    segments: ['a2a', 'peers', '*', 'refresh'],
    tier: 'decide',
  },
  {
    method: 'POST',
    segments: ['a2a', 'peers', '*', 'enable'],
    tier: 'decide',
  },
  {
    method: 'POST',
    segments: ['a2a', 'peers', '*', 'disable'],
    tier: 'decide',
  },
  { method: 'DELETE', segments: ['a2a', 'peers', '*'], tier: 'decide' },

  // ---- operator: acting on the host machine as its owner --------------------
  // Writing a file straight to disk bypasses the orchestrator, which is what
  // holds a run's edits to the task's declared `writes` and records them.
  // Reads stay on the request tier with the rest of the read surface.
  { method: 'POST', segments: ['files', 'write'], tier: 'operator' },
  // Opening the A2A listener exposes this machine on a network port and
  // points the daemon at TLS files on disk; closing it is paired.
  { method: 'PUT', segments: ['a2a', 'listener'], tier: 'operator' },
  // Standalone A2A hosts put this project on another machine's network
  // (spec:1656); minting, listing and revoking them is the owner's call.
  { method: 'GET', segments: ['a2a', 'hosts'], tier: 'operator' },
  { method: 'POST', segments: ['a2a', 'hosts'], tier: 'operator' },
  { method: 'DELETE', segments: ['a2a', 'hosts', '*'], tier: 'operator' },
  {
    method: 'PUT',
    segments: ['a2a', 'listener', 'standalone'],
    tier: 'operator',
  },
  { method: 'DELETE', segments: ['a2a', 'listener'], tier: 'operator' },
  // The stored Linear key is the credential the daemon acts on Linear with,
  // kept in the owner's own ~/.dispatch/credentials.json: choosing it picks
  // whose account, and which workspace, the board is sent to — the same call
  // as notifications.webhook or sync.repo. Disconnecting is paired so the
  // control is not half-privileged. Using the key once set stays on the
  // request tier: sync pushes board data the caller can already read to a
  // destination higher tiers chose, and import only brings issues in.
  { method: 'POST', segments: ['linear', 'connect'], tier: 'operator' },
  { method: 'POST', segments: ['linear', 'disconnect'], tier: 'operator' },
  // `evaluate` runs arbitrary JavaScript in a browser carrying the user's own
  // session cookies, which is at least the authority a shell has. The whole
  // family stays together for that reason.
  { method: 'GET', segments: ['browser'], tier: 'operator' },
  { method: 'POST', segments: ['browser'], tier: 'operator' },
  { method: 'GET', segments: ['browser', '*'], tier: 'operator' },
  { method: 'DELETE', segments: ['browser', '*'], tier: 'operator' },
  { method: 'POST', segments: ['browser', '*', 'navigate'], tier: 'operator' },
  { method: 'POST', segments: ['browser', '*', 'click'], tier: 'operator' },
  { method: 'POST', segments: ['browser', '*', 'fill'], tier: 'operator' },
  { method: 'GET', segments: ['browser', '*', 'text'], tier: 'operator' },
  { method: 'POST', segments: ['browser', '*', 'evaluate'], tier: 'operator' },
  { method: 'GET', segments: ['browser', '*', 'screenshot'], tier: 'operator' },
  { method: 'POST', segments: ['browser', '*', 'pick'], tier: 'operator' },
  { method: 'GET', segments: ['browser', '*', 'pick'], tier: 'operator' },
  // A terminal is arbitrary command execution in the project's checkout, so
  // the whole family sits here. On a lower tier, any holder could open a shell
  // and walk straight around the scope, floor and approval gates the rest of
  // this file enforces — reading output is listed too, since scrollback
  // carries whatever the human typed into it, credentials included.
  { method: 'GET', segments: ['terminals'], tier: 'operator' },
  { method: 'POST', segments: ['terminals'], tier: 'operator' },
  { method: 'GET', segments: ['terminals', '*'], tier: 'operator' },
  { method: 'DELETE', segments: ['terminals', '*'], tier: 'operator' },
  { method: 'GET', segments: ['terminals', '*', 'output'], tier: 'operator' },
  { method: 'POST', segments: ['terminals', '*', 'input'], tier: 'operator' },
  { method: 'POST', segments: ['terminals', '*', 'resize'], tier: 'operator' },
  { method: 'POST', segments: ['terminals', '*', 'close'], tier: 'operator' },
  // Git operations that change the operator's own checkout or push with their
  // credentials. On a shared daemon these would otherwise let any invited
  // teammate discard someone's uncommitted work or push to their remote.
  // Reads, `fetch` (refs only, never the working tree) and drafting a commit
  // message stay on the request tier. Only the desktop app calls these — the
  // CLI and the agents' MCP tools never do — and the app holds the app token.
  ...(
    [
      'stage',
      'unstage',
      'stage-hunk',
      'unstage-hunk',
      'discard',
      'commit',
      'checkout',
      'branch',
      'stash',
      'pull',
      'push',
      'cherry-pick',
      'revert',
    ] as const
  ).map((op) => ({
    method: 'POST',
    segments: ['git', op],
    tier: 'operator' as const,
  })),
  { method: 'DELETE', segments: ['git', 'branch', '*'], tier: 'operator' },
  { method: 'POST', segments: ['git', 'stash', 'pop'], tier: 'operator' },
  { method: 'POST', segments: ['git', 'stash', 'drop'], tier: 'operator' },
];

// A task id as the board mints them (`t-` or `e-` and a hex tag), with room
// for a longer tag. Only a shape check: focus names a task someone has open,
// and a task that does not exist is harmless there.
const TASK_ID_SHAPE = /^[a-z]-[0-9a-z]{1,64}$/;

function matchesRoute(
  pattern: readonly string[],
  segments: readonly string[]
): boolean {
  return (
    pattern.length === segments.length &&
    pattern.every((part, i) => part === '*' || part === segments[i])
  );
}

// Routes that authenticate via resolvePrincipal instead of the request/
// decide/operator ladder below; an entry here skips the tier check.
const SELF_AUTHENTICATED_ROUTES: ReadonlyArray<{
  method: string;
  segments: readonly string[];
}> = [
  { method: 'POST', segments: ['messages'] },
  { method: 'GET', segments: ['messages', '*'] },
  { method: 'POST', segments: ['messages', '*', 'reply'] },
  { method: 'GET', segments: ['messages', '*', 'answer'] },
  { method: 'GET', segments: ['threads'] },
  { method: 'GET', segments: ['threads', '*'] },
  { method: 'GET', segments: ['mailbox'] },
  { method: 'POST', segments: ['deliveries', '*', 'read'] },
  { method: 'GET', segments: ['channels'] },
  { method: 'POST', segments: ['channels', '*', 'members'] },
  { method: 'DELETE', segments: ['channels', '*', 'members'] },
  { method: 'DELETE', segments: ['channels', '*', 'members', '*'] },
  { method: 'GET', segments: ['decisions', 'open'] },
  { method: 'GET', segments: ['memory'] },
  { method: 'GET', segments: ['memory', '*'] },
  { method: 'POST', segments: ['memory', 'import', 'ledger'] },
  { method: 'POST', segments: ['memory', 'import', 'claude'] },
  { method: 'POST', segments: ['memory'] },
  { method: 'POST', segments: ['memory', 'link'] },
  { method: 'POST', segments: ['memory', 'link', '*'] },
  { method: 'POST', segments: ['memory', '*', '*'] },
  { method: 'DELETE', segments: ['memory', '*'] },
  { method: 'GET', segments: ['memory', 'proposals', '*'] },
  { method: 'POST', segments: ['memory', 'ingest-problems', '*', 'accept'] },
];

// Route families that authenticate by principal throughout, every method.
const SELF_AUTHENTICATED_PREFIXES: ReadonlySet<string> = new Set(['docs']);

/** Whether `/api/<segments>` is a messaging route that authenticates by
 *  principal, not tier: requiredTier skips it and handleApi resolves it. */
export function isSelfAuthenticated(
  segments: readonly string[],
  method: string
): boolean {
  if (segments.length > 0 && SELF_AUTHENTICATED_PREFIXES.has(segments[0])) {
    return true;
  }
  return SELF_AUTHENTICATED_ROUTES.some(
    (route) => route.method === method && matchesRoute(route.segments, segments)
  );
}

/**
 * The tier a request to `/api/<segments>` must present, or null when open.
 * `GET /api/health` is the only open route, because the CLI, MCP and the
 * desktop sidecar all probe it to discover a daemon before they hold a token.
 */
function requiredTier(
  method: string,
  segments: readonly string[]
): AuthTier | null {
  if (
    (method === 'GET' || method === 'HEAD') &&
    segments.length === 1 &&
    segments[0] === 'health'
  ) {
    return null;
  }
  // Signing in is how a browser gets a credential, so it cannot require one;
  // it checks the token in its body itself. Signing out only clears a cookie.
  if (
    (method === 'POST' || method === 'DELETE') &&
    segments.length === 1 &&
    segments[0] === 'session'
  ) {
    return null;
  }
  // Self-authenticating routes check via resolvePrincipal in handleApi, not
  // this ladder — returning null here just opens the gate for them.
  if (isSelfAuthenticated(segments, method)) return null;
  // A standalone host's routes accept its host token only, checked in
  // a2a/portRoutes.ts; A2A client tokens were already refused above.
  if (segments[0] === 'a2a' && segments[1] === 'port') return null;
  for (const route of ELEVATED_ROUTES) {
    if (route.method === method && matchesRoute(route.segments, segments)) {
      return route.tier;
    }
  }
  return 'request';
}

/** The credential a request presents: a bearer header, or failing that a
 *  team-local session cookie sent from the daemon's own page (session.ts). The
 *  header wins so the CLI, MCP and desktop app are never affected by a stray
 *  cookie. */
function presentedCredential(
  req: Request,
  sessionOrigins: ReadonlySet<string>
): string | null {
  return bearerToken(req) ?? sessionToken(req, sessionOrigins);
}

/** The bearer token on a request, or null when the header is absent or malformed. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get('authorization');
  if (header === null) return null;
  const match = /^Bearer[ ]+(\S+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}

const MISSING_TOKEN_MESSAGE =
  'missing daemon token: send `Authorization: Bearer <token>`. The CLI and MCP ' +
  'read `agentToken` from ~/.dispatch/daemons/<key>.json; if that file has no ' +
  '`agentToken`, the daemon predates token auth — restart it.';

const INVALID_TOKEN_MESSAGE =
  'daemon token not recognized: it belongs to a different or restarted daemon. ' +
  'Re-read `agentToken` from ~/.dispatch/daemons/<key>.json.';

/** Why a valid credential was turned away, naming the tier it lacked. The
 *  operator's own fix (the app token) and a teammate's (ask for a higher
 *  tier) are different, so both are spelled out. */
function wrongTierMessage(required: AuthTier, held: AuthTier): string {
  return (
    `this route needs the ${required} tier and this credential carries ` +
    `${held}. On your own machine, pass the daemon app token with --token or ` +
    'DISPATCH_APP_TOKEN (the DISPATCH_APP_TOKEN line the daemon prints at ' +
    'startup; restart the daemon if you no longer have it). As a teammate, ask ' +
    `whoever runs the daemon for \`dispatch team invite <you> --tier ${required}\`.`
  );
}

function authErrorResponse(
  status: number,
  message: string,
  code: string
): Response {
  const res = jsonResponse({ error: message, code }, status);
  if (status === 401) res.headers.set('www-authenticate', 'Bearer');
  return res;
}

/**
 * Rejects a request whose token is not good for `required`, or null to let it
 * through. 401 is "no usable credential"; 403 is "valid, but ranks below this
 * route" — the distinction a client needs to tell those two apart.
 */
export function rejectUnauthorized(
  req: Request,
  tokens: DaemonTokens,
  required: AuthTier,
  presented: string | null = bearerToken(req)
): Response | null {
  if (presented === null) {
    return authErrorResponse(401, MISSING_TOKEN_MESSAGE, 'auth_missing_token');
  }
  const found = tokens.registry.lookup(presented);
  if (found.kind === 'expired') {
    return authErrorResponse(
      401,
      expiredTokenMessage(found.handle, found.expiredAt),
      'auth_token_expired'
    );
  }
  if (found.kind === 'refused') {
    // A real teammate, just one more than the license covers: say so, so the
    // person can ask for a seat instead of doubting their token.
    return authErrorResponse(403, found.reason, 'seat_limit');
  }
  const caller = found.kind === 'valid' ? found.identity : null;
  if (caller === null) {
    return authErrorResponse(401, INVALID_TOKEN_MESSAGE, 'auth_invalid_token');
  }
  if (!tierAllows(caller.tier, required)) {
    return authErrorResponse(
      403,
      wrongTierMessage(required, caller.tier),
      'auth_insufficient_tier'
    );
  }
  return null;
}

export async function handleApi(
  req: Request,
  daemonCtx: ApiContext
): Promise<Response> {
  const url = new URL(req.url);
  const segments = url.pathname
    .replace(/^\/api\/?/, '')
    .split('/')
    .filter(Boolean);
  const method = req.method;

  const untrusted = rejectUntrustedOrigin(req, daemonCtx.ownOrigins);
  if (untrusted !== null) return untrusted;

  // Linear's deliveries carry no daemon token: this one exact route is
  // admitted by path and gated on its HMAC signature instead (see
  // api/linearWebhook.ts). Nothing else skips the token check.
  if (isLinearWebhook(method, segments)) {
    return await linearWebhook(req, daemonCtx);
  }

  const presented = presentedCredential(req, daemonCtx.sessionOrigins);

  // An A2A client's bearer never works on /api, open routes included. Only a
  // token the registry does not know reaches the messages.db lookup.
  if (
    presented !== null &&
    daemonCtx.tokens.registry.lookup(presented).kind === 'unknown' &&
    isA2AClientToken(daemonCtx.messaging.store, presented)
  ) {
    return authErrorResponse(
      403,
      'A2A client tokens work only on the A2A listener',
      'auth_a2a_client'
    );
  }

  // Resolves and enforces the principal here, before dispatch, so every
  // self-authenticated route fails closed even with no handler behind it.
  let principal: Principal | undefined;
  if (isSelfAuthenticated(segments, method)) {
    const principalResult = resolvePrincipal(daemonCtx, presented);
    if (!principalResult.ok) {
      return authErrorResponse(
        principalResult.status,
        principalResult.error,
        principalResult.code
      );
    }
    principal = principalResult.principal;
  }

  const tier = requiredTier(method, segments);
  if (tier !== null) {
    const unauthorized = rejectUnauthorized(
      req,
      daemonCtx.tokens,
      tier,
      presented
    );
    if (unauthorized !== null) return unauthorized;
  }

  // Every handler below sees who made this request. A shallow copy per
  // request, so the daemon-wide context is never mutated with one caller's
  // identity and a concurrent request can never read someone else's.
  const caller = daemonCtx.tokens.registry.resolve(presented);
  // The shared agentToken resolves to the owner but is never a human; a
  // constant-time digest compare, as resolvePrincipal does.
  const viaAgentToken =
    presented !== null &&
    timingSafeEqual(sha256(presented), sha256(daemonCtx.tokens.agentToken));
  const ownerCredential =
    presented !== null &&
    timingSafeEqual(sha256(presented), sha256(daemonCtx.tokens.appToken));
  let ctx: ApiContext = daemonCtx;
  if (caller !== null) ctx = { ...ctx, caller, viaAgentToken, ownerCredential };
  if (principal !== undefined) ctx = { ...ctx, principal };

  try {
    if (segments[0] === 'health' && segments.length === 1 && method === 'GET') {
      // `rootDir` lets the web UI show a project name (its basename) in the
      // top bar without a separate endpoint — see the phase-2 plan's Slice
      // S3 TopBar requirement.
      //
      // Whether this process is still the daemon the file under
      // ~/.dispatch/daemons names — read fresh per probe (see daemonfile.ts).
      const identity = checkDaemonIdentity(ctx.rootDir, ctx.claimsDaemonFile);
      return jsonResponse({
        ok: true,
        version: ctx.version,
        rootDir: ctx.rootDir,
        // Task files the cache couldn't parse (e.g. missing
        // frontmatter, invalid kind) — empty when the task set is clean. The
        // daemon keeps serving the last-good cache regardless; this is
        // visibility, not a fatal signal (`ok` stays true). A displaced or
        // unregistered daemon adds its own line here for the same reason:
        // it still serves whoever reaches it, but clients following the
        // daemon file will not.
        problems: [
          ...ctx.cache.problems(),
          ...(identity.problem === null ? [] : [identity.problem]),
          ...receiptsProblems(ctx),
          ...ctx.team.teammates.problems(),
          ...ctx.memory.restoreProblems(),
          ...(ctx.a2a?.problems() ?? []),
        ],
        // The same fact as an enum, so a client can branch on it without
        // matching the problem string.
        identity: identity.identity,
        // Phase 5 P1: whether this project can use the PR review action
        // (gh on PATH + a configured git remote), detected once at boot.
        pr: ctx.prCapability,
        // Who is answering and what it will run. On 2026-09-08 a fleet ran
        // on the wrong model for two days and nothing surfaced it, and two
        // daemons served one root with only `ps` able to tell them apart.
        // Health is the one open route every client probes, so it carries
        // the process identity and the fully-defaulted per-role model map
        // (read fresh, since config.yml can change under a live daemon).
        pid: process.pid,
        startedAt: ctx.startedAt,
        models: loadConfig(ctx.rootDir).models,
        watchdog: ctx.watchdogStatus(),
        // Which backend the task store uses, so a client can show only the
        // settings that apply to it (autoCommit is file-backend-only).
        storageBackend: ctx.storeBackend,
      });
    }

    if (segments[0] === 'team' && segments[1] === 'tokens') {
      if (segments.length === 2 && method === 'GET') return listTeamTokens(ctx);
      if (segments.length === 2 && method === 'POST') {
        return await issueTeamToken(req, ctx);
      }
      if (segments.length === 3 && method === 'DELETE') {
        return revokeTeamToken(ctx, segments[2]);
      }
    }

    // GET /api/license — how many people may use this project together and
    // how many already do; PUT installs a key (team/license.ts).
    if (segments.length === 1 && segments[0] === 'license') {
      if (method === 'GET') return getLicense(ctx);
      if (method === 'PUT') return await installLicense(req, ctx);
    }

    // GET /api/presence — who is here and what they are running. Derived on
    // every read from open sockets and live runs, so there is nothing to go
    // stale.
    if (
      segments[0] === 'presence' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      return jsonResponse(
        ctx.presence.list(
          ctx.orchestrator.list().map((run) => ({
            id: run.id,
            dispatchedBy: run.dispatchedBy,
            live: !TERMINAL_RUN_STATES.has(run.state),
          }))
        )
      );
    }

    // POST /api/presence/focus — which task this person has open, or null
    // when they close it. Request tier, like the rest of the board: it says
    // where someone is looking, which the board they can read already shows.
    if (
      segments[0] === 'presence' &&
      segments[1] === 'focus' &&
      segments.length === 2 &&
      method === 'POST'
    ) {
      const parsed = await readJsonBody(req);
      if (!parsed.ok) return parsed.response;
      const taskId = (parsed.value as { taskId?: unknown }).taskId;
      if (
        taskId !== null &&
        (typeof taskId !== 'string' || !TASK_ID_SHAPE.test(taskId))
      ) {
        return errorResponse(400, 'expected { taskId: string | null }');
      }
      if (ctx.caller === undefined) {
        return errorResponse(401, 'credential resolves to no one');
      }
      if (ctx.presence.setFocus(ctx.caller.handle, taskId)) {
        ctx.events.broadcast({ type: 'presence.changed' });
      }
      return jsonResponse({ ok: true });
    }

    // GET /api/board-sync — board sync's state: whether it is on (and why
    // not, when it is off), when it last ran, what is waiting to go, and
    // anything it could not resolve alone. POST /api/board-sync/now runs a pass and answers once it is
    // done, for a person who does not want to wait for the interval.
    // Not /api/sync: that is the file backend's board syncer, already
    // answered below and read by the app's status strip.
    if (segments[0] === 'board-sync') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(
          ctx.boardSync?.status() ?? {
            enabled: false,
            reason: boardSyncOffReason(ctx),
          }
        );
      }
      if (segments.length === 2 && segments[1] === 'now' && method === 'POST') {
        if (ctx.boardSync === null) {
          return errorResponse(
            409,
            BOARD_SYNC_OFF_MESSAGE[boardSyncOffReason(ctx)]
          );
        }
        await ctx.boardSync.syncNow();
        return jsonResponse(ctx.boardSync.status());
      }
    }

    // GET /api/team/address — where teammates reach this daemon, for the
    // Team page to put beside a freshly issued token. Empty on loopback, which
    // is the page's cue to explain `--host 0.0.0.0` instead.
    if (
      segments[0] === 'team' &&
      segments[1] === 'address' &&
      segments.length === 2 &&
      method === 'GET'
    ) {
      return jsonResponse({
        shared: ctx.shared,
        origins: [...ctx.ownOrigins].sort(),
      });
    }

    // GET /api/whoami — who the presented credential speaks for. The one
    // endpoint that exists purely because tokens now name people: presence,
    // claims and attribution all need a caller to be identifiable before they
    // can mean anything, and this is how a client checks that it is.
    if (segments[0] === 'whoami' && segments.length === 1 && method === 'GET') {
      // requiredTier already rejected an unusable credential, so a missing
      // caller here would be a bug rather than an unauthenticated one.
      if (ctx.caller === undefined) {
        return errorResponse(401, 'credential resolves to no one');
      }
      return jsonResponse(ctx.caller);
    }

    // POST /api/session — a teammate's browser trades the token it was given
    // for an HttpOnly session cookie, so the page never has to hold it.
    // DELETE clears it. Both sit behind rejectUntrustedOrigin above, so a
    // page on another origin can neither sign someone in nor out.
    if (segments[0] === 'session' && segments.length === 1) {
      if (method === 'DELETE') {
        const res = jsonResponse({ ok: true });
        res.headers.set('set-cookie', clearedSessionCookie(req));
        return res;
      }
      if (method === 'POST') {
        const parsed = await readJsonBody(req);
        if (!parsed.ok) return parsed.response;
        const token = (parsed.value as { token?: unknown }).token;
        if (typeof token !== 'string' || token === '') {
          return errorResponse(400, 'expected { token }');
        }
        const unauthorized = rejectUnauthorized(
          req,
          ctx.tokens,
          'request',
          token
        );
        if (unauthorized !== null) return unauthorized;
        const who = ctx.tokens.registry.resolve(token);
        if (who === null) return errorResponse(401, 'token not recognized');
        const res = jsonResponse(who);
        res.headers.set('set-cookie', sessionCookie(req, token));
        return res;
      }
    }

    if (segments[0] === 'config' && segments.length === 1 && method === 'GET') {
      // Webhook URLs are credentials; see secretUrls.ts.
      return jsonResponse(redactSecretUrls(loadConfig(ctx.rootDir)));
    }
    if (
      segments[0] === 'config' &&
      segments.length === 1 &&
      method === 'PATCH'
    ) {
      return await patchConfig(req, ctx);
    }

    if (segments[0] === 'sync' && segments.length === 1 && method === 'GET') {
      return getSyncStatus(ctx);
    }

    if (segments[0] === 'linear' && segments.length === 2) {
      if (segments[1] === 'status' && method === 'GET') {
        return jsonResponse(ctx.linearSync.status());
      }
      if (segments[1] === 'connect' && method === 'POST') {
        return await connectLinear(req, ctx);
      }
      if (segments[1] === 'disconnect' && method === 'POST') {
        return await disconnectLinear(ctx);
      }
      if (segments[1] === 'teams' && method === 'GET') {
        return await linearTeams(ctx);
      }
      // GET /api/linear/links — issue UUID -> { identifier, url }, so a client
      // holding only `TaskMeta.external` can render a real "ENG-123" chip.
      if (segments[1] === 'links' && method === 'GET') {
        return jsonResponse(ctx.linearSync.links());
      }
      // POST /api/linear/import — bring down Linear issues that have no local
      // task. Deliberately explicit: an ordinary sync never imports a backlog.
      if (segments[1] === 'import' && method === 'POST') {
        return jsonResponse(await ctx.linearSync.importIssues());
      }
      if (segments[1] === 'states' && method === 'GET') {
        return await linearStates(ctx, url.searchParams.get('teamId'));
      }
      // POST /api/linear/sync — run a pass now. An optional `taskIds` array pushes exactly
      // those tasks, bypassing the gate that keeps a first sync from flooding the workspace.
      if (segments[1] === 'sync' && method === 'POST') {
        const parsed = await readJsonBodyOptional(req);
        if (!parsed.ok) return parsed.response;
        const raw = parsed.value.taskIds;
        if (
          raw !== undefined &&
          (!Array.isArray(raw) || !raw.every((v) => typeof v === 'string'))
        ) {
          return errorResponse(400, 'taskIds must be a list of strings');
        }
        return jsonResponse(await ctx.linearSync.syncOnce(raw));
      }
    }

    if (segments[0] === 'files' && segments.length === 2) {
      if (segments[1] === 'tree' && method === 'GET') {
        return listDirectory(ctx, url.searchParams);
      }
      if (segments[1] === 'read' && method === 'GET') {
        return readWorkspaceFile(ctx, url.searchParams);
      }
      if (segments[1] === 'raw' && method === 'GET') {
        return rawFile(ctx, url.searchParams);
      }
      if (segments[1] === 'search' && method === 'GET') {
        return await searchFiles(ctx, url.searchParams);
      }
      if (segments[1] === 'write' && method === 'POST') {
        return await writeWorkspaceFile(req, ctx);
      }
    }

    // GET /api/remotes — the machines this project can open a terminal on.
    // Names and destinations only: an identity file path is a local detail of
    // whoever runs the daemon, not something a client needs.
    if (
      segments[0] === 'remotes' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      const remotes = loadConfig(ctx.rootDir).remotes ?? {};
      return jsonResponse(
        Object.entries(remotes).map(([name, remote]) => ({
          name,
          host: remote.host,
          user: remote.user ?? null,
          port: remote.port ?? null,
          path: remote.path ?? null,
        }))
      );
    }

    if (segments[0] === 'browser') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.browsers.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await launchBrowser(req, ctx);
      }
      const id = segments[1];
      if (id !== undefined && segments.length === 2) {
        if (method === 'GET') {
          const info = ctx.browsers.get(id);
          return info === null
            ? errorResponse(404, `no browser ${id}`)
            : jsonResponse(info);
        }
        if (method === 'DELETE') return closeBrowser(ctx, id);
      }
      if (id !== undefined && segments.length === 3) {
        const action = segments[2];
        if (action === 'navigate' && method === 'POST') {
          return await navigateBrowser(req, ctx, id);
        }
        if (action === 'click' && method === 'POST') {
          return await clickInBrowser(req, ctx, id);
        }
        if (action === 'fill' && method === 'POST') {
          return await fillInBrowser(req, ctx, id);
        }
        if (action === 'text' && method === 'GET') {
          return await readBrowserText(
            ctx,
            id,
            url.searchParams.get('selector')
          );
        }
        if (action === 'evaluate' && method === 'POST') {
          return await evaluateInBrowser(req, ctx, id);
        }
        if (action === 'screenshot' && method === 'GET') {
          return await screenshotBrowser(ctx, id);
        }
        if (action === 'pick' && method === 'POST') {
          return await startBrowserPick(ctx, id);
        }
        if (action === 'pick' && method === 'GET') {
          return await readBrowserPick(ctx, id);
        }
      }
    }

    if (segments[0] === 'terminals') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.terminals.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await createTerminal(req, ctx);
      }
      const id = segments[1];
      if (id !== undefined && segments.length === 2) {
        if (method === 'GET') {
          const info = ctx.terminals.get(id);
          return info === null
            ? errorResponse(404, `no terminal ${id}`)
            : jsonResponse(info);
        }
        if (method === 'DELETE') return deleteTerminal(ctx, id);
      }
      if (id !== undefined && segments.length === 3) {
        if (segments[2] === 'output' && method === 'GET') {
          return readTerminalOutput(ctx, id, url.searchParams.get('since'));
        }
        if (segments[2] === 'input' && method === 'POST') {
          return await writeTerminalInput(req, ctx, id);
        }
        if (segments[2] === 'resize' && method === 'POST') {
          return await resizeTerminal(req, ctx, id);
        }
        if (segments[2] === 'close' && method === 'POST') {
          return closeTerminal(ctx, id);
        }
      }
    }

    if (segments[0] === 'tasks') {
      // One fence for every write to a task an open A2A proposal holds.
      const fenced = proposalWriteRefusal(ctx, method, segments);
      if (fenced !== null) return fenced;
      // Before any `:id` sub-route below, and matched on its own literal so
      // "fanout" is never read as a run id.
      if (
        segments.length === 3 &&
        segments[2] === 'fanout' &&
        method === 'POST' &&
        segments[1] !== undefined
      ) {
        return await fanoutTask(req, ctx, segments[1]);
      }
      if (segments.length === 1 && method === 'GET') {
        const filter = {
          status: url.searchParams.get('status') ?? undefined,
          kind: url.searchParams.get('kind') ?? undefined,
          parent: url.searchParams.get('parent') ?? undefined,
          includeArchived: url.searchParams.get('archived') === '1',
        };
        // `fields=meta` drops every body — the shape list views want.
        const fields = url.searchParams.get('fields');
        if (fields === null) {
          return jsonTextResponse(ctx.cache.queryJson(filter));
        }
        if (fields === 'meta') {
          return jsonTextResponse(ctx.cache.queryMetaJson(filter));
        }
        return errorResponse(400, `unknown fields: ${fields}`);
      }
      if (segments.length === 1 && method === 'POST') {
        return await createTask(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'draft' &&
        method === 'POST'
      ) {
        return await draftTask(req, ctx);
      }
      // Before any `:id` lookup so "filter" is never read as a task id.
      if (
        segments.length === 3 &&
        segments[1] === 'filter' &&
        segments[2] === 'ai' &&
        method === 'POST'
      ) {
        return await aiFilterTasks(req, ctx);
      }
      // Checked before the generic `:id` GET branch below, so "drafts"
      // isn't treated as a task id.
      if (
        segments.length === 2 &&
        segments[1] === 'drafts' &&
        method === 'GET'
      ) {
        return listDrafts(ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'drafts' &&
        method === 'GET'
      ) {
        return getDraft(ctx, segments[2]);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'drafts' &&
        method === 'DELETE'
      ) {
        return dismissDraft(ctx, segments[2]);
      }
      if (
        segments.length === 4 &&
        segments[1] === 'drafts' &&
        segments[3] === 'message' &&
        method === 'POST'
      ) {
        return await sendDraftMessage(req, ctx, segments[2]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'enrich' &&
        method === 'POST'
      ) {
        return enrichTask(ctx, segments[1]);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'ready' &&
        method === 'GET'
      ) {
        return await getReadyTasks(ctx, url.searchParams.get('fields'));
      }
      // GET /api/tasks/readiness — the cached readings as-is, for the board,
      // which renders the whole task list rather than the ready route.
      if (
        segments.length === 2 &&
        segments[1] === 'readiness' &&
        method === 'GET'
      ) {
        return jsonResponse(cachedReadiness(ctx));
      }
      if (segments.length === 2 && method === 'GET') {
        const doc = ctx.cache.get(segments[1]);
        return doc !== null
          ? jsonResponse(doc)
          : errorResponse(404, `task not found: ${segments[1]}`);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateTask(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'runs' &&
        method === 'POST'
      ) {
        return await createRun(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comment' &&
        method === 'POST'
      ) {
        return await addLegacyTaskNote(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await startTaskReview(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'verify' &&
        method === 'POST'
      ) {
        return await startTaskVerification(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'verification' &&
        method === 'GET'
      ) {
        return getTaskVerification(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'findings' &&
        method === 'GET'
      ) {
        return listTaskFindings(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'fix-loop' &&
        method === 'GET'
      ) {
        return getFixLoop(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'amend' &&
        method === 'POST'
      ) {
        return await amendTask(req, ctx, segments[1]);
      }
      if (segments.length === 3 && segments[2] === 'comments') {
        if (method === 'GET') return listComments(ctx, segments[1]);
        if (method === 'POST') {
          return await addComment(req, ctx, segments[1]);
        }
      }
      if (segments.length === 4 && segments[2] === 'comments') {
        if (method === 'PATCH') {
          return await updateComment(req, ctx, segments[1], segments[3]);
        }
        if (method === 'DELETE') {
          return deleteComment(ctx, segments[1], segments[3]);
        }
      }
      if (segments.length === 3 && segments[2] === 'attachments') {
        if (method === 'GET') return listTaskAttachments(ctx, segments[1]);
        if (method === 'POST') {
          return await uploadTaskAttachments(req, ctx, segments[1]);
        }
      }
      if (segments.length === 4 && segments[2] === 'attachments') {
        if (method === 'GET' || method === 'HEAD') {
          return downloadTaskAttachment(ctx, segments[1], segments[3], method);
        }
        if (method === 'DELETE') {
          return removeTaskAttachment(ctx, segments[1], segments[3]);
        }
      }
      if (
        segments.length === 4 &&
        segments[2] === 'fix-loop' &&
        segments[3] === 'advance' &&
        method === 'POST'
      ) {
        return await advanceFixLoop(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'fix-loop' &&
        segments[3] === 'start' &&
        method === 'POST'
      ) {
        return await startFixLoop(ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'fix-loop' &&
        segments[3] === 'stop' &&
        method === 'POST'
      ) {
        return stopFixLoop(ctx, segments[1]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'findings' &&
        segments[4] === 'adjudicate' &&
        method === 'POST'
      ) {
        return await adjudicateFinding(req, ctx, segments[1], segments[3]);
      }
    }

    if (
      segments[0] === 'fix-loops' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      return listFixLoops(ctx);
    }

    // GET /api/plans — every plan's summary, newest activity first, for the
    // Plans page's history (persisted server-side; localStorage is gone).
    if (segments[0] === 'plans' && segments.length === 1 && method === 'GET') {
      return jsonResponse(ctx.planManager.list());
    }

    if (segments[0] === 'runs') {
      if (segments.length === 1 && method === 'GET') {
        ctx.orchestrator.backfillLastSteps();
        return jsonResponse(
          ctx.orchestrator.decorateRunsWithPushed(ctx.orchestrator.list())
        );
      }
      if (
        segments.length === 2 &&
        segments[1] === 'claims' &&
        method === 'GET'
      ) {
        return listRunClaims(ctx);
      }
      if (segments.length === 2 && method === 'GET') {
        ctx.orchestrator.backfillLastSteps();
        const result = ctx.orchestrator.getRun(segments[1]);
        if (result === null) {
          return errorResponse(404, `run not found: ${segments[1]}`);
        }
        return jsonResponse(result);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'cancel' &&
        method === 'POST'
      ) {
        await ctx.orchestrator.cancel(segments[1]);
        return jsonResponse({ ok: true });
      }
      if (segments.length === 3 && segments[2] === 'preview') {
        return await handleRunPreview(req, ctx, segments[1], method);
      }
      // POST /api/runs/:id/stop — the graceful counterpart to cancel: the agent
      // finishes what it is doing and then stops, so its work is committed.
      // Returns the run's meta (now carrying `stopRequestedAt`) rather than
      // `{ ok: true }`, since the marker is what the UI renders "Stopping…"
      // from and the run is deliberately still live at this point.
      if (
        segments.length === 3 &&
        segments[2] === 'stop' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.orchestrator.requestStop(segments[1]));
      }
      if (segments.length === 3 && segments[2] === 'diff' && method === 'GET') {
        return jsonResponse(ctx.orchestrator.diff(segments[1]));
      }
      // GET /api/runs/:id/approvals/:requestId — the full input of a call the
      // run is parked on; its gate carries only a preview.
      if (
        segments.length === 4 &&
        segments[2] === 'approvals' &&
        method === 'GET'
      ) {
        const parked = ctx.orchestrator.pendingApprovalFor(
          segments[1],
          segments[3]
        );
        return parked === undefined
          ? errorResponse(
              404,
              `run ${segments[1]} is not parked on ${segments[3]}`
            )
          : jsonResponse({ tool: parked.toolName, input: parked.input });
      }
      // GET /api/runs/:id/checklist — the run's requirement checklist; 404
      // until the finish hook has written one (or ever, without a client).
      if (
        segments.length === 3 &&
        segments[2] === 'checklist' &&
        method === 'GET'
      ) {
        const checklist = readChecklist(ctx.rootDir, segments[1]);
        return checklist === null
          ? errorResponse(404, `no checklist for run: ${segments[1]}`)
          : jsonResponse(checklist);
      }
      if (segments.length === 3 && segments[2] === 'file' && method === 'GET') {
        return await readRunFile(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'edits' &&
        method === 'POST'
      ) {
        return await applyRunEdit(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'evidence' &&
        method === 'POST'
      ) {
        return await createRunEvidence(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'mutations' &&
        method === 'POST'
      ) {
        return await createRunMutation(req, ctx, segments[1]);
      }
      // POST /api/runs/:id/resume — agent-death recovery: a new run in the
      // same worktree that continues the prior run's agent session (see
      // Orchestrator.resumeRun), carrying its survey.
      if (
        segments.length === 3 &&
        segments[2] === 'resume' &&
        method === 'POST'
      ) {
        return jsonResponse(
          ctx.orchestrator.resumeRun(segments[1], {
            actor: humanActor(ctx),
            operator: humanOperator(ctx),
          }),
          201
        );
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await reviewRun(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'GET'
      ) {
        return listReviewComments(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'POST'
      ) {
        return await addReviewComment(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'comments' &&
        method === 'PATCH'
      ) {
        return await updateReviewComment(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'comments' &&
        segments[4] === 'reply' &&
        method === 'POST'
      ) {
        return await replyReviewComment(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'comments' &&
        segments[4] === 'apply' &&
        method === 'POST'
      ) {
        return await applySuggestion(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'send-back' &&
        method === 'POST'
      ) {
        return await sendBackRun(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review-submit' &&
        method === 'POST'
      ) {
        return await submitReview(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'archive' &&
        method === 'POST'
      ) {
        return await archiveRun(req, ctx, segments[1]);
      }
      if (segments.length === 3 && segments[2] === 'pr' && method === 'GET') {
        return await getPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'pr' &&
        segments[3] === 'review' &&
        method === 'POST'
      ) {
        return await reviewPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'pr' &&
        segments[3] === 'comment' &&
        method === 'POST'
      ) {
        return await commentPr(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'conversations') {
      if (segments.length === 1 && method === 'GET') {
        return listConversation(req, ctx);
      }
      if (segments.length === 1 && method === 'POST') {
        return await addChatMessage(req, ctx);
      }
      if (segments.length === 2 && method === 'DELETE') {
        return deleteChatMessage(req, ctx, segments[1]);
      }
    }

    // Messaging routes read ctx.principal; the agent roster, register and
    // approve/revoke/mute/unmute routes use the tier ladder instead.
    if (segments[0] === 'messages') {
      if (segments.length === 1 && method === 'POST') {
        return await sendMessage(req, ctx);
      }
      if (segments.length === 2 && method === 'GET') {
        return getMessageById(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'reply' &&
        method === 'POST'
      ) {
        return await replyToMessage(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'answer' &&
        method === 'GET'
      ) {
        return await waitForAnswer(req, ctx, segments[1], url);
      }
    }

    if (segments[0] === 'threads') {
      if (segments.length === 1 && method === 'GET') {
        return listRecentThreads(ctx, url);
      }
      if (segments.length === 2 && method === 'GET') {
        return getThreadById(ctx, segments[1]);
      }
    }

    if (
      segments[0] === 'mailbox' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      return getMailbox(ctx, url);
    }

    if (
      segments[0] === 'deliveries' &&
      segments.length === 3 &&
      segments[2] === 'read' &&
      method === 'POST'
    ) {
      return markDeliveryRead(ctx, segments[1]);
    }

    if (segments[0] === 'channels') {
      if (segments.length === 1 && method === 'GET') {
        return listChannels(ctx);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'members' &&
        method === 'POST'
      ) {
        return await joinChannel(req, ctx, decodeURIComponent(segments[1]));
      }
      if (
        (segments.length === 3 || segments.length === 4) &&
        segments[2] === 'members' &&
        method === 'DELETE'
      ) {
        return leaveChannel(
          ctx,
          decodeURIComponent(segments[1]),
          segments.length === 4 ? decodeURIComponent(segments[3]) : undefined
        );
      }
    }

    if (segments[0] === 'a2a') {
      const handled = await handleA2ARoute(req, ctx, segments.slice(1), method);
      if (handled !== null) return handled;
    }

    if (segments[0] === 'agents') {
      if (
        segments.length === 2 &&
        segments[1] === 'roster' &&
        method === 'GET'
      ) {
        return listAgentRoster(ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'register' &&
        method === 'POST'
      ) {
        return await registerAgent(req, ctx);
      }
      if (segments.length === 3 && method === 'POST') {
        const address = decodeURIComponent(segments[1]);
        if (segments[2] === 'approve') return await approveAgent(ctx, address);
        if (segments[2] === 'revoke') return await revokeAgent(ctx, address);
        if (segments[2] === 'mute') return muteAgent(ctx, address);
        if (segments[2] === 'unmute') return unmuteAgent(ctx, address);
      }
    }

    // Docs routes read ctx.principal and map their own errors (docs/routes.ts).
    if (segments[0] === 'docs') {
      const res = await handleDocsRoute(req, ctx, segments.slice(1), url);
      if (res !== null) return res;
    }

    // Memory routes read ctx.principal, like messaging's (memory/routes.ts).
    if (segments[0] === 'memory') {
      if (segments.length === 1 && method === 'GET') {
        return listMemory(ctx, url);
      }
      if (segments.length === 1 && method === 'POST') {
        return await saveMemoryRoute(req, ctx);
      }
      if (segments.length === 2 && method === 'GET') {
        if (segments[1] === 'search') return searchMemory(ctx, url);
        if (segments[1] === 'health') return memoryHealthRoute(ctx);
        if (segments[1] === 'index') return memoryIndexRoute(ctx, url);
        if (segments[1] === 'recalls') return memoryRecallsRoute(ctx, url);
        if (segments[1] === 'proposals') return listProposalsRoute(ctx, url);
        if (segments[1] === 'activity') return memoryActivityRoute(ctx, url);
        if (segments[1] === 'identity') return memoryIdentityRoute(ctx);
        if (segments[1] === 'ingest-problems') return ingestProblemsRoute(ctx);
        return getMemory(ctx, segments[1]);
      }
      if (segments.length === 2 && method === 'POST') {
        if (segments[1] === 'link') return await startLinkRoute(req, ctx);
      }
      if (segments.length === 2 && method === 'DELETE') {
        return deleteMemoryRoute(ctx, segments[1]);
      }
      if (segments.length === 3 && method === 'GET') {
        if (segments[1] === 'proposals') {
          return getProposalRoute(ctx, segments[2]);
        }
      }
      if (segments.length === 3 && method === 'POST') {
        if (segments[1] === 'import' && segments[2] === 'ledger') {
          return importLedgerRoute(ctx, url);
        }
        if (segments[1] === 'import' && segments[2] === 'claude') {
          return await importClaudeRoute(ctx, url);
        }
        if (segments[1] === 'link') {
          return await completeLinkRoute(req, ctx, segments[2]);
        }
        const acted = await memoryActionRoute(
          req,
          ctx,
          segments[1],
          segments[2]
        );
        if (acted !== null) return acted;
      }
      if (
        segments.length === 4 &&
        method === 'POST' &&
        segments[1] === 'ingest-problems' &&
        segments[3] === 'accept'
      ) {
        return await acceptIngestProblemRoute(ctx, segments[2]);
      }
    }

    if (
      segments[0] === 'decisions' &&
      segments.length === 2 &&
      segments[1] === 'open' &&
      method === 'GET'
    ) {
      return listOpenDecisions(ctx);
    }

    // GET /api/decisions — every item awaiting a human, across all four
    // sources, for the notification center and the delivery channels built on
    // it. `?disposition=blocking|recorded` is the policy engine's filter (see
    // decisionFeed.ts); `?resolved=1` also returns the items the feed has just
    // watched resolve, so a surface can show a row settling instead of
    // vanishing.
    if (segments[0] === 'decisions' && segments.length === 1) {
      if (method === 'GET') {
        const raw = url.searchParams.get('disposition');
        if (raw !== null && raw !== 'blocking' && raw !== 'recorded') {
          return errorResponse(
            400,
            "disposition must be 'blocking' or 'recorded'"
          );
        }
        return jsonResponse({
          items: ctx.decisionFeed.list({
            disposition: (raw ?? undefined) as DecisionDisposition | undefined,
            includeResolved: url.searchParams.get('resolved') === '1',
          }),
        });
      }
    }

    // GET /api/prs (item B): every open PR in the repo — see
    // PrManager.listRepoPrs for the gh call + parsing, and its 409 when this
    // project lacks the `pr` capability (mapped by the typed-error catch
    // below, same as every other PR route).
    if (segments[0] === 'prs') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(await ctx.prManager.listRepoPrs());
      }
      // GET /api/prs/:number/detail, POST /api/prs/:number/review, POST
      // /api/prs/:number/comment — the in-app review surface for "Other open
      // PRs" (repo PRs dispatch never opened itself, so there's no run to key
      // off). Each resolves `number` to its url via listRepoPrs() (404 when
      // it isn't among the repo's open PRs), then delegates to the same
      // URL-driven PrManager cores the run-keyed routes above use — this is
      // what keeps dispatch from becoming an open proxy for reviewing/
      // commenting on an arbitrary PR url a client might otherwise supply
      // directly.
      if (
        segments.length === 3 &&
        segments[2] === 'detail' &&
        method === 'GET'
      ) {
        return await getRepoPrDetail(ctx, segments[1]);
      }
      // GET /api/prs/:number/diff — the PR's diff in DiffResult shape, so the
      // review surface renders a PR through the same component a run uses.
      if (segments.length === 3 && segments[2] === 'diff' && method === 'GET') {
        const pr = await resolveRepoPrByNumber(ctx, segments[1]);
        if (pr === null) return errorResponse(404, 'pull request not found');
        return jsonResponse(await ctx.prManager.getPrDiffByUrl(pr.url));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'review' &&
        method === 'POST'
      ) {
        return await reviewRepoPr(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comment' &&
        method === 'POST'
      ) {
        return await commentRepoPr(req, ctx, segments[1]);
      }
      // POST /api/prs/:number/review-agent — hand the PR to a review agent.
      // The only entry point for that dispatch, so its fork gate (spec
      // Decision 3) is the only door in: see startPrAgentReview.
      if (
        segments.length === 3 &&
        segments[2] === 'review-agent' &&
        method === 'POST'
      ) {
        return await startPrAgentReview(req, ctx, segments[1]);
      }
      // GET /api/prs/:number/findings — what an agent review of this PR
      // found, including the unlocated ones no line comment could carry.
      if (
        segments.length === 3 &&
        segments[2] === 'findings' &&
        method === 'GET'
      ) {
        return listPrFindings(ctx, segments[1]);
      }
      // GET/POST /api/prs/:number/comments, PATCH .../comments/:commentId,
      // POST .../comments/:commentId/reply — the line-comment mirror's
      // PR-keyed twin of the /api/runs/:id/comments verbs above. See
      // listPrComments/addPrComment/updatePrComment/replyPrComment: each
      // resolves `number` itself (via PrManager, never a caller-supplied
      // URL) before any `gh` call.
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'GET'
      ) {
        return await listPrComments(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'comments' &&
        method === 'POST'
      ) {
        return await addPrComment(req, ctx, segments[1]);
      }
      if (
        segments.length === 4 &&
        segments[2] === 'comments' &&
        method === 'PATCH'
      ) {
        return await updatePrComment(req, ctx, segments[1], segments[3]);
      }
      if (
        segments.length === 5 &&
        segments[2] === 'comments' &&
        segments[4] === 'reply' &&
        method === 'POST'
      ) {
        return await replyPrComment(req, ctx, segments[1], segments[3]);
      }
      // POST /api/prs/:number/review-submit — see submitPrReview for why
      // this is not named .../review (that path is reviewRepoPr, above).
      if (
        segments.length === 3 &&
        segments[2] === 'review-submit' &&
        method === 'POST'
      ) {
        return await submitPrReview(req, ctx, segments[1]);
      }
      // POST/DELETE /api/prs/:number/worktree — Task 7's on-demand review
      // worktree: cut it (fork-gated, same as review-agent) or retire it.
      if (
        segments.length === 3 &&
        segments[2] === 'worktree' &&
        method === 'POST'
      ) {
        return await createPrWorktreeRoute(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'worktree' &&
        method === 'DELETE'
      ) {
        return await removePrWorktreeRoute(ctx, segments[1]);
      }
    }

    // GET /api/landing — the unified PR table feed (runs + merge queue +
    // open/merged PRs). See getLandingSnapshot for the capability-loss
    // degradation.
    if (segments[0] === 'landing') {
      if (segments.length === 1 && method === 'GET') {
        return await getLandingSnapshot(ctx);
      }
    }

    if (segments[0] === 'branches') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(await ctx.orchestrator.listBranches());
      }
      if (
        segments.length === 2 &&
        segments[1] === 'free-disk' &&
        method === 'POST'
      ) {
        return await freeBranchDisk(req, ctx);
      }
      // Everything after `branches/` is one branch name that happens to
      // contain slashes — `segments` already split it apart, so rejoin it and
      // decode each part back to its original form.
      if (segments.length >= 2 && method === 'DELETE') {
        const branch = segments
          .slice(1)
          .map((part) => decodeURIComponent(part))
          .join('/');
        return await deleteBranch(ctx, branch, url);
      }
    }

    // The Git page — status/log/branches/diff reads plus staging, committing,
    // checkout, stash, and remote mutations against the main checkout.
    if (segments[0] === 'git') {
      if (
        segments.length === 2 &&
        segments[1] === 'status' &&
        method === 'GET'
      ) {
        return jsonResponse(await ctx.gitRepo.status());
      }
      if (segments.length === 2 && segments[1] === 'log' && method === 'GET') {
        const limit = parseCountParam(url.searchParams.get('limit'));
        if (limit === null)
          return errorResponse(400, 'limit must be a non-negative integer');
        const skip = parseCountParam(url.searchParams.get('skip'));
        if (skip === null)
          return errorResponse(400, 'skip must be a non-negative integer');
        return jsonResponse(
          await ctx.gitRepo.log({
            ref: url.searchParams.get('ref') ?? undefined,
            limit,
            skip,
          })
        );
      }
      if (
        segments.length === 2 &&
        segments[1] === 'branches' &&
        method === 'GET'
      ) {
        return jsonResponse(await gitBranches(ctx));
      }
      if (segments.length === 2 && segments[1] === 'diff' && method === 'GET') {
        return jsonResponse(
          await ctx.gitRepo.diff({
            staged: url.searchParams.get('staged') === '1',
            path: url.searchParams.get('path') ?? undefined,
          })
        );
      }
      if (
        segments.length === 3 &&
        segments[1] === 'commit' &&
        method === 'GET'
      ) {
        return jsonResponse(
          await ctx.gitRepo.diffCommit(decodeURIComponent(segments[2]))
        );
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stage' &&
        method === 'POST'
      ) {
        return await gitStage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'unstage' &&
        method === 'POST'
      ) {
        return await gitUnstage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stage-hunk' &&
        method === 'POST'
      ) {
        return await gitStageHunk(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'unstage-hunk' &&
        method === 'POST'
      ) {
        return await gitUnstageHunk(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'discard' &&
        method === 'POST'
      ) {
        return await gitDiscard(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'commit' &&
        method === 'POST'
      ) {
        return await gitCommit(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'commit-message' &&
        method === 'POST'
      ) {
        return await gitCommitMessage(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'checkout' &&
        method === 'POST'
      ) {
        return await gitCheckout(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'branch' &&
        method === 'POST'
      ) {
        return await gitCreateBranch(req, ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'branch' &&
        method === 'DELETE'
      ) {
        return await gitDeleteBranch(req, ctx, decodeURIComponent(segments[2]));
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stash' &&
        method === 'POST'
      ) {
        return await gitStashPush(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stash' &&
        method === 'GET'
      ) {
        return jsonResponse(await ctx.gitRepo.stashList());
      }
      if (
        segments.length === 3 &&
        segments[1] === 'stash' &&
        segments[2] === 'pop' &&
        method === 'POST'
      ) {
        return await gitStashPop(req, ctx);
      }
      if (
        segments.length === 3 &&
        segments[1] === 'stash' &&
        segments[2] === 'drop' &&
        method === 'POST'
      ) {
        return await gitStashDrop(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'fetch' &&
        method === 'POST'
      ) {
        return await gitFetch(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'pull' &&
        method === 'POST'
      ) {
        return gitMutationResponse(ctx, await ctx.gitRepo.pull(), {
          alwaysBroadcast: true,
        });
      }
      if (
        segments.length === 2 &&
        segments[1] === 'push' &&
        method === 'POST'
      ) {
        return await gitPush(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'cherry-pick' &&
        method === 'POST'
      ) {
        return await gitCherryPick(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'revert' &&
        method === 'POST'
      ) {
        return await gitRevert(req, ctx);
      }
    }

    if (segments[0] === 'notes') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.noteStore.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await createNote(req, ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateNote(req, ctx, segments[1]);
      }
      if (segments.length === 2 && method === 'DELETE') {
        return deleteNote(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'promote' &&
        method === 'POST'
      ) {
        return promoteNote(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'enrich' &&
        method === 'POST'
      ) {
        return enrichNote(ctx, segments[1]);
      }
    }

    if (segments[0] === 'inbox') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.inboxStore.list());
      }
      if (segments.length === 1 && method === 'POST') {
        return await addInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'convert' &&
        method === 'POST'
      ) {
        return await convertInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'dismiss' &&
        method === 'POST'
      ) {
        return await dismissInbox(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'cluster' &&
        method === 'POST'
      ) {
        return await clusterInbox(ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'clusters' &&
        method === 'GET'
      ) {
        return getInboxClusters(ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'triage' &&
        method === 'GET'
      ) {
        return getInboxTriage(ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateInbox(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'findings') {
      if (segments.length === 1 && method === 'GET') {
        return listFindings(ctx, url);
      }
      if (segments.length === 1 && method === 'POST') {
        return await createFinding(req, ctx);
      }
      if (segments.length === 2 && method === 'PATCH') {
        return await updateFinding(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'ledger') {
      if (segments.length === 1 && method === 'GET') {
        return listLedger(ctx, url);
      }
    }

    if (segments[0] === 'impact' && segments.length === 1 && method === 'GET') {
      return await getImpact(ctx, url);
    }

    // GET /api/queue — dispatchable tasks ranked by the scoring function, with
    // the per-factor breakdown. Computed per request; `task.changed` and
    // `config.changed` are the refetch signals.
    if (segments[0] === 'queue' && segments.length === 1 && method === 'GET') {
      return getQueue(ctx, url);
    }

    // GET /api/agents — every in-memory conversation agent (planner chats,
    // enrich/"add detail" agents, task drafts, overseer chats), normalized for
    // the All agents page. Task runs are not repeated here: GET /api/runs
    // already lists them, and the client merges the two.
    // POST /api/migrations/milestones — legacy milestone strings to projects.
    if (
      segments[0] === 'migrations' &&
      segments[1] === 'milestones' &&
      segments.length === 2 &&
      method === 'POST'
    ) {
      return await migrateMilestones(req, ctx);
    }
    // GET /api/people — the people registry pickers and avatars read.
    if (segments[0] === 'people' && segments.length === 1 && method === 'GET') {
      return listPeople(ctx);
    }
    // GET /api/labels — the label registry chips take their colors from;
    // PUT sets one label's color.
    if (segments[0] === 'labels' && segments.length === 1) {
      if (method === 'GET') return listLabels(ctx);
      if (method === 'PUT') return await putLabelColor(req, ctx);
    }
    // GET /api/executors — what this daemon can dispatch on, so no client has
    // to hard-code executor names.
    if (
      segments[0] === 'executors' &&
      segments.length === 1 &&
      method === 'GET'
    ) {
      return jsonResponse({
        executors: ctx.orchestrator.describeExecutors(),
        default: ctx.orchestrator.defaultExecutorName(),
      });
    }

    if (segments[0] === 'agents' && segments.length === 1 && method === 'GET') {
      return jsonResponse(
        buildAgentSessions(
          ctx.planManager.listPlans(),
          ctx.planManager.listDrafts(),
          ctx.overseerManager.list()
        )
      );
    }

    if (segments[0] === 'plan') {
      if (segments.length === 1 && method === 'POST') {
        return await startPlan(req, ctx);
      }
      if (segments.length === 2 && method === 'GET') {
        return jsonResponse(ctx.planManager.get(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'message' &&
        method === 'POST'
      ) {
        return await sendPlanMessage(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'confirm' &&
        method === 'POST'
      ) {
        return await confirmPlan(req, ctx, segments[1]);
      }
    }

    if (segments[0] === 'overseer') {
      if (segments.length === 1 && method === 'POST') {
        return await startOverseer(
          req,
          ctx,
          overseerSpeaker(daemonCtx, presented)
        );
      }
      if (segments.length === 2 && method === 'GET') {
        return jsonResponse(ctx.overseerManager.get(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'message' &&
        method === 'POST'
      ) {
        return await sendOverseerMessage(
          req,
          ctx,
          segments[1],
          overseerSpeaker(daemonCtx, presented)
        );
      }
    }

    if (segments[0] === 'epics') {
      // Bulk progress sits at /api/epics/progress, so it must be matched
      // before the /:id/... branches would read `progress` as an epic id.
      if (
        segments.length === 2 &&
        segments[1] === 'progress' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.epicEngine.progressAll());
      }
      if (
        segments.length === 3 &&
        segments[2] === 'dispatch' &&
        method === 'POST'
      ) {
        return await startEpic(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'pause' &&
        method === 'POST'
      ) {
        return pauseEpic(ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'resume' &&
        method === 'POST'
      ) {
        return await resumeEpic(req, ctx, segments[1]);
      }
      if (
        segments.length === 3 &&
        segments[2] === 'stop' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.epicEngine.stop(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'progress' &&
        method === 'GET'
      ) {
        return jsonResponse(ctx.epicEngine.progress(segments[1]));
      }
      if (
        segments.length === 3 &&
        segments[2] === 'land' &&
        method === 'POST'
      ) {
        return await landEpic(ctx, segments[1]);
      }
      // The epic branch's diff against the default base — served from the
      // land-time snapshot once the branch itself is gone.
      if (segments.length === 3 && segments[2] === 'diff' && method === 'GET') {
        return jsonResponse(ctx.orchestrator.epicDiff(segments[1]));
      }
    }

    if (segments[0] === 'merge-queue') {
      if (segments.length === 1 && method === 'GET') {
        return jsonResponse(ctx.mergeQueue.snapshot());
      }
      if (segments.length === 1 && method === 'POST') {
        return await enqueueMergeQueue(req, ctx);
      }
      if (
        segments.length === 2 &&
        segments[1] === 'stack' &&
        method === 'POST'
      ) {
        return await enqueueMergeQueueStack(req, ctx);
      }
      // POST /api/merge-queue/ready. Enqueues every mergeable run in the
      // registry at once — an empty `[]` is a valid 201, not an error.
      if (
        segments.length === 2 &&
        segments[1] === 'ready' &&
        method === 'POST'
      ) {
        return jsonResponse(ctx.mergeQueue.enqueueReady(), 201);
      }
      // POST /api/merge-queue/recheck. Re-runs the pump against the current
      // main checkout — the retry for entries held in 'blocked-environment'
      // (dirty tree, staged index, wrong branch). Those blockers are resolved
      // by the user in a terminal, which produces no event this daemon can
      // observe, so there has to be an explicit "I've cleaned up, try again"
      // call. Takes no body and always 200s with the resulting snapshot: it's
      // a nudge, not an assertion that anything is currently blocked.
      if (
        segments.length === 2 &&
        segments[1] === 'recheck' &&
        method === 'POST'
      ) {
        ctx.mergeQueue.recheck();
        return jsonResponse(ctx.mergeQueue.snapshot());
      }
      if (segments.length === 2 && method === 'DELETE') {
        ctx.mergeQueue.remove(segments[1]);
        return new Response(null, { status: 204 });
      }
    }

    return errorResponse(404, `not found: ${url.pathname}`);
  } catch (err) {
    // TaskParseError (a corrupt task file) and ConfigError (corrupt
    // config.yml) are the only errors expected to reach here from core; both
    // map to 422 with just their message — never a stack trace. The
    // Orchestrator* errors mirror that same typed-error-to-status-code
    // pattern for the run endpoints.
    if (err instanceof TaskParseError || err instanceof ConfigError) {
      return errorResponse(422, err.message);
    }
    if (err instanceof OrchestratorNotFoundError) {
      return errorResponse(404, err.message);
    }
    if (err instanceof OrchestratorConflictError) {
      return errorResponse(409, err.message);
    }
    // The message says which file and what to do; it never quotes the file.
    if (err instanceof CredentialsUnreadableError) {
      return errorResponse(409, err.message);
    }
    if (err instanceof OrchestratorClientError) {
      return errorResponse(400, err.message);
    }
    // Messaging routes let @dispatch/protocol's MessagingError surface
    // rather than pre-validating; `code` maps to the same statuses below.
    if (err instanceof MessagingError) {
      const status: Record<MessagingError['code'], number> = {
        invalid: 400,
        forbidden: 403,
        'not-found': 404,
        conflict: 409,
        limited: 429,
      };
      const body: { error: string; field?: string } = { error: err.message };
      if (err.field !== undefined) body.field = err.field;
      return jsonResponse(body, status[err.code]);
    }
    // Memory routes do the same with MemoryError, which also has `unavailable` (503).
    if (err instanceof MemoryError) {
      const body: { error: string; field?: string } = { error: err.message };
      if (err.field !== undefined) body.field = err.field;
      const res = jsonResponse(body, err.status);
      if (err instanceof MemoryBusyError) res.headers.set('retry-after', '1');
      return res;
    }
    // A busy database is 503 to retry; a write the disk refused is 507.
    const storage = storageErrorResponse(err);
    if (storage !== null) return storage;
    throw err;
  }
}
