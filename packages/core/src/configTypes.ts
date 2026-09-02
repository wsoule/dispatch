import { DEFAULT_STATUS_MAP } from './linearMap.js';
import type { QueueWeights } from './scoring.js';
import { DEFAULT_QUEUE_WEIGHTS } from './scoring.js';

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
}

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
}

export const DEFAULT_RECEIPTS: ReceiptsConfig = { enabled: true };

/** One named gate in the verify pipeline. */
export interface VerifyStep {
  name: string;
  command: string;
}

export interface DispatchConfig {
  statuses: string[];
  autoCommit: boolean;
  verifyCommand?: string;
  /** Verify as named steps rather than one opaque command, so a failure names
   *  the check that broke. Takes precedence over `verifyCommand`. */
  verifySteps?: VerifyStep[];
  orchestrator: OrchestratorConfig;
  models: ModelConfig;
  linear: LinearConfig;
  fixLoop: FixLoopConfig;
  /** How to run this project for a `verify` run to exercise it. Absent means
   *  the verify stage has nothing to dispatch, so a task simply skips it. */
  verify?: VerifyConfig;
  carto: CartoConfig;
  repoDigest: RepoDigestConfig;
  /**
   * The git receipt log. `loadConfig` always populates this, so a config it
   * returns can be read without a fallback; it is optional only so callers
   * that build a DispatchConfig literal by hand — test fixtures, mostly — do
   * not all have to be updated at once. Absent means DEFAULT_RECEIPTS.
   */
  receipts?: ReceiptsConfig;
  /** Optional in the type, but `loadConfig` always populates it — the marker
   *  is for hand-built config objects (test fixtures) written before the block
   *  existed. Read it through `queueWeights()`, never directly: that is what
   *  forces a caller to handle a rejected block instead of silently ranking
   *  against defaults. */
  queue?: QueueConfig;
  /** Parent directory for PR review worktrees (Task 7); each PR gets a
   *  `pr-<n>` child inside it. Absent means the default sibling of `rootDir`. */
  prWorktreeDir?: string;
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

/** Linear sync settings. Holds no secret — the API key lives in `~/.dispatch/credentials.json`. */
export interface LinearConfig {
  enabled: boolean;
  teamId: string | null;
  /** dispatch status -> Linear workflow state name (a state `type` also matches). */
  statusMap: Record<string, string>;
  intervalSec: number;
  direction: 'both' | 'pull' | 'push';
}

export const LINEAR_DIRECTIONS = ['both', 'pull', 'push'] as const;

export const DEFAULT_LINEAR: LinearConfig = {
  enabled: false,
  teamId: null,
  statusMap: { ...DEFAULT_STATUS_MAP },
  intervalSec: 300,
  direction: 'both',
};

/** Per-role model ids. Each role is a distinct kind of agent work, so cheap
 *  roles can run on a cheap model without downgrading coding runs. */
export interface ModelConfig {
  /** Coding runs — the agent that edits the repo. */
  execute: string;
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
}

export const DEFAULT_MODELS: ModelConfig = {
  execute: 'claude-opus-5',
  plan: 'claude-sonnet-5',
  draft: 'claude-haiku-4-5-20251001',
  enrich: 'claude-haiku-4-5-20251001',
  cluster: 'claude-haiku-4-5-20251001',
  summarize: 'claude-haiku-4-5-20251001',
};

/** Every valid key of `ModelConfig`, in the order the Settings UI renders them. */
export const MODEL_ROLES: readonly (keyof ModelConfig)[] = [
  'execute',
  'plan',
  'draft',
  'enrich',
  'cluster',
  'summarize',
];

/** The subset of config the Settings screen can change. Everything else — statuses chief
 *  among them — is structural, and editing it from a form would invalidate existing tasks. */
export interface ConfigPatch {
  verifyCommand?: string | null;
  autoCommit?: boolean;
  epicConcurrency?: number;
  verifyTimeoutSec?: number;
  /** `null` clears the key, restoring "no cap" — both are optional in OrchestratorConfig. */
  maxTurns?: number | null;
  maxBudgetUsd?: number | null;
  permissionMode?: OrchestratorConfig['permissionMode'];
  models?: Partial<ModelConfig>;
  linear?: Partial<LinearConfig>;
  fixLoop?: Partial<FixLoopConfig>;
  verify?: Partial<VerifyConfig>;
  /** Weights only — the factor table itself is code, not configuration. */
  queue?: { weights?: Partial<QueueWeights> };
}
