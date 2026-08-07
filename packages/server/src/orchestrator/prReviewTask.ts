import type { CreateInput, TaskMeta } from '@dispatch/core';

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

// review.ts's scanDestructiveWrites/undeclaredWrites (see :165-168, :196)
// treat every `writes` entry as a Bun.Glob pattern, not a literal path.
// GitHub paths legally contain glob metacharacters — Next.js dynamic
// routes (`app/[id]/route.ts`) are the common case — so left unescaped a
// path here would fail to match the very file it came from, or match an
// unrelated one instead (e.g. `[id]` as a one-char class matching `i`).
const GLOB_METACHARS = /[\\*?[\]{}()+@|!]/g;

// Escapes glob syntax so a literal path only ever matches itself once it
// is (elsewhere) interpreted as a Bun.Glob pattern. Do not "simplify" this
// away — an unescaped path is the bug this function exists to prevent.
function escapeGlobPath(path: string): string {
  return path.replace(GLOB_METACHARS, '\\$&');
}

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
    title: `${titlePrefix(pr.number)}${collapseWhitespace(pr.title)}`,
    description: `${description}\n\n---\n\nGitHub PR: ${pr.url}`,
    writes: files.map((file) => escapeGlobPath(file.path)),
    risk: 'elevated',
    labels: [PR_REVIEW_LABEL],
  };
}

// The one place a PR review task's title is shaped, so isPrReviewTaskFor
// below reads back exactly what this wrote.
function titlePrefix(number: number): string {
  return `Review PR #${number}: `;
}

// Recognizes a task synthesized for one specific PR. The label alone matches
// every PR's task, so the number is read back off the title prefix — which
// is why that prefix has a single definition above.
export function isPrReviewTaskFor(
  meta: Pick<TaskMeta, 'title' | 'labels'>,
  number: number
): boolean {
  return (
    meta.labels.includes(PR_REVIEW_LABEL) &&
    meta.title.startsWith(titlePrefix(number))
  );
}

// Collapses runs of whitespace (including embedded newlines) to a single
// space. A task title renders on one board row; a crafted or copy-pasted
// multi-line PR title would otherwise break that layout.
function collapseWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}
