import type { Message } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { threadLookups } from '../../lib/threadSources';
import { GateCard, RegistrationCard, WakeCard } from './GateCard';

const gate: Message = {
  id: 'm-g',
  thread: 'm-g',
  replyTo: null,
  from: 'agent:dispatch',
  to: ['human:wyat'],
  kind: 'question',
  body: 'wake?',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: '2026-10-05T10:00:00.000Z',
};

test('a gate card answers a gate choice with an empty body', async () => {
  const answer = mock((_r: { body: string; choice?: string }) =>
    Promise.resolve()
  );
  render(
    <GateCard
      message={gate}
      control={{ kind: 'choices', choices: ['approve', 'deny'], gate: true }}
      lookups={threadLookups([], [], [])}
      onOpen={() => {}}
      availability={{
        enabled: true,
        notice: null,
        explanation: null,
        restart: null,
      }}
      onRestartDaemon={() => Promise.resolve()}
      answer={answer}
      loadApprovalInput={() => Promise.resolve(undefined)}
      client={null}
      port={undefined}
    />
  );
  fireEvent.click(screen.getByRole('button', { name: 'deny' }));
  await waitFor(() =>
    expect(answer).toHaveBeenCalledWith({ body: '', choice: 'deny' })
  );
});

test("a wake card names the task it wakes, and Don't denies", async () => {
  const onDecide = mock((_c: 'approve' | 'deny') => Promise.resolve());
  render(<WakeCard target="task:t-46" onDecide={onDecide} />);
  expect(screen.getByTestId('wake-card')).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Wake t-46' }));
  await waitFor(() => expect(onDecide).toHaveBeenCalledWith('approve'));
  fireEvent.click(screen.getByRole('button', { name: 'Don’t' }));
  await waitFor(() => expect(onDecide).toHaveBeenCalledWith('deny'));
});

test('a registration card names the agent and who asked, and is disabled below the decide tier', () => {
  render(
    <RegistrationCard
      agent="agent:sam/helper"
      client="codex"
      requestedBy="human:sam"
      onDecide={() => Promise.resolve()}
      canDecide={false}
    />
  );
  expect(screen.getByTestId('registration-card').textContent).toContain(
    'agent:sam/helper · codex · asked by human:sam'
  );
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'Approve' }).disabled
  ).toBe(true);
});
