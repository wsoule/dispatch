import type { StatusModel, TaskListItem } from '@dispatch-foo/core/browser';
import { isCompletedStatus, isDoneStatus } from '@dispatch-foo/core/browser';
import type { EpicProgress } from '@dispatch/client';

// Which fan-out verbs a container (an epic, a milestone) offers right now, as
// one pure rule the Issues list's group menu reads. The rules are
// FanoutControls' (components/milestones) and EpicLaneHeader's `landable`,
// stated once without React so a menu with no header to draw can ask the same
// question. A verb here is an offer: the server stays the authority and
// answers a stale one with its own reason.

export type FanoutVerb = 'send' | 'pause' | 'resume' | 'stop' | 'land';

/** The verbs' menu words. */
export const FANOUT_VERB_LABEL: Record<FanoutVerb, string> = {
  send: 'Send agents…',
  pause: 'Pause',
  resume: 'Resume',
  stop: 'Stop',
  land: 'Land',
};

/**
 * The verbs for one container, by its fan-out session's state:
 *
 * - active: Pause and Stop;
 * - paused: Resume and Stop (Raise ceiling… stays with the dialog that has
 *   the ceilings to show);
 * - no session (or a complete or stopped one): Land once every child the
 *   progress knows is done and the container itself has not landed; nothing
 *   for a landed container or one with no children to send (`childCount`
 *   stands in for the children while the progress has not resolved);
 *   otherwise Send agents….
 */
export function fanoutVerbs(
  container: TaskListItem,
  model: StatusModel,
  progress: EpicProgress | undefined,
  childCount?: number
): FanoutVerb[] {
  const state = progress?.session?.state;
  if (state === 'active') return ['pause', 'stop'];
  if (state === 'paused') return ['resume', 'stop'];
  const children = progress?.children ?? [];
  const total = progress === undefined ? childCount : children.length;
  const completed = isCompletedStatus(container.meta.status, model);
  if (
    !completed &&
    children.length > 0 &&
    children.every((child) => isDoneStatus(child.status, model))
  ) {
    return ['land'];
  }
  if (completed || total === 0) return [];
  return ['send'];
}
