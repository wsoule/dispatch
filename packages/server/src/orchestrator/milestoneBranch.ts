// Naming for a milestone's integration branch — the branch a task under that milestone
// is cut from and merged back onto, so the milestone's work accumulates in one
// place instead of landing on the default branch task by task.
//
// Lifecycle (decided for the milestone-branches feature; see
// docs/design/milestone-branches.md for the full rationale):
//
// - Created LAZILY: the first dispatch of a child task cuts `milestone/<id>` from
//   the project's default base branch. A milestone whose children never dispatch
//   never grows a branch.
// - Only ever moves FORWARD. Dispatch appends squash commits to it (one per
//   merged child run) and a human may merge the default branch into it, but
//   dispatch never rebases or otherwise rewrites it. That is what makes it
//   safe for in-flight child runs: their commits are never orphaned by a
//   history rewrite, and the merge queue's existing rebase-onto-base step
//   brings each run onto the milestone tip at merge time — the same guarantee the
//   default branch gives concurrent runs today.
// - Drift against the default branch is SURFACED (BranchEntry.behindBase on
//   the branches listing), never repaired automatically.

export const MILESTONE_BRANCH_PREFIX = 'milestone/';

// The integration branch name for a milestone id: `milestone/e-abc123`.
export function milestoneBranchName(milestoneId: string): string {
  return `${MILESTONE_BRANCH_PREFIX}${milestoneId}`;
}

// Whether a ref name is a milestone integration branch. Keyed on the name alone —
// run metadata records branch names, not what kind of thing they point at.
export function isMilestoneBranch(branch: string): boolean {
  return branch.startsWith(MILESTONE_BRANCH_PREFIX);
}
