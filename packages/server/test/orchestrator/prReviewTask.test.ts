import { describe, expect, it } from 'bun:test';

import type { RepoPr } from '../../src/orchestrator/pr.js';
import {
  buildPrReviewTask,
  PR_REVIEW_LABEL,
} from '../../src/orchestrator/prReviewTask.js';

// A minimal-but-realistic RepoPr, matching the shape `gh pr list --json …`
// actually returns (see pr.ts's listRepoPrs) — every field buildPrReviewTask
// doesn't use is still present, so a shape drift in RepoPr would surface here.
function makePr(overrides: Partial<RepoPr & { body: string }> = {}) {
  return {
    number: 12,
    title: 'Fix the flaky retry loop',
    url: 'https://github.com/acme/widgets/pull/12',
    headRefName: 'fix-retry',
    baseRefName: 'main',
    author: 'octocat',
    isDraft: false,
    updatedAt: '2026-08-01T00:00:00Z',
    headRefOid: 'deadbeef',
    isCrossRepository: false,
    headRepositoryOwner: 'acme',
    reviewDecision: null,
    mergeable: 'MERGEABLE' as const,
    checks: { passed: 0, failed: 0, pending: 0, total: 0 },
    additions: 10,
    deletions: 2,
    changedFiles: 2,
    body: 'Retries now back off exponentially instead of busy-looping.',
    ...overrides,
  };
}

describe('buildPrReviewTask', () => {
  it('titles the task from the PR number and title, unmangled', () => {
    const input = buildPrReviewTask(makePr(), [{ path: 'src/retry.ts' }]);
    expect(input.title).toBe('Review PR #12: Fix the flaky retry loop');
  });

  it('carries the PR body and URL into the description', () => {
    const input = buildPrReviewTask(makePr(), [{ path: 'src/retry.ts' }]);
    expect(input.description).toContain(
      'Retries now back off exponentially instead of busy-looping.'
    );
    expect(input.description).toContain(
      'https://github.com/acme/widgets/pull/12'
    );
  });

  it('produces a sensible description for an empty PR body', () => {
    const input = buildPrReviewTask(makePr({ body: '' }), []);
    expect(input.description).not.toBe('');
    expect(input.description).not.toContain('undefined');
    // A placeholder stands in for the missing text, rather than the
    // description opening straight on the "---" separator.
    expect(input.description).toContain('No description provided');
    // Still links back to the PR even with nothing else to say.
    expect(input.description).toContain(
      'https://github.com/acme/widgets/pull/12'
    );
  });

  it('trims whitespace-only PR bodies to the placeholder too', () => {
    const input = buildPrReviewTask(makePr({ body: '   \n  ' }), []);
    expect(input.description).toContain('No description provided');
  });

  it('produces empty writes for a PR with no changed files', () => {
    const input = buildPrReviewTask(makePr(), []);
    expect(input.writes).toEqual([]);
  });

  it('maps changed files straight into writes', () => {
    const input = buildPrReviewTask(makePr(), [
      { path: 'src/retry.ts' },
      { path: 'src/retry.test.ts' },
    ]);
    expect(input.writes).toEqual(['src/retry.ts', 'src/retry.test.ts']);
  });

  it('marks the task as synthesized via a label', () => {
    const input = buildPrReviewTask(makePr(), []);
    expect(input.labels).toContain(PR_REVIEW_LABEL);
  });

  it('defaults to a non-routine risk', () => {
    const input = buildPrReviewTask(makePr(), []);
    expect(input.risk).not.toBe('routine');
  });

  it('collapses a title with embedded newlines to a single line', () => {
    const input = buildPrReviewTask(
      makePr({ title: 'Fix retry\nand also\nrename things' }),
      []
    );
    expect(input.title).toBe('Review PR #12: Fix retry and also rename things');
    expect(input.title).not.toContain('\n');
  });

  it('is pure: called twice with the same input, returns equal output', () => {
    const pr = makePr();
    const files = [{ path: 'src/retry.ts' }];
    expect(buildPrReviewTask(pr, files)).toEqual(buildPrReviewTask(pr, files));
  });
});
