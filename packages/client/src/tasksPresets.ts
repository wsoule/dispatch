// The Tasks view's preset ids and labels, shared so the Overseer transcript
// (overseerThread.ts) can validate and name a show_tasks door. Which tasks each
// preset matches stays in the desktop app.

/** The Tasks view's presets: one question each about the work. */
export type TasksPreset =
  | 'all'
  | 'mine'
  | 'needs-you'
  | 'failed'
  | 'moving'
  | 'review'
  | 'ready'
  | 'landing'
  | 'landed'
  | 'starred';

export const TASKS_PRESETS: readonly { id: TasksPreset; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mine', label: 'Mine' },
  { id: 'needs-you', label: 'Needs you' },
  { id: 'failed', label: 'Failed' },
  { id: 'moving', label: 'Moving' },
  { id: 'review', label: 'Review' },
  { id: 'ready', label: 'Ready' },
  { id: 'landing', label: 'Landing' },
  { id: 'landed', label: 'Landed' },
  { id: 'starred', label: 'Starred' },
];
