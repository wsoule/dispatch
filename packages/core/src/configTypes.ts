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
}

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
  permissionMode?: OrchestratorConfig['permissionMode'];
  models?: Partial<ModelConfig>;
  linear?: Partial<LinearConfig>;
}
