import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

import { DISPATCH_DIR } from './store.js';
import { STATUSES } from './types.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// The exact set of Claude Agent SDK `PermissionMode` values, duplicated here
// (rather than imported) so core stays executor-agnostic — @dispatch/server
// is the only package that knows the Agent SDK exists. Keep this list in
// sync with the SDK's `PermissionMode` union if it ever changes; a value
// outside this set is a loud ConfigError rather than a confusing 400 from
// the SDK itself at dispatch time.
const KNOWN_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

// Per-run caps/defaults for the orchestrator's executors (spec's Slice O2):
// how many turns an agent gets, an optional USD spend cap, and which
// permission mode it starts in. `maxBudgetUsd` has no default — omitting it
// means "no budget cap" — everything else always has a concrete value.
// `epicConcurrency` (Phase 5) is the default cap the epic dispatch engine
// applies when starting an epic without an explicit override -- how many of
// an epic's ready children may have a live run at once.
//
// `permissionMode: 'auto'` is the default rather than `'acceptEdits'`: the
// SDK's own model-classifier auto-approves the whole run (edits and every
// other tool), not just file edits, so a dispatched agent proceeds
// unattended instead of stalling on the first non-edit tool call (a Bash
// command, an MCP tool) waiting for a human who isn't watching. Verified
// against the installed SDK (0.3.207)'s `PermissionMode` union, which
// includes `'auto'`.
export interface OrchestratorConfig {
  maxTurns?: number;
  // How long the merge queue lets `verifyCommand` run before killing it and
  // failing the entry. A ceiling, not a budget: the queue is strictly serial, so
  // a verify that never returns holds up every entry behind it — which is
  // exactly how an entry once sat in `verifying` for 11 minutes with no process
  // behind it at all.
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
  /**
   * Verify as named steps rather than one opaque command.
   *
   * `verifyCommand` runs a single shell line, which means a failure can only ever be reported
   * as "verify failed" — the queue genuinely does not know whether typecheck or the tests broke.
   * Listing steps here is what makes per-check reporting possible at all: each runs in order,
   * each is recorded pass/fail with its duration, and the first failure stops the rest.
   *
   * Takes precedence over `verifyCommand` when both are set. Absent, the single command is run
   * as one step called "verify", so nothing changes for a project that has not opted in.
   */
  verifySteps?: VerifyStep[];
  orchestrator: OrchestratorConfig;
  models: ModelConfig;
}

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

const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  // No default turn cap — maxBudgetUsd is the real guard.
  permissionMode: 'auto',
  epicConcurrency: 3,
  // 10 minutes: comfortably above a real install+build+test verify (~2-3 min
  // measured on this repo) while still bounded, so a hang is caught in minutes
  // rather than never.
  verifyTimeoutSec: 600,
};

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
  orchestrator: { ...DEFAULT_ORCHESTRATOR },
  models: { ...DEFAULT_MODELS },
};

// Validates and normalizes the optional `orchestrator:` block. `raw` is
// whatever YAML.parse produced for that key — `undefined` (key omitted) is
// the only shape that skips validation entirely and falls back to defaults;
// anything else that isn't a plain object is a loud ConfigError rather than
// being silently ignored.
function parseOrchestratorConfig(raw: unknown): OrchestratorConfig {
  if (raw === undefined) return { ...DEFAULT_ORCHESTRATOR };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { maxTurns } = obj;
  if (
    maxTurns !== undefined &&
    (typeof maxTurns !== 'number' ||
      !Number.isFinite(maxTurns) ||
      maxTurns <= 0)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.maxTurns must be a positive number'
    );
  }

  const { verifyTimeoutSec } = obj;
  if (
    verifyTimeoutSec !== undefined &&
    (typeof verifyTimeoutSec !== 'number' ||
      !Number.isFinite(verifyTimeoutSec) ||
      verifyTimeoutSec <= 0)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.verifyTimeoutSec must be a positive number'
    );
  }

  const { maxBudgetUsd } = obj;
  if (
    maxBudgetUsd !== undefined &&
    (typeof maxBudgetUsd !== 'number' ||
      !Number.isFinite(maxBudgetUsd) ||
      maxBudgetUsd <= 0)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.maxBudgetUsd must be a positive number'
    );
  }

  const { permissionMode } = obj;
  if (
    permissionMode !== undefined &&
    (typeof permissionMode !== 'string' ||
      !KNOWN_PERMISSION_MODES.includes(
        permissionMode as (typeof KNOWN_PERMISSION_MODES)[number]
      ))
  ) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: orchestrator.permissionMode must be one of ${KNOWN_PERMISSION_MODES.join('|')}`
    );
  }

  const { epicConcurrency } = obj;
  if (
    epicConcurrency !== undefined &&
    (typeof epicConcurrency !== 'number' ||
      !Number.isInteger(epicConcurrency) ||
      epicConcurrency < 1)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.epicConcurrency must be an integer >= 1'
    );
  }

  return {
    maxTurns: maxTurns ?? DEFAULT_ORCHESTRATOR.maxTurns,
    maxBudgetUsd,
    permissionMode: permissionMode ?? DEFAULT_ORCHESTRATOR.permissionMode,
    epicConcurrency: epicConcurrency ?? DEFAULT_ORCHESTRATOR.epicConcurrency,
    verifyTimeoutSec: verifyTimeoutSec ?? DEFAULT_ORCHESTRATOR.verifyTimeoutSec,
  };
}

// Validates and normalizes the optional `models:` block, same shape of contract as
// parseOrchestratorConfig: `undefined` (key omitted) falls back to DEFAULT_MODELS entirely; any
// other non-object is a loud ConfigError; an unrecognized role key is a ConfigError rather than
// a silently-ignored typo (e.g. `excute:` would otherwise leave `execute` on the SDK default
// forever with no indication why); each provided value must be a non-empty string; a role left
// out of the block keeps its default.
function parseModelConfig(raw: unknown): ModelConfig {
  if (raw === undefined) return { ...DEFAULT_MODELS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: models must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!MODEL_ROLES.includes(key as keyof ModelConfig)) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: unknown models role "${key}" (expected ${MODEL_ROLES.join('|')})`
      );
    }
  }
  const result = { ...DEFAULT_MODELS };
  for (const role of MODEL_ROLES) {
    const value = obj[role];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `invalid .dispatch/config.yml: models.${role} must be a non-empty string`
      );
    }
    result[role] = value;
  }
  return result;
}

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) {
    return {
      statuses: [...DEFAULTS.statuses],
      autoCommit: DEFAULTS.autoCommit,
      orchestrator: { ...DEFAULTS.orchestrator },
      models: { ...DEFAULTS.models },
    };
  }
  let parsed: unknown;
  try {
    parsed = YAML.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${(err as Error).message}`
    );
  }
  const raw = (parsed ?? {}) as Partial<DispatchConfig>;
  if (raw.verifySteps !== undefined) {
    if (!Array.isArray(raw.verifySteps)) {
      throw new ConfigError(
        'invalid .dispatch/config.yml: verifySteps must be a list'
      );
    }
    for (const step of raw.verifySteps) {
      if (
        typeof step !== 'object' ||
        step === null ||
        typeof step.name !== 'string' ||
        typeof step.command !== 'string' ||
        step.name.trim() === '' ||
        step.command.trim() === ''
      ) {
        throw new ConfigError(
          'invalid .dispatch/config.yml: each verifySteps entry needs a name and a command'
        );
      }
    }
  }
  if (
    raw.statuses !== undefined &&
    (!Array.isArray(raw.statuses) ||
      raw.statuses.some((s) => typeof s !== 'string'))
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: statuses must be an array of strings'
    );
  }
  if (raw.autoCommit !== undefined && typeof raw.autoCommit !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: autoCommit must be a boolean'
    );
  }
  if (
    raw.verifyCommand !== undefined &&
    (typeof raw.verifyCommand !== 'string' || raw.verifyCommand.trim() === '')
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: verifyCommand must be a non-empty string'
    );
  }
  return {
    statuses: [...(raw.statuses ?? DEFAULTS.statuses)],
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
    verifyCommand: raw.verifyCommand,
    verifySteps: raw.verifySteps,
    orchestrator: parseOrchestratorConfig(raw.orchestrator),
    models: parseModelConfig(raw.models),
  };
}

/** The subset of config the Settings screen can change. Everything else in the file — statuses
 * chief among them — is structural, and editing it from a settings form would silently
 * invalidate every task already carrying an old status. */
export interface ConfigPatch {
  verifyCommand?: string | null;
  autoCommit?: boolean;
  epicConcurrency?: number;
  verifyTimeoutSec?: number;
  permissionMode?: OrchestratorConfig['permissionMode'];
  models?: Partial<ModelConfig>;
}

/**
 * Applies a partial change to `.dispatch/config.yml`, preserving everything it does not touch.
 *
 * Re-serialising a parsed object would be simpler and wrong: this file is hand-written and
 * checked in, so it carries comments and key ordering someone chose. YAML's document API is used
 * so an edit changes the one value asked for and leaves the rest of the file — comments
 * included — exactly as it was found.
 *
 * `verifyCommand: null` clears the key rather than writing an empty string, since an empty
 * verify command and no verify command mean different things to the merge queue.
 */
export function updateConfig(
  rootDir: string,
  patch: ConfigPatch
): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  const doc = existsSync(path)
    ? YAML.parseDocument(readFileSync(path, 'utf8'))
    : new YAML.Document({});

  if (patch.verifyCommand !== undefined) {
    if (patch.verifyCommand === null || patch.verifyCommand.trim() === '') {
      doc.delete('verifyCommand');
    } else {
      doc.set('verifyCommand', patch.verifyCommand.trim());
    }
  }
  if (patch.autoCommit !== undefined) doc.set('autoCommit', patch.autoCommit);

  for (const key of ['epicConcurrency', 'verifyTimeoutSec'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(`invalid ${key}: must be a positive integer`);
    }
    doc.setIn(['orchestrator', key], value);
  }
  if (patch.permissionMode !== undefined) {
    // Validated BEFORE the write, not after. updateConfig re-reads through loadConfig to return
    // its result, and loadConfig throws on an unknown mode — so validating only there would
    // leave a file on disk that the daemon then refuses to load.
    if (
      !KNOWN_PERMISSION_MODES.includes(
        patch.permissionMode as (typeof KNOWN_PERMISSION_MODES)[number]
      )
    ) {
      throw new ConfigError(
        `invalid permissionMode: must be one of ${KNOWN_PERMISSION_MODES.join('|')}`
      );
    }
    doc.setIn(['orchestrator', 'permissionMode'], patch.permissionMode);
  }
  if (patch.models !== undefined) {
    // Same validate-before-write reasoning as permissionMode above: an unknown role or a
    // non-string value must never reach disk, since loadConfig would then refuse to read the
    // file back at all on the very next request.
    for (const [role, value] of Object.entries(patch.models)) {
      if (!MODEL_ROLES.includes(role as keyof ModelConfig)) {
        throw new ConfigError(
          `invalid models role: ${role} (expected ${MODEL_ROLES.join('|')})`
        );
      }
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(
          `invalid models.${role}: must be a non-empty string`
        );
      }
      doc.setIn(['models', role], value.trim());
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString());
  // Re-read rather than returning a locally-patched object, so the caller gets exactly what the
  // next loadConfig() will see — including any validation the parser applies.
  return loadConfig(rootDir);
}
