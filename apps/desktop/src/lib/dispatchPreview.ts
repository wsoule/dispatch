import type { TaskDoc } from '@dispatch/core/browser';

/**
 * What a bulk dispatch is actually about to do.
 *
 * The mockup framed this as "5 of 8 slots are busy, so 3 start now" — a fixed global cap. There
 * isn't one: dispatch concurrency is chosen per call (see `handleWorkEpic(epicId, concurrency)`
 * and the stepper in EpicCardTile), not configured once for the project. So the honest preview
 * is computed against the concurrency the user is about to pick, not an imaginary ceiling.
 *
 * The rule the dialog exists to enforce: nothing is ever silently dropped. Every selected task
 * appears in the preview, either starting now or explicitly queued.
 */

type DispatchDisposition = 'starts-now' | 'queued' | 'not-ready';

interface DispatchPreviewRow {
  taskId: string;
  title: string;
  disposition: DispatchDisposition;
}

export interface DispatchPreview {
  rows: DispatchPreviewRow[];
  startsNow: number;
  queued: number;
  /** Selected tasks that cannot be dispatched at all — blocked, or already running. */
  notReady: number;
  /** How many agents are already working, which is what eats into the concurrency budget. */
  runningNow: number;
  /** One sentence stating the arithmetic, so the dialog never makes the user do it. */
  summary: string;
}

export interface BuildDispatchPreviewInput {
  /** The tasks the user selected, in the order they should start. */
  tasks: TaskDoc[];
  /** Ids that are dependency-clear and have no live run. */
  readyIds: ReadonlySet<string>;
  /** How many agents are already running for this project. */
  runningNow: number;
  /** The concurrency the user is about to dispatch with. */
  concurrency: number;
}

function sentence(
  startsNow: number,
  queued: number,
  notReady: number,
  runningNow: number,
  concurrency: number
): string {
  if (startsNow === 0 && queued === 0) {
    return notReady > 0
      ? 'Nothing here can start — every task is blocked or already running.'
      : 'Nothing selected.';
  }
  const parts = [
    `${runningNow} already running, ${concurrency} at a time`,
    `${startsNow} start${startsNow === 1 ? 's' : ''} now`,
  ];
  if (queued > 0) parts.push(`${queued} queue${queued === 1 ? 's' : ''}`);
  if (notReady > 0) {
    parts.push(`${notReady} cannot start yet`);
  }
  return `${parts.join(' · ')}.`;
}

export function buildDispatchPreview(
  input: BuildDispatchPreviewInput
): DispatchPreview {
  const { tasks, readyIds, runningNow, concurrency } = input;
  // A concurrency of 0 or less would silently start nothing; treat it as at least one so the
  // preview and the dispatch agree about what the button will do.
  const limit = Math.max(1, Math.round(concurrency));
  const free = Math.max(0, limit - runningNow);

  let started = 0;
  const rows: DispatchPreviewRow[] = tasks.map((task) => {
    const id = task.meta.id;
    if (!readyIds.has(id)) {
      return { taskId: id, title: task.meta.title, disposition: 'not-ready' };
    }
    if (started < free) {
      started += 1;
      return { taskId: id, title: task.meta.title, disposition: 'starts-now' };
    }
    return { taskId: id, title: task.meta.title, disposition: 'queued' };
  });

  const startsNow = rows.filter((r) => r.disposition === 'starts-now').length;
  const queued = rows.filter((r) => r.disposition === 'queued').length;
  const notReady = rows.filter((r) => r.disposition === 'not-ready').length;

  return {
    rows,
    startsNow,
    queued,
    notReady,
    runningNow,
    summary: sentence(startsNow, queued, notReady, runningNow, limit),
  };
}
