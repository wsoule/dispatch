import type { Priority } from '@dispatch/core';

import type { PlanProposal } from './api';

// Every edit the plan review screen (Phase 5 P2) can make to a `PlanProposal`
// before confirming it. Pure and network-free — the same "extract the
// display-agnostic logic into @dispatch/client" split this package already
// applies to taskQueryString/computeBlockedIds-style helpers — so both the
// desktop review screen and its tests can exercise the exact edit semantics
// (in particular, index renumbering on remove) without mounting any React.
export type ProposalAction =
  | { type: 'setEpicTitle'; title: string }
  | { type: 'setEpicDescription'; description: string }
  | { type: 'setTaskTitle'; index: number; title: string }
  | { type: 'setTaskDescription'; index: number; description: string }
  | { type: 'setTaskPriority'; index: number; priority: Priority }
  | { type: 'removeTask'; index: number };

// Removes the task at `removedIndex` from a `blockedByIndices` list, and
// shifts every remaining index above it down by one — the same renumbering
// `reduceProposal`'s `removeTask` case needs for every *other* task's
// dependency list once one sibling's array position disappears. A dependency
// on the removed task itself is simply dropped (that dependency no longer
// exists); nothing else moves.
function renumberAfterRemoval(
  blockedByIndices: number[],
  removedIndex: number
): number[] {
  return blockedByIndices
    .filter((i) => i !== removedIndex)
    .map((i) => (i > removedIndex ? i - 1 : i));
}

/**
 * Applies one edit to a plan proposal, returning a new `PlanProposal` (never
 * mutates its input — every field the review screen renders comes straight
 * from the reducer's own output, same as any other React-friendly reducer).
 * `removeTask` is the one case with cross-cutting effects: deleting
 * `tasks[index]` shifts every later task's own array position down by one,
 * so every sibling's `blockedByIndices` must be renumbered in the same pass
 * or a dependency arrow would silently point at the wrong (shifted) task —
 * see `renumberAfterRemoval` above for the exact rule.
 */
export function reduceProposal(
  proposal: PlanProposal,
  action: ProposalAction
): PlanProposal {
  switch (action.type) {
    case 'setEpicTitle':
      if (proposal.epic === undefined) return proposal;
      return { ...proposal, epic: { ...proposal.epic, title: action.title } };
    case 'setEpicDescription':
      if (proposal.epic === undefined) return proposal;
      return {
        ...proposal,
        epic: { ...proposal.epic, description: action.description },
      };
    case 'setTaskTitle':
      return {
        ...proposal,
        tasks: proposal.tasks.map((task, i) =>
          i === action.index ? { ...task, title: action.title } : task
        ),
      };
    case 'setTaskDescription':
      return {
        ...proposal,
        tasks: proposal.tasks.map((task, i) =>
          i === action.index
            ? { ...task, description: action.description }
            : task
        ),
      };
    case 'setTaskPriority':
      return {
        ...proposal,
        tasks: proposal.tasks.map((task, i) =>
          i === action.index ? { ...task, priority: action.priority } : task
        ),
      };
    case 'removeTask':
      return {
        ...proposal,
        tasks: proposal.tasks
          .filter((_, i) => i !== action.index)
          .map((task) => ({
            ...task,
            blockedByIndices: renumberAfterRemoval(
              task.blockedByIndices,
              action.index
            ),
          })),
      };
  }
}
