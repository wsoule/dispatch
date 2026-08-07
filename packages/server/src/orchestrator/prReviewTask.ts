import type { CreateInput } from '@dispatch/core';

import type { RepoPr } from './pr.js';

// RepoPr (from `gh pr list --json …`, see pr.ts's listRepoPrs) has no body
// field — no caller has needed the PR's description text before this one.
// Task 5's caller sources it separately (e.g. a `gh pr view --json body`
// call) and spreads it onto the RepoPr it already has before calling this.
export type PrWithBody = RepoPr & { body: string };

// Label marking a task this function synthesized rather than a human
// writing it — lets the board (and any future filter) tell the two apart.
export const PR_REVIEW_LABEL = 'github-pr';

// Placeholder used when a PR was opened with no description at all, so the
// task body never renders as literally empty.
const NO_DESCRIPTION = '_No description provided._';

/**
 * Builds the CreateInput for a task that reviews an open GitHub PR. Pure:
 * no store, filesystem, or `gh` call — turning this into a real task is
 * Task 5's job, via TaskStore.create().
 */
export function buildPrReviewTask(
  pr: PrWithBody,
  files: { path: string }[]
): CreateInput {
  const body = pr.body.trim();
  const description = body === '' ? NO_DESCRIPTION : body;
  return {
    title: `Review PR #${pr.number}: ${collapseWhitespace(pr.title)}`,
    description: `${description}\n\n---\n\nGitHub PR: ${pr.url}`,
    writes: files.map((file) => file.path),
    risk: 'elevated',
    labels: [PR_REVIEW_LABEL],
  };
}

// Collapses runs of whitespace (including embedded newlines) to a single
// space. A task title renders on one board row; a crafted or copy-pasted
// multi-line PR title would otherwise break that layout.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
