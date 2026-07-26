import type { PlannedTask, PlanRecord } from '@dispatch/client';

// The Notes hub's "draft this note into a real task with AI" state, kept here as plain
// transitions rather than inline setState calls because the interesting rules aren't visual:
// a draft is seeded exactly once from a record that keeps being re-polled, and a record that
// belongs to a *different* note must never land in the row the user is looking at now.

export interface NoteDraftState {
  /** The note a draft was requested for, or null when no draft is open. */
  noteId: string | null;
  /** The editable proposal, once the planner has produced one. */
  tasks: PlannedTask[] | null;
  /** Why the draft failed — a rejected request, or a plan that ended `failed`. */
  error: string | null;
}

export const NO_NOTE_DRAFT: NoteDraftState = {
  noteId: null,
  tasks: null,
  error: null,
};

export function startNoteDraft(noteId: string): NoteDraftState {
  return { noteId, tasks: null, error: null };
}

export function failNoteDraft(
  state: NoteDraftState,
  message: string
): NoteDraftState {
  return { ...state, error: message };
}

/**
 * Folds the polled plan record into the open draft. Returns `state` unchanged (same
 * reference, so React bails out of the re-render) whenever there is nothing to apply:
 *
 * - a record for another note is a leftover from the draft that was open a moment ago —
 *   applying it would show note A's drafted task under note B;
 * - a record that is still `running` has nothing to show yet;
 * - a draft that already has tasks is left alone, because the record arrives again on every
 *   poll and re-seeding would throw away whatever the user has since typed into the card.
 */
export function applyNotePlanRecord(
  state: NoteDraftState,
  record: PlanRecord | undefined
): NoteDraftState {
  if (state.noteId === null || record === undefined) return state;
  if (record.sourceNoteId !== state.noteId) return state;
  if (record.state === 'failed') {
    return failNoteDraft(
      state,
      record.error ?? 'the agent could not draft this task'
    );
  }
  if (record.state !== 'ready' || record.proposal === undefined) return state;
  if (state.tasks !== null) return state;
  return { ...state, tasks: record.proposal.tasks };
}

export function editNoteDraftTask(
  state: NoteDraftState,
  index: number,
  patch: Partial<PlannedTask>
): NoteDraftState {
  if (state.tasks === null) return state;
  return {
    ...state,
    tasks: state.tasks.map((task, i) =>
      i === index ? { ...task, ...patch } : task
    ),
  };
}

/** Whether this note's row should show the "drafting…" spinner: asked for, nothing back yet. */
export function isNoteDraftPending(
  state: NoteDraftState,
  noteId: string
): boolean {
  return (
    state.noteId === noteId && state.tasks === null && state.error === null
  );
}
