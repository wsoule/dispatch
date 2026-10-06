import type { Message } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { MessageAccess } from '../../lib/daemonAuth';
import { DECIDE_TIER_EXPLANATION } from '../../lib/daemonAuth';
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
  const onReply = mock((_plan: ReplyPlan, _body: string, _key: string) =>
    Promise.resolve()
  );
  render(
    <ThreadPane
      messages={[msg('m-01', { kind: 'question', blocking: true })]}
      deliveries={[]}
      focus={null}
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

test('the reply box says where the text goes', () => {
  renderPane();
  expect(screen.getByText('Answering r-000001')).toBeTruthy();
  cleanup();
  renderPane({ messages: [msg('m-01', { to: ['channel:general'] })] });
  expect(screen.getByText('To #general')).toBeTruthy();
  cleanup();
  renderPane({ route: 'overseer' });
  expect(screen.getByText('To the Assistant')).toBeTruthy();
});

test('a typed reply answers the open question put to me', async () => {
  const onReply = renderPane();
  fireEvent.change(replyBox(), { target: { value: ' the new cart ' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  expect(onReply.mock.calls[0]?.[0]).toMatchObject({ kind: 'reply' });
  expect(onReply.mock.calls[0]?.[1]).toBe('the new cart');
  await waitFor(() => expect(replyBox().value).toBe(''));
});

test("a teammate's reply replies to a message they took part in, not to a note sent past them", async () => {
  const question = msg('m-01', { kind: 'question' });
  const answer = msg('m-02', {
    from: ME,
    to: ['run:r-000001'],
    kind: 'answer',
    replyTo: 'm-01',
  });
  const note = msg('m-03', { to: ['human:owner'], replyTo: 'm-02' });
  const onReply = renderPane({
    messages: [question, answer, note],
    openIds: new Set(),
    access: { canDecide: false, canMessage: true, explanation: 'no decide' },
  });
  fireEvent.change(replyBox(), { target: { value: 'one more thing' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  expect(onReply.mock.calls[0]?.[0]).toEqual({
    kind: 'send',
    to: ['run:r-000001'],
    replyTo: 'm-01',
  });
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

test('a thread that is only my message to a run still sends a reply to that run', async () => {
  // The daemon routes it to the run's task once the run has ended.
  const mine = msg('m-01', { from: ME, to: ['run:r-000001'] });
  const onReply = renderPane({ messages: [mine], openIds: new Set() });
  fireEvent.change(replyBox(), { target: { value: 'still there?' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(1));
  expect(onReply.mock.calls[0]?.[0]).toMatchObject({
    kind: 'send',
    to: ['run:r-000001'],
    replyTo: 'm-01',
  });
  expect(onReply.mock.calls[0]?.[1]).toBe('still there?');
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

test('resending after a lost response repeats the first plan, even once the answer has arrived', async () => {
  const q = msg('m-01', { kind: 'question', blocking: true });
  const onReply = mock((_plan: ReplyPlan, _body: string, _key: string) =>
    Promise.resolve()
  );
  onReply.mockImplementationOnce(() =>
    Promise.reject(new TypeError('Failed to fetch'))
  );
  const pane = (messages: Message[], openIds: ReadonlySet<string>) => (
    <ThreadPane
      messages={messages}
      deliveries={[]}
      focus={null}
      me={ME}
      openIds={openIds}
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
    />
  );
  const { rerender } = render(pane([q], new Set(['m-01'])));
  fireEvent.change(replyBox(), { target: { value: 'the new cart' } });
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  // The first send landed; its answer arrives while the response was lost.
  const answer = msg('m-02', {
    from: ME,
    to: ['run:r-000001'],
    kind: 'answer',
    replyTo: 'm-01',
    body: 'the new cart',
  });
  rerender(pane([q, answer], new Set()));
  fireEvent.keyDown(replyBox(), { key: 'Enter' });
  await waitFor(() => expect(onReply).toHaveBeenCalledTimes(2));
  expect(onReply.mock.calls[1]?.[0]).toBe(onReply.mock.calls[0]?.[0]);
  expect(onReply.mock.calls[1]?.[2]).toBe(onReply.mock.calls[0]?.[2]);
  await waitFor(() => expect(replyBox().value).toBe(''));
});

test('each reply draft has its own idempotency key: kept across a resend, renewed by an edit or a send', async () => {
  const onReply = renderPane({
    messages: [msg('m-01')],
    openIds: new Set(),
  });
  onReply.mockImplementationOnce(() =>
    Promise.reject(new TypeError('Failed to fetch'))
  );
  const send = async (text: string | null, calls: number) => {
    if (text !== null) {
      fireEvent.change(replyBox(), { target: { value: text } });
    }
    fireEvent.keyDown(replyBox(), { key: 'Enter' });
    await waitFor(() => expect(onReply).toHaveBeenCalledTimes(calls));
  };
  await send('noted', 1);
  // Edited after the lost response: a new draft, so a new key.
  await send('noted!', 2);
  await waitFor(() => expect(replyBox().value).toBe(''));
  // The same text again after a send is a new draft too.
  await send('noted!', 3);
  const keys = onReply.mock.calls.map((call) => call[2]);
  expect(new Set(keys).size).toBe(3);
});

test('an open gate is answered with its buttons, not a typed reply', () => {
  renderPane({ messages: [wake], openIds: new Set(['m-01']) });
  expect(screen.getByText('Answer with the buttons above.')).toBeTruthy();
  expect(screen.queryByLabelText('Reply')).toBeNull();
});

test('an open gate a request-tier window cannot answer points at no buttons', () => {
  renderPane({
    messages: [wake],
    openIds: new Set(['m-01']),
    access: {
      canDecide: false,
      canMessage: true,
      explanation: DECIDE_TIER_EXPLANATION,
    },
  });
  expect(screen.getByText(DECIDE_TIER_EXPLANATION)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
  expect(screen.queryByText('Answer with the buttons above.')).toBeNull();
  expect(
    screen.getByText('Nothing in this thread takes a reply.')
  ).toBeTruthy();
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

test('an Assistant conversation this pane cannot reply to is read-only, with a way to the Assistant', () => {
  const onOpenOverseer = mock(() => {});
  renderPane({ route: 'overseer-elsewhere', onOpenOverseer });
  // The task tab routes even the live conversation here, so it is never called earlier.
  expect(
    screen.getByText('This Assistant conversation takes no replies here.')
  ).toBeTruthy();
  expect(screen.queryByText(/earlier/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open Assistant' }));
  expect(onOpenOverseer).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText('Reply')).toBeNull();
});

test('in Two views the reply box names your agent, never the Assistant', () => {
  renderPane({ route: 'overseer', overseerVoice: 'agent' });
  expect(screen.getByText('To your agent')).toBeTruthy();
  expect(replyBox().placeholder).toBe('Reply to your agent…');
  cleanup();
  renderPane({ route: 'overseer', overseerVoice: 'agent', overseerBusy: true });
  expect(replyBox().placeholder).toBe('Your agent is answering…');
  cleanup();
  renderPane({ route: 'overseer-elsewhere', overseerVoice: 'agent' });
  expect(
    screen.getByText('This conversation with your agent takes no replies here.')
  ).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Open Overseer' })).toBeTruthy();
});

// happy-dom has no layout, so the scroller's height is given by hand.
test('opens a thread at its newest message', () => {
  const height = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    'scrollHeight'
  );
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get(this: HTMLElement) {
      return this.getAttribute('role') === 'log' ? 900 : 0;
    },
  });
  try {
    renderPane({ messages: [msg('m-01'), msg('m-02'), msg('m-03')] });
    expect(screen.getByRole('log', { name: 'Messages' }).scrollTop).toBe(900);
  } finally {
    if (height === undefined) {
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollHeight');
    } else {
      Object.defineProperty(HTMLElement.prototype, 'scrollHeight', height);
    }
  }
});

test('a link to a message further up scrolls it into view and marks it; the root does not', () => {
  const scrolled: [string | null, ScrollIntoViewOptions | undefined][] = [];
  const original = Element.prototype.scrollIntoView;
  Element.prototype.scrollIntoView = function (
    this: Element,
    arg?: boolean | ScrollIntoViewOptions
  ) {
    scrolled.push([
      this.getAttribute('data-message-id'),
      typeof arg === 'object' ? arg : undefined,
    ]);
  };
  const messages = [msg('m-01'), msg('m-02'), msg('m-03')];
  const linked = () =>
    document
      .querySelector('[data-message-id="m-02"]')
      ?.getAttribute('data-linked');
  try {
    renderPane({ messages, focus: 'm-01' });
    expect(scrolled).toEqual([]);
    cleanup();
    renderPane({ messages, focus: 'm-02' });
  } finally {
    Element.prototype.scrollIntoView = original;
  }
  expect(scrolled).toEqual([['m-02', { block: 'center' }]]);
  expect(linked()).toBe('true');
});

test('the mark fades, and a later link back to the same message marks it again', async () => {
  const messages = [msg('m-01'), msg('m-02'), msg('m-03')];
  const pane = (focus: string) => (
    <ThreadPane
      messages={messages}
      deliveries={[]}
      focus={focus}
      me={ME}
      openIds={new Set()}
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
      onReply={() => Promise.resolve()}
      onOverseerReply={() => Promise.resolve()}
      overseerBusy={false}
      onOpenOverseer={() => {}}
    />
  );
  const marked = () =>
    document
      .querySelector('[data-linked="true"]')
      ?.getAttribute('data-message-id') ?? null;
  const { rerender } = render(pane('m-02'));
  expect(marked()).toBe('m-02');
  await waitFor(() => expect(marked()).toBeNull(), { timeout: 3000 });
  rerender(pane('m-01'));
  rerender(pane('m-02'));
  expect(marked()).toBe('m-02');
});
