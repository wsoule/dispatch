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
