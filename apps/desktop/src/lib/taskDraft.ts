// The full-page task creator's draft model: what the planner returns (`TaskDraft`) is only
// part of a task, so the view keeps its own editable copy that adds the two fields the
// planner never proposes — `status` (the tracker column, which a board column's "+" can
// pre-select) and `parent` (the epic to file it under). Kept here, DOM- and React-free, so
// the "what actually gets saved" rules are testable without mounting the view.

import type { TaskDraft } from '@dispatch/client';
import { taskDraftToCreateInput } from '@dispatch/client';
import type { CreateInput } from '@dispatch/core';

export interface EditableTaskDraft extends TaskDraft {
  /** Tracker status the task will be created in — seeded from the board column whose "+"
   * opened the creator, or the first configured status otherwise. */
  status: string;
  /** Epic id to file the task under, or `null` for a top-level task. */
  parent: string | null;
}

/** Seeds the editable draft from a planner-returned `TaskDraft` plus the status the creator
 * was opened with. Every other field is taken from the draft as-is — the user edits it in
 * place before saving. */
export function editableDraftFrom(
  draft: TaskDraft,
  status: string
): EditableTaskDraft {
  return { ...draft, status, parent: null };
}

/** A draft is saveable once it has a title — the same single required field
 * `CreateTaskModal` enforces, so the two creation paths can't disagree about what a minimum
 * task is. */
export function isDraftSaveable(draft: EditableTaskDraft): boolean {
  return draft.title.trim() !== '';
}

/**
 * Maps the edited draft onto the `CreateInput` that `handleCreate`/`POST /api/tasks` takes —
 * the same save path `CreateTaskModal` uses, so nothing about how a task is persisted depends
 * on which creator produced it. `taskDraftToCreateInput` (client) does the title/description/
 * priority/acceptance-criteria fold; this adds the two view-owned fields on top and cleans up
 * what inline editing can leave behind: a title padded with whitespace, and blank criteria
 * rows from an "Add criterion" the user never filled in.
 */
export function editableDraftToCreateInput(
  draft: EditableTaskDraft
): CreateInput {
  const { status, parent, ...planned } = draft;
  return {
    ...taskDraftToCreateInput({
      ...planned,
      title: planned.title.trim(),
      acceptanceCriteria: planned.acceptanceCriteria
        .map((criterion) => criterion.trim())
        .filter((criterion) => criterion !== ''),
    }),
    status,
    parent,
  };
}
