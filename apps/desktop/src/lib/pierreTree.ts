import type { GitStatus } from '@pierre/trees';

// Maps a `git diff --name-status` code (what dispatchd's
// `GET /api/runs/:id/diff` returns per file — see
// packages/server/src/orchestrator/worktree.ts's `diff()`) to the
// `GitStatus` enum @pierre/trees' `FileTree` decorates rows with. Only the
// first letter matters — git's own codes carry a similarity percentage
// suffix for renames/copies (`R100`, `C87`) that this ignores. Anything
// unrecognized (there shouldn't be any, but a future git version could add
// one) falls back to `modified` rather than throwing, since a wrong-but
// -present decoration beats crashing the review view over a single file.
export function toTreeGitStatus(nameStatusCode: string): GitStatus {
  switch (nameStatusCode.charAt(0)) {
    case 'A':
      return 'added';
    case 'D':
      return 'deleted';
    case 'R':
      return 'renamed';
    case 'C':
      return 'added';
    default:
      return 'modified';
  }
}

// Normalizes a diff file's path for the tree/PatchDiff header, which both
// expect a single forward-slash path with no leading slash. Defensive
// against a rename line's two tab-separated paths (`old\tnew`) — worktree.ts
// joins them back together with a literal tab when it splits on the first
// tab, which is a real quirk of that endpoint's output, not something O3
// should silently mask by pretending the field is always a clean path; this
// keeps the tree from rendering a raw tab character by preferring the
// rename's destination path (the last segment) for display.
export function normalizeDiffFilePath(path: string): string {
  if (!path.includes('\t')) return path;
  const segments = path.split('\t');
  return segments[segments.length - 1] ?? path;
}
