// The Cockpit's optimistic dispatch, as pure transitions over a map of pending
// dispatches. `d` moves a task into In flight at once; the map holds it there until the
// run shows up in the run list (or the task leaves the ready queue), and a failed request
// takes it back out so the task reappears in Ready.

interface PendingDispatch {
  /** When `d` was pressed, ms — the starting row's clock. */
  startedAt: number;
  /** `sending` while the request is out; `sent` once it resolved, until the run lands. */
  state: 'sending' | 'sent';
}

export type PendingDispatches = ReadonlyMap<string, PendingDispatch>;

export const NO_PENDING: PendingDispatches = new Map();

/** A `sent` dispatch whose run never appears is dropped after this long. */
export const PENDING_TIMEOUT_MS = 30_000;

/** `d` pressed: the task is in flight from now. A task already pending stays as it is. */
export function startDispatch(
  pending: PendingDispatches,
  taskId: string,
  now: number
): PendingDispatches {
  if (pending.has(taskId)) return pending;
  const next = new Map(pending);
  next.set(taskId, { startedAt: now, state: 'sending' });
  return next;
}

/** The request succeeded: keep the row until the run itself is visible. */
export function settleDispatch(
  pending: PendingDispatches,
  taskId: string
): PendingDispatches {
  const entry = pending.get(taskId);
  if (entry === undefined || entry.state === 'sent') return pending;
  const next = new Map(pending);
  next.set(taskId, { ...entry, state: 'sent' });
  return next;
}

/** The request failed: the task goes back to Ready. */
export function rollbackDispatch(
  pending: PendingDispatches,
  taskId: string
): PendingDispatches {
  if (!pending.has(taskId)) return pending;
  const next = new Map(pending);
  next.delete(taskId);
  return next;
}

/**
 * Drops the settled dispatches the caches have caught up with: the run is live, or the task
 * is no longer waiting to start (the daemon moved its status). A `sent` one that never
 * resolves either way times out rather than haunting the lane. `sending` ones stay until
 * their request answers.
 */
export function reconcileDispatches(
  pending: PendingDispatches,
  liveTaskIds: ReadonlySet<string>,
  stillWaiting: (taskId: string) => boolean,
  now: number
): PendingDispatches {
  let next: Map<string, PendingDispatch> | null = null;
  for (const [taskId, entry] of pending) {
    if (entry.state === 'sending') continue;
    const done =
      liveTaskIds.has(taskId) ||
      !stillWaiting(taskId) ||
      now - entry.startedAt > PENDING_TIMEOUT_MS;
    if (!done) continue;
    next ??= new Map(pending);
    next.delete(taskId);
  }
  return next ?? pending;
}

/** The pending map as the lane builder reads it: task id → when it started. */
export function pendingStarts(
  pending: PendingDispatches
): ReadonlyMap<string, number> {
  const out = new Map<string, number>();
  for (const [taskId, entry] of pending) out.set(taskId, entry.startedAt);
  return out;
}
