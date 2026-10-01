import type { Message } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { DECIDE_TIER_EXPLANATION } from '../../lib/daemonAuth';
import { taskDoc } from '../../lib/taskDoc.test-helper';
import { TaskProposalCard } from './TaskProposalCard';

const GATE: Message = {
  id: 'm-gate',
  thread: 'm-root',
  replyTo: 'm-root',
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'agent:wyat/a2a.acme proposes a task over A2A: "Rate-limit uploads" (t-a1b2c3). Approve to move it to Ready; nothing runs until you do.',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  choices: ['approve', 'decline'],
  data: {
    type: 'task-proposal',
    task: 't-a1b2c3',
    proposedBy: 'agent:wyat/a2a.acme',
    message: 'm-root',
  },
  createdAt: '2026-09-25T10:00:00.000Z',
};
const DRAFT = taskDoc(
  {
    id: 't-a1b2c3',
    title: 'Rate-limit uploads',
    status: 'draft',
    risk: 'critical',
    labels: ['a2a'],
    writes: ['src/upload.ts'],
  },
  'Cap uploads at 10 a minute per client.\n\nRequested over A2A by agent:wyat/a2a.acme (message m-root).'
);

test('shows the draft and approves through the gate', async () => {
  const onAnswer = mock(() => Promise.resolve());
  render(
    <TaskProposalCard
      gate={GATE}
      task={DRAFT}
      onAnswer={onAnswer}
      onOpenTask={() => {}}
      canDecide
    />
  );
  expect(screen.getByText('Rate-limit uploads')).toBeTruthy();
  expect(screen.getByText('agent:wyat/a2a.acme')).toBeTruthy();
  expect(screen.getByText('src/upload.ts')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('approve'));
});

test('renders the client’s description as text, not markdown', () => {
  render(
    <TaskProposalCard
      gate={GATE}
      task={{ ...DRAFT, body: '## injected heading' }}
      onAnswer={async () => {}}
      onOpenTask={() => {}}
      canDecide
    />
  );
  expect(
    screen.queryByRole('heading', { name: 'injected heading' })
  ).toBeNull();
  expect(screen.getByText('## injected heading')).toBeTruthy();
});

test('disables the answers below the decide tier', () => {
  render(
    <TaskProposalCard
      gate={GATE}
      task={DRAFT}
      onAnswer={async () => {}}
      onOpenTask={() => {}}
      canDecide={false}
    />
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Decline' }).disabled
  ).toBe(true);
  expect(screen.getByText(DECIDE_TIER_EXPLANATION)).toBeTruthy();
});

test('declines through the gate, and opens the draft', async () => {
  const onAnswer = mock((_choice: 'approve' | 'decline') => Promise.resolve());
  const onOpenTask = mock((_id: string) => {});
  render(
    <TaskProposalCard
      gate={GATE}
      task={DRAFT}
      onAnswer={onAnswer}
      onOpenTask={onOpenTask}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Open draft' }));
  expect(onOpenTask).toHaveBeenCalledWith('t-a1b2c3');
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('decline'));
});

test('holds both answers while one is in flight, and shows a failed one', async () => {
  let fail = (_err: Error) => {};
  const onAnswer = mock(
    (_choice: 'approve' | 'decline') =>
      new Promise<void>((_resolve, reject) => {
        fail = reject;
      })
  );
  render(
    <TaskProposalCard
      gate={GATE}
      task={DRAFT}
      onAnswer={onAnswer}
      onOpenTask={() => {}}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  const decline = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Decline',
  });
  expect(decline.disabled).toBe(true);
  fireEvent.click(decline);
  expect(onAnswer).toHaveBeenCalledTimes(1);
  fail(new Error('question m-gate already has an answer'));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'question m-gate already has an answer'
    )
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled
  ).toBe(false);
});

test('offers no Approve until the draft is on the board, but Decline still answers', async () => {
  const onAnswer = mock((_choice: 'approve' | 'decline') => Promise.resolve());
  render(
    <TaskProposalCard
      gate={GATE}
      task={null}
      onAnswer={onAnswer}
      onOpenTask={() => {}}
      canDecide
    />
  );
  expect(
    screen.getByText('The draft t-a1b2c3 is not on the board.')
  ).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledWith('decline'));
});

test('keeps both answers held after one succeeds, so a second click cannot conflict', async () => {
  const onAnswer = mock((_choice: 'approve' | 'decline') => Promise.resolve());
  render(
    <TaskProposalCard
      gate={GATE}
      task={DRAFT}
      onAnswer={onAnswer}
      onOpenTask={() => {}}
      canDecide
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'Approve' }));
  await waitFor(() => expect(onAnswer).toHaveBeenCalledTimes(1));
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Approving…' })
        .disabled
    ).toBe(true)
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Decline' }).disabled
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  expect(onAnswer).toHaveBeenCalledTimes(1);
});

test('names the description’s scroll area and lists duplicate writes', () => {
  render(
    <TaskProposalCard
      gate={GATE}
      task={{ ...DRAFT, meta: { ...DRAFT.meta, writes: ['a.ts', 'a.ts'] } }}
      onAnswer={async () => {}}
      onOpenTask={() => {}}
      canDecide
    />
  );
  const region = screen.getByLabelText('Draft description');
  expect(region.tabIndex).toBe(0);
  expect(screen.getAllByText('a.ts')).toHaveLength(2);
});
