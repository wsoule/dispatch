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
  expect(
    screen.queryByRole('checkbox', { name: /also post to github/i })
  ).toBeNull();

  render(
    <ReviewVerdictBar
      layout="bar"
      comments={[]}
      onSubmit={submit}
      canPostToGitHub
    />
  );
  const box = screen.getByRole<HTMLInputElement>('checkbox', {
    name: /also post to github/i,
  });
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

  fireEvent.click(
    screen.getByRole('checkbox', { name: /also post to github/i })
  );
  fireEvent.click(screen.getByRole('button', { name: /submit review/i }));
  await waitFor(() => expect(calls).toEqual([false, true]));
});

// The "agent is reviewing" indicator is derived from the run list (see
// `liveReviewAgentFor`), not from the click-local starting/started state —
// this is what keeps it visible after navigating away and back, and what
// stops a second agent being dispatched onto a diff one is already reviewing.
test('a live review agent disables re-dispatch and says so', () => {
  render(
    <ReviewVerdictBar
      layout="bar"
      comments={[]}
      onSubmit={submit}
      onStartAiReview={() => Promise.resolve()}
      reviewAgentLive
    />
  );
  const button = screen.getByRole<HTMLButtonElement>('button', {
    name: /agent reviewing/i,
  });
  expect(button.disabled).toBe(true);
  expect(screen.getByText(/an agent is reviewing this run/i)).toBeDefined();
});

// The verdicts are a radio group in both layouts. In the one-row bar there is no room for the
// hint lines, so each hint is a tooltip and stays the radio's accessible description.
test('the bar layout describes each verdict radio by its hint', () => {
  render(<ReviewVerdictBar layout="bar" comments={[]} onSubmit={submit} />);
  expect(screen.getByRole('radiogroup', { name: 'Verdict' })).toBeDefined();

  const hints: [string, string][] = [
    ['Comment', 'Sends the notes. Nothing else happens.'],
    [
      'Request changes',
      'Resumes the agent on the same branch with your review attached.',
    ],
    ['Approve', 'Queues the work to land, once verify passes.'],
  ];
  for (const [name, description] of hints) {
    const radio = screen.getByRole<HTMLInputElement>('radio', {
      name,
      description,
    });
    expect(radio.type).toBe('radio');
    // No visible line: the description is the hidden copy the tooltip shows.
    expect(screen.getByText(description).className).toBe('srOnly');
  }
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Comment' }).checked
  ).toBe(true);
});

// Requesting changes with nothing written would resume the agent to tell it nothing, so the
// submit button waits for a summary once that verdict is picked.
test('picking Request changes holds submit until there is something to send', () => {
  render(<ReviewVerdictBar layout="bar" comments={[]} onSubmit={submit} />);
  const submitButton = () =>
    screen.getByRole<HTMLButtonElement>('button', { name: /submit review/i });
  expect(submitButton().disabled).toBe(false);

  fireEvent.click(screen.getByRole('radio', { name: 'Request changes' }));
  expect(
    screen.getByRole<HTMLInputElement>('radio', { name: 'Request changes' })
      .checked
  ).toBe(true);
  expect(submitButton().disabled).toBe(true);

  fireEvent.change(screen.getByRole('textbox', { name: 'Review summary' }), {
    target: { value: 'Split the parser out first.' },
  });
  expect(submitButton().disabled).toBe(false);
});

// The stacked card has room for the hints, so they are visible lines under each verdict.
test('the stacked layout shows each verdict hint as visible text', () => {
  render(<ReviewVerdictBar layout="stacked" comments={[]} onSubmit={submit} />);
  expect(screen.getByText('Finish the review')).toBeDefined();
  expect(
    screen.getByRole('radio', {
      name: 'Approve',
      description: 'Queues the work to land, once verify passes.',
    })
  ).toBeDefined();
  expect(screen.queryByRole('tooltip')).toBeNull();
  expect(
    screen.getByText('Queues the work to land, once verify passes.').className
  ).not.toBe('srOnly');
});
