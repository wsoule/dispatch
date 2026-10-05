import type { LabelDefinition } from './labels.js';
import { DEFAULT_STATUS_MAP } from './linearMap.js';
import type { Person } from './people.js';
import type { PolicyConfig, PolicyGate, PolicyGateMode } from './policy.js';
import { DEFAULT_POLICY } from './policy.js';
import type { QueueWeights } from './scoring.js';
import { DEFAULT_QUEUE_WEIGHTS } from './scoring.js';
import type { StatusDefinition, StatusRoles } from './status.js';

// The browser-safe half of the config module: shapes and defaults with no
// filesystem access, so the desktop webview can import them.

/** Per-run caps and defaults for the orchestrator's executors. `maxBudgetUsd`
 *  has no default — omitting it means "no budget cap". */
export interface OrchestratorConfig {
  maxTurns?: number;
  /** Ceiling on one `verifyCommand` run. The merge queue is serial, so a verify
   *  that never returns holds up every entry behind it. */
  verifyTimeoutSec: number;
  maxBudgetUsd?: number;
  permissionMode: string;
  epicConcurrency: number;
  /** Hard ceiling on concurrent runs any one epic session may hold, capped at
   *  `MAX_CONCURRENCY_HARD_CAP`. `epicConcurrency` must not exceed it. */
  maxConcurrency: number;
  /** What the spend gate charges for a run still in flight, before its real
   *  cost is known. */
  runCostEstimateUsd: number;
  /** The executor a dispatch runs on when the caller names none. */
  executor: string;
}

/** The largest `maxConcurrency` the loader accepts. Browser-safe so the
 *  dispatch dialog can clamp its own input against it. */
export const MAX_CONCURRENCY_HARD_CAP = 32;

export interface RepoDigestConfig {
  /** False stops all generation; the cache still serves what is on disk. */
  enabled: boolean;
  /** Minimum age of a cached digest before a stale one is regenerated. */
  cooldownHours: number;
}

// Six hours: a digest is an orientation map, not an index, so one written a few
// commits ago is nearly as useful as one written now.
export const DEFAULT_REPO_DIGEST: RepoDigestConfig = {
  enabled: true,
  cooldownHours: 6,
};

/**
 * Per-run dev-server previews: what turns a finished run from a diff you read
 * into an app you look at. The daemon starts the command inside the run's own
 * worktree, so a preview shows that run's work and nothing else.
 */
export interface PreviewConfig {
  /** False stops the daemon starting any preview at all. */
  enabled: boolean;
  /** Shell command to start this project's dev server, run inside the run's
   *  worktree. Absent means autodetect from the worktree's package.json — see
   *  `detectPreviewCommand`. A repo with neither simply has no preview, which
   *  is an ordinary state, not an error. */
  command?: string;
  /** Command that installs dependencies, run once before `command` when the
   *  worktree has no `node_modules`. A run's worktree is a fresh checkout, so
   *  without this most dev servers fail to boot at all. */
  installCommand?: string;
  /** How long the dev server has to answer on its port before the daemon
   *  gives up and reports the preview as failed. Generous by default: a cold
   *  worktree may install first. */
  readyTimeoutSec: number;
  /** How long a preview may sit with no request before the daemon sweeps it. Dev
   *  servers are expensive and a reviewer looks at one for a minute, so an
   *  idle preview is pure cost. */
  idleTimeoutSec: number;
}

// Defaults chosen for a cold worktree: 180s covers an install plus a dev
// server's first boot, and 15 minutes of idle is far longer than a review
// takes while still reclaiming a preview left open in a background tab.
export const DEFAULT_PREVIEW: PreviewConfig = {
  enabled: true,
  readyTimeoutSec: 180,
  idleTimeoutSec: 900,
};

/** The preview settings a config implies. The single reader of the optional
 *  `preview` block, so no caller has to remember that a hand-built config
 *  (test fixtures, mostly) may not carry one. Returns a fresh object every
 *  call — DEFAULT_PREVIEW is a shared module constant, and handing it out by
 *  reference would let one caller's mutation change every later read. */
export function previewSettings(config: DispatchConfig): PreviewConfig {
  return { ...DEFAULT_PREVIEW, ...(config.preview ?? {}) };
}

/**
 * The git-versioned audit trail the daemon exports outside the project repo.
 *
 * On by default, because the receipt log is what keeps the project's history
 * auditable once the database — not git — is the sync layer. Turning it off
 * stops the export; it never deletes a log already written.
 */
export interface ReceiptsConfig {
  enabled: boolean;
  /**
   * Where the log lives. Absent means the default under DISPATCH_HOME, keyed
   * by a hash of the project path the same way runs and worktrees are. A
   * relative path is resolved against the project root.
   */
  dir?: string;
  /**
   * Where to push the log after each export, so it survives the machine:
   * one of the project's own remotes, by name (`origin`). Absent, with no
   * `repo` either, keeps the log local, as it always was.
   */
  remote?: string;
  /**
   * Or a repository of its own: a git URL, or a path (relative to the
   * project root). Mutually exclusive with `remote`.
   */
  repo?: string;
  /** The branch the log is pushed to. */
  branch?: string;
}

export const DEFAULT_RECEIPTS: ReceiptsConfig = { enabled: true };

/** The branch receipts go to when `receipts.remote` names no other. */
export const DEFAULT_RECEIPTS_BRANCH = 'dispatch-receipts';

/**
 * Two-way board sync between teammates' daemons over git
 * (packages/server/src/sync). Off unless turned on: each daemon keeps its own
 * database, and this is what lets several of them converge on one board.
 */
export interface SyncConfig {
  enabled: boolean;
  /** Which of the project's own remotes carries the sync branch, by name.
   *  Ignored when `repo` is set. */
  remote: string;
  /**
   * A repository of its own for the board instead: a git URL, or a path
   * (relative to the project root). Set only when the config names one;
   * mutually exclusive with `remote`.
   */
  repo?: string;
  /** The branch the changes travel on. Nothing but sync writes to it. */
  branch: string;
  /** How often to sync when nothing local has changed. */
  intervalSec: number;
}

export const DEFAULT_SYNC: SyncConfig = {
  enabled: false,
  remote: 'origin',
  branch: 'dispatch-sync',
  intervalSec: 30,
};

/** One named gate in the verify pipeline. */
export interface VerifyStep {
  name: string;
  command: string;
}

/** A `statuses:` entry as written: a bare name, or a name with a type/color. */
export type StatusEntryInput =
  | string
  | { name: string; type?: StatusDefinition['type']; color?: string | null };

export interface DispatchConfig {
  /** Status names in board order (always populated). */
  statuses: string[];
  /** Typed statuses, parallel to `statuses`. Set by loadConfig when any
   *  entry is typed; read through `statusModelOf`, which fills defaults. */
  statusDefinitions?: StatusDefinition[];
  /** Which status each lifecycle event writes. Absent means the defaults;
   *  read through `statusModelOf`. */
  statusRoles?: StatusRoles;
  /** The people registry beyond team.yml (see people.ts); absent when none. */
  people?: Person[];
  /** The label registry (see labels.ts): colors and links; absent when none. */
  labels?: LabelDefinition[];
  autoCommit: boolean;
  verifyCommand?: string;
  /** Verify as named steps rather than one opaque command, so a failure names
   *  the check that broke. Takes precedence over `verifyCommand`. */
  verifySteps?: VerifyStep[];
  orchestrator: OrchestratorConfig;
  models: ModelConfig;
  /** Per-role reasoning effort. `loadConfig` always populates it (empty when
   *  the block is absent); optional so hand-built fixtures stay valid. */
  effort?: EffortConfig;
  /** Per-executor overrides of the execute-side model roles (see
   *  `executorModels`). `loadConfig` always populates it; optional only so
   *  hand-built config literals (test fixtures) stay valid. */
  executors?: Record<string, ExecutorConfig>;
  /** Machines reachable over ssh — see RemoteConfig. Absent means none. */
  remotes?: Record<string, RemoteConfig>;
  linear: LinearConfig;
  fixLoop: FixLoopConfig;
  /** How to run this project for a `verify` run to exercise it. Absent means
   *  the verify stage has nothing to dispatch, so a task simply skips it. */
  verify?: VerifyConfig;
  carto: CartoConfig;
  repoDigest: RepoDigestConfig;
  notifications: NotificationsConfig;
  messaging: MessagingConfig;
  /** Optional only so hand-built fixtures stay valid; `loadConfig` always
   *  sets it. */
  memory?: MemoryConfig;
  /** The A2A bridge's policy; `loadConfig` always sets it, optional for hand-built fixtures. */
  a2a?: A2AConfig;
  /** One line per `a2a:` key that fell back to its default. */
  a2aWarnings?: string[];
  /**
   * The git receipt log. `loadConfig` always populates this, so a config it
   * returns can be read without a fallback; it is optional only so callers
   * that build a DispatchConfig literal by hand — test fixtures, mostly — do
   * not all have to be updated at once. Absent means DEFAULT_RECEIPTS.
   */
  receipts?: ReceiptsConfig;
  /** Board sync. Optional for the same reason `receipts` is; absent means
   *  DEFAULT_SYNC. Read it through `syncSettings()`. */
  sync?: SyncConfig;
  /** Optional in the type, but `loadConfig` always populates it — the marker
   *  is for hand-built config objects (test fixtures) written before the block
   *  existed. Read it through `queueWeights()`, never directly: that is what
   *  forces a caller to handle a rejected block instead of silently ranking
   *  against defaults. */
  queue?: QueueConfig;
  /** Parent directory for PR review worktrees (Task 7); each PR gets a
   *  `pr-<n>` child inside it. Absent means the default sibling of `rootDir`. */
  prWorktreeDir?: string;
  /** The autonomy policy: which gates auto-decide instead of blocking.
   *  `loadConfig` always populates it; optional only so hand-built config
   *  literals (test fixtures) predating the block stay valid. Read it through
   *  `projectPolicy()`, never directly, so the default rung applies. */
  policy?: PolicyConfig;
  /** Per-run dev-server previews. `loadConfig` always populates it; optional
   *  only so hand-built config literals predating the block stay valid. Read
   *  it through `previewSettings()`, never directly, so a partial block still
   *  carries the default timeouts. */
  preview?: PreviewConfig;
}

/** The policy a config implies. The single reader of the optional `policy`
 *  block, so no gate call site has to remember that a hand-built config may
 *  not carry one. Returns a fresh object every call — DEFAULT_POLICY is a
 *  shared module constant, and handing it out by reference would let one
 *  caller's mutation change every later gate consult process-wide. */
export function projectPolicy(config: DispatchConfig): PolicyConfig {
  const policy = config.policy ?? DEFAULT_POLICY;
  return { rung: policy.rung, gates: { ...policy.gates } };
}

/** Settings for the planning queue's ranking. Nested under `queue:` rather
 *  than sitting at the top level so the pull actions and dispatch policy that
 *  come later have somewhere obvious to land. */
export interface QueueConfig {
  /** Per-factor weights for the scoring function (see scoring.ts). Every
   *  factor key is always present — a partial `queue.weights:` block layers
   *  over the defaults rather than replacing them. Holds the defaults when
   *  `error` is set, so a Settings screen still has something to render. */
  weights: QueueWeights;
  /** Why the `queue:` block on disk was rejected, when it was.
   *
   *  Carried rather than thrown from `loadConfig`, because throwing there
   *  turns one mistyped weight into a 422 on every config-reading endpoint in
   *  the daemon. The blast radius belongs to the queue: consumers whose answer
   *  must be correct go through `queueWeights()`, which refuses. */
  error?: string;
}

/** Either the weights to rank with, or the reason the configured block cannot
 *  be used. A result rather than a plain value so a caller cannot accidentally
 *  rank against defaults while the user's real config is broken. */
export type QueueWeightsResult =
  | { ok: true; weights: QueueWeights }
  | { ok: false; error: string };

/** The scoring weights a config implies. The single reader of the optional
 *  `queue` block, so no caller has to remember that a hand-built config may
 *  not carry one — or that the one on disk may not have parsed.
 *
 *  Returns a fresh object every call: DEFAULT_QUEUE_WEIGHTS is a module-level
 *  constant read live by every loadConfig, so handing it out by reference
 *  would let one caller's mutation corrupt every later ranking process-wide. */
export function queueWeights(config: DispatchConfig): QueueWeightsResult {
  const queue = config.queue;
  if (queue?.error !== undefined) return { ok: false, error: queue.error };
  return {
    ok: true,
    weights: { ...(queue?.weights ?? DEFAULT_QUEUE_WEIGHTS) },
  };
}

/** Whether Dispatch uses carto for the dependency graph, and whether it may
 *  build the container itself. `on` is a build policy, never a requirement —
 *  an absent binary always degrades to the built-in scanner. */
export type CartoMode = 'on' | 'detect' | 'off';

export interface CartoConfig {
  enabled: CartoMode;
}

export const CARTO_MODES: readonly CartoMode[] = ['on', 'detect', 'off'];

export const DEFAULT_CARTO: CartoConfig = { enabled: 'on' };

/** The run recipe a `verify` run exercises the project with — none of these
 *  are required, since a project may need only one of them explained. */
export interface VerifyConfig {
  command?: string;
  url?: string;
  notes?: string;
}

/** One rung of the fix-loop escalation ladder: how round `round`, and every
 *  later round up to the next rung, is dispatched. */
export interface EscalationStep {
  round: number;
  strategy: 'resume' | 'fresh';
  modelTier: 'standard' | 'high';
}

/** Bounds on the review -> fix -> re-review loop. `cap` is the last round that
 *  may dispatch; reaching it demands an explicit ruling on every finding.
 *  `auto` opens the loop on its own when a task's implementer finishes —
 *  the default lifecycle; individual tasks opt out via `fix-loop: false`. */
export interface FixLoopConfig {
  auto: boolean;
  cap: number;
  escalation: EscalationStep[];
}

// Declared as `readonly string[]` (not the literal unions) so a membership
// check against an unvalidated `unknown` never needs an `as` cast.
export const FIX_STRATEGIES: readonly string[] = ['resume', 'fresh'];
export const FIX_MODEL_TIERS: readonly string[] = ['standard', 'high'];

// Rounds 1-3 resume the same agent; 4 and 5 hand the work to a fresh one at
// the top tier, because an agent three rounds deep stops seeing its own shape.
export const DEFAULT_FIX_LOOP: FixLoopConfig = {
  // Off by default: every round dispatches a real agent run, so igniting on
  // each finished implementer spends without anyone asking for it. The task
  // view's "Review & fix" button opens the same loop on demand; set
  // `fixLoop.auto: true` to go back to igniting automatically.
  auto: false,
  cap: 5,
  escalation: [
    { round: 1, strategy: 'resume', modelTier: 'standard' },
    { round: 4, strategy: 'fresh', modelTier: 'high' },
  ],
};

/**
 * The kinds of thing that can wait on a human — the decision feed's own
 * vocabulary, owned here so the notification toggles and the feed cannot
 * drift apart. The server's DecisionFeed aliases its item kind to this type.
 *
 * - `approval`        a run is parked on a permission gate.
 * - `scope-request`   an agent asked to edit outside its declared writes.
 * - `memory`          an agent proposes a lesson for shared memory.
 * - `doc`             an agent proposes an edit to an accepted doc.
 * - `question`        an agent sent a blocking question (msg_send) and waits
 *                     on the answer.
 * - `fix-loop-capped` a review/fix loop exhausted its rounds and wants a ruling.
 * - `run-stalled`     a run failed or dead-ended and nobody has dealt with it.
 */
export type NotificationKind =
  | 'approval'
  | 'scope-request'
  | 'memory'
  | 'doc'
  | 'question'
  | 'fix-loop-capped'
  | 'run-stalled';

const APPROVAL_GATES: ReadonlySet<string> = new Set([
  'tool-approval',
  'wake',
  'agent-registration',
  'overseer-action',
  'task-proposal',
]);

/** The toggle a message notifies under; null when no human is being asked. */
export function notificationKindForMessage(message: {
  kind: string;
  blocking: boolean;
  data?: unknown;
}): NotificationKind | null {
  if (message.kind !== 'question' || !message.blocking) return null;
  const data = message.data;
  const type =
    typeof data === 'object' && data !== null && !Array.isArray(data)
      ? (data as { type?: unknown }).type
      : undefined;
  if (type === 'scope') return 'scope-request';
  if (type === 'memory') return 'memory';
  if (type === 'doc') return 'doc';
  if (typeof type === 'string' && APPROVAL_GATES.has(type)) return 'approval';
  return 'question';
}

/** Every kind, in the order the Settings UI renders them. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = [
  'question',
  'approval',
  'scope-request',
  'memory',
  'doc',
  'fix-loop-capped',
  'run-stalled',
];

/**
 * Delivery beyond the app for things awaiting a human. `kinds` gates both
 * channels — the desktop's OS notifications and the webhook — so a noisy
 * kind (a stalled run, a capped fix loop) can be quieted without also muting
 * an agent's question. The in-app record (the inbox, the decision feed) is
 * never gated: these toggles tune what interrupts you, not what is kept.
 */
export interface NotificationsConfig {
  kinds: Record<NotificationKind, boolean>;
  /** An http(s) URL every newly-blocking feed item is POSTed to as JSON — the
   *  seam for Slack or anything else; no per-service integrations. Absent
   *  means no webhook. */
  webhook?: string;
}

/** What the daemon hands out in place of a webhook URL's path, since the URL
 *  is the credential: `https://hooks.slack.com/services/T0/B0/x` becomes
 *  `https://hooks.slack.com/…`. Shared so the server's masking and the
 *  desktop's "is this value masked?" check cannot drift apart. */
export const SECRET_URL_MASK_SUFFIX = '/…';

/** True when `value` is a masked webhook the daemon handed out, never a URL a
 *  user typed. Such a value must not be written back as the webhook. */
export function isMaskedSecretUrl(value: string): boolean {
  return value.endsWith(SECRET_URL_MASK_SUFFIX);
}

// Everything on: the toggles exist to take noise away, so the out-of-the-box
// behaviour is what the desktop already did before they existed.
export const DEFAULT_NOTIFICATIONS: NotificationsConfig = {
  kinds: {
    question: true,
    approval: true,
    'scope-request': true,
    memory: true,
    doc: true,
    'fix-loop-capped': true,
    'run-stalled': true,
  },
};

/** Rate and timeout limits for the messaging system. */
export interface MessagingConfig {
  urgentPerHour: number;
  agentTurnsPerThreadPerHour: number;
  agentBlockingTimeoutSec: number;
  /** Mail ops applied per clock hour from any one teammate's machine (federation). */
  remoteMailPerReplicaPerHour: number;
}

export const DEFAULT_MESSAGING: MessagingConfig = {
  urgentPerHour: 10,
  agentTurnsPerThreadPerHour: 20,
  agentBlockingTimeoutSec: 600,
  remoteMailPerReplicaPerHour: 600,
};

/** Memory's prompt budget, write limits and decay clock. */
export interface MemoryConfig {
  indexTokens: number;
  personalWritesPerHour: number;
  proposalsPerHour: number;
  maxOpenProposals: number;
  proposalTtlDays: number;
  staleAfterDays: number;
  retireAfterDays: number;
  claudeAutoMemory: 'export' | 'off';
}

export const DEFAULT_MEMORY: MemoryConfig = {
  indexTokens: 1000,
  personalWritesPerHour: 50,
  proposalsPerHour: 10,
  maxOpenProposals: 50,
  proposalTtlDays: 14,
  staleAfterDays: 60,
  retireAfterDays: 180,
  claudeAutoMemory: 'export',
};

/** The skills an A2A agent card may offer. */
export const A2A_SKILLS = ['ask', 'handoff', 'status'] as const;
export type A2ASkill = (typeof A2A_SKILLS)[number];

/** Project policy for the A2A bridge. Holds no listener setting: those are machine-local. */
export interface A2AConfig {
  /** The card's name; null means the basename of the project root. */
  name: string | null;
  /** The card's description; null means the default description. */
  description: string | null;
  /** The skills the card offers; null means every skill built. */
  skills: A2ASkill[] | null;
  /** How long a blocking send waits for its answer, 1 to 600 seconds. */
  blockingWaitSec: number;
  requestsPerMinute: number;
  sendsPerHour: number;
  handoffsPerDay: number;
  openTasksPerClient: number;
  streamsPerClient: number;
  outboundPerHour: number;
}

export const DEFAULT_A2A: A2AConfig = {
  name: null,
  description: null,
  skills: null,
  blockingWaitSec: 60,
  requestsPerMinute: 120,
  sendsPerHour: 60,
  handoffsPerDay: 10,
  openTasksPerClient: 20,
  streamsPerClient: 5,
  outboundPerHour: 60,
};

/** Linear sync settings. Holds no secret — the API key lives in `~/.dispatch/credentials.json`. */
export interface LinearConfig {
  enabled: boolean;
  /** The primary linked team: `teamIds[0]`, or null when none is linked.
   *  Read from a legacy `teamId:` when `teamIds:` is absent. */
  teamId: string | null;
  /** Every linked team, primary first. Issues follow a move between them
   *  and unlink only when they leave all of them. */
  teamIds: string[];
  /** Pre-mirroring map (status -> state name or type). Once a team is linked
   *  the statuses ARE its workflow states; this only guides that first move. */
  statusMap: Record<string, string>;
  /** Seconds between polls when no webhook delivers changes. */
  intervalSec: number;
  direction: 'both' | 'pull' | 'push';
  /** Whether a task's Acceptance Criteria travels in the Linear description. */
  includeAcceptanceCriteria: boolean;
}

export const LINEAR_DIRECTIONS = ['both', 'pull', 'push'] as const;

export const DEFAULT_LINEAR: LinearConfig = {
  enabled: false,
  teamId: null,
  teamIds: [],
  statusMap: { ...DEFAULT_STATUS_MAP },
  intervalSec: 30,
  direction: 'both',
  includeAcceptanceCriteria: true,
};

/** Per-role model ids. Each role is a distinct kind of agent work, so cheap
 *  roles can run on a cheap model without downgrading coding runs. */
export interface ModelConfig {
  /** Coding runs — the agent that edits the repo. */
  execute: string;
  /** The overseer chat: a full agent session in the checkout that also holds
   *  the daemon's own controls (dispatch, approve, cancel). */
  overseer: string;
  /** Multi-turn planning conversations. */
  plan: string;
  /** One-shot natural-language task drafting. */
  draft: string;
  /** Filling in description / acceptance criteria for a task or inbox item. */
  enrich: string;
  /** Grouping inbox captures into suggested epics. */
  cluster: string;
  /** Short mechanical text: titles, summaries, commit messages. */
  summarize: string;
  /** TypeSafe System One judgments — inbox triage, readiness, the landing
   *  checklist, run model tier. A Jev model id, not a Claude one. */
  judge: string;
}

export const DEFAULT_MODELS: ModelConfig = {
  execute: 'claude-opus-5-5',
  overseer: 'claude-opus-5-5',
  plan: 'claude-sonnet-5',
  draft: 'claude-haiku-4-5-20251001',
  enrich: 'claude-haiku-4-5-20251001',
  cluster: 'claude-haiku-4-5-20251001',
  summarize: 'claude-haiku-4-5-20251001',
  judge: 'jev-latest',
};

/** Reasoning effort levels a Claude agent session accepts, lowest first. */
export const EFFORT_LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

export type EffortLevel = (typeof EFFORT_LEVELS)[number];

export function isEffortLevel(value: unknown): value is EffortLevel {
  return (
    typeof value === 'string' &&
    (EFFORT_LEVELS as readonly string[]).includes(value)
  );
}

/** Per-role effort for the Claude agent sessions. An unset role sends no
 *  effort, so the model's own default applies (Opus 5.5: medium). */
export interface EffortConfig {
  execute?: EffortLevel;
  overseer?: EffortLevel;
  plan?: EffortLevel;
}

export const EFFORT_ROLES: readonly (keyof EffortConfig)[] = [
  'execute',
  'overseer',
  'plan',
];

/** Every valid key of `ModelConfig`, in the order the Settings UI renders them. */
export const MODEL_ROLES: readonly (keyof ModelConfig)[] = [
  'execute',
  'overseer',
  'plan',
  'draft',
  'enrich',
  'cluster',
  'summarize',
  'judge',
];

/** The two model roles a run's executor decides: the coding model and the
 *  lighter tier judged/reviewed routine work drops to. Either may be unset,
 *  meaning "whatever that executor runs by default". */
export interface ExecutorModels {
  execute?: string;
  plan?: string;
}

/** USD per million tokens, for an executor that reports usage but no cost. */
export interface ExecutorPricing {
  input: number;
  /** Defaults to `input` when unset. */
  cachedInput?: number;
  output: number;
}

/**
 * How to run an agent that is just a command-line program.
 *
 * Dispatch speaks two agents' protocols natively (Claude's SDK, Codex's app
 * server). Everything else — and there are dozens — is a CLI that takes a
 * prompt and prints to stdout, which is enough to run inside a worktree and
 * review afterwards. Declaring one here is what makes it dispatchable without
 * a code change.
 *
 * `run` is the argv, with two placeholders substituted before spawn:
 * `{prompt}` and `{model}`. An entry containing a placeholder is replaced
 * wholesale, so `--model={model}` and a bare `{model}` both work. When `run`
 * has no `{prompt}`, the prompt is written to the process's stdin instead,
 * which is what the agents that read a prompt from a pipe expect.
 */
export interface ExecutorCommand {
  run: string[];
  /** Extra environment for the child, merged over the daemon's own. */
  env?: Record<string, string>;
}

/**
 * A machine Dispatch can reach over ssh.
 *
 * Only what ssh itself needs, plus the checkout to work in. Everything else —
 * keys, jump hosts, multiplexing — belongs in the user's own `~/.ssh/config`,
 * which ssh already reads and which is where anyone maintaining a fleet
 * already keeps it. Re-declaring that here would be a second place to keep in
 * step with the first.
 */
export interface RemoteConfig {
  /** Hostname or an alias from the user's ssh config. */
  host: string;
  user?: string;
  port?: number;
  /** The checkout on that machine; commands run here. */
  path?: string;
  /** Passed as `ssh -i`. Prefer an ssh-config `IdentityFile` where possible. */
  identityFile?: string;
}

export interface ExecutorConfig {
  models: ExecutorModels;
  pricing?: ExecutorPricing;
  /** Present only for CLI-backed agents; the built-in executors ignore it. */
  command?: ExecutorCommand;
}

export const EXECUTOR_PRICING_FIELDS: readonly (keyof ExecutorPricing)[] = [
  'input',
  'cachedInput',
  'output',
];

export const EXECUTOR_MODEL_ROLES: readonly (keyof ExecutorModels)[] = [
  'execute',
  'plan',
];

/** The executor `orchestrator.executor` names when the config is silent. */
export const DEFAULT_EXECUTOR_NAME = 'claude';

// The one place a model is chosen for an executor: `models.execute`/`plan`
// stay the Claude aliases, an `executors.<name>.models` block overlays them for
// claude and is the whole answer for any other executor.
export function executorModels(
  config: Pick<DispatchConfig, 'models' | 'executors'>,
  name: string
): ExecutorModels {
  const own = config.executors?.[name]?.models ?? {};
  if (name !== DEFAULT_EXECUTOR_NAME) return { ...own };
  return {
    execute: own.execute ?? config.models.execute,
    plan: own.plan ?? config.models.plan,
  };
}

/** The subset of config the Settings screen can change. Everything else — statuses chief
 *  among them — is structural, and editing it from a form would invalidate existing tasks. */
export interface ConfigPatch {
  verifyCommand?: string | null;
  autoCommit?: boolean;
  epicConcurrency?: number;
  verifyTimeoutSec?: number;
  maxConcurrency?: number;
  runCostEstimateUsd?: number;
  /** `null` clears the key, restoring "no cap" — both are optional in OrchestratorConfig. */
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  permissionMode?: OrchestratorConfig['permissionMode'];
  models?: Partial<ModelConfig>;
  /** Per-role effort; `null` removes the role so the model default applies. */
  effort?: Partial<Record<keyof EffortConfig, EffortLevel | null>>;
  /** Writes `orchestrator.executor`. */
  executor?: string;
  /** Written key-by-key under `executors.<name>.models`. `command` declares
   *  or changes a CLI agent (null makes it a plain executor again); a whole
   *  entry of `null` removes that agent. */
  executors?: Record<
    string,
    {
      models?: Partial<ExecutorModels>;
      pricing?: ExecutorPricing;
      command?: ExecutorCommand | null;
    } | null
  >;
  linear?: Partial<LinearConfig>;
  fixLoop?: Partial<FixLoopConfig>;
  verify?: Partial<VerifyConfig>;
  /** `webhook: null` clears the URL. `kinds` merges over what is on disk. */
  notifications?: {
    kinds?: Partial<Record<NotificationKind, boolean>>;
    webhook?: string | null;
  };
  /** Weights only — the factor table itself is code, not configuration. */
  queue?: { weights?: Partial<QueueWeights> };
  /** `gates` is written key-by-key; a `null` pin clears the override so the
   *  rung decides again. */
  policy?: {
    rung?: number;
    gates?: Partial<Record<PolicyGate, PolicyGateMode | null>>;
  };
  // The blocks below follow one rule, field by field: a value sets it, `null`
  // removes it (its default applies again), absent leaves it alone. The
  // patched document is then validated whole (updateConfig), so none of
  // these can write something the loader would refuse.
  /** The board's statuses, in order, replacing the list. */
  statuses?: StatusEntryInput[];
  /** Replaces `statusRoles`; null removes it (defaults apply again). */
  statusRoles?: StatusRoles | null;
  /** Replaces `people`; null or empty removes it. */
  people?: Person[] | null;
  /** Replaces `labels`; null or empty removes it. */
  labels?: LabelDefinition[] | null;
  /** Named verify gates, replacing the list; null or empty removes it. */
  verifySteps?: VerifyStep[] | null;
  /** Per remote name: a config sets it, null removes it. */
  remotes?: Record<string, RemoteConfig | null>;
  carto?: { enabled?: CartoMode };
  repoDigest?: { enabled?: boolean; cooldownHours?: number | null };
  receipts?: {
    enabled?: boolean;
    dir?: string | null;
    remote?: string | null;
    repo?: string | null;
    branch?: string | null;
  };
  sync?: {
    enabled?: boolean;
    remote?: string | null;
    repo?: string | null;
    branch?: string | null;
    intervalSec?: number | null;
  };
  prWorktreeDir?: string | null;
  preview?: {
    enabled?: boolean;
    command?: string | null;
    installCommand?: string | null;
    readyTimeoutSec?: number | null;
    idleTimeoutSec?: number | null;
  };
  /** A value sets the key, `null` removes it (its default applies again). */
  memory?: { [K in keyof MemoryConfig]?: MemoryConfig[K] | null };
}
