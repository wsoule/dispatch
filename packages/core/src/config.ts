import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
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
export interface OrchestratorConfig {
  maxTurns: number;
  maxBudgetUsd?: number;
  permissionMode: string;
}

export interface DispatchConfig {
  statuses: string[];
  autoCommit: boolean;
  orchestrator: OrchestratorConfig;
}

const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  maxTurns: 100,
  permissionMode: 'acceptEdits',
};

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
  orchestrator: { ...DEFAULT_ORCHESTRATOR },
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

  return {
    maxTurns: maxTurns ?? DEFAULT_ORCHESTRATOR.maxTurns,
    maxBudgetUsd,
    permissionMode: permissionMode ?? DEFAULT_ORCHESTRATOR.permissionMode,
  };
}

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) {
    return {
      statuses: [...DEFAULTS.statuses],
      autoCommit: DEFAULTS.autoCommit,
      orchestrator: { ...DEFAULTS.orchestrator },
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
  return {
    statuses: [...(raw.statuses ?? DEFAULTS.statuses)],
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
    orchestrator: parseOrchestratorConfig(raw.orchestrator),
  };
}
