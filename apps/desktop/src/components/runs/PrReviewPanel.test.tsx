import type { PrDetail, PrReviewEvent, RunMeta } from '@dispatch/client';
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

// A second PR in the same panel — what the review queue does when the user
// switches rows without unmounting the surface.
const OTHER_DETAIL: PrDetail = {
  ...DETAIL,
  status: { ...DETAIL.status, number: 8 },
};

// The run POST /api/prs/:number/review-agent answers with — the panel reports
// its id back, which is what tells the user the click did something.
const DISPATCHED: RunMeta = {
  id: 'r-review1',
  taskId: 't-abc123',
  taskTitle: 'Review PR #7: Mirror review comments',
  executor: 'claude',
  state: 'running',
  branch: 'dispatch/review-t-abc123',
  baseBranch: 'refs/dispatch/pr/7',
  worktreePath: '/tmp/wt',
  createdAt: '2026-08-07T00:00:00Z',
  updatedAt: '2026-08-07T00:00:00Z',
};

// The fork gate's UI half (spec Decision 3). Handing a PR to a review agent
// runs that PR's code here, so a fork has to say whose code it is first.
function agentPanel(
  detail: PrDetail,
  forkOwner: string | undefined,
  confirms: boolean[]
) {
  return (
    <PrReviewPanel
      detail={detail}
      loading={false}
      error={null}
      onReview={() => Promise.resolve()}
      onComment={() => Promise.resolve()}
      forkOwner={forkOwner}
      onAgentReview={(confirmFork) => {
        confirms.push(confirmFork);
        return Promise.resolve(DISPATCHED);
      }}
    />
  );
}

function setupAgentReview(forkOwner?: string) {
  const confirms: boolean[] = [];
  const { rerender } = render(agentPanel(DETAIL, forkOwner, confirms));
  fireEvent.click(screen.getByRole('button', { name: /review with agent/i }));
  return {
    confirms,
    switchPr: (owner: string) =>
      rerender(agentPanel(OTHER_DETAIL, owner, confirms)),
  };
}

describe('PrReviewPanel agent review', () => {
  test('a same-repo PR dispatches on the first click', async () => {
    const { confirms } = setupAgentReview(undefined);
    await waitFor(() => expect(confirms).toEqual([false]));
    expect(screen.queryByText(/on this machine/i)).toBeNull();
  });

  test('a fork PR asks first, naming the head owner', () => {
    const { confirms } = setupAgentReview('outsider-org');
    expect(confirms).toEqual([]);
    expect(screen.getByText(/outsider-org/)).toBeDefined();
    expect(screen.getByText(/on this machine/i)).toBeDefined();
  });

  test('a fork PR dispatches with confirmFork once confirmed', async () => {
    const { confirms } = setupAgentReview('outsider-org');
    fireEvent.click(screen.getByRole('button', { name: /run the review/i }));
    await waitFor(() => expect(confirms).toEqual([true]));
  });

  test('cancelling a fork confirm dispatches nothing', () => {
    const { confirms } = setupAgentReview('outsider-org');
    fireEvent.click(screen.getByRole('button', { name: /^cancel$/i }));
    expect(confirms).toEqual([]);
    expect(screen.queryByText(/on this machine/i)).toBeNull();
  });

  // A user who clicks and sees nothing change clicks again — and a second
  // review of the same PR ends up posting every line comment to GitHub twice.
  test('a dispatched review names the run it started', async () => {
    setupAgentReview(undefined);
    await waitFor(() =>
      expect(screen.getAllByText(/run r-review1/i).length).toBe(1)
    );
  });

  // The notice belongs to the PR it was dispatched for, same as the confirm.
  test('switching to another PR drops the dispatched notice', async () => {
    const { switchPr } = setupAgentReview(undefined);
    await waitFor(() =>
      expect(screen.getAllByText(/run r-review1/i).length).toBe(1)
    );
    switchPr('other-org');
    expect(screen.queryAllByText(/run r-review1/i).length).toBe(0);
  });

  // A confirm is agreement to run ONE PR's code. Carried across a switch, the
  // next click would dispatch a PR whose prompt the user never opened.
  test('switching to another PR retracts an open fork confirm', () => {
    const { confirms, switchPr } = setupAgentReview('outsider-org');
    switchPr('other-org');
    // Counted, not `queryByText(...).toBeNull()`: a failure there prints the
    // matched DOM node, and its React fibers serialize unboundedly.
    expect(screen.queryAllByText(/on this machine/i).length).toBe(0);
    fireEvent.click(screen.getByRole('button', { name: /review with agent/i }));
    expect(screen.getByText(/other-org/)).toBeDefined();
    expect(confirms).toEqual([]);
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
