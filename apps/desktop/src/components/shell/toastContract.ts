export type ToastTone = 'error' | 'success' | 'info';

/** A toast's one follow-up: the `View task` link under a task toast, or an action such as
 * `Restart`. Clicking it dismisses the toast. */
export interface ToastLink {
  label: string;
  onClick: () => void;
}

/** Milliseconds a toast stays. Errors do not auto-dismiss (Infinity): a failure you did not
 * manage to read is the same as a failure that was never reported. */
export function toastDurationFor(tone: ToastTone): number {
  const ms = { success: 3500, info: 4500, error: Infinity } as const;
  return ms[tone];
}

/** The library's toast has one action slot, so `link` and `action` share it, `link` winning
 * when a caller passes both. */
export function toastActionFor(input: {
  link?: ToastLink;
  action?: ToastLink;
}): ToastLink | undefined {
  return input.link ?? input.action;
}

/** The `View task` link every toast about a task carries. */
export function viewTaskLink(
  taskId: string,
  openTask: (taskId: string) => void
): ToastLink {
  return { label: 'View task', onClick: () => openTask(taskId) };
}

/** The second line of a task toast: `t-8f2a — Cache the search index`. */
export function taskToastDescription(taskId: string, title: string): string {
  return `${taskId} — ${title}`;
}
