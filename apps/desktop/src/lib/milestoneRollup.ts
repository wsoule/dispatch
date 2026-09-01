import type { TaskDoc } from '@dispatch/core/browser';
import { isDoneStatus } from '@dispatch/core/browser';

/**
 * A milestone's own pipeline state, rolled up from its children so a milestone reads like a
 * big task. Precedence mirrors the control room's whose-move rule — the milestone wears its
 * most actionable child state: working > review > landing > ready > draft, and it only
 * turns `landed` once every child is terminal (landed or dropped). A custom, non-built-in
 * open status counts at the `ready` tier: it's open work, just not one of the named stages.
 */
export function rollupMilestoneStatus(children: TaskDoc[]): string {
  if (children.length === 0) return 'draft';
  if (children.every((c) => isDoneStatus(c.meta.status))) return 'landed';
  const open = new Set(
    children
      .filter((c) => !isDoneStatus(c.meta.status))
      .map((c) => c.meta.status)
  );
  if (open.has('working')) return 'working';
  if (open.has('review')) return 'review';
  if (open.has('landing')) return 'landing';
  if (open.has('ready')) return 'ready';
  // Only drafts left — unless a custom open status is present, which is still real work.
  for (const status of open) {
    if (status !== 'draft') return 'ready';
  }
  return 'draft';
}

/** True once every child is terminal — the "milestones show as finished" rule. */
export function isMilestoneFinished(children: TaskDoc[]): boolean {
  return children.length > 0 && rollupMilestoneStatus(children) === 'landed';
}
