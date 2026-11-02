import type { StatusModel, StatusType } from '@dispatch-foo/core/browser';
import { hasStatusDefinition, statusType } from '@dispatch-foo/core/browser';
import type { UiTone } from '@dispatch/ui';

import { activeStatusModel } from './statusModel';

/**
 * A task status's colour as a `UiTone`, read through the `data-tone` hook
 * (`--tone`, `--tone-ink`, …) by the status glyph, the branch graph's dots and
 * anything else that paints a status. It follows the AGENTS.md hue table:
 * in progress is blue (info), review is green (success: the agent's work
 * succeeded and waits on a person, plan Q6), backlog, todo and canceled are
 * grey (muted). Done is `null`: the filled neutral mark (`--text-2`), never
 * green beside a red.
 *
 * A colour configured on a status (a mirrored Linear workflow's own hex,
 * which core's `statusColor` returns) is no longer painted: the hue table
 * wins, so a status always means the same colour across projects.
 */
export type StatusTone = UiTone | null;

// The tracker's built-in pipeline, by name.
const BUILT_IN_TONES: Readonly<Record<string, StatusTone>> = {
  draft: 'muted',
  ready: 'muted',
  working: 'info',
  review: 'success',
  landing: 'info',
  landed: null,
  dropped: 'muted',
};

// A typed custom status (a Linear workflow state) by its workflow type.
const TYPE_TONES: Readonly<Record<StatusType, StatusTone>> = {
  triage: 'muted',
  backlog: 'muted',
  unstarted: 'muted',
  started: 'info',
  completed: null,
  canceled: 'muted',
};

/** A task held by an unmet dependency: amber (blocked), whatever its status
 * (plan Q6; it was red). The glyph keeps its status shape. */
export const BLOCKED_TONE: UiTone = 'warning';

/** The tone a status paints with: a built-in by name, else a defined status
 * by its workflow type, else (an untyped custom status) muted like todo. */
export function statusTone(
  status: string,
  model: StatusModel = activeStatusModel()
): StatusTone {
  if (Object.hasOwn(BUILT_IN_TONES, status)) {
    return BUILT_IN_TONES[status] ?? null;
  }
  if (hasStatusDefinition(status, model)) {
    return TYPE_TONES[statusType(status, model)];
  }
  return 'muted';
}
