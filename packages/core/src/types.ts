export type { TaskStatus } from './status.js';
import type { ContainerKind } from './kinds.js';

// Linear's hierarchy: containers group tasks (see kinds.ts). Legacy `epic`
// reads as `milestone`.
export type TaskKind = 'task' | ContainerKind;
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
// A serialized ActorRef (see actor.ts): `none`, the legacy bare `human`/`agent`,
// or a named `human:wyat` / `agent:wyat/claude`.
export type Assignee = string;
export type TaskRisk = 'routine' | 'elevated' | 'critical';

export interface TaskMeta {
  id: string;
  title: string;
  // Built-ins (TaskStatus/STATUSES below) are just the defaults — .dispatch/config.yml
  // `statuses` is the source of truth for what's valid in a given tracker.
  status: string;
  kind: TaskKind;
  parent: string | null;
  // A milestone/project name this task belongs to — the Linear-style grouping *above* epics,
  // free-form (ad-hoc names, not ids) so a project doesn't need any per-project setup. `null`
  // when the task isn't assigned to one.
  milestone: string | null;
  blockedBy: string[];
  labels: string[];
  priority: Priority;
  assignee: Assignee;
  created: string;
  updated: string;
  external: string | null;
  // When true, the dispatched agent is instructed (see server's prompt builder) to re-review
  // its own diff against the acceptance criteria before finishing, rather than stopping at
  // "tests pass." New tasks default to false: Claude Opus 5 verifies unprompted and an explicit
  // self-check makes it over-verify, and every run already gets a separate adversarial review.
  // Opt in for executors that still benefit. Files without the key still parse as true.
  selfReview: boolean;
  /**
   * Paths or globs the planner expects this task to modify.
   *
   * One field, three readings — know which one you are adding to:
   * - **glob**: scanDestructiveWrites / matchesDeclaredWrites /
   *   undeclaredWrites (orchestrator/review.ts) run entries through Bun.Glob.
   * - **literal path**: entriesOverlap (conflicts.ts) compares entries for
   *   equality, with `dir/**` as the one glob form it understands. It is not
   *   a glob matcher: `src/*.ts` will not match `src/foo.ts` there.
   * - **regex subject**: sharedSurfaceWrites (orchestrator/review.ts) tests
   *   each entry against SHARED_SURFACE_PATTERNS as a plain string.
   *
   * A synthesized PR review task escapes glob metacharacters into its
   * entries (escapeGlobPath, server's orchestrator/prReviewTask.ts) because
   * a real path may contain them and the glob readers would misread it.
   * conflicts.ts unescapes before comparing so both spellings of one path
   * still conflict; a new reader has to decide the same question.
   */
  writes: string[];
  // Per-task opt-out of the automatic fix loop (config `fixLoop.auto`). Absent
  // means opted in — like selfReview, the file only carries the key on `false`.
  fixLoop?: boolean;
  /** Drives review depth and model tier. */
  risk: TaskRisk;
  /** Per-task model override, layered over config.models. */
  model: string | null;
  // Set once a reconciler determines the task's merge landed; absent otherwise.
  archivedAt?: string;
  // Set once a verify run has actually exercised this task's work and every
  // check passed. Distinct from a review's findings, which only read the diff.
  exercised: boolean;
  // What Dispatch synthesized this task from, e.g. `github-pr:41`; absent on
  // every task a person wrote. A derived task exists only to anchor a review
  // of someone else's artifact, so it is never dispatchable, never synced
  // outward, and retires itself once that review ends.
  derivedFrom?: string;
  // Files uploaded against the task. The frontmatter (or row) names them; the
  // bytes live gitignored under `.dispatch/attachments/<taskId>/` on the
  // machine that took the upload. Absent when the task has none.
  attachments?: TaskAttachment[];
  // Linear-parity fields, defaulted on read (see defaultTaskFields) so files
  // and rows written before them still parse.
  /** Story points; null when not estimated. */
  estimate: number | null;
  /** ISO date; a container's target date. */
  dueDate: string | null;
  /** ISO date; containers only, in practice. */
  startDate: string | null;
  cycle: TaskCycle | null;
  /** Ids of related tasks (Linear's "related" relation, symmetric). */
  relatedTo: string[];
  /** The task this one duplicates, or null. */
  duplicateOf: string | null;
  /** Extra initiative ids a project belongs to; `parent` holds the first. */
  initiatives: string[];
  /** Who created it, as an actor ref; null when unknown (older tasks). */
  creator: Assignee | null;
  /** Display color for a container (`#rrggbb`), or null. */
  color: string | null;
  /** Display icon name for a container, or null. */
  icon: string | null;
  /** Manual order among siblings (a project's milestones), low first; null
   *  when unordered. */
  sortOrder: number | null;
}

/** A Linear-style cycle (sprint) a task is scheduled into. */
export interface TaskCycle {
  id: string;
  number: number;
  name: string | null;
  startsAt: string;
  endsAt: string;
}

/** The Linear-parity fields of TaskMeta, as a task without them reads. */
export type TaskFieldDefaults = Pick<
  TaskMeta,
  | 'estimate'
  | 'dueDate'
  | 'startDate'
  | 'cycle'
  | 'relatedTo'
  | 'duplicateOf'
  | 'initiatives'
  | 'creator'
  | 'color'
  | 'icon'
  | 'sortOrder'
>;

/** Fresh defaults for the Linear-parity fields (new arrays each call). */
export function defaultTaskFields(): TaskFieldDefaults {
  return {
    estimate: null,
    dueDate: null,
    startDate: null,
    cycle: null,
    relatedTo: [],
    duplicateOf: null,
    initiatives: [],
    creator: null,
    color: null,
    icon: null,
    sortOrder: null,
  };
}

export interface TaskAttachment {
  // The sanitized file name, unique within the task.
  name: string;
  // Project-relative posix path to the blob (attachmentRelativePath).
  path: string;
  size: number;
  addedAt: string;
}

// A task without its markdown body: what `GET /api/tasks?fields=meta` returns,
// so list views skip shipping and parsing every description.
export interface TaskListItem {
  meta: TaskMeta;
}

export interface TaskDoc extends TaskListItem {
  body: string;
}

export { CANONICAL_STATUSES as STATUSES } from './status.js';
export const PRIORITIES: readonly Priority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];
export const KINDS: readonly TaskKind[] = [
  'task',
  'milestone',
  'project',
  'initiative',
];
export const ASSIGNEES: readonly Assignee[] = ['agent', 'human', 'none'];
export const TASK_RISKS: readonly TaskRisk[] = [
  'routine',
  'elevated',
  'critical',
];
