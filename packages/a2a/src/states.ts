// A2A 1.0 task states, without the TASK_STATE_ prefix the wire carries.
export const TASK_STATE_NAMES = [
  'SUBMITTED',
  'WORKING',
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'REJECTED',
] as const;
export type TaskStateName = (typeof TASK_STATE_NAMES)[number];

export const TERMINAL_STATES: ReadonlySet<TaskStateName> = new Set([
  'COMPLETED',
  'FAILED',
  'CANCELED',
  'REJECTED',
]);
export const INTERRUPTED_STATES: ReadonlySet<TaskStateName> = new Set([
  'INPUT_REQUIRED',
  'AUTH_REQUIRED',
]);

export type WireTaskState = `TASK_STATE_${TaskStateName}`;

export function wireState(name: TaskStateName): WireTaskState {
  return `TASK_STATE_${name}`;
}

// Reads a wire state with or without its prefix; null for anything else.
export function stateFromWire(value: string): TaskStateName | null {
  const name = value.replace(/^TASK_STATE_/, '');
  return (TASK_STATE_NAMES as readonly string[]).includes(name)
    ? (name as TaskStateName)
    : null;
}
