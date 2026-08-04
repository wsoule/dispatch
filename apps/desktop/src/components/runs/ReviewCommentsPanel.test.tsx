import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReviewCommentsPanel } from './ReviewCommentsPanel';

const noop = async () => {};
const submit = async () => ({ published: 0 });

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
