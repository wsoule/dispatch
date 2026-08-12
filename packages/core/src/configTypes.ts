import { DEFAULT_STATUS_MAP } from './linearMap.js';

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
  /** Parent directory for PR review worktrees (Task 7); each PR gets a
   *  `pr-<n>` child inside it. Absent means the default sibling of `rootDir`. */
  prWorktreeDir?: string;
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
  auto: true,
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
}
