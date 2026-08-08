import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ReviewVerdictBar } from './ReviewVerdictBar';

const submit = () => Promise.resolve({ published: 0 });

// The full-page review renders the `bar` layout, and it is the surface most
// reviews are submitted from — but the copy test that pins the checkbox's
// meaning goes through ReviewCommentsPanel, which is hardcoded `stacked`.
// These drive `bar` directly so that gap cannot reopen.
test('the bar layout explains what leaving the GitHub box off does', () => {
  render(<ReviewVerdictBar layout="bar" comments={[]} onSubmit={submit} />);
  expect(screen.queryByLabelText(/also post to github/i)).toBeNull();

  render(
    <ReviewVerdictBar
      layout="bar"
      comments={[]}
      onSubmit={submit}
      canPostToGitHub
    />
  );
  const box = screen.getByLabelText<HTMLInputElement>(/also post to github/i);
  expect(box.checked).toBe(false);
  // Visible text, not a hover `title` — a keyboard or screen-reader user
  // never sees the latter.
  expect(screen.getByText(/still goes back to the agent/i)).toBeDefined();
});

test('the bar layout submits with the GitHub choice the reviewer made', async () => {
  const calls: boolean[] = [];
  const record = (_v: unknown, _b: string, postToGitHub: boolean) => {
    calls.push(postToGitHub);
    return Promise.resolve({ published: 0 });
  };
  render(
    <ReviewVerdictBar
      layout="bar"
      comments={[]}
      onSubmit={record}
      canPostToGitHub
    />
  );

  fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
  await waitFor(() => expect(calls).toEqual([false]));

  fireEvent.click(screen.getByLabelText(/also post to github/i));
  fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
  await waitFor(() => expect(calls).toEqual([false, true]));
});
