import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import YAML from 'yaml';

import type {
  CartoConfig,
  CartoMode,
  ConfigPatch,
  DispatchConfig,
  EscalationStep,
  ExecutorCommand,
  ExecutorConfig,
  ExecutorPricing,
  FixLoopConfig,
  LinearConfig,
  MessagingConfig,
  ModelConfig,
  NotificationKind,
  NotificationsConfig,
  OrchestratorConfig,
  PreviewConfig,
  QueueConfig,
  ReceiptsConfig,
  RemoteConfig,
  RepoDigestConfig,
  SyncConfig,
  VerifyConfig,
} from './configTypes.js';
import {
  CARTO_MODES,
  DEFAULT_CARTO,
  DEFAULT_EXECUTOR_NAME,
  DEFAULT_FIX_LOOP,
  DEFAULT_LINEAR,
  DEFAULT_MESSAGING,
  DEFAULT_MODELS,
  DEFAULT_NOTIFICATIONS,
  DEFAULT_PREVIEW,
  DEFAULT_RECEIPTS,
  DEFAULT_REPO_DIGEST,
  DEFAULT_SYNC,
  EXECUTOR_MODEL_ROLES,
  EXECUTOR_PRICING_FIELDS,
  FIX_MODEL_TIERS,
  FIX_STRATEGIES,
  LINEAR_DIRECTIONS,
  MAX_CONCURRENCY_HARD_CAP,
  MODEL_ROLES,
  NOTIFICATION_KINDS,
} from './configTypes.js';
import type { PolicyConfig, PolicyGate, PolicyGateMode } from './policy.js';
import {
  DEFAULT_POLICY,
  isFloorCheck,
  MAX_POLICY_RUNG,
  MIN_POLICY_RUNG,
  POLICY_GATE_MODES,
  POLICY_GATES,
} from './policy.js';
import type { QueueWeights, ScoreFactorKey } from './scoring.js';
import {
  DEFAULT_QUEUE_WEIGHTS,
  isQueueWeight,
  QUEUE_FACTOR_KEYS,
} from './scoring.js';
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
  executor: DEFAULT_EXECUTOR_NAME,
  // 10 minutes: above a real install+build+test verify, still bounded.
  verifyTimeoutSec: 600,
  maxConcurrency: 16,
  runCostEstimateUsd: 10,
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

// A fresh QueueConfig carrying a copy of the frozen defaults, so no loaded
// config ever shares a weights object with another.
function defaultQueue(): QueueConfig {
  return { weights: { ...DEFAULT_QUEUE_WEIGHTS } };
}

const DEFAULTS: DispatchConfig = {
  statuses: [...STATUSES],
  autoCommit: false,
  orchestrator: { ...DEFAULT_ORCHESTRATOR },
  preview: { ...DEFAULT_PREVIEW },
  models: { ...DEFAULT_MODELS },
  executors: {},
  remotes: {},
  linear: { ...DEFAULT_LINEAR, statusMap: { ...DEFAULT_LINEAR.statusMap } },
  fixLoop: cloneFixLoop(DEFAULT_FIX_LOOP),
  carto: { ...DEFAULT_CARTO },
  repoDigest: { ...DEFAULT_REPO_DIGEST },
  notifications: cloneNotifications(DEFAULT_NOTIFICATIONS),
  messaging: { ...DEFAULT_MESSAGING },
  receipts: { ...DEFAULT_RECEIPTS },
  policy: { ...DEFAULT_POLICY, gates: {} },
  // No `queue` here: it is the one optional block, so a DEFAULTS entry could
  // only be read through a fallback anyway. Both readers call defaultQueue().
};

// `kinds` is an object, so a shallow spread would share the toggle map
// between the defaults and every loaded config.
function cloneNotifications(config: NotificationsConfig): NotificationsConfig {
  return {
    kinds: { ...config.kinds },
    ...(config.webhook === undefined ? {} : { webhook: config.webhook }),
  };
}

// A webhook has to be somewhere an HTTP POST can reach: a parseable URL with
// an http(s) scheme. Anything else is a ConfigError at load time rather than a
// fetch failure logged on the first delivery. Returns the trimmed URL.
function validateWebhookUrl(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(`invalid ${label}: must be a non-empty string`);
  }
  const trimmed = value.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ConfigError(`invalid ${label}: must be an http(s) URL`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ConfigError(`invalid ${label}: must be an http(s) URL`);
  }
  return trimmed;
}

// Validates one `kinds:` map — the shape the loader and updateConfig share.
// An unknown kind is an error rather than ignored, so a typo cannot leave the
// kind it meant to silence on its default.
function parseNotificationKinds(
  raw: unknown,
  label: string
): Partial<Record<NotificationKind, boolean>> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`invalid ${label}: must be an object`);
  }
  const result: Partial<Record<NotificationKind, boolean>> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!NOTIFICATION_KINDS.includes(key as NotificationKind)) {
      throw new ConfigError(
        `invalid ${label}: unknown kind "${key}" (expected ${NOTIFICATION_KINDS.join('|')})`
      );
    }
    if (typeof value !== 'boolean') {
      throw new ConfigError(`invalid ${label}.${key}: must be a boolean`);
    }
    result[key as NotificationKind] = value;
  }
  return result;
}

// Validates the optional `notifications:` block, same contract as the blocks
// below. `kinds` merges over the defaults, so switching one kind off does not
// switch the other four off with it.
function parseNotificationsConfig(raw: unknown): NotificationsConfig {
  if (raw === undefined) return cloneNotifications(DEFAULT_NOTIFICATIONS);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: notifications must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  const result = cloneNotifications(DEFAULT_NOTIFICATIONS);
  if (obj.kinds !== undefined) {
    Object.assign(
      result.kinds,
      parseNotificationKinds(
        obj.kinds,
        '.dispatch/config.yml: notifications.kinds'
      )
    );
  }
  // `null` is how a hand edit clears the URL without deleting the key.
  if (obj.webhook !== undefined && obj.webhook !== null) {
    result.webhook = validateWebhookUrl(
      obj.webhook,
      '.dispatch/config.yml: notifications.webhook'
    );
  }
  return result;
}

// Validates the optional `messaging:` block. Each key is a positive integer
// that overrides its default independently, same merge-over-defaults contract
// as `notifications:`.
function parseMessagingConfig(raw: unknown): MessagingConfig {
  if (raw === undefined) return { ...DEFAULT_MESSAGING };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: messaging must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  const result = { ...DEFAULT_MESSAGING };
  for (const key of Object.keys(DEFAULT_MESSAGING) as Array<
    keyof MessagingConfig
  >) {
    const value = obj[key];
    if (value === undefined) continue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value <= 0) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: messaging.${key} must be a positive integer`
      );
    }
    result[key] = value;
  }
  return result;
}

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

  const { maxConcurrency } = obj;
  if (
    maxConcurrency !== undefined &&
    (typeof maxConcurrency !== 'number' ||
      !Number.isInteger(maxConcurrency) ||
      maxConcurrency < 1 ||
      maxConcurrency > MAX_CONCURRENCY_HARD_CAP)
  ) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: orchestrator.maxConcurrency must be an integer between 1 and ${MAX_CONCURRENCY_HARD_CAP}`
    );
  }

  const { runCostEstimateUsd } = obj;
  if (
    runCostEstimateUsd !== undefined &&
    (typeof runCostEstimateUsd !== 'number' ||
      !Number.isFinite(runCostEstimateUsd) ||
      runCostEstimateUsd <= 0)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.runCostEstimateUsd must be a positive number'
    );
  }

  // Checked on the resolved values so a raised epicConcurrency alone cannot
  // slip past the default cap.
  const resolvedEpicConcurrency =
    epicConcurrency ?? DEFAULT_ORCHESTRATOR.epicConcurrency;
  const resolvedMaxConcurrency =
    maxConcurrency ?? DEFAULT_ORCHESTRATOR.maxConcurrency;
  if (resolvedEpicConcurrency > resolvedMaxConcurrency) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: orchestrator.epicConcurrency (${resolvedEpicConcurrency}) must not exceed orchestrator.maxConcurrency (${resolvedMaxConcurrency})`
    );
  }

  const { executor } = obj;
  if (
    executor !== undefined &&
    (typeof executor !== 'string' || executor.trim() === '')
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: orchestrator.executor must be a non-empty string'
    );
  }

  return {
    maxTurns: maxTurns ?? DEFAULT_ORCHESTRATOR.maxTurns,
    maxBudgetUsd,
    permissionMode: permissionMode ?? DEFAULT_ORCHESTRATOR.permissionMode,
    epicConcurrency: resolvedEpicConcurrency,
    verifyTimeoutSec: verifyTimeoutSec ?? DEFAULT_ORCHESTRATOR.verifyTimeoutSec,
    maxConcurrency: resolvedMaxConcurrency,
    runCostEstimateUsd:
      runCostEstimateUsd ?? DEFAULT_ORCHESTRATOR.runCostEstimateUsd,
    executor: executor?.trim() ?? DEFAULT_ORCHESTRATOR.executor,
  };
}

// Validates one `executors.<name>.models` block: only the execute-side roles,
// each a non-empty string. Shared by loadConfig and updateConfig so a bad
// value never reaches disk and then fails every later load.
function parseExecutorModels(
  name: string,
  raw: unknown,
  prefix: string
): ExecutorConfig['models'] {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `${prefix}: executors.${name}.models must be an object`
    );
  }
  const obj = raw as Record<string, unknown>;
  const models: ExecutorConfig['models'] = {};
  for (const [role, value] of Object.entries(obj)) {
    if (
      !EXECUTOR_MODEL_ROLES.includes(role as keyof ExecutorConfig['models'])
    ) {
      throw new ConfigError(
        `${prefix}: unknown executors.${name}.models role "${role}" (expected ${EXECUTOR_MODEL_ROLES.join('|')})`
      );
    }
    if (typeof value !== 'string' || value.trim() === '') {
      throw new ConfigError(
        `${prefix}: executors.${name}.models.${role} must be a non-empty string`
      );
    }
    models[role as keyof ExecutorConfig['models']] = value.trim();
  }
  return models;
}

// Validates one `executors.<name>.pricing` block: known fields only, each a
// non-negative finite number, `input` and `output` required.
function parseExecutorPricing(
  name: string,
  raw: unknown,
  prefix: string
): ExecutorPricing {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `${prefix}: executors.${name}.pricing must be an object`
    );
  }
  const obj = raw as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!EXECUTOR_PRICING_FIELDS.includes(key as keyof ExecutorPricing)) {
      throw new ConfigError(
        `${prefix}: unknown executors.${name}.pricing field "${key}" (expected ${EXECUTOR_PRICING_FIELDS.join('|')})`
      );
    }
  }
  const rate = (key: keyof ExecutorPricing): number | undefined => {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new ConfigError(
        `${prefix}: executors.${name}.pricing.${key} must be a non-negative number`
      );
    }
    return value;
  };
  const input = rate('input');
  const output = rate('output');
  if (input === undefined || output === undefined) {
    throw new ConfigError(
      `${prefix}: executors.${name}.pricing needs both input and output rates`
    );
  }
  const cachedInput = rate('cachedInput');
  return {
    input,
    output,
    ...(cachedInput === undefined ? {} : { cachedInput }),
  };
}

// Validates one `executors.<name>.command` block: the argv a CLI-backed agent
// is spawned with, plus optional environment. An empty argv is rejected rather
// than defaulted — a command block with nothing to run is a typo, and silently
// ignoring it would make the executor register and then fail at dispatch.
function parseExecutorCommand(
  name: string,
  raw: unknown,
  prefix: string
): ExecutorCommand {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      `${prefix}: executors.${name}.command must be an object`
    );
  }
  const entry = raw as Record<string, unknown>;
  for (const key of Object.keys(entry)) {
    if (key !== 'run' && key !== 'env') {
      throw new ConfigError(
        `${prefix}: unknown executors.${name}.command key "${key}" (expected run|env)`
      );
    }
  }
  const { run, env } = entry;
  if (
    !Array.isArray(run) ||
    run.length === 0 ||
    !run.every((part) => typeof part === 'string')
  ) {
    throw new ConfigError(
      `${prefix}: executors.${name}.command.run must be a non-empty list of strings`
    );
  }
  if (env !== undefined) {
    if (typeof env !== 'object' || env === null || Array.isArray(env)) {
      throw new ConfigError(
        `${prefix}: executors.${name}.command.env must be an object`
      );
    }
    for (const [key, value] of Object.entries(env)) {
      if (typeof value !== 'string') {
        throw new ConfigError(
          `${prefix}: executors.${name}.command.env.${key} must be a string`
        );
      }
    }
  }
  return {
    run,
    ...(env === undefined ? {} : { env: env as Record<string, string> }),
  };
}

// Validates the optional `remotes:` block. Every field is checked by name so a
// typo (`hostname:` for `host:`) fails the load with the key that was wrong,
// rather than silently producing a remote that cannot connect.
function parseRemotesConfig(raw: unknown): Record<string, RemoteConfig> {
  if (raw === undefined) return {};
  const prefix = 'invalid .dispatch/config.yml';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${prefix}: remotes must be an object`);
  }
  const result: Record<string, RemoteConfig> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(`${prefix}: remotes.${name} must be an object`);
    }
    const value = entry as Record<string, unknown>;
    for (const key of Object.keys(value)) {
      if (!['host', 'user', 'port', 'path', 'identityFile'].includes(key)) {
        throw new ConfigError(
          `${prefix}: unknown remotes.${name} key "${key}" (expected host|user|port|path|identityFile)`
        );
      }
    }
    if (typeof value.host !== 'string' || value.host.trim() === '') {
      throw new ConfigError(`${prefix}: remotes.${name}.host is required`);
    }
    for (const key of ['user', 'path', 'identityFile'] as const) {
      if (value[key] !== undefined && typeof value[key] !== 'string') {
        throw new ConfigError(
          `${prefix}: remotes.${name}.${key} must be a string`
        );
      }
    }
    if (
      value.port !== undefined &&
      (typeof value.port !== 'number' ||
        !Number.isInteger(value.port) ||
        value.port <= 0)
    ) {
      throw new ConfigError(
        `${prefix}: remotes.${name}.port must be a positive integer`
      );
    }
    // Every field has already been narrowed by the checks above, so these read
    // without casts.
    const { user, port, path, identityFile } = value;
    result[name] = {
      host: value.host.trim(),
      ...(typeof user === 'string' ? { user } : {}),
      ...(typeof port === 'number' ? { port } : {}),
      ...(typeof path === 'string' ? { path } : {}),
      ...(typeof identityFile === 'string' ? { identityFile } : {}),
    };
  }
  return result;
}

// Validates the optional `executors:` block, same contract as
// parseOrchestratorConfig: absent means none configured.
function parseExecutorsConfig(raw: unknown): Record<string, ExecutorConfig> {
  if (raw === undefined) return {};
  const prefix = 'invalid .dispatch/config.yml';
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(`${prefix}: executors must be an object`);
  }
  const result: Record<string, ExecutorConfig> = {};
  for (const [name, entry] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new ConfigError(
        `${prefix}: executors.${name} must be an object with a models block`
      );
    }
    for (const key of Object.keys(entry)) {
      if (key !== 'models' && key !== 'pricing' && key !== 'command') {
        throw new ConfigError(
          `${prefix}: unknown executors.${name} key "${key}" (expected models|pricing|command)`
        );
      }
    }
    const { models, pricing, command } = entry as {
      models?: unknown;
      pricing?: unknown;
      command?: unknown;
    };
    result[name] = {
      models:
        models === undefined ? {} : parseExecutorModels(name, models, prefix),
      ...(pricing === undefined
        ? {}
        : { pricing: parseExecutorPricing(name, pricing, prefix) }),
      ...(command === undefined
        ? {}
        : { command: parseExecutorCommand(name, command, prefix) }),
    };
  }
  return result;
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

// Validates the optional `receipts:` block, same contract as the two above.
// `dir` is rejected empty rather than defaulted, matching prWorktreeDir: a
// blank path in config.yml is a typo, and silently falling back to the default
// location would export the audit trail somewhere the author did not ask for
// and would not think to look.
function parseReceiptsConfig(raw: unknown): ReceiptsConfig {
  if (raw === undefined) return { ...DEFAULT_RECEIPTS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: receipts must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { enabled } = obj;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: receipts.enabled must be a boolean'
    );
  }

  const { dir } = obj;
  if (dir !== undefined && (typeof dir !== 'string' || dir.trim() === '')) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: receipts.dir must be a non-empty string'
    );
  }

  const { remote, repo } = pushTarget(obj, 'receipts');
  const branch = optionalName(obj.branch, 'receipts.branch');

  return {
    enabled: enabled ?? DEFAULT_RECEIPTS.enabled,
    dir,
    ...(remote === undefined ? {} : { remote }),
    ...(repo === undefined ? {} : { repo }),
    ...(branch === undefined ? {} : { branch }),
  };
}

// Where a block pushes to: `remote`, one of the project's own remotes by
// name, or `repo`, a repository of its own by URL or path — never both, and
// never a URL under `remote`, so each key means one thing and a config reads
// the same to everyone who opens it.
function pushTarget(
  obj: Record<string, unknown>,
  block: 'receipts' | 'sync'
): { remote?: string; repo?: string } {
  const remote = optionalName(obj.remote, `${block}.remote`);
  const repo = optionalName(obj.repo, `${block}.repo`);
  if (remote !== undefined && repo !== undefined) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${block}.remote and ${block}.repo are two different places — set one`
    );
  }
  // Git allows `/` inside a remote's name (`team/board`), so only what can
  // only be a URL or a path is turned away: a colon, a backslash, or a
  // leading `/`, `.` or `~`.
  if (remote !== undefined && /[:\\]|^[./~]/.test(remote)) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${block}.remote names one of this project's remotes (like origin); for a repository of its own, set ${block}.repo: ${remote}`
    );
  }
  return {
    ...(remote === undefined ? {} : { remote }),
    ...(repo === undefined ? {} : { repo }),
  };
}

// A remote or branch name, if given: a non-empty string that cannot be read
// as a git option. Checked here so a typo fails at load with the key named,
// not as a confusing git error on the first push.
function optionalName(value: unknown, key: string): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || value.trim() === '') {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${key} must be a non-empty string`
    );
  }
  if (value.trim().startsWith('-')) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: ${key} must not start with "-"`
    );
  }
  return value.trim();
}

// Validates the optional `sync:` block, same contract as the others: only
// `undefined` falls back to defaults, and a wrong type is an error naming the
// key rather than a silent default.
function parseSyncConfig(raw: unknown): SyncConfig {
  if (raw === undefined) return { ...DEFAULT_SYNC };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: sync must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;
  if (obj.enabled !== undefined && typeof obj.enabled !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: sync.enabled must be a boolean'
    );
  }
  const interval = obj.intervalSec;
  if (
    interval !== undefined &&
    (typeof interval !== 'number' ||
      !Number.isInteger(interval) ||
      interval < 5)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: sync.intervalSec must be a whole number of seconds, at least 5'
    );
  }
  const { remote, repo } = pushTarget(obj, 'sync');
  return {
    enabled: obj.enabled ?? DEFAULT_SYNC.enabled,
    remote: remote ?? DEFAULT_SYNC.remote,
    ...(repo === undefined ? {} : { repo }),
    branch: optionalName(obj.branch, 'sync.branch') ?? DEFAULT_SYNC.branch,
    intervalSec: interval ?? DEFAULT_SYNC.intervalSec,
  };
}

/** A config's sync settings, defaulted for a hand-built config without them. */
export function syncSettings(config: DispatchConfig): SyncConfig {
  return config.sync ?? { ...DEFAULT_SYNC };
}

// Validates the optional `policy:` block, same contract as the blocks above —
// only `undefined` falls back to defaults. An unknown gate key or mode is a
// ConfigError rather than silently ignored: a typo'd override would otherwise
// leave a gate on the rung's behavior while the file reads as pinning it.
// Validates the optional `preview:` block. Same contract as every other block
// here: absent means the defaults, a malformed one throws rather than being
// silently dropped, and a partial one layers over the defaults so a config
// naming only `command` still gets both timeouts.
function parsePreviewConfig(raw: unknown): PreviewConfig {
  if (raw === undefined) return { ...DEFAULT_PREVIEW };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: preview must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { enabled } = obj;
  if (enabled !== undefined && typeof enabled !== 'boolean') {
    throw new ConfigError(
      'invalid .dispatch/config.yml: preview.enabled must be a boolean'
    );
  }

  // Both commands are rejected when present-but-empty rather than coerced to
  // absent: an empty string in a config file is a mistake someone should hear
  // about, and silently autodetecting instead hides it.
  for (const key of ['command', 'installCommand'] as const) {
    const value = obj[key];
    if (
      value !== undefined &&
      (typeof value !== 'string' || value.trim() === '')
    ) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: preview.${key} must be a non-empty string`
      );
    }
  }

  for (const key of ['readyTimeoutSec', 'idleTimeoutSec'] as const) {
    const value = obj[key];
    if (
      value !== undefined &&
      (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
    ) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: preview.${key} must be a positive number`
      );
    }
  }

  return {
    ...DEFAULT_PREVIEW,
    ...(enabled === undefined ? {} : { enabled }),
    ...(obj.command === undefined ? {} : { command: obj.command as string }),
    ...(obj.installCommand === undefined
      ? {}
      : { installCommand: obj.installCommand as string }),
    ...(obj.readyTimeoutSec === undefined
      ? {}
      : { readyTimeoutSec: obj.readyTimeoutSec as number }),
    ...(obj.idleTimeoutSec === undefined
      ? {}
      : { idleTimeoutSec: obj.idleTimeoutSec as number }),
  };
}

function parsePolicyConfig(raw: unknown): PolicyConfig {
  if (raw === undefined) return { ...DEFAULT_POLICY, gates: {} };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: policy must be an object'
    );
  }
  const obj = raw as Record<string, unknown>;

  const { rung } = obj;
  if (
    rung !== undefined &&
    (typeof rung !== 'number' ||
      !Number.isInteger(rung) ||
      rung < MIN_POLICY_RUNG ||
      rung > MAX_POLICY_RUNG)
  ) {
    throw new ConfigError(
      `invalid .dispatch/config.yml: policy.rung must be an integer between ${MIN_POLICY_RUNG} and ${MAX_POLICY_RUNG}`
    );
  }

  const { gates } = obj;
  const parsedGates: Partial<Record<PolicyGate, PolicyGateMode>> = {};
  if (gates !== undefined) {
    if (typeof gates !== 'object' || gates === null || Array.isArray(gates)) {
      throw new ConfigError(
        'invalid .dispatch/config.yml: policy.gates must be an object'
      );
    }
    for (const [gate, mode] of Object.entries(gates)) {
      // The irreversibility floor is not configurable at all: naming a floor
      // check here gets its own error, so the answer reads as "never", not
      // "you misspelled a gate".
      if (isFloorCheck(gate)) {
        throw new ConfigError(
          `invalid .dispatch/config.yml: policy.gates.${gate}: '${gate}' is on the irreversibility floor — it always blocks for a human and cannot be configured`
        );
      }
      if (!POLICY_GATES.includes(gate as PolicyGate)) {
        throw new ConfigError(
          `invalid .dispatch/config.yml: unknown policy gate: ${gate} (expected ${POLICY_GATES.join('|')})`
        );
      }
      if (!POLICY_GATE_MODES.includes(mode as PolicyGateMode)) {
        throw new ConfigError(
          `invalid .dispatch/config.yml: policy.gates.${gate} must be one of ${POLICY_GATE_MODES.join('|')}`
        );
      }
      parsedGates[gate as PolicyGate] = mode as PolicyGateMode;
    }
  }

  return { rung: rung ?? DEFAULT_POLICY.rung, gates: parsedGates };
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

// Reads one factor weight, rejecting anything that would make a score
// meaningless: a non-number, a NaN/Infinity, or a negative (which would invert
// the factor's meaning — turning a factor off is what `0` is for). `label`
// names the source so the same checks can report a config.yml path or a patch
// field.
function parseWeight(raw: unknown, label: string): number {
  if (!isQueueWeight(raw)) {
    throw new ConfigError(`invalid ${label}: must be a number >= 0`);
  }
  return raw;
}

// Every key the `queue:` block accepts. Checked so a typo one level *up* from
// the weights — `queue.wieghts:` — is refused too, rather than parsing as an
// empty block and silently handing back the defaults.
const QUEUE_KEYS: readonly string[] = ['weights'];

// Validates the `queue:` block, throwing on anything it will not accept.
// Weights layer over the defaults key by key, so a config naming only
// `urgency` keeps the default unblocking and age weights instead of silently
// zeroing them. An unknown key at either level is an error rather than
// ignored: it is almost always a typo for a real one, and swallowing it would
// leave the setting the user wrote with no effect at all.
function parseQueueBlock(raw: unknown): QueueWeights {
  if (raw === undefined) return { ...DEFAULT_QUEUE_WEIGHTS };
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: queue must be an object'
    );
  }
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) {
    if (!QUEUE_KEYS.includes(key)) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: unknown queue key "${key}" (expected ${QUEUE_KEYS.join('|')})`
      );
    }
  }

  const { weights } = block;
  if (weights === undefined) return { ...DEFAULT_QUEUE_WEIGHTS };
  if (
    typeof weights !== 'object' ||
    weights === null ||
    Array.isArray(weights)
  ) {
    throw new ConfigError(
      'invalid .dispatch/config.yml: queue.weights must be an object'
    );
  }

  const merged: QueueWeights = { ...DEFAULT_QUEUE_WEIGHTS };
  for (const [key, value] of Object.entries(weights)) {
    if (!QUEUE_FACTOR_KEYS.includes(key as ScoreFactorKey)) {
      throw new ConfigError(
        `invalid .dispatch/config.yml: unknown queue.weights factor "${key}" (expected ${QUEUE_FACTOR_KEYS.join('|')})`
      );
    }
    if (value === undefined) continue;
    merged[key as ScoreFactorKey] = parseWeight(
      value,
      `.dispatch/config.yml: queue.weights.${key}`
    );
  }
  return merged;
}

/**
 * Loads the `queue:` block, keeping any rejection as `error` instead of
 * throwing it.
 *
 * Deliberately the one block that does not fail `loadConfig`. Every other
 * block is read by machinery the daemon cannot run without, so refusing the
 * whole file is right for them. The queue's weights are read by one endpoint,
 * and throwing here would turn a single mistyped weight into a 422 on every
 * config-reading route — runs, tasks, settings, all of it — for a mistake that
 * only makes the ranking wrong. `queueWeights()` is where it becomes loud, for
 * the callers that actually depend on it.
 */
function parseQueueConfig(raw: unknown): QueueConfig {
  try {
    return { weights: parseQueueBlock(raw) };
  } catch (err) {
    if (!(err instanceof ConfigError)) throw err;
    return { weights: { ...DEFAULT_QUEUE_WEIGHTS }, error: err.message };
  }
}

export function loadConfig(rootDir: string): DispatchConfig {
  const path = join(rootDir, DISPATCH_DIR, 'config.yml');
  if (!existsSync(path)) {
    return {
      statuses: [...DEFAULTS.statuses],
      autoCommit: DEFAULTS.autoCommit,
      orchestrator: { ...DEFAULTS.orchestrator },
      models: { ...DEFAULTS.models },
      executors: {},
      remotes: {},
      linear: {
        ...DEFAULTS.linear,
        statusMap: { ...DEFAULTS.linear.statusMap },
      },
      fixLoop: cloneFixLoop(DEFAULTS.fixLoop),
      carto: { ...DEFAULTS.carto },
      repoDigest: { ...DEFAULTS.repoDigest },
      notifications: cloneNotifications(DEFAULTS.notifications),
      messaging: { ...DEFAULTS.messaging },
      receipts: { ...DEFAULT_RECEIPTS },
      sync: { ...DEFAULT_SYNC },
      policy: { ...DEFAULT_POLICY, gates: {} },
      preview: { ...DEFAULT_PREVIEW },
      queue: defaultQueue(),
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
  return parseConfig(parsed);
}

/**
 * A parsed config.yml, validated and defaulted: what loadConfig returns, from
 * the document instead of the file. updateConfig runs a patched document
 * through this before writing it, so a value the loader would refuse never
 * reaches disk, whichever key it came in through.
 */
function parseConfig(parsed: unknown): DispatchConfig {
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
    executors: parseExecutorsConfig(raw.executors),
    remotes: parseRemotesConfig(raw.remotes),
    linear: parseLinearConfig(raw.linear),
    fixLoop: parseFixLoopConfig(raw.fixLoop),
    verify: parseVerifyConfig(raw.verify),
    carto: parseCarto(raw.carto),
    repoDigest: parseRepoDigestConfig(raw.repoDigest),
    notifications: parseNotificationsConfig(raw.notifications),
    messaging: parseMessagingConfig(raw.messaging),
    receipts: parseReceiptsConfig(raw.receipts),
    sync: parseSyncConfig(raw.sync),
    policy: parsePolicyConfig(raw.policy),
    preview: parsePreviewConfig(raw.preview),
    queue: parseQueueConfig(raw.queue),
    prWorktreeDir: raw.prWorktreeDir,
  };
}

// Writes the `notifications:` keys a patch names. `kinds` is written
// key-by-key so a toggle the patch omits survives; `webhook: null` deletes the
// key, and an empty string counts as clearing too, since a form cannot send
// null from a text field.
function applyNotificationsPatch(
  doc: YAML.Document,
  patch: NonNullable<ConfigPatch['notifications']>
): void {
  if (patch.kinds !== undefined) {
    const kinds = parseNotificationKinds(patch.kinds, 'notifications.kinds');
    for (const [kind, enabled] of Object.entries(kinds)) {
      doc.setIn(['notifications', 'kinds', kind], enabled);
    }
  }
  if (patch.webhook !== undefined) {
    if (patch.webhook === null || patch.webhook.trim() === '') {
      // Same guard as clearing an absent cap above: never create the block as
      // a side effect of clearing a key that is not there.
      if (doc.hasIn(['notifications', 'webhook'])) {
        doc.deleteIn(['notifications', 'webhook']);
      }
      return;
    }
    doc.setIn(
      ['notifications', 'webhook'],
      validateWebhookUrl(patch.webhook, 'notifications.webhook')
    );
  }
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
// Writes one value, or removes it for `null`; a string that is empty after
// trimming counts as removing, since a form cannot send null from a text
// field. `undefined` is "not in this patch" and leaves the key alone. Removing
// never creates the parents on the way.
function setOrDelete(doc: YAML.Document, path: string[], value: unknown): void {
  if (value === undefined) return;
  const cleared =
    value === null || (typeof value === 'string' && value.trim() === '');
  if (cleared) {
    if (doc.hasIn(path)) doc.deleteIn(path);
    return;
  }
  doc.setIn(path, typeof value === 'string' ? value.trim() : value);
}

// The blocks Settings edits whole or field by field (ConfigPatch's second
// half). Validation is the loader's own, run on the whole document after.
function applyBlockPatches(doc: YAML.Document, patch: ConfigPatch): void {
  if (patch.statuses !== undefined) {
    doc.set(
      'statuses',
      patch.statuses.map((status) => status.trim())
    );
  }
  if (patch.verifySteps !== undefined) {
    if (patch.verifySteps === null || patch.verifySteps.length === 0) {
      doc.delete('verifySteps');
    } else {
      doc.set(
        'verifySteps',
        patch.verifySteps.map((step) => ({
          name: step.name.trim(),
          command: step.command.trim(),
        }))
      );
    }
  }
  if (patch.remotes !== undefined) {
    for (const [name, remote] of Object.entries(patch.remotes)) {
      setOrDelete(doc, ['remotes', name], remote);
    }
  }
  const blocks = [
    ['carto', patch.carto],
    ['repoDigest', patch.repoDigest],
    ['receipts', patch.receipts],
    ['sync', patch.sync],
    ['preview', patch.preview],
  ] as const;
  for (const [block, fields] of blocks) {
    if (fields === undefined) continue;
    for (const [field, value] of Object.entries(fields)) {
      setOrDelete(doc, [block, field], value);
    }
  }
  setOrDelete(doc, ['prWorktreeDir'], patch.prWorktreeDir);
}

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

  for (const key of [
    'epicConcurrency',
    'verifyTimeoutSec',
    'maxConcurrency',
  ] as const) {
    const value = patch[key];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || value < 1) {
      throw new ConfigError(`invalid ${key}: must be a positive integer`);
    }
    doc.setIn(['orchestrator', key], value);
  }

  // Checked before the write, like permissionMode: a cap over the hard limit
  // or below epicConcurrency on disk would make every later loadConfig throw.
  if (
    patch.maxConcurrency !== undefined ||
    patch.epicConcurrency !== undefined
  ) {
    const effective = (key: 'epicConcurrency' | 'maxConcurrency'): number => {
      const onDisk = doc.getIn(['orchestrator', key]);
      return typeof onDisk === 'number' ? onDisk : DEFAULT_ORCHESTRATOR[key];
    };
    const maxConcurrency = effective('maxConcurrency');
    if (maxConcurrency > MAX_CONCURRENCY_HARD_CAP) {
      throw new ConfigError(
        `invalid maxConcurrency: must be an integer between 1 and ${MAX_CONCURRENCY_HARD_CAP}`
      );
    }
    const epicConcurrency = effective('epicConcurrency');
    if (epicConcurrency > maxConcurrency) {
      throw new ConfigError(
        `invalid epicConcurrency: ${epicConcurrency} exceeds maxConcurrency (${maxConcurrency})`
      );
    }
  }

  if (patch.runCostEstimateUsd !== undefined) {
    const value = patch.runCostEstimateUsd;
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
      throw new ConfigError(
        'invalid runCostEstimateUsd: must be a positive number'
      );
    }
    doc.setIn(['orchestrator', 'runCostEstimateUsd'], value);
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
  if (patch.executor !== undefined) {
    if (typeof patch.executor !== 'string' || patch.executor.trim() === '') {
      throw new ConfigError('invalid executor: must be a non-empty string');
    }
    doc.setIn(['orchestrator', 'executor'], patch.executor.trim());
  }
  if (patch.executors !== undefined) {
    for (const [name, entry] of Object.entries(patch.executors)) {
      if (entry === null) {
        if (doc.hasIn(['executors', name])) doc.deleteIn(['executors', name]);
        continue;
      }
      if (entry.command !== undefined) {
        setOrDelete(doc, ['executors', name, 'command'], entry.command);
      }
      if (entry.models !== undefined) {
        const models = parseExecutorModels(name, entry.models, 'invalid patch');
        for (const [role, value] of Object.entries(models)) {
          doc.setIn(['executors', name, 'models', role], value);
        }
      }
      if (entry.pricing !== undefined) {
        doc.setIn(
          ['executors', name, 'pricing'],
          parseExecutorPricing(name, entry.pricing, 'invalid patch')
        );
      }
    }
  }
  if (patch.linear !== undefined) applyLinearPatch(doc, patch.linear);
  if (patch.fixLoop !== undefined) applyFixLoopPatch(doc, patch.fixLoop);
  if (patch.notifications !== undefined) {
    applyNotificationsPatch(doc, patch.notifications);
  }
  if (patch.queue?.weights !== undefined) {
    // Same validate-before-write rule as models: a bad weight must never reach
    // disk, or every later loadConfig refuses the whole file. Written key by
    // key so a weight the patch omits keeps whatever is already on disk.
    for (const [key, value] of Object.entries(patch.queue.weights)) {
      if (!QUEUE_FACTOR_KEYS.includes(key as ScoreFactorKey)) {
        throw new ConfigError(
          `invalid queue.weights factor: ${key} (expected ${QUEUE_FACTOR_KEYS.join('|')})`
        );
      }
      // `Partial<QueueWeights>` built with a conditional field carries the key
      // with an explicit `undefined`; that means "not in this patch", not "set
      // it to nothing", so skip rather than reject the whole write.
      if (value === undefined) continue;
      doc.setIn(
        ['queue', 'weights', key],
        parseWeight(value, `queue.weights.${key}`)
      );
    }
  }
  if (patch.policy !== undefined) {
    // Same validate-before-write rule as models: a bad rung or gate must never
    // reach disk, or every later loadConfig refuses the whole file.
    const { rung, gates } = patch.policy;
    if (rung !== undefined) {
      if (
        !Number.isInteger(rung) ||
        rung < MIN_POLICY_RUNG ||
        rung > MAX_POLICY_RUNG
      ) {
        throw new ConfigError(
          `invalid policy.rung: must be an integer between ${MIN_POLICY_RUNG} and ${MAX_POLICY_RUNG}`
        );
      }
      doc.setIn(['policy', 'rung'], rung);
    }
    if (gates !== undefined) {
      // Written key-by-key so a pin the patch omits survives; `null` clears a
      // pin, handing the gate back to the rung.
      for (const [gate, mode] of Object.entries(gates)) {
        // Same floor refusal as parsePolicyConfig: the Settings surface must
        // not be able to write a demotion the loader would then reject.
        if (isFloorCheck(gate)) {
          throw new ConfigError(
            `invalid policy gate: '${gate}' is on the irreversibility floor — it always blocks for a human and cannot be configured`
          );
        }
        if (!POLICY_GATES.includes(gate as PolicyGate)) {
          throw new ConfigError(
            `invalid policy gate: ${gate} (expected ${POLICY_GATES.join('|')})`
          );
        }
        if (mode === undefined) continue;
        if (mode === null) {
          if (doc.hasIn(['policy', 'gates', gate])) {
            doc.deleteIn(['policy', 'gates', gate]);
          }
          continue;
        }
        if (!POLICY_GATE_MODES.includes(mode)) {
          throw new ConfigError(
            `invalid policy.gates.${gate}: must be one of ${POLICY_GATE_MODES.join('|')}`
          );
        }
        doc.setIn(['policy', 'gates', gate], mode);
      }
    }
  }
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

  applyBlockPatches(doc, patch);

  // The whole patched document, checked by the same parser loadConfig uses
  // before anything is written: a value it would refuse — from any key, not
  // only the ones checked above — throws here instead of leaving a file
  // every later load rejects.
  parseConfig(doc.toJS());
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, doc.toString());
  // Re-read rather than returning a locally-patched object, so the caller gets exactly what the
  // next loadConfig() will see — including any validation the parser applies.
  return loadConfig(rootDir);
}
