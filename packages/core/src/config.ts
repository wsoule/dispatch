import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

import type {
  CartoConfig,
  CartoMode,
  ConfigPatch,
  DispatchConfig,
  EscalationStep,
  FixLoopConfig,
  LinearConfig,
  ModelConfig,
  OrchestratorConfig,
  RepoDigestConfig,
  VerifyConfig,
} from './configTypes.js';
import {
  CARTO_MODES,
  DEFAULT_CARTO,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MODELS,
  DEFAULT_REPO_DIGEST,
  FIX_MODEL_TIERS,
  FIX_STRATEGIES,
  LINEAR_DIRECTIONS,
  MODEL_ROLES,
} from './configTypes.js';
import { canonicalStatus } from './status.js';
import { DISPATCH_DIR } from './store.js';
import { STATUSES } from './types.js';

export * from './configTypes.js';

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}

// The Claude Agent SDK's `PermissionMode` values, duplicated so core stays
// executor-agnostic. An unknown mode is a ConfigError, not an SDK 400 later.
const KNOWN_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
  'auto',
] as const;

// `permissionMode: 'auto'` lets the SDK's own classifier approve every tool, so a
// dispatched agent proceeds unattended instead of stalling on the first Bash call.
const DEFAULT_ORCHESTRATOR: OrchestratorConfig = {
  // No default turn cap — maxBudgetUsd is the real guard.
  permissionMode: 'auto',
  epicConcurrency: 3,
  // 10 minutes: above a real install+build+test verify, still bounded.
  verifyTimeoutSec: 600,
};

// `escalation` holds objects, so a shallow spread would share rows between the
// defaults and every loaded config.
function cloneFixLoop(config: FixLoopConfig): FixLoopConfig {
  return {
    auto: config.auto,
    cap: config.cap,
    escalation: config.escalation.map((step) => ({ ...step })),
  };
}

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
  orchestrator: { ...DEFAULT_ORCHESTRATOR },
  models: { ...DEFAULT_MODELS },
  linear: { ...DEFAULT_LINEAR, statusMap: { ...DEFAULT_LINEAR.statusMap } },
  fixLoop: cloneFixLoop(DEFAULT_FIX_LOOP),
  carto: { ...DEFAULT_CARTO },
  repoDigest: { ...DEFAULT_REPO_DIGEST },
};

// Validates the optional `orchestrator:` block. Only `undefined` falls back to
// defaults; any other non-object is a ConfigError rather than silently ignored.
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

// Validates the optional `repoDigest:` block, same contract as
// parseOrchestratorConfig — only `undefined` falls back to defaults.
function parseRepoDigestConfig(raw: unknown): RepoDigestConfig {
  if (raw === undefined) return { ...DEFAULT_REPO_DIGEST };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: repoDigest must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { enabled } = obj;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: repoDigest.enabled must be a boolean'
    );
  }

  const { cooldownHours } = obj;
  if (
    cooldownHours !== undefined &&
    (typeof cooldownHours !== 'number' ||
      !Number.isFinite(cooldownHours) ||
      cooldownHours <= 0)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: repoDigest.cooldownHours must be a positive number'
    );
  }

  return {
    enabled: enabled ?? DEFAULT_REPO_DIGEST.enabled,
    cooldownHours: cooldownHours ?? DEFAULT_REPO_DIGEST.cooldownHours,
  };
}

// Validates the optional `models:` block, same contract as parseOrchestratorConfig.
// An unknown role key is a ConfigError so a typo can't leave a role on its default.
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

// Declared as `readonly string[]` (not the literal union) so a membership
// check against an unvalidated `unknown` never needs an `as` cast.
const VERIFY_FIELDS: readonly (keyof VerifyConfig)[] = [
  'command',
  'url',
  'notes',
];

// Validates the optional `verify:` block. Unlike models, an absent block
// stays absent — no recipe means the verify stage has nothing to dispatch.
function parseVerifyConfig(raw: unknown): VerifyConfig | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: verify must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!VERIFY_FIELDS.includes(key as keyof VerifyConfig)) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: unknown verify field "${key}" (expected ${VERIFY_FIELDS.join('|')})`
      );
    }
  }
  const result: VerifyConfig = {};
  for (const field of VERIFY_FIELDS) {
    const value = obj[field];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `invalid .dispatch/config.yml: verify.${field} must be a non-empty string`
      );
    }
    result[field] = value;
  }
  return result;
}

// Validates the optional `linear:` block, same contract as the blocks above. `statusMap`
// merges over the default, so remapping one status does not unmap the other five.
function parseLinearConfig(raw: unknown): LinearConfig {
  const defaults: LinearConfig = {
    ...DEFAULT_LINEAR,
    statusMap: { ...DEFAULT_LINEAR.statusMap },
  };
  if (raw === undefined) return defaults;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: linear must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { enabled } = obj;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: linear.enabled must be a boolean'
    );
  }

  const { teamId } = obj;
  if (teamId !== undefined && teamId !== null && typeof teamId !== 'string') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: linear.teamId must be a string or null'
    );
  }

  const { intervalSec } = obj;
  if (
    intervalSec !== undefined &&
    (typeof intervalSec !== 'number' ||
      !Number.isFinite(intervalSec) ||
      intervalSec < 30)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: linear.intervalSec must be a number >= 30'
    );
  }

  const { direction } = obj;
  if (
    direction !== undefined &&
    (typeof direction !== 'string' ||
      !LINEAR_DIRECTIONS.includes(direction as LinearConfig['direction']))
  ) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: linear.direction must be one of ${LINEAR_DIRECTIONS.join('|')}`
    );
  }

  const { statusMap } = obj;
  const mergedStatusMap = { ...defaults.statusMap };
  if (statusMap !== undefined) {
    if (
      typeof statusMap !== 'object' ||
      statusMap === null ||
      Array.isArray(statusMap)
    ) {
      throw new ConfigError(
        'invalid .dispatch/config.yml: linear.statusMap must be an object'
      );
    }
    for (const [key, value] of Object.entries(statusMap)) {
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(
          `invalid .dispatch/config.yml: linear.statusMap.${key} must be a non-empty string`
        );
      }
      mergedStatusMap[key] = value;
    }
  }

  return {
    enabled: enabled ?? defaults.enabled,
    teamId: teamId ?? defaults.teamId,
    statusMap: mergedStatusMap,
    intervalSec: intervalSec ?? defaults.intervalSec,
    direction: (direction as LinearConfig['direction']) ?? defaults.direction,
  };
}

// Validates one escalation row. `label` names it in the error so a bad row in
// a five-row table is identifiable without counting.
function parseEscalationStep(raw: unknown, label: string): EscalationStep {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`invalid ${label}: must be an object`);
  }
  const { round, strategy, modelTier } = raw as Record<string, unknown>;
  if (typeof round !== 'number' || !Number.isInteger(round) || round < 1) {
    throw new ConfigError(`invalid ${label}.round: must be an integer >= 1`);
  }
  if (typeof strategy !== 'string' || !FIX_STRATEGIES.includes(strategy)) {
    throw new ConfigError(
      `invalid ${label}.strategy: must be one of ${FIX_STRATEGIES.join('|')}`
    );
  }
  if (typeof modelTier !== 'string' || !FIX_MODEL_TIERS.includes(modelTier)) {
    throw new ConfigError(
      `invalid ${label}.modelTier: must be one of ${FIX_MODEL_TIERS.join('|')}`
    );
  }
  return {
    round,
    strategy: strategy as EscalationStep['strategy'],
    modelTier: modelTier as EscalationStep['modelTier'],
  };
}

// Validates the optional `fixLoop:` block, same contract as the blocks above.
// An escalation table on disk replaces the default outright rather than merging.
function parseFixLoopConfig(raw: unknown): FixLoopConfig {
  if (raw === undefined) return cloneFixLoop(DEFAULT_FIX_LOOP);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: fixLoop must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { auto } = obj;
  if (auto !== undefined && typeof auto !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: fixLoop.auto must be a boolean'
    );
  }

  const { cap } = obj;
  if (
    cap !== undefined &&
    (typeof cap !== 'number' || !Number.isInteger(cap) || cap < 1)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: fixLoop.cap must be an integer >= 1'
    );
  }

  const { escalation } = obj;
  if (escalation === undefined) {
    return {
      ...cloneFixLoop(DEFAULT_FIX_LOOP),
      auto: auto ?? DEFAULT_FIX_LOOP.auto,
      cap: cap ?? DEFAULT_FIX_LOOP.cap,
    };
  }
  if (!Array.isArray(escalation)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: fixLoop.escalation must be a list'
    );
  }
  return {
    auto: auto ?? DEFAULT_FIX_LOOP.auto,
    cap: cap ?? DEFAULT_FIX_LOOP.cap,
    escalation: escalation.map((entry, index) =>
      parseEscalationStep(entry, `fixLoop.escalation[${index}]`)
    ),
  };
}

// Validates the optional `carto:` block. `enabled: true`/`false` (real YAML
// booleans) are normalized to 'on'/'off' alongside the string spellings.
function parseCarto(raw: unknown): CartoConfig {
  if (raw === undefined || raw === null) return { ...DEFAULT_CARTO };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: carto must be a mapping'
    );
  }
  const enabled = (raw as Record<string, unknown>).enabled;
  if (enabled === undefined) return { ...DEFAULT_CARTO };
  const normalized =
    enabled === true ? 'on' : enabled === false ? 'off' : enabled;
  if (
    typeof normalized !== 'string' ||
    !CARTO_MODES.includes(normalized as CartoMode)
  ) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: carto.enabled must be one of: ${CARTO_MODES.join(', ')}`
    );
  }
  return { enabled: normalized as CartoMode };
}

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) {
    return {
      statuses: [...DEFAULTS.statuses],
      autoCommit: DEFAULTS.autoCommit,
      orchestrator: { ...DEFAULTS.orchestrator },
      models: { ...DEFAULTS.models },
      linear: {
        ...DEFAULTS.linear,
        statusMap: { ...DEFAULTS.linear.statusMap },
      },
      fixLoop: cloneFixLoop(DEFAULTS.fixLoop),
      carto: { ...DEFAULTS.carto },
      repoDigest: { ...DEFAULTS.repoDigest },
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
  if (
    raw.prWorktreeDir !== undefined &&
    (typeof raw.prWorktreeDir !== 'string' || raw.prWorktreeDir.trim() === '')
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: prWorktreeDir must be a non-empty string'
    );
  }
  return {
    // Old config files list the pre-rename names; canonicalize (and dedupe,
    // in case a file lists both an old name and its successor) on load.
    statuses: [
      ...new Set((raw.statuses ?? DEFAULTS.statuses).map(canonicalStatus)),
    ],
    autoCommit: raw.autoCommit ?? DEFAULTS.autoCommit,
    verifyCommand: raw.verifyCommand,
    verifySteps: raw.verifySteps,
    orchestrator: parseOrchestratorConfig(raw.orchestrator),
    models: parseModelConfig(raw.models),
    linear: parseLinearConfig(raw.linear),
    fixLoop: parseFixLoopConfig(raw.fixLoop),
    verify: parseVerifyConfig(raw.verify),
    carto: parseCarto(raw.carto),
    repoDigest: parseRepoDigestConfig(raw.repoDigest),
    prWorktreeDir: raw.prWorktreeDir,
  };
}

// Writes the `linear:` keys a patch names, validating each before it reaches disk.
// `statusMap` is written key-by-key so an entry the patch omits survives.
function applyLinearPatch(
  doc: YAML.Document,
  patch: Partial<LinearConfig>
): void {
  if (patch.enabled !== undefined) {
    if (typeof patch.enabled !== 'boolean') {
      throw new ConfigError('invalid linear.enabled: must be a boolean');
    }
    doc.setIn(['linear', 'enabled'], patch.enabled);
  }
  if (patch.teamId !== undefined) {
    if (patch.teamId !== null && typeof patch.teamId !== 'string') {
      throw new ConfigError('invalid linear.teamId: must be a string or null');
    }
    doc.setIn(['linear', 'teamId'], patch.teamId);
  }
  if (patch.intervalSec !== undefined) {
    if (!Number.isFinite(patch.intervalSec) || patch.intervalSec < 30) {
      throw new ConfigError('invalid linear.intervalSec: must be >= 30');
    }
    doc.setIn(['linear', 'intervalSec'], patch.intervalSec);
  }
  if (patch.direction !== undefined) {
    if (!LINEAR_DIRECTIONS.includes(patch.direction)) {
      throw new ConfigError(
        `invalid linear.direction: must be one of ${LINEAR_DIRECTIONS.join('|')}`
      );
    }
    doc.setIn(['linear', 'direction'], patch.direction);
  }
  if (patch.statusMap !== undefined) {
    if (
      typeof patch.statusMap !== 'object' ||
      patch.statusMap === null ||
      Array.isArray(patch.statusMap)
    ) {
      throw new ConfigError('invalid linear.statusMap: must be an object');
    }
    for (const [status, state] of Object.entries(patch.statusMap)) {
      if (typeof state !== 'string' || state.trim() === '') {
        throw new ConfigError(
          `invalid linear.statusMap.${status}: must be a non-empty string`
        );
      }
      doc.setIn(['linear', 'statusMap', status], state.trim());
    }
  }
}

// Writes the `fixLoop:` keys a patch names. The escalation table is written
// whole, since a per-row merge has no stable key to merge on.
function applyFixLoopPatch(
  doc: YAML.Document,
  patch: Partial<FixLoopConfig>
): void {
  if (patch.auto !== undefined) {
    if (typeof patch.auto !== 'boolean') {
      throw new ConfigError('invalid fixLoop.auto: must be a boolean');
    }
    doc.setIn(['fixLoop', 'auto'], patch.auto);
  }
  if (patch.cap !== undefined) {
    if (!Number.isInteger(patch.cap) || patch.cap < 1) {
      throw new ConfigError('invalid fixLoop.cap: must be an integer >= 1');
    }
    doc.setIn(['fixLoop', 'cap'], patch.cap);
  }
  if (patch.escalation !== undefined) {
    if (!Array.isArray(patch.escalation)) {
      throw new ConfigError('invalid fixLoop.escalation: must be a list');
    }
    const steps = patch.escalation.map((entry, index) =>
      parseEscalationStep(entry, `fixLoop.escalation[${index}]`)
    );
    doc.setIn(['fixLoop', 'escalation'], steps);
  }
}

/** Applies a partial change to `.dispatch/config.yml` through YAML's document API, so the
 *  hand-written file keeps its comments and ordering. `verifyCommand: null` clears the key. */
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

  // Positive *numbers*, not integers: a budget is money and a turn cap is
  // checked with `<=` upstream, matching the loader's own rule for both.
  for (const key of ['maxTurns', 'maxBudgetUsd'] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (value === null) {
      // Clearing an absent cap is a no-op, not an error: the config already
      // says "no cap". `deleteIn` throws if `orchestrator` isn't a
      // collection yet, so only delete when the key is actually there —
      // never create `orchestrator` as a side effect of clearing.
      if (doc.hasIn(['orchestrator', key])) doc.deleteIn(['orchestrator', key]);
      continue;
    }
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(`invalid ${key}: must be a positive number`);
    }
    doc.setIn(['orchestrator', key], value);
  }
  if (patch.permissionMode !== undefined) {
    // Validated before the write: an unknown mode on disk would make every
    // later loadConfig throw.
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
    // Same validate-before-write rule as permissionMode: a bad role must never
    // reach disk, or loadConfig refuses the whole file afterwards.
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
  if (patch.linear !== undefined) applyLinearPatch(doc, patch.linear);
  if (patch.fixLoop !== undefined) applyFixLoopPatch(doc, patch.fixLoop);
  if (patch.verify !== undefined) {
    // Same validate-before-write rule as models: a bad field must never reach
    // disk, or loadConfig refuses the whole file afterwards.
    for (const [field, value] of Object.entries(patch.verify)) {
      if (!VERIFY_FIELDS.includes(field as keyof VerifyConfig)) {
        throw new ConfigError(
          `invalid verify field: ${field} (expected ${VERIFY_FIELDS.join('|')})`
        );
      }
      if (typeof value !== 'string' || value.trim() === '') {
        throw new ConfigError(
          `invalid verify.${field}: must be a non-empty string`
        );
      }
      doc.setIn(['verify', field], value.trim());
    }
  }

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString());
  // Re-read rather than returning a locally-patched object, so the caller gets exactly what the
  // next loadConfig() will see — including any validation the parser applies.
  return loadConfig(rootDir);
}
