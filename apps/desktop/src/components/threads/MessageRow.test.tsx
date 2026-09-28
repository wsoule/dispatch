import type { AgentSummary, Message } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DecideAvailability, MessageAccess } from '../../lib/daemonAuth';
import { proposal } from '../../lib/memory.test-helper';
import type { ParkedCall } from '../../lib/threadSources';
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

// A client with only the calls a test gives it; any other call fails the test.
function clientWith(
  calls: Partial<NonNullable<MessageRowProps['client']>>
): NonNullable<MessageRowProps['client']> {
  const missing = (name: string) => () =>
    Promise.reject(new Error(`unexpected ${name} call`));
  return {
    declineA2ATask: missing('declineA2ATask'),
    getMemoryProposal: missing('getMemoryProposal'),
    ...calls,
  };
}

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
      loadApprovalInput={() => Promise.resolve(undefined)}
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

test('holds the choices while an answer is in flight, so a double click answers once', async () => {
  const q = msg('m-q', {
    kind: 'question',
    blocking: true,
    choices: ['Mapbox', 'Leaflet'],
  });
  let settle = () => {};
  const onAnswer = mock(
    (_m: Message, _r: { body: string; choice?: string }) =>
      new Promise<void>((resolve) => {
        settle = resolve;
      })
  );
  renderRow(q, { onAnswer });
  fireEvent.click(screen.getByRole('button', { name: 'Mapbox' }));
  const sending = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Sending…',
  });
  expect(sending.disabled).toBe(true);
  const other = screen.getByRole<HTMLButtonElement>('button', {
    name: 'Leaflet',
  });
  expect(other.disabled).toBe(true);
  fireEvent.click(sending);
  fireEvent.click(other);
  expect(onAnswer).toHaveBeenCalledTimes(1);
  settle();
  await waitFor(() =>
    expect(
      screen.getByRole<HTMLButtonElement>('button', { name: 'Mapbox' }).disabled
    ).toBe(false)
  );
  expect(screen.queryByRole('alert')).toBeNull();
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

test('a truncated tool call loads its full input for a decider, from its run or its Assistant conversation', async () => {
  const approval = (parkedOn: { runId: string } | { conversation: string }) =>
    msg('m-a', {
      from: 'agent:dispatch',
      kind: 'question',
      blocking: true,
      choices: ['approve', 'approve-session', 'deny'],
      data: {
        type: 'tool-approval',
        requestId: 'req-1',
        ...parkedOn,
        tool: 'Bash',
        input: '{"command":"rm -rf build/',
        truncated: true,
        floor: false,
      },
    });
  const loadApprovalInput = mock((_call: ParkedCall) =>
    Promise.resolve({ command: 'rm -rf build/tmp' })
  );
  renderRow(approval({ runId: 'r-000001' }), { loadApprovalInput });
  await waitFor(() =>
    expect(screen.getByText(/rm -rf build\/tmp/)).toBeTruthy()
  );
  expect(loadApprovalInput).toHaveBeenCalledWith({
    runId: 'r-000001',
    requestId: 'req-1',
  });
  expect(screen.queryByText(/Preview truncated/)).toBeNull();
  cleanup();

  renderRow(approval({ conversation: 'o-000001' }), { loadApprovalInput });
  await waitFor(() =>
    expect(screen.getByText(/rm -rf build\/tmp/)).toBeTruthy()
  );
  expect(loadApprovalInput).toHaveBeenLastCalledWith({
    conversation: 'o-000001',
    requestId: 'req-1',
  });
  expect(screen.queryByText(/Preview truncated/)).toBeNull();
});

test('badges a custom kind by its name, as the run chat does', () => {
  renderRow(msg('m-x', { kind: 'x-review', body: 'looks fine' }), {
    open: false,
  });
  expect(screen.getByText('x-review')).toBeTruthy();
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

test('a doc ref chip names its whole section and opens the doc there', () => {
  const onOpen = mock((_action: unknown) => {});
  renderRow(
    msg('m-d', { refs: [{ type: 'doc', id: 'doc-01K', at: 'auth-flow' }] }),
    { onOpen, open: false }
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'doc:doc-01K#auth-flow' })
  );
  expect(onOpen).toHaveBeenCalledWith({
    kind: 'doc',
    docId: 'doc-01K',
    anchor: 'auth-flow',
  });
});

test('badges a close from Dispatch as Closed, and a client’s look-alike as the plain answer it is', () => {
  const system = msg('m-c', {
    from: 'agent:dispatch',
    kind: 'answer',
    replyTo: 'm-q',
    body: 'canceled by the client',
    data: { type: 'x-closed' },
  });
  renderRow(system, { open: false });
  expect(screen.getByText('Closed')).toBeTruthy();
  cleanup();
  const lookalike = msg('m-f', {
    from: 'agent:wyat/a2a.acme',
    kind: 'answer',
    replyTo: 'm-q',
    body: 'closing this',
    data: { type: 'x-closed' },
  });
  renderRow(lookalike, { open: false });
  expect(screen.queryByText('Closed')).toBeNull();
  expect(screen.getByText('Answer')).toBeTruthy();
  expect(screen.getByText('closing this')).toBeTruthy();
});

test('badges a breaker pause from Dispatch as Breaker', () => {
  renderRow(
    msg('m-b', {
      from: 'agent:dispatch',
      kind: 'notice',
      body: 'paused',
      data: { type: 'x-breaker' },
    }),
    { open: false }
  );
  expect(screen.getByText('Breaker')).toBeTruthy();
  expect(screen.queryByText('Notice')).toBeNull();
});

test('offers Decline on an open question from an A2A client, and not once it is answered', async () => {
  const declineA2ATask = mock((_id: string, _reason?: string) =>
    Promise.resolve({})
  );
  const ask = msg('m-q', {
    from: 'agent:wyat/a2a.acme',
    kind: 'question',
    blocking: true,
    body: 'Is /sessions final?',
  });
  renderRow(ask, { client: clientWith({ declineA2ATask }) });
  fireEvent.click(screen.getByRole('button', { name: 'Decline' }));
  fireEvent.click(screen.getByRole('button', { name: 'Decline question' }));
  await waitFor(() =>
    expect(declineA2ATask).toHaveBeenCalledWith('m-q', undefined)
  );
  cleanup();
  renderRow(ask, { client: clientWith({ declineA2ATask }), open: false });
  expect(screen.queryByRole('button', { name: 'Decline' })).toBeNull();
});

test('shows a decider the memory proposal, and answers its gate with the choice', async () => {
  const getMemoryProposal = mock((_id: string) =>
    Promise.resolve({ proposal: proposal(), base: null, current: null })
  );
  const gate = msg('m-mem', {
    from: 'agent:dispatch',
    kind: 'question',
    blocking: true,
    choices: ['approve', 'reject'],
    body: 'run:r-9f2c01 proposes a team memory (hazard). Review it in Needs you.',
    data: {
      type: 'memory',
      proposalId: 'mp-000001',
      action: 'add',
      scope: 'team',
      kind: 'hazard',
    },
  });
  const onAnswer = renderRow(gate, {
    client: clientWith({ getMemoryProposal }),
  });
  await screen.findByText('pnpm 11 ignores onlyBuiltDependencies');
  expect(getMemoryProposal).toHaveBeenCalledWith('mp-000001');
  expect(screen.queryByRole('button', { name: 'approve' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'Approve' }));
  await waitFor(() =>
    expect(onAnswer).toHaveBeenCalledWith(gate, {
      body: '',
      choice: 'approve',
    })
  );
});

test('a ref of a type this build does not register is plain text, not a link', () => {
  renderRow(msg('m-w', { refs: [{ type: 'wiki', id: 'handbook' }] }), {
    open: false,
  });
  expect(screen.getByText('wiki:handbook')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'wiki:handbook' })).toBeNull();
});
