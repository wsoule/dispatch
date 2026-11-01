// The task-status vocabulary — the pipeline, in the same word family as the
// app's whose-move feed states, so board columns and feed rows speak one
// language. Browser-safe: no node:* imports (re-exported to the webview).
//
// Draft and Ready are the human columns (captured vs specified-enough-to-
// dispatch); Working/Review/Landing/Landed are machine-set as runs and the
// merge queue advance; Dropped is a deliberate "not doing it". "Landed" is
// what "done" always wanted to mean: merged, not merely finished.

export const CANONICAL_STATUSES = [
  'draft',
  'ready',
  'working',
  'review',
  'landing',
  'landed',
  'dropped',
] as const;

export type TaskStatus = (typeof CANONICAL_STATUSES)[number];

/**
 * The pre-rename names, mapped to their canonical successors. Applied at every
 * read boundary (task-file parse, config load) and write boundary
 * (store create/update), so task files written years ago and API callers
 * speaking the old names keep working forever without a migration pass —
 * files simply rewrite themselves in canonical form on their next touch.
 */
const LEGACY_STATUS_ALIASES: Record<string, TaskStatus> = {
  backlog: 'draft',
  todo: 'ready',
  'in-progress': 'working',
  'in-review': 'review',
  done: 'landed',
  cancelled: 'dropped',
};

/** Canonical form of any status string. Unknown names pass through untouched —
 * `.dispatch/config.yml` may define custom statuses. */
export function canonicalStatus(raw: string): string {
  return LEGACY_STATUS_ALIASES[raw] ?? raw;
}

/** Column/label casing for a status, canonical or custom ("draft" -> "Draft"). */
export function statusLabel(status: string): string {
  const canonical = canonicalStatus(status);
  return canonical.charAt(0).toUpperCase() + canonical.slice(1);
}

// Linear's workflow-state types. Dispatch's machinery keys off a status's
// type (and the roles below), never its name, so a project can mirror any
// tracker's workflow.
export const STATUS_TYPES = [
  'triage',
  'backlog',
  'unstarted',
  'started',
  'completed',
  'canceled',
] as const;
export type StatusType = (typeof STATUS_TYPES)[number];

/** One configured status: its name, workflow type and display color. */
export interface StatusDefinition {
  name: string;
  type: StatusType;
  /** A CSS color (`#rrggbb`), or null to let the UI pick one. */
  color: string | null;
}

/**
 * Which status the machinery writes on each lifecycle event. `landing` is
 * optional: null means entering the merge queue changes no status.
 */
export interface StatusRoles {
  /** Where a discarded run hands its task back to. */
  ready: string;
  /** Written when a run is dispatched. */
  dispatched: string;
  /** Written when an execute run finishes with work to review. */
  review: string;
  /** Written when a run enters the merge queue, or null for none. */
  landing: string | null;
  /** Written when work merges. */
  landed: string;
  /** Written when work is abandoned. */
  dropped: string;
}

export const STATUS_ROLE_KEYS: readonly (keyof StatusRoles)[] = [
  'ready',
  'dispatched',
  'review',
  'landing',
  'landed',
  'dropped',
];

/** The built-in statuses' types. */
export const DEFAULT_STATUS_TYPES: Readonly<Record<TaskStatus, StatusType>> = {
  draft: 'backlog',
  ready: 'unstarted',
  working: 'started',
  review: 'started',
  landing: 'started',
  landed: 'completed',
  dropped: 'canceled',
};

export const DEFAULT_STATUS_ROLES: Readonly<StatusRoles> = {
  ready: 'ready',
  dispatched: 'working',
  review: 'review',
  landing: 'landing',
  landed: 'landed',
  dropped: 'dropped',
};

/** A project's status vocabulary: what every type/role helper reads. */
export interface StatusModel {
  definitions: readonly StatusDefinition[];
  roles: Readonly<StatusRoles>;
}

/** The type a status name gets when config does not say: built-ins keep
 *  theirs, anything else is backlog (never dispatched, never done). */
export function defaultStatusType(name: string): StatusType {
  return DEFAULT_STATUS_TYPES[canonicalStatus(name) as TaskStatus] ?? 'backlog';
}

export const DEFAULT_STATUS_MODEL: StatusModel = {
  definitions: CANONICAL_STATUSES.map((name) => ({
    name,
    type: DEFAULT_STATUS_TYPES[name],
    color: null,
  })),
  roles: DEFAULT_STATUS_ROLES,
};

/**
 * The status model of a loaded config. Takes the loose shape so a hand-built
 * config (test fixtures, the desktop before config loads) still resolves.
 */
export function statusModelOf(
  config:
    | {
        statuses?: readonly string[];
        statusDefinitions?: readonly StatusDefinition[];
        statusRoles?: Readonly<StatusRoles>;
      }
    | null
    | undefined
): StatusModel {
  if (config === null || config === undefined) return DEFAULT_STATUS_MODEL;
  // An untyped list defines only its built-ins; a custom name stays
  // undefined (see hasStatusDefinition) and types as backlog.
  const definitions =
    config.statusDefinitions ??
    (config.statuses ?? CANONICAL_STATUSES)
      .map(canonicalStatus)
      .filter((name): name is TaskStatus =>
        (CANONICAL_STATUSES as readonly string[]).includes(name)
      )
      .map((name) => ({
        name,
        type: DEFAULT_STATUS_TYPES[name],
        color: null,
      }));
  return { definitions, roles: config.statusRoles ?? DEFAULT_STATUS_ROLES };
}

/** Whether `model` defines `status` (a built-in, or a typed config entry). */
export function hasStatusDefinition(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  const name = canonicalStatus(status);
  return model.definitions.some((d) => d.name === name);
}

/** A status's workflow type under `model` (built-in defaults when absent). */
export function statusType(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): StatusType {
  const name = canonicalStatus(status);
  return (
    model.definitions.find((d) => d.name === name)?.type ??
    defaultStatusType(name)
  );
}

/** The configured color for a status, or null. */
export function statusColor(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): string | null {
  const name = canonicalStatus(status);
  return model.definitions.find((d) => d.name === name)?.color ?? null;
}

/** The statuses of one type, in board order. */
export function statusesOfType(
  type: StatusType,
  model: StatusModel = DEFAULT_STATUS_MODEL
): string[] {
  return model.definitions.filter((d) => d.type === type).map((d) => d.name);
}

/** Terminal: the task's story is over, by merge or by choice. */
export function isDoneStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  const type = statusType(status, model);
  return type === 'completed' || type === 'canceled';
}

/** Completed (merged/finished), as distinct from canceled. */
export function isCompletedStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  return statusType(status, model) === 'completed';
}

/** Canceled: a deliberate "not doing it". */
export function isCanceledStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  return statusType(status, model) === 'canceled';
}

/** Specified and waiting to start: the ready queue's status test. */
export function isUnstartedStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  return statusType(status, model) === 'unstarted';
}

/** In progress, whoever is doing it (includes review and landing). */
export function isStartedStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  return statusType(status, model) === 'started';
}

/** Not yet specified enough to dispatch: triage or backlog. */
export function isBacklogStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  const type = statusType(status, model);
  return type === 'triage' || type === 'backlog';
}

/** Whether `status` is the one the machinery writes for `role`. */
export function hasStatusRole(
  status: string,
  role: keyof StatusRoles,
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  const name = model.roles[role];
  return name !== null && canonicalStatus(status) === name;
}

/** Whether the review role names a status of its own; a workflow with no
 *  review state shares the dispatched one. */
export function hasDistinctReviewRole(
  model: StatusModel = DEFAULT_STATUS_MODEL
): boolean {
  return model.roles.review !== model.roles.dispatched;
}

// A role reached by status, except that a status shared with the dispatched
// role only counts once the task's run has finished.
function reachedRole(
  status: string,
  role: 'review' | 'landing',
  model: StatusModel,
  finishedRun: boolean
): boolean {
  return (
    hasStatusRole(status, role, model) &&
    (finishedRun || !hasStatusRole(status, 'dispatched', model))
  );
}

/** In review: the review role, and when that status is shared with
 *  dispatched, only once the task's run has finished. */
export function isReviewStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL,
  finishedRun = false
): boolean {
  return reachedRole(status, 'review', model, finishedRun);
}

/**
 * Whether a blocker no longer holds up *dispatching* its dependents. Looser
 * than done: a dependent can start as soon as the blocker's code exists on a
 * branch, which is the review role — and certainly once it is queued (the
 * landing role). `finishedRun` says the blocker's latest run has ended, which
 * a board whose review status is its dispatched one cannot tell from status.
 */
export function isSatisfiedForDispatchStatus(
  status: string,
  model: StatusModel = DEFAULT_STATUS_MODEL,
  finishedRun = false
): boolean {
  return (
    isDoneStatus(status, model) ||
    isReviewStatus(status, model, finishedRun) ||
    reachedRole(status, 'landing', model, finishedRun)
  );
}

/** Where a captured-but-unspecified task goes: the first backlog status,
 *  else triage. Null on a board with neither: the ready status would queue
 *  it for dispatch, which a draft must never be. */
export function draftStatus(
  model: StatusModel = DEFAULT_STATUS_MODEL
): string | null {
  return (
    statusesOfType('backlog', model)[0] ??
    statusesOfType('triage', model)[0] ??
    null
  );
}

// The status a built-in word stands for on a board, read through its role.
function builtInRoleStatus(word: string, model: StatusModel): string | null {
  switch (word as TaskStatus) {
    case 'draft':
      return draftStatus(model);
    case 'ready':
      return model.roles.ready;
    case 'working':
      return model.roles.dispatched;
    case 'review':
      return model.roles.review;
    case 'landing':
      return model.roles.landing;
    case 'landed':
      return model.roles.landed;
    case 'dropped':
      return model.roles.dropped;
    default:
      return null;
  }
}

/**
 * A caller's status as one of `names`: exact, then a unique case-insensitive
 * match, then a legacy alias, then a built-in word read as its role (landed ->
 * roles.landed, working -> roles.dispatched, draft -> draftStatus). Null when
 * none fits, `draft` included on a board with no backlog or triage status.
 */
export function resolveStatusName(
  raw: string,
  names: readonly string[],
  model: StatusModel = DEFAULT_STATUS_MODEL
): string | null {
  if (names.includes(raw)) return raw;
  const folded = raw.toLowerCase();
  const insensitive = names.filter((name) => name.toLowerCase() === folded);
  if (insensitive.length === 1) return insensitive[0];
  const canonical = canonicalStatus(folded);
  if (names.includes(canonical)) return canonical;
  const byRole = builtInRoleStatus(canonical, model);
  return byRole !== null && names.includes(byRole) ? byRole : null;
}
