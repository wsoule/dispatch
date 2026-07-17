export type TaskStatus = 'backlog' | 'todo' | 'in-progress' | 'in-review' | 'done' | 'cancelled';
export type TaskKind = 'task' | 'epic';
export type Priority = 'urgent' | 'high' | 'medium' | 'low' | 'none';
export type Assignee = 'agent' | 'human' | 'none';

export interface TaskMeta {
  id: string;
  title: string;
  // Built-ins (TaskStatus/STATUSES below) are just the defaults — .dispatch/config.yml
  // `statuses` is the source of truth for what's valid in a given tracker.
  status: string;
  kind: TaskKind;
  parent: string | null;
  blockedBy: string[];
  labels: string[];
  priority: Priority;
  assignee: Assignee;
  created: string;
  updated: string;
  external: string | null;
}

export interface TaskDoc {
  meta: TaskMeta;
  body: string;
}

export const STATUSES: readonly TaskStatus[] = ['backlog', 'todo', 'in-progress', 'in-review', 'done', 'cancelled'];
export const PRIORITIES: readonly Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
export const KINDS: readonly TaskKind[] = ['task', 'epic'];
export const ASSIGNEES: readonly Assignee[] = ['agent', 'human', 'none'];
