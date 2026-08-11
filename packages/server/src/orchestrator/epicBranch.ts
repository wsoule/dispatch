// Naming for an epic's integration branch — the branch a task under that epic
// is cut from and merged back onto, so the epic's work accumulates in one
// place instead of landing on the default branch task by task.
//
// Lifecycle (decided for the epic-branches feature; see
// docs/design/epic-branches.md for the full rationale):
//
// - Created LAZILY: the first dispatch of a child task cuts `epic/<id>` from
//   the project's default base branch. An epic whose children never dispatch
//   never grows a branch.
// - Only ever moves FORWARD. Dispatch appends squash commits to it (one per
//   merged child run) and a human may merge the default branch into it, but
//   dispatch never rebases or otherwise rewrites it. That is what makes it
//   safe for in-flight child runs: their commits are never orphaned by a
//   history rewrite, and the merge queue's existing rebase-onto-base step
//   brings each run onto the epic tip at merge time — the same guarantee the
//   default branch gives concurrent runs today.
// - Drift against the default branch is SURFACED (BranchEntry.behindBase on
//   the branches listing), never repaired automatically.

export const EPIC_BRANCH_PREFIX = 'epic/';

// The integration branch name for an epic id: `epic/e-abc123`.
export function epicBranchName(epicId: string): string {
  return `${EPIC_BRANCH_PREFIX}${epicId}`;
}

// Whether a ref name is an epic integration branch. Keyed on the name alone —
// run metadata records branch names, not what kind of thing they point at.
export function isEpicBranch(branch: string): boolean {
  return branch.startsWith(EPIC_BRANCH_PREFIX);
}
