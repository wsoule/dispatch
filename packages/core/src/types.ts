export type TaskStatus =
  | 'backlog'
  | 'todo'
  | 'in-progress'
  | 'in-review'
  | 'done'
  | 'cancelled';
export type TaskKind = 'task' | 'epic';
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
  // "tests pass." Defaults to true — the extra pass is cheap next to reviewing (or merging) a
  // half-checked diff, so tasks opt out of it rather than into it.
  selfReview: boolean;
  /** Paths or globs the planner expects this task to modify. */
  writes: string[];
  /** Drives review depth and model tier. */
  risk: TaskRisk;
  /** Per-task model override, layered over config.models. */
  model: string | null;
  // Set once a reconciler determines the task's merge landed; absent otherwise.
  archivedAt?: string;
  // Set once a verify run has actually exercised this task's work and every
  // check passed. Distinct from a review's findings, which only read the diff.
  exercised: boolean;
}

export interface TaskDoc {
  meta: TaskMeta;
  body: string;
}

export const STATUSES: readonly TaskStatus[] = [
  'backlog',
  'todo',
  'in-progress',
  'in-review',
  'done',
  'cancelled',
];
export const PRIORITIES: readonly Priority[] = [
  'urgent',
  'high',
  'medium',
  'low',
  'none',
];
export const KINDS: readonly TaskKind[] = ['task', 'epic'];
export const ASSIGNEES: readonly Assignee[] = ['agent', 'human', 'none'];
export const TASK_RISKS: readonly TaskRisk[] = [
  'routine',
  'elevated',
  'critical',
];
