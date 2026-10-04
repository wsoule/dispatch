import type {
  AgentSummary,
  ApiClient,
  Delivery,
  DeliveryState,
  MailboxItem,
  Message,
  SendInput,
  ThreadDetail,
} from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, mock } from 'bun:test';
import type { ReactNode } from 'react';

import { agentRosterKey } from '../lib/agentRoster';
import type { MessageAccess } from '../lib/daemonAuth';
import { openGatesKey } from '../lib/gates';
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
  useThreadsNeedsYouCount,
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

  it('keeps a message that arrives while the thread is first fetched', async () => {
    const server = gatedThreadServer();
    server.gated = true;
    const { qc, result } = mount(() =>
      useThread(server.client, PORT, 'm-01', DECIDER)
    );
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.post(qc, msg('m-02', { thread: 'm-01', replyTo: 'm-01' }));
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm-01',
        'm-02',
      ]);
    });
    expect(result.current.error).toBeNull();
  });

  it('keeps a message that arrives during a background refetch of the open thread', async () => {
    const server = gatedThreadServer();
    const { qc, result } = mount(() =>
      useThread(server.client, PORT, 'm-01', DECIDER)
    );
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['m-01']);
    });
    server.gated = true;
    applyThreadEvent(qc, PORT, { type: 'hello', version: '0.0.1' });
    await waitFor(() => {
      expect(server.pending).toHaveLength(1);
    });
    server.post(qc, msg('m-02', { thread: 'm-01', replyTo: 'm-01' }));
    server.gated = false;
    server.release();
    await waitFor(() => {
      expect(qc.isFetching()).toBe(0);
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm-01',
        'm-02',
      ]);
    });
  });

  it("keeps an open thread's deliveries current, so a message that arrived live can be marked read", async () => {
    const server = gatedThreadServer();
    const { qc, result } = mount(() =>
      useThread(server.client, PORT, 'm-01', DECIDER)
    );
    await waitFor(() => {
      expect(result.current.messages).toHaveLength(1);
    });
    const root = result.current.messages[0];
    server.post(qc, msg('m-02', { thread: 'm-01', replyTo: 'm-01' }));
    server.deliver(qc, 'm-02', 'notified');
    const states = () =>
      result.current.deliveries.map((d) => `${d.id} ${d.state}`);
    await waitFor(() => {
      expect(states()).toEqual(['d-m-02 notified']);
    });
    server.deliver(qc, 'm-02', 'read');
    await waitFor(() => {
      expect(states()).toEqual(['d-m-02 read']);
    });
    expect(result.current.messages[0]).toBe(root);
  });

  it('marks the lists stale on a new message or a delivery change, and everything on reconnect', () => {
    const qc = new QueryClient();
    const mailbox = [...threadListsKey(PORT), 'mailbox', ME];
    qc.setQueryData(mailbox, { items: [] });
    qc.setQueryData(threadKey(PORT, 'm-01'), { messages: [], deliveries: [] });
    applyThreadEvent(qc, PORT, { type: 'message.new', message: msg('m-07') });
    expect(stale(qc, mailbox)).toBe(true);
    qc.setQueryData(mailbox, { items: [] });
    expect(stale(qc, mailbox)).toBe(false);
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

  it('on reconnect also refetches the open gates and the roster, which a daemon restart may have changed unseen', () => {
    const qc = new QueryClient();
    qc.setQueryData(openGatesKey(PORT), { items: [] });
    qc.setQueryData(agentRosterKey(PORT), { agents: [] });
    qc.setQueryData(openGatesKey(PORT + 1), { items: [] });
    applyThreadEvent(qc, PORT, { type: 'hello', version: '0.0.1' });
    expect(stale(qc, openGatesKey(PORT))).toBe(true);
    expect(stale(qc, agentRosterKey(PORT))).toBe(true);
    expect(stale(qc, openGatesKey(PORT + 1))).toBe(false);
  });
});

describe('useThreadActions', () => {
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
    const sent = () =>
      Promise.resolve({ message: question, deliveries: [], downgraded: false });
    const client = {
      replyToMessage: mock(sent),
      sendMessage: mock(sent),
      markDeliveryRead: mock((id: string) => Promise.resolve({ id })),
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

  it('denies a tool call on deny, and approves nothing without an approve choice', async () => {
    const { handlers, actions } = setup(DECIDER);
    await actions.answer(approval, { body: 'too broad', choice: 'deny' });
    expect(handlers.handleApprove).toHaveBeenCalledWith('r-1', 'req-1', false, {
      scope: 'once',
      reason: 'too broad',
    });
    const failed = (choice?: string) =>
      actions
        .answer(approval, { body: '', ...(choice ? { choice } : {}) })
        .then(
          () => 'resolved',
          () => 'rejected'
        );
    expect(await failed()).toBe('rejected');
    expect(await failed('maybe')).toBe('rejected');
    expect(handlers.handleApprove).toHaveBeenCalledTimes(1);
  });

  it('sends a draft as its send input, under the idempotency key its draft holds', async () => {
    const { client, actions } = setup(DECIDER);
    const draft = {
      to: ['task:t-000001'],
      body: ' ship it? ',
      kind: 'question' as const,
      urgent: false,
      wake: true,
    };
    await actions.send(draft, 'k-draft-1');
    // The same text sent again as a new draft is a new message, not a replay.
    await actions.send(draft, 'k-draft-2');
    const calls = client.sendMessage.mock.calls as unknown as [
      SendInput,
      { idempotencyKey: string },
    ][];
    expect(calls[0]?.[0]).toEqual({
      to: ['task:t-000001'],
      kind: 'question',
      body: 'ship it?',
      blocking: true,
      wake: 'request',
    });
    expect(calls.map(([, opts]) => opts.idempotencyKey)).toEqual([
      'k-draft-1',
      'k-draft-2',
    ]);
  });

  it('answers the target of a reply plan, and sends a send plan as a plain message beside its replyTo, both keyed', async () => {
    const { client, actions } = setup(DECIDER);
    await actions.reply({ kind: 'reply', target: msg('m-01') }, 'on it', 'k-1');
    expect(client.sendMessage).toHaveBeenCalledWith(
      {
        to: ['run:r-000001'],
        kind: 'answer',
        body: 'on it',
        replyTo: 'm-01',
      },
      { idempotencyKey: 'k-1' }
    );
    expect(client.replyToMessage).not.toHaveBeenCalled();
    await actions.reply(
      { kind: 'send', to: ['channel:general'], replyTo: 'm-01' },
      'noted',
      'k-2'
    );
    expect(client.sendMessage).toHaveBeenCalledWith(
      {
        to: ['channel:general'],
        kind: 'message',
        body: 'noted',
        replyTo: 'm-01',
      },
      { idempotencyKey: 'k-2' }
    );
  });

  it('sends and replies nothing from a window that cannot message, and says why', async () => {
    const { client, actions } = setup(AGENT_WINDOW);
    const outcome = (p: Promise<unknown>) =>
      p.then(
        () => 'resolved',
        (err: unknown) => (err instanceof Error ? err.message : 'not an Error')
      );
    expect(
      await outcome(
        actions.send(
          {
            to: ['task:t-000001'],
            body: 'hi',
            kind: 'message',
            urgent: false,
            wake: false,
          },
          'k-1'
        )
      )
    ).toBe('cannot message');
    expect(
      await outcome(
        actions.reply({ kind: 'reply', target: msg('m-01') }, 'x', 'k-2')
      )
    ).toBe('cannot message');
    expect(client.sendMessage).not.toHaveBeenCalled();
    expect(client.replyToMessage).not.toHaveBeenCalled();
  });

  it('marks only my unread deliveries read, and nothing from an agent window', () => {
    const delivery = (
      id: string,
      state: DeliveryState,
      recipient = ME
    ): Delivery => ({
      id,
      messageId: 'm-01',
      recipient,
      runId: null,
      via: 'direct',
      state,
      updatedAt: '2026-09-25T10:00:00.000Z',
    });
    const deliveries = [
      delivery('d-held', 'held'),
      delivery('d-notified', 'notified'),
      delivery('d-pushed', 'pushed'),
      delivery('d-read', 'read'),
      delivery('d-answered', 'answered'),
      delivery('d-ada', 'notified', 'human:ada'),
    ];
    const decider = setup(DECIDER);
    decider.actions.markRead(deliveries);
    expect(
      decider.client.markDeliveryRead.mock.calls.map(([id]) => id)
    ).toEqual(['d-held', 'd-notified', 'd-pushed']);
    const agentWindow = setup(AGENT_WINDOW);
    agentWindow.actions.markRead(deliveries);
    expect(agentWindow.client.markDeliveryRead).not.toHaveBeenCalled();
  });

  it('marks a delivery read once while its mark is in flight, and again only if that mark failed', async () => {
    const { client, actions } = setup(DECIDER);
    const unread = (id: string): Delivery => ({
      id,
      messageId: 'm-01',
      recipient: ME,
      runId: null,
      via: 'direct',
      state: 'notified',
      updatedAt: '2026-09-25T10:00:00.000Z',
    });
    const deliveries = [unread('d-1'), unread('d-2')];
    client.markDeliveryRead.mockImplementationOnce(() =>
      Promise.reject(new Error('daemon unreachable'))
    );
    actions.markRead(deliveries);
    actions.markRead(deliveries);
    const marked = () => client.markDeliveryRead.mock.calls.map(([id]) => id);
    expect(marked()).toEqual(['d-1', 'd-2']);
    // Still unread in a stale thread: only the failed mark goes again.
    await waitFor(() => {
      actions.markRead(deliveries);
      expect(marked()).toEqual(['d-1', 'd-2', 'd-1']);
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

// One thread on a fake daemon: each getThread answers with the rows stored when
// it was asked, held back while `gated` until the test releases it.
function gatedThreadServer() {
  const rows: Message[] = [msg('m-01')];
  const deliveries = new Map<string, Delivery>();
  const pending: (() => void)[] = [];
  const server = {
    gated: false,
    pending,
    client: {
      getMessage: (id: string) => Promise.resolve(msg(id, { thread: 'm-01' })),
      getThread: () => {
        const snapshot: ThreadDetail = {
          messages: [...rows],
          deliveries: [...deliveries.values()],
        };
        if (!server.gated) return Promise.resolve(snapshot);
        return new Promise<ThreadDetail>((resolve) => {
          pending.push(() => resolve(snapshot));
        });
      },
    } as unknown as ApiClient,
    // Stores a message, then announces it the way the daemon does: after commit.
    post(qc: QueryClient, message: Message) {
      rows.push(message);
      applyThreadEvent(qc, PORT, { type: 'message.new', message });
    },
    // Stores a delivery's new state, then signals it as delivery.changed.
    deliver(qc: QueryClient, messageId: string, state: DeliveryState) {
      const id = `d-${messageId}`;
      deliveries.set(id, {
        id,
        messageId,
        recipient: ME,
        runId: null,
        via: 'direct',
        state,
        updatedAt: '2026-09-25T10:00:00.000Z',
      });
      applyThreadEvent(qc, PORT, {
        type: 'delivery.changed',
        deliveryId: id,
        messageId,
      });
    },
    release() {
      for (const resolve of pending.splice(0)) resolve();
    },
  };
  return server;
}

// A teammate's mailbox holding a gate they cannot answer and a muted agent's question.
function quietMailboxClient(): ApiClient {
  const gate = msg('m-g', {
    kind: 'question',
    blocking: true,
    choices: ['grant', 'deny'],
    data: { type: 'scope', paths: ['a.ts'], reason: 'needed' },
  });
  const muted = msg('m-m', {
    from: 'agent:wyat/quiet',
    kind: 'question',
    blocking: true,
  });
  const mailbox: MailboxItem[] = [gate, muted].map((message) => ({
    message,
    delivery: {
      id: `d-${message.id}`,
      messageId: message.id,
      recipient: ME,
      runId: null,
      via: 'direct',
      state: 'notified',
      updatedAt: message.createdAt,
    },
  }));
  const quiet: AgentSummary = {
    address: 'agent:wyat/quiet',
    displayName: 'quiet',
    client: 'codex',
    status: 'approved',
    muted: true,
    approvedBy: ME,
    createdAt: '2026-09-25T10:00:00.000Z',
  };
  return {
    getMailbox: () => Promise.resolve({ items: mailbox }),
    listAgentRoster: () => Promise.resolve({ agents: [quiet] }),
  } as unknown as ApiClient;
}

function mount<T>(hook: () => T) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return { qc, ...renderHook(hook, { wrapper }) };
}

describe('messaging queries', () => {
  it('reads only the mailbox and roster for a teammate below decide, and finds their open question there', async () => {
    const { calls, client } = readingClient();
    const { result } = mount(() => useThreadRail(client, PORT, ME, TEAMMATE));
    await waitFor(() => {
      expect(result.current.groups['needs-you'].map((t) => t.thread)).toEqual([
        'm-q',
      ]);
    });
    expect([...calls].sort()).toEqual([`mailbox ${ME}`, 'roster']);
  });

  it("keeps a gate a teammate cannot answer and a muted agent's question out of Needs you, readable in Direct", async () => {
    const client = quietMailboxClient();
    const { result } = mount(() => useThreadRail(client, PORT, ME, TEAMMATE));
    await waitFor(() => {
      expect(result.current.groups.direct.map((t) => t.thread).sort()).toEqual([
        'm-g',
        'm-m',
      ]);
    });
    expect(result.current.groups['needs-you']).toEqual([]);
    // Both rows still open, so the gate shows its reason and the question its answer.
    expect([...result.current.openIds].sort()).toEqual(['m-g', 'm-m']);
  });

  it("counts neither a gate a teammate cannot answer nor a muted agent's question, as the rail shows", async () => {
    const client = quietMailboxClient();
    // One cache, so the count has read everything once the rail shows both rows.
    const { result } = mount(() => ({
      count: useThreadsNeedsYouCount(client, PORT, ME, TEAMMATE),
      rail: useThreadRail(client, PORT, ME, TEAMMATE),
    }));
    await waitFor(() => {
      expect(result.current.rail.groups.direct).toHaveLength(2);
    });
    expect(result.current.count).toBe(0);
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
        'roster',
      ]);
    });
    expect(agent.calls).toEqual([]);
    expect(idle.result.current.summaries).toEqual([]);
  });

  // The sidebar is on every screen, so its count must not keep the recent list alive.
  it('counts Needs you for the sidebar without the recent threads', async () => {
    const decider = readingClient();
    const { result } = mount(() =>
      useThreadsNeedsYouCount(decider.client, PORT, ME, DECIDER)
    );
    await waitFor(() => {
      expect(result.current).toBe(1);
    });
    expect([...decider.calls].sort()).toEqual([
      `mailbox ${ME}`,
      'open gates',
      'roster',
    ]);
  });

  it('counts nothing and asks nothing in a window that cannot message', async () => {
    const agent = readingClient();
    const { result } = mount(() =>
      useThreadsNeedsYouCount(agent.client, PORT, ME, AGENT_WINDOW)
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(result.current).toBe(0);
    expect(agent.calls).toEqual([]);
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

  it("treats a handoff put to me in a task's thread as open, as the rail does", async () => {
    const handoff = msg('m-h', {
      kind: 'handoff',
      choices: ['accept', 'decline'],
    });
    const elsewhere = msg('m-x', { kind: 'handoff' });
    const mailbox: MailboxItem[] = [handoff, elsewhere].map((message) => ({
      message,
      delivery: {
        id: `d-${message.id}`,
        messageId: message.id,
        recipient: ME,
        runId: null,
        via: 'direct',
        state: 'notified',
        updatedAt: message.createdAt,
      },
    }));
    const client = {
      getMailbox: () => Promise.resolve({ items: mailbox }),
      listRecentThreads: () =>
        Promise.resolve({
          threads: [{ thread: 'm-h', root: handoff, last: handoff, count: 1 }],
        }),
      openDecisions: () => Promise.resolve({ items: [] }),
    } as unknown as ApiClient;
    const tab = mount(() =>
      useTaskThreads(client, PORT, ME, DECIDER, 't-000001')
    );
    const rail = mount(() => useThreadRail(client, PORT, ME, DECIDER));
    await waitFor(() => {
      expect([...tab.result.current.openIds]).toEqual(['m-h']);
      expect(rail.result.current.openIds.has('m-h')).toBe(true);
    });
    expect(tab.result.current.summaries.map((t) => t.thread)).toEqual(['m-h']);
  });

  it('opens the thread holding any of its messages', async () => {
    const { calls, client } = readingClient();
    const { result } = mount(() => useThread(client, PORT, 'm-02', TEAMMATE));
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm-01',
        'm-02',
      ]);
    });
    expect(result.current.thread).toBe('m-01');
    expect(calls).toEqual(['message m-02', 'thread m-01']);
  });

  it('says at once when a linked thread cannot be read or is gone, without retrying', async () => {
    const calls: string[] = [];
    const client = {
      getMessage: (id: string) => {
        calls.push(`message ${id}`);
        return id === 'm-gone'
          ? Promise.resolve(msg(id))
          : Promise.reject(new ApiError(`cannot read message ${id}`, 403));
      },
      getThread: (id: string) => {
        calls.push(`thread ${id}`);
        return Promise.reject(new ApiError(`no thread ${id}`, 404));
      },
    } as unknown as ApiClient;
    // The app's client keeps TanStack's default of three retries.
    const qc = new QueryClient();
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const hidden = renderHook(
      () => useThread(client, PORT, 'm-hidden', TEAMMATE),
      { wrapper }
    );
    const gone = renderHook(() => useThread(client, PORT, 'm-gone', TEAMMATE), {
      wrapper,
    });
    await waitFor(() => {
      expect(hidden.result.current.error?.message).toBe(
        'cannot read message m-hidden'
      );
      expect(gone.result.current.error?.message).toBe('no thread m-gone');
    });
    // m-hidden is also tried as a thread id once, which fails the same way.
    expect([...calls].sort()).toEqual([
      'message m-gone',
      'message m-hidden',
      'thread m-gone',
      'thread m-hidden',
    ]);
  });

  it('opens a thread by its root id when the root is one a teammate cannot read but the thread is', async () => {
    // A rail row names its thread by the root, which a teammate pulled in
    // by a later reply never held.
    const calls: string[] = [];
    const client = {
      getMessage: (id: string) => {
        calls.push(`message ${id}`);
        return Promise.reject(new ApiError(`cannot read message ${id}`, 403));
      },
      getThread: (id: string) => {
        calls.push(`thread ${id}`);
        return Promise.resolve({
          messages: [msg('m-root'), msg('m-02', { thread: 'm-root' })],
          deliveries: [],
        });
      },
    } as unknown as ApiClient;
    const { result } = mount(() => useThread(client, PORT, 'm-root', TEAMMATE));
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual([
        'm-root',
        'm-02',
      ]);
    });
    expect(result.current.thread).toBe('m-root');
    expect(result.current.error).toBeNull();
  });

  it('tries a thread read again after a network blip, a daemon error or any refusal but 403 and 404', async () => {
    const messageFailures: Error[] = [
      new TypeError('Failed to fetch'),
      new ApiError('too many requests', 429),
    ];
    const threadFailures: Error[] = [new ApiError('daemon busy', 503)];
    const calls: string[] = [];
    const client = {
      getMessage: (id: string) => {
        calls.push(`message ${id}`);
        const failure = messageFailures.shift();
        return failure === undefined
          ? Promise.resolve(msg(id, { thread: 'm-01' }))
          : Promise.reject(failure);
      },
      getThread: (id: string) => {
        calls.push(`thread ${id}`);
        const failure = threadFailures.shift();
        return failure === undefined
          ? Promise.resolve({ messages: [msg('m-01')], deliveries: [] })
          : Promise.reject(failure);
      },
    } as unknown as ApiClient;
    const qc = new QueryClient({
      defaultOptions: { queries: { retryDelay: 0 } },
    });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={qc}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(
      () => useThread(client, PORT, 'm-02', TEAMMATE),
      { wrapper }
    );
    await waitFor(() => {
      expect(result.current.messages.map((m) => m.id)).toEqual(['m-01']);
    });
    expect(result.current.error).toBeNull();
    expect(calls).toEqual([
      'message m-02',
      'message m-02',
      'message m-02',
      'thread m-01',
      'thread m-01',
    ]);
  });

  it('opens no thread for an agent window, even with a focus from a link', async () => {
    const { calls, client } = readingClient();
    const agent = mount(() => useThread(client, PORT, 'm-02', AGENT_WINDOW));
    const decider = readingClient();
    mount(() => useThread(decider.client, PORT, 'm-02', DECIDER));
    await waitFor(() => {
      expect(decider.calls).toEqual(['message m-02', 'thread m-01']);
    });
    expect(calls).toEqual([]);
    expect(agent.result.current).toMatchObject({
      thread: null,
      messages: [],
      loading: false,
    });
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
