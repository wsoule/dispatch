import type { PrDetail, PrReviewEvent } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { PrReviewPanel } from './PrReviewPanel';

const DETAIL: PrDetail = {
  status: {
    number: 7,
    url: 'https://github.com/wsoule/dispatch/pull/7',
    title: 'Mirror review comments',
    state: 'OPEN',
    isDraft: false,
    reviewDecision: null,
    mergeable: 'MERGEABLE',
    checks: { passed: 1, failed: 0, pending: 0, total: 1 },
    additions: 10,
    deletions: 2,
    changedFiles: 1,
  },
  conversation: [],
};

function setup(stagedNotes: number) {
  const reviews: PrReviewEvent[] = [];
  const comments: string[] = [];
  render(
    <PrReviewPanel
      detail={DETAIL}
      loading={false}
      error={null}
      stagedNotes={stagedNotes}
      onReview={(event) => {
        reviews.push(event);
        return Promise.resolve();
      }}
      onComment={(body) => {
        comments.push(body);
        return Promise.resolve();
      }}
    />
  );
  const box = screen.getByRole<HTMLTextAreaElement>('textbox');
  fireEvent.change(box, { target: { value: 'Two small things.' } });
  fireEvent.click(screen.getByRole('button', { name: /^comment$/i }));
  return { reviews, comments };
}

// The fork gate's UI half (spec Decision 3). Handing a PR to a review agent
// runs that PR's code here, so a fork has to say whose code it is first.
function setupAgentReview(forkOwner?: string) {
  const confirms: boolean[] = [];
  render(
    <PrReviewPanel
      detail={DETAIL}
      loading={false}
      error={null}
      onReview={() => Promise.resolve()}
      onComment={() => Promise.resolve()}
      forkOwner={forkOwner}
      onAgentReview={(confirmFork) => {
        confirms.push(confirmFork);
        return Promise.resolve();
      }}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: /review with agent/i }));
  return confirms;
}

describe('PrReviewPanel agent review', () => {
  test('a same-repo PR dispatches on the first click', async () => {
    const confirms = setupAgentReview(undefined);
    await waitFor(() => expect(confirms).toEqual([false]));
    expect(screen.queryByText(/on this machine/i)).toBeNull();
  });

  test('a fork PR asks first, naming the head owner', () => {
    const confirms = setupAgentReview('outsider-org');
    expect(confirms).toEqual([]);
    expect(screen.getByText(/outsider-org/)).toBeDefined();
    expect(screen.getByText(/on this machine/i)).toBeDefined();
  });

  test('a fork PR dispatches with confirmFork once confirmed', async () => {
    const confirms = setupAgentReview('outsider-org');
    fireEvent.click(screen.getByRole('button', { name: /run the review/i }));
    await waitFor(() => expect(confirms).toEqual([true]));
  });

  test('cancelling a fork confirm dispatches nothing', () => {
    const confirms = setupAgentReview('outsider-org');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(confirms).toEqual([]);
    expect(screen.queryByText(/on this machine/i)).toBeNull();
  });
});

describe('PrReviewPanel', () => {
  // On GitHub, Comment is how you submit review notes without a verdict. A
  // plain issue comment would post the body and strand every staged note.
  test('Comment submits a review when notes are staged', async () => {
    const { reviews, comments } = setup(2);
    await waitFor(() => expect(reviews).toEqual(['comment']));
    expect(comments).toEqual([]);
  });

  test('Comment stays a conversation comment with nothing staged', async () => {
    const { reviews, comments } = setup(0);
    await waitFor(() => expect(comments).toEqual(['Two small things.']));
    expect(reviews).toEqual([]);
  });
});
