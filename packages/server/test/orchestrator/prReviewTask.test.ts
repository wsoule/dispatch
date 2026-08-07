import { describe, expect, it } from 'bun:test';

import type { RepoPr } from '../../src/orchestrator/pr.js';
import {
  buildPrReviewTask,
  isPrReviewTaskFor,
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

  it('escapes bracket paths so writes matches only that literal file', () => {
    // Next.js dynamic route — a real, common path shape that is also
    // valid Bun.Glob character-class syntax if left unescaped.
    const input = buildPrReviewTask(makePr(), [{ path: 'app/[id]/route.ts' }]);
    const glob = new Bun.Glob(input.writes![0]);
    expect(glob.match('app/[id]/route.ts')).toBe(true);
    // An unescaped `[id]` is a one-character class matching either
    // i or d — this must NOT match either single-letter variant.
    expect(glob.match('app/i/route.ts')).toBe(false);
    expect(glob.match('app/d/route.ts')).toBe(false);
  });

  it('escapes star paths so writes matches only that literal file', () => {
    const input = buildPrReviewTask(makePr(), [{ path: 'src/*star*.ts' }]);
    const glob = new Bun.Glob(input.writes![0]);
    expect(glob.match('src/*star*.ts')).toBe(true);
    // An unescaped `*` matches any run of characters in its place.
    expect(glob.match('src/xxxstarxxx.ts')).toBe(false);
  });

  it('leaves an ordinary metacharacter-free path unchanged', () => {
    const input = buildPrReviewTask(makePr(), [{ path: 'src/retry.ts' }]);
    const glob = new Bun.Glob(input.writes![0]);
    expect(glob.match('src/retry.ts')).toBe(true);
    expect(input.writes![0]).toBe('src/retry.ts');
  });

  it('is pure: called twice with the same input, returns equal output', () => {
    const pr = makePr();
    const files = [{ path: 'src/retry.ts' }];
    expect(buildPrReviewTask(pr, files)).toEqual(buildPrReviewTask(pr, files));
  });
});

// What stops a second dispatch for a PR already under review: the api layer
// finds the task it made last time through this, so the two have to agree.
describe('isPrReviewTaskFor', () => {
  function metaFor(number: number, title: string) {
    const input = buildPrReviewTask(makePr({ number, title }), []);
    return { title: input.title, labels: input.labels ?? [] };
  }

  it('matches the task buildPrReviewTask made for that PR', () => {
    expect(isPrReviewTaskFor(metaFor(7, 'Bump deps'), 7)).toBe(true);
  });

  it('does not match another PR, including a prefix-sharing number', () => {
    const meta = metaFor(11, 'Fix a typo');
    expect(isPrReviewTaskFor(meta, 1)).toBe(false);
    expect(isPrReviewTaskFor(meta, 7)).toBe(false);
  });

  // A human-written task called "Review PR #7: ..." is not one of ours; the
  // label is what says a dispatch synthesized it.
  it('does not match a same-titled task without the label', () => {
    const meta = metaFor(7, 'Bump deps');
    expect(isPrReviewTaskFor({ ...meta, labels: [] }, 7)).toBe(false);
  });
});
