import type { StatusModel, TaskListItem } from '@dispatch/core/browser';
import {
  hasStatusDefinition,
  hasStatusRole,
  isBacklogStatus,
  isDoneStatus,
  statusesOfType,
} from '@dispatch/core/browser';

import { activeStatusModel } from './statusModel';

/**
 * A milestone's own pipeline state, rolled up from its children so a milestone reads like a
 * big task. Precedence mirrors the control room's whose-move rule — the milestone wears its
 * most actionable child state: dispatched > review > landing > ready > backlog, and it only
 * turns landed once every child is terminal (completed or canceled). A custom open status
 * that is not backlog counts at the ready tier: it's open work, just not a named stage.
 * Statuses are the project's own, found by role and type (see core's status.ts). A memo keyed
 * on config passes that config's `model`: the module-level one updates a render later.
 */
export function rollupMilestoneStatus(
  children: TaskListItem[],
  model: StatusModel = activeStatusModel()
): string {
  const { roles } = model;
  const backlog = statusesOfType('backlog', model)[0] ?? 'draft';
  if (children.length === 0) return backlog;
  const open = children
    .map((c) => c.meta.status)
    .filter((status) => !isDoneStatus(status, model));
  if (open.length === 0) return roles.landed;
  const has = (role: 'dispatched' | 'review' | 'landing' | 'ready'): boolean =>
    open.some((status) => hasStatusRole(status, role, model));
  if (has('dispatched')) return roles.dispatched;
  if (has('review')) return roles.review;
  if (roles.landing !== null && has('landing')) return roles.landing;
  if (has('ready')) return roles.ready;
  // Only backlog left — unless another open status is present, which is still real work.
  // An untyped custom status is open work too.
  const openWork = (status: string): boolean =>
    !isBacklogStatus(status, model) || !hasStatusDefinition(status, model);
  if (open.some(openWork)) return roles.ready;
  return backlog;
}

/** True once every child is terminal — the "milestones show as finished" rule. */
export function isMilestoneFinished(
  children: TaskListItem[],
  model: StatusModel = activeStatusModel()
): boolean {
  return (
    children.length > 0 &&
    children.every((c) => isDoneStatus(c.meta.status, model))
  );
}
