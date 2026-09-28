import type { ApiClient, Message } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { MessageAccess } from '../../lib/daemonAuth';
import { proposal } from '../../lib/memory.test-helper';
import { dataWith } from '../settings/fixtures.test-helper';
import { TaskThreadTab } from './TaskThreadTab';

const root: Message = {
  id: 'm-01',
  thread: 'm-01',
  replyTo: null,
  from: 'run:r-000001',
  to: ['human:wyat'],
  kind: 'message',
  body: 'Blocked on the cart schema',
  refs: [],
  urgent: false,
  blocking: false,
  wake: 'none',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};

function clientWith(threads: Message[]) {
  return {
    listRecentThreads: mock((_limit?: number, _opts?: { about?: string }) =>
      Promise.resolve({
        threads: threads.map((m) => ({
          thread: m.thread,
          root: m,
          last: m,
          count: 1,
        })),
      })
    ),
    getMailbox: mock(() => Promise.resolve({ items: [] })),
    openDecisions: mock(() => Promise.resolve({ items: [] })),
    getMessage: mock(() => Promise.resolve(root)),
    getThread: mock(() =>
      Promise.resolve({ messages: [root], deliveries: [] })
    ),
    sendMessage: mock(() =>
      Promise.resolve({
        message: { ...root, id: 'm-02', thread: 'm-02' },
        deliveries: [],
        downgraded: false,
      })
    ),
    markDeliveryRead: mock(() => Promise.resolve({})),
    listChannels: mock(() => Promise.resolve({ channels: [] })),
    listAgentRoster: mock(() => Promise.resolve({ agents: [] })),
  };
}

function renderTab(
  client: ReturnType<typeof clientWith>,
  access: MessageAccess = DECIDER
) {
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: 'human:wyat',
    messageAccess: access,
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    tasks: [{ meta: { id: 't-000001', title: 'Checkout' } }] as never,
    runs: [{ id: 'r-000001', taskId: 't-000001' }] as never,
    presence: [],
  });
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={qc}>
      <TaskThreadTab
        data={data}
        taskId="t-000001"
        onOpenRef={() => {}}
        onOpenOverseer={() => {}}
      />
    </QueryClientProvider>
  );
  return { qc };
}

test("lists the task's threads, opens one, and sends to the task by default", async () => {
  const client = clientWith([root]);
  renderTab(client);

  const list = screen.getByRole('complementary', { name: 'Thread list' });
  fireEvent.click(
    await within(list).findByRole('option', {
      name: /Blocked on the cart schema/,
    })
  );
  expect(client.listRecentThreads).toHaveBeenCalledWith(50, {
    about: 'task:t-000001',
  });
  expect(await screen.findByLabelText('Reply')).toBeDefined();

  // With a thread open, a new message to the task waits behind its own button.
  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
  // The task is a recipient the draft cannot drop.
  expect(screen.getByText('t-000001 · Checkout')).toBeDefined();
  expect(
    screen.queryByRole('button', { name: 'Remove t-000001 · Checkout' })
  ).toBeNull();
  const box = screen.getByLabelText('New message');
  fireEvent.change(box, { target: { value: 'Use the new schema' } });
  fireEvent.keyDown(box, { key: 'Enter' });
  await waitFor(() =>
    expect(client.sendMessage).toHaveBeenCalledWith(
      {
        to: ['task:t-000001'],
        kind: 'message',
        body: 'Use the new schema',
        wake: 'request',
      },
      expect.anything()
    )
  );
  // The sent message's thread opens.
  await waitFor(() => expect(client.getMessage).toHaveBeenCalledWith('m-02'));
});

test('a task with no messages says so', async () => {
  renderTab(clientWith([]));
  expect(await screen.findByText('No messages yet.')).toBeDefined();
});

test('a window that cannot decide says why it lists nothing, and still writes to the task', () => {
  const client = clientWith([root]);
  renderTab(client, {
    canDecide: false,
    canMessage: true,
    explanation: 'Answering needs the decide tier.',
  });
  expect(
    screen.getByText(/Listing a task's threads needs the decide tier/)
  ).toBeDefined();
  expect(
    screen.getByText(/Ask the project owner for a decide token\./)
  ).toBeDefined();
  expect(client.listRecentThreads).not.toHaveBeenCalled();
  expect(client.getMailbox).not.toHaveBeenCalled();
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('New message').disabled
  ).toBe(false);
});

test('an attached agent-token window queries nothing and says why', () => {
  const client = clientWith([root]);
  renderTab(client, {
    canDecide: false,
    canMessage: false,
    explanation: 'This window cannot send messages.',
  });
  expect(screen.getByText('This window cannot send messages.')).toBeDefined();
  expect(screen.queryByLabelText('New message')).toBeNull();
  expect(client.listRecentThreads).not.toHaveBeenCalled();
  expect(client.getMailbox).not.toHaveBeenCalled();
  expect(client.openDecisions).not.toHaveBeenCalled();
  expect(client.listChannels).not.toHaveBeenCalled();
});

test('a failed refetch keeps the rows on screen and says why under them', async () => {
  const client = clientWith([root]);
  const { qc } = renderTab(client);
  await screen.findByRole('option', { name: /Blocked on the cart schema/ });
  client.listRecentThreads.mockImplementation(() =>
    Promise.reject(new Error('daemon busy'))
  );
  await act(() => qc.invalidateQueries());
  expect((await screen.findByRole('alert')).textContent).toBe('daemon busy');
  expect(
    screen.getAllByRole('option').map((option) => option.textContent)
  ).toEqual([expect.stringContaining('Blocked on the cart schema')]);
});

// Two text boxes at once invite a reply typed into the new-message one.
test('while a thread is open the new-message composer waits behind a button', async () => {
  renderTab(clientWith([root]));
  expect(await screen.findByLabelText('New message')).toBeDefined();
  fireEvent.click(
    await screen.findByRole('option', { name: /Blocked on the cart schema/ })
  );
  expect(await screen.findByLabelText('Reply')).toBeDefined();
  expect(screen.queryByLabelText('New message')?.tagName).toBeUndefined();

  fireEvent.click(screen.getByRole('button', { name: 'New message' }));
  const box = screen.getByLabelText('New message');
  expect(document.activeElement === box).toBe(true);
  fireEvent.keyDown(box, { key: 'Escape' });
  expect(screen.queryByLabelText('New message')?.tagName).toBeUndefined();
  expect(
    document.activeElement ===
      screen.getByRole('button', { name: 'New message' })
  ).toBe(true);
});

test('a memory gate in the task’s threads shows its proposal to a decider', async () => {
  const gate: Message = {
    ...root,
    id: 'm-mem',
    thread: 'm-mem',
    from: 'agent:dispatch',
    kind: 'question',
    blocking: true,
    choices: ['approve', 'reject'],
    body: 'run:r-000001 proposes a team memory (hazard).',
    data: {
      type: 'memory',
      proposalId: 'mp-000001',
      action: 'add',
      scope: 'team',
      kind: 'hazard',
    },
  };
  const getMemoryProposal = mock((_id: string) =>
    Promise.resolve({ proposal: proposal(), base: null, current: null })
  );
  const client = {
    ...clientWith([gate]),
    openDecisions: mock(() => Promise.resolve({ items: [gate] })),
    getMessage: mock(() => Promise.resolve(gate)),
    getThread: mock(() =>
      Promise.resolve({ messages: [gate], deliveries: [] })
    ),
    getMemoryProposal,
  };
  renderTab(client);
  const list = screen.getByRole('complementary', { name: 'Thread list' });
  fireEvent.click(
    await within(list).findByRole('option', {
      name: /proposes a team memory/,
    })
  );
  expect(
    await screen.findByText('pnpm 11 ignores onlyBuiltDependencies')
  ).toBeDefined();
  expect(getMemoryProposal).toHaveBeenCalledWith('mp-000001');
});
