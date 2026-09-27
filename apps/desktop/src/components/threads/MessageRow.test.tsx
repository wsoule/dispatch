import type { AgentSummary, Message } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { threadLookups } from '../../lib/threadSources';
import type { MessageRowProps } from './MessageRow';
import { MessageRow } from './MessageRow';

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: id,
    replyTo: null,
    from: 'run:r-000001',
    to: ['human:wyat'],
    kind: 'message',
    body: id,
    refs: [],
    urgent: false,
    blocking: false,
    wake: 'none',
    createdAt: '2026-09-25T10:00:00.000Z',
    ...over,
  };
}

const revoked: AgentSummary = {
  address: 'agent:wyat/old',
  displayName: 'old',
  client: 'codex',
  status: 'revoked',
  muted: false,
  approvedBy: null,
  createdAt: '2026-09-25T10:00:00.000Z',
};
const lookups = threadLookups(
  [{ meta: { id: 't-000002', title: 'Checkout' } }],
  [{ id: 'r-000001', taskId: 't-000002' }],
  [revoked]
);
const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};
const TEAMMATE: MessageAccess = {
  canDecide: false,
  canMessage: true,
  explanation: 'Answering approvals needs the decide tier.',
};
const CAN_DECIDE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

function renderRow(message: Message, over: Partial<MessageRowProps> = {}) {
  const onAnswer = mock((_m: Message, _r: { body: string; choice?: string }) =>
    Promise.resolve()
  );
  render(
    <MessageRow
      message={message}
      me="human:wyat"
      open
      access={DECIDER}
      lookups={lookups}
      availability={CAN_DECIDE}
      onRestartDaemon={() => Promise.resolve()}
      onAnswer={onAnswer}
      onOpen={() => {}}
      {...over}
    />
  );
  return onAnswer;
}

test('answers a question put to me with the choice as body and choice', async () => {
  const q = msg('m-q', {
    kind: 'question',
    blocking: true,
    choices: ['old cart', 'new cart'],
  });
  const onAnswer = renderRow(q, { access: TEAMMATE });
  fireEvent.click(screen.getByRole('button', { name: 'new cart' }));
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith(q, {
      body: 'new cart',
      choice: 'new cart',
    })
  );
});

test('shows a gate read-only, with the reason and no buttons, to a viewer who cannot decide', () => {
  const wake = msg('m-w', {
    from: 'agent:dispatch',
    kind: 'question',
    blocking: true,
    choices: ['approve', 'deny'],
    data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
  });
  renderRow(wake, { access: TEAMMATE });
  expect(
    screen.getByText('Answering approvals needs the decide tier.')
  ).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
});

test("keeps a revoked agent's message readable, with a Revoked pill", () => {
  renderRow(msg('m-r', { from: 'agent:wyat/old', body: 'still here' }), {
    open: false,
  });
  expect(screen.getByText('still here')).toBeTruthy();
  expect(screen.getByText('Revoked')).toBeTruthy();
});

test('shows a failed answer on the row', async () => {
  const q = msg('m-q', { kind: 'question', blocking: true, choices: ['yes'] });
  renderRow(q, {
    onAnswer: () =>
      Promise.reject(new Error('question m-q already has an answer')),
  });
  fireEvent.click(screen.getByRole('button', { name: 'yes' }));
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'question m-q already has an answer'
    )
  );
});

test('a run sender and a task ref open where they lead; a commit ref does not', () => {
  const onOpen = mock((_action: unknown) => {});
  renderRow(
    msg('m-n', {
      kind: 'notice',
      refs: [
        { type: 'task', id: 't-000002' },
        { type: 'commit', id: 'abc1234def' },
      ],
    }),
    { onOpen, open: false }
  );
  expect(screen.getByText('Notice')).toBeTruthy();
  fireEvent.click(
    screen.getByRole('button', { name: 't-000002 · Checkout · r-000001' })
  );
  expect(onOpen).toHaveBeenCalledWith({
    kind: 'run',
    taskId: 't-000002',
    runId: 'r-000001',
  });
  fireEvent.click(screen.getByRole('button', { name: 'task:t-000002' }));
  expect(onOpen).toHaveBeenCalledWith({ kind: 'task', taskId: 't-000002' });
  expect(screen.queryByRole('button', { name: /commit:/ })).toBeNull();
  expect(screen.getByText('commit:abc1234def')).toBeTruthy();
});
