import type { Message } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { MessageAccess } from '../../lib/daemonAuth';
import type { ReplyPlan } from '../../lib/threadSources';
import { threadLookups } from '../../lib/threadSources';
import type { ThreadPaneProps } from './ThreadPane';
import { ThreadPane } from './ThreadPane';

const ME = 'human:wyat';

function msg(id: string, over: Partial<Message> = {}): Message {
  return {
    id,
    thread: 'm-01',
    replyTo: null,
    from: 'run:r-000001',
    to: [ME],
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

const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};
const wake = msg('m-01', {
  from: 'agent:dispatch',
  kind: 'question',
  blocking: true,
  choices: ['approve', 'deny'],
  data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
});

function renderPane(over: Partial<ThreadPaneProps> = {}) {
  const onReply = mock((_plan: ReplyPlan, _body: string) => Promise.resolve());
  render(
    <ThreadPane
      messages={[msg('m-01', { kind: 'question', blocking: true })]}
      me={ME}
      openIds={new Set(['m-01'])}
      access={DECIDER}
      lookups={threadLookups([], [], [])}
      availability={{
        enabled: true,
        notice: null,
        explanation: null,
        restart: null,
      }}
      onRestartDaemon={() => Promise.resolve()}
      onAnswer={() => Promise.resolve()}
      onOpen={() => {}}
      loadApprovalInput={() => Promise.resolve(undefined)}
      route="bus"
      onReply={onReply}
      onOverseerReply={() => Promise.resolve()}
      overseerBusy={false}
      onOpenOverseer={() => {}}
      {...over}
    />
  );
  return onReply;
}

const replyBox = () => screen.getByLabelText<HTMLTextAreaElement>('Reply');

test('a typed reply answers the open question put to me', async () => {
  const onReply = renderPane();
  fireEvent.change(replyBox(), { target: { value: ' the new cart ' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  expect(onReply.mock.calls[0]?.[0]).toMatchObject({ kind: 'reply' });
  expect(onReply.mock.calls[0]?.[1]).toBe('the new cart');
  await waitFor(() => expect(replyBox().value).toBe(''));
});

test('a failed reply says why and keeps the draft', async () => {
  renderPane({
    onReply: () =>
      Promise.reject(
        new ApiError('question m-01 already has an answer', 409, undefined)
      ),
  });
  fireEvent.change(replyBox(), { target: { value: 'the new cart' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'Reply: question m-01 already has an answer'
    )
  );
  expect(replyBox().value).toBe('the new cart');
});

test('a non-blocking question put to me offers its choices as answers', async () => {
  const onAnswer = mock((_m: Message, _r: { body: string; choice?: string }) =>
    Promise.resolve()
  );
  const q = msg('m-01', { kind: 'question', choices: ['yes', 'no'] });
  renderPane({ messages: [q], openIds: new Set(), onAnswer });
  fireEvent.click(screen.getByRole('button', { name: 'yes' }));
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith(q, { body: 'yes', choice: 'yes' })
  );
});

test('an open gate is answered with its buttons, not a typed reply', () => {
  renderPane({ messages: [wake], openIds: new Set(['m-01']) });
  expect(screen.getByText('Answer with the buttons above.')).toBeTruthy();
  expect(screen.queryByLabelText('Reply')).toBeNull();
});

test('an answered daemon gate offers no reply box', () => {
  const answer = msg('m-02', {
    from: ME,
    to: ['agent:dispatch'],
    kind: 'answer',
    replyTo: 'm-01',
    body: '',
    choice: 'approve',
  });
  renderPane({ messages: [wake, answer], openIds: new Set() });
  expect(
    screen.getByText('Nothing in this thread takes a reply.')
  ).toBeTruthy();
  expect(screen.queryByLabelText('Reply')).toBeNull();
});

test('a failed Assistant reply says why and keeps the draft', async () => {
  renderPane({
    route: 'overseer',
    onOverseerReply: () =>
      Promise.reject(new ApiError('overseer w-1 is still answering', 409)),
  });
  fireEvent.change(replyBox(), { target: { value: 'try the new cart' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() =>
    expect(screen.getByRole('alert').textContent).toBe(
      'Reply: overseer w-1 is still answering'
    )
  );
  expect(replyBox().value).toBe('try the new cart');
});

test('the Assistant reply box waits while the Assistant is answering', () => {
  renderPane({ route: 'overseer', overseerBusy: true });
  expect(replyBox().disabled).toBe(true);
  expect(replyBox().placeholder).toBe('The Assistant is answering…');
});

test('an earlier Assistant conversation is read-only, with a way to the Assistant', () => {
  const onOpenOverseer = mock(() => {});
  renderPane({ route: 'overseer-elsewhere', onOpenOverseer });
  expect(
    screen.getByText('This is an earlier Assistant conversation.')
  ).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
  expect(onOpenOverseer).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Reply')).toBeNull();
});
