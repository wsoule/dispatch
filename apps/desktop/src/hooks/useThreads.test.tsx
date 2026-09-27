import type {
  AgentSummary,
  ApiClient,
  MailboxItem,
  Message,
  ThreadDetail,
} from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';

import { agentRosterKey } from '../lib/agentRoster';
import type { MessageAccess } from '../lib/daemonAuth';
import {
  applyThreadEvent,
  threadKey,
  threadListsKey,
  useAgentRoster,
  useChannels,
  useTaskThreads,
  useThread,
  useThreadActions,
  useThreadRail,
} from './useThreads';

const PORT = 4000;
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
const stale = (qc: QueryClient, key: readonly unknown[]) =>
  qc.getQueryState(key)?.isInvalidated === true;
const ME = 'human:wyat';
const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};
const TEAMMATE: MessageAccess = {
  canDecide: false,
  canMessage: true,
  explanation: 'needs decide',
};
const AGENT_WINDOW: MessageAccess = {
  canDecide: false,
  canMessage: false,
  explanation: 'cannot message',
};

describe('applyThreadEvent', () => {
  it('appends once to a cached thread and ignores an uncached one', () => {
    const qc = new QueryClient();
    const root = msg('m-01');
    qc.setQueryData<ThreadDetail>(threadKey(PORT, 'm-01'), {
      messages: [root],
      deliveries: [],
    });
    const reply = msg('m-02', { thread: 'm-01', replyTo: 'm-01' });
    applyThreadEvent(qc, PORT, { type: 'message.new', message: reply });
    applyThreadEvent(qc, PORT, { type: 'message.new', message: reply });
    const cached = qc.getQueryData<ThreadDetail>(threadKey(PORT, 'm-01'));
    expect(cached?.messages.map((m) => m.id)).toEqual(['m-01', 'm-02']);
    expect(cached?.messages[0]).toBe(root);
    applyThreadEvent(qc, PORT, { type: 'message.new', message: msg('m-05') });
    expect(qc.getQueryData(threadKey(PORT, 'm-05'))).toBeUndefined();
  });

  it('marks the lists stale on a new message or a delivery change, and everything on reconnect', () => {
    const qc = new QueryClient();
    const mailbox = [...threadListsKey(PORT), 'rail', 'human:wyat', 'mailbox'];
    qc.setQueryData(mailbox, { items: [] });
    qc.setQueryData(threadKey(PORT, 'm-01'), { messages: [], deliveries: [] });
    applyThreadEvent(qc, PORT, {
      type: 'delivery.changed',
      deliveryId: 'd-1',
      messageId: 'm-1',
    });
    expect(stale(qc, mailbox)).toBe(true);
    expect(stale(qc, threadKey(PORT, 'm-01'))).toBe(false);
    applyThreadEvent(qc, PORT, { type: 'hello', version: '0.0.1' });
    expect(stale(qc, threadKey(PORT, 'm-01'))).toBe(true);
  });
});

describe('useThreadActions.answer', () => {
  const approval = msg('m-a', {
    from: 'agent:dispatch',
    kind: 'question',
    blocking: true,
    choices: ['approve', 'approve-session', 'deny'],
    data: {
      type: 'tool-approval',
      requestId: 'req-1',
      runId: 'r-1',
      tool: 'Bash',
      input: {},
    },
  });
  const scope = msg('m-s', {
    kind: 'question',
    blocking: true,
    choices: ['grant', 'deny'],
    data: { type: 'scope', paths: ['a.ts'], reason: 'r' },
  });
  const wake = msg('m-w', {
    from: 'agent:dispatch',
    kind: 'question',
    blocking: true,
    choices: ['approve', 'deny'],
    data: { type: 'wake', target: 'task:t-000002', message: 'm-x' },
  });
  const question = msg('m-q', {
    kind: 'question',
    blocking: true,
    choices: ['old', 'new'],
  });

  function setup(access: MessageAccess) {
    const client = {
      replyToMessage: mock(() =>
        Promise.resolve({
          message: question,
          deliveries: [],
          downgraded: false,
        })
      ),
    };
    const handlers = {
      handleApprove: mock(() => Promise.resolve()),
      handleDecideScopeRequest: mock(() => Promise.resolve()),
    };
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () =>
        useThreadActions(
          client as unknown as ApiClient,
          PORT,
          'human:wyat',
          access,
          handlers
        ),
      { wrapper }
    );
    return { client, handlers, actions: result.current };
  }

  it("sends a run's gates through the run-gate handlers and every other answer as a reply", async () => {
    const { client, handlers, actions } = setup(DECIDER);
    await actions.answer(approval, { body: '', choice: 'approve-session' });
    expect(handlers.handleApprove).toHaveBeenCalledWith('r-1', 'req-1', true, {
      scope: 'session',
    });
    await actions.answer(scope, { body: '', choice: 'deny' });
    expect(handlers.handleDecideScopeRequest).toHaveBeenCalledWith(
      'r-000001',
      'm-s',
      false,
      undefined
    );
    await actions.answer(wake, { body: '', choice: 'approve' });
    expect(client.replyToMessage).toHaveBeenCalledWith('m-w', {
      body: '',
      choice: 'approve',
    });
  });

  it('refuses a gate answer without decide, and lets a teammate answer a question put to them', async () => {
    const { client, actions } = setup(TEAMMATE);
    const refused = await actions
      .answer(wake, { body: '', choice: 'approve' })
      .then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
      );
    expect(refused).toBe('needs decide');
    await actions.answer(question, { body: 'new', choice: 'new' });
    expect(client.replyToMessage).toHaveBeenCalledWith('m-q', {
      body: 'new',
      choice: 'new',
    });
  });
});

// A client that answers every messaging read from fixed rows and records each call.
function readingClient() {
  const calls: string[] = [];
  const question = msg('m-q', {
    kind: 'question',
    blocking: true,
    choices: ['old', 'new'],
  });
  const mailbox: MailboxItem[] = [
    {
      message: question,
      delivery: {
        id: 'd-q',
        messageId: 'm-q',
        recipient: ME,
        runId: null,
        via: 'direct',
        state: 'notified',
        updatedAt: question.createdAt,
      },
    },
  ];
  const roster: AgentSummary[] = [
    {
      address: 'agent:wyat/codex',
      displayName: 'codex',
      client: 'codex',
      status: 'approved',
      muted: false,
      approvedBy: ME,
      createdAt: '2026-09-25T10:00:00.000Z',
    },
  ];
  const client = {
    getMailbox: (address?: string) => {
      calls.push(`mailbox ${address}`);
      return Promise.resolve({ items: mailbox });
    },
    listRecentThreads: (limit?: number, opts?: { about?: string }) => {
      calls.push(['recent', limit, opts?.about].filter(Boolean).join(' '));
      return Promise.resolve({ threads: [] });
    },
    openDecisions: () => {
      calls.push('open gates');
      return Promise.resolve({ items: [] });
    },
    getMessage: (id: string) => {
      calls.push(`message ${id}`);
      return Promise.resolve(msg(id, { thread: 'm-01' }));
    },
    getThread: (id: string) => {
      calls.push(`thread ${id}`);
      return Promise.resolve({
        messages: [msg('m-01'), msg('m-02', { thread: 'm-01' })],
        deliveries: [],
      });
    },
    listAgentRoster: () => {
      calls.push('roster');
      return Promise.resolve({ agents: roster });
    },
    listChannels: () => {
      calls.push('channels');
      return Promise.resolve({
        channels: [{ name: 'general', auto: false, members: [] }],
      });
    },
  };
  return { calls, client: client as unknown as ApiClient };
}

function mount<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(hook, { wrapper }) };
}

describe('messaging queries', () => {
  it('reads only the mailbox for a teammate below decide, and finds their open question there', async () => {
    const { calls, client } = readingClient();
    const { result } = mount(() => useThreadRail(client, PORT, ME, TEAMMATE));
    await waitFor(() => {
      expect(result.current.groups['needs-you'].map((t) => t.thread)).toEqual([
        'm-q',
      ]);
    });
    expect(calls).toEqual([`mailbox ${ME}`]);
  });

  it('adds recent threads and the open gates for a decider, and asks nothing for an agent window', async () => {
    const agent = readingClient();
    const idle = mount(() =>
      useThreadRail(agent.client, PORT, ME, AGENT_WINDOW)
    );
    const decider = readingClient();
    mount(() => useThreadRail(decider.client, PORT, ME, DECIDER));
    await waitFor(() => {
      expect([...decider.calls].sort()).toEqual([
        `mailbox ${ME}`,
        'open gates',
        'recent 100',
      ]);
    });
    expect(agent.calls).toEqual([]);
    expect(idle.result.current.summaries).toEqual([]);
  });

  it("asks about a task's threads for a decider only", async () => {
    const teammate = readingClient();
    mount(() =>
      useTaskThreads(teammate.client, PORT, ME, TEAMMATE, 't-000001')
    );
    const decider = readingClient();
    mount(() => useTaskThreads(decider.client, PORT, ME, DECIDER, 't-000001'));
    await waitFor(() => {
      expect(decider.calls).toContain('recent 50 task:t-000001');
    });
    expect(teammate.calls).toEqual([]);
  });

  it('opens the thread holding any of its messages', async () => {
    const { calls, client } = readingClient();
    const { result } = mount(() => useThread(client, PORT, 'm-02'));
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm-01',
        'm-02',
      ]);
    });
    expect(result.current.thread).toBe('m-01');
    expect(calls).toEqual(['message m-02', 'thread m-01']);
  });

  it('reads the roster on the key Settings shares, and channels only when asked', async () => {
    const { calls, client } = readingClient();
    const { qc, result } = mount(() => ({
      roster: useAgentRoster(client, PORT),
      hidden: useChannels(client, PORT, false),
      channels: useChannels(client, PORT + 1, true),
    }));
    await waitFor(() => {
      expect(result.current.channels.map((c) => c.name)).toEqual(['general']);
    });
    expect(result.current.roster.map((a) => a.address)).toEqual([
      'agent:wyat/codex',
    ]);
    expect(
      qc.getQueryData<{ agents: AgentSummary[] }>(agentRosterKey(PORT))
    ).toEqual({
      agents: result.current.roster,
    });
    expect(result.current.hidden).toEqual([]);
    expect([...calls].sort()).toEqual(['channels', 'roster']);
  });
});
