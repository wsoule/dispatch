import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReviewCommentsPanel } from './ReviewCommentsPanel';

const noop = () => Promise.resolve();
const submit = () => Promise.resolve({ published: 0 });

// `RunReviewView` renders this panel and is deliberately not edited alongside the full-page
// review's rework, so the split into thread index + verdict bar has to leave both halves
// rendering together in one column. These pin that.
test('the panel renders threads and the verdict together', () => {
  render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
    />
  );
  expect(screen.getByText('Finish the review')).toBeDefined();
  expect(screen.getByRole('button', { name: /submit review/i })).toBeDefined();
  // The thread index's own empty state, which lives in the other half.
  expect(screen.getByText(/hover a diff line/i)).toBeDefined();
});

test('the agent-review button appears only when the action is given', () => {
  const { rerender } = render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
    />
  );
  expect(screen.queryByRole('button', { name: /ask an agent/i })).toBeNull();

  rerender(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
      onStartAiReview={noop}
    />
  );
  expect(screen.getByRole('button', { name: /ask an agent/i })).toBeDefined();
});

// Posting to GitHub is only possible when the run's work is on a PR, so the
// choice appears only there rather than sitting inert on every review.
test('the GitHub checkbox appears only for a run whose work is on a PR', () => {
  const { rerender } = render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
    />
  );
  expect(screen.queryByLabelText(/also post to github/i)).toBeNull();

  rerender(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
      canPostToGitHub
    />
  );
  const box = screen.getByLabelText<HTMLInputElement>(/also post to github/i);
  expect(box.checked).toBe(false);
});

// The default has to be the quiet one, and the copy has to say that leaving
// it off still sends the review — otherwise it reads as "skip the review".
test('submitting posts to GitHub only once the box is ticked', async () => {
  const calls: boolean[] = [];
  const record = (_v: unknown, _b: string, postToGitHub: boolean) => {
    calls.push(postToGitHub);
    return Promise.resolve({ published: 0 });
  };
  render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={record}
      canPostToGitHub
    />
  );
  expect(screen.getByText(/still goes back to the agent/i)).toBeDefined();

  fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
  await waitFor(() => expect(calls).toEqual([false]));

  fireEvent.click(screen.getByLabelText(/also post to github/i));
  fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
  await waitFor(() => expect(calls).toEqual([false, true]));
});

// The panel is the TaskView path's only route to the verdict bar; if it
// drops these props the task view silently loses the AI-review affordance.
test('passes the live-review-agent state through to the verdict bar', () => {
  render(
    <ReviewCommentsPanel
      comments={[]}
      onResolve={noop}
      onReply={noop}
      onSubmit={submit}
      canPostToGitHub={false}
      onStartAiReview={noop}
      reviewAgentLive
    />
  );
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: /agent reviewing/i,
  });
  expect(button.disabled).toBe(true);
});
