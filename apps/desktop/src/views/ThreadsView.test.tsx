import type { ApiClient, Message } from '@dispatch/client';
import { ApiError } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { dataWith } from '../components/settings/fixtures.test-helper';
import { ThreadsView } from './ThreadsView';

const question: Message = {
  id: 'm-q',
  thread: 'm-q',
  replyTo: null,
  from: 'run:r-000001',
  to: ['human:wyat'],
  kind: 'question',
  body: 'Which cart should the checkout read?',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['old cart', 'new cart'],
  wake: 'none',
  createdAt: '2026-09-25T10:00:00.000Z',
};
const OVERSEER = {
  thread: null,
  busy: false,
  submit: () => Promise.resolve(),
  open: () => {},
};

test('a question waiting on me is under Needs you, and its choice answers it', async () => {
  const client = {
    getMailbox: mock(() =>
      Promise.resolve({
        items: [
          {
            message: question,
            delivery: {
              id: 'd-1',
              messageId: 'm-q',
              recipient: 'human:wyat',
              runId: null,
              via: 'direct',
              state: 'notified',
              updatedAt: question.createdAt,
            },
          },
        ],
      })
    ),
    listRecentThreads: mock(() =>
      Promise.resolve({
        threads: [{ thread: 'm-q', root: question, last: question, count: 1 }],
      })
    ),
    openDecisions: mock(() => Promise.resolve({ items: [question] })),
    getMessage: mock(() => Promise.resolve(question)),
    getThread: mock(() =>
      Promise.resolve({ messages: [question], deliveries: [] })
    ),
    replyToMessage: mock(() =>
      Promise.resolve({ message: question, deliveries: [], downgraded: false })
    ),
    markDeliveryRead: mock(() => Promise.resolve({})),
    listChannels: mock(() => Promise.resolve({ channels: [] })),
    listAgentRoster: mock(() => Promise.resolve({ agents: [] })),
  };
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: 'human:wyat',
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    tasks: [],
    runs: [],
    presence: [],
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const onFocus = mock((_id: string | null) => {});
  const view = (focus: string | null) => (
    <QueryClientProvider client={queryClient}>
      <ThreadsView
        data={data}
        projectName="storefront"
        focus={focus}
        onFocus={onFocus}
        onOpenRef={() => {}}
        overseer={OVERSEER}
      />
    </QueryClientProvider>
  );
  const { rerender } = render(view(null));

  const needsYou = await screen.findByRole('region', { name: 'Needs you' });
  fireEvent.click(
    await within(needsYou).findByRole('button', {
      name: /Which cart should the checkout read\?/,
    })
  );
  expect(onFocus).toHaveBeenCalledWith('m-q');

  rerender(view('m-q'));
  fireEvent.click(await screen.findByRole('button', { name: 'new cart' }));
  await waitFor(() =>
    expect(client.replyToMessage).toHaveBeenCalledWith('m-q', {
      body: 'new cart',
      choice: 'new cart',
    })
  );
});

test('an attached agent-token window queries nothing and says why', () => {
  const client = {
    getMailbox: mock(() => Promise.resolve({ items: [] })),
    listRecentThreads: mock(() => Promise.resolve({ threads: [] })),
    openDecisions: mock(() => Promise.resolve({ items: [] })),
    listChannels: mock(() => Promise.resolve({ channels: [] })),
    listAgentRoster: mock(() => Promise.resolve({ agents: [] })),
  };
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: 'human:wyat',
    messageAccess: {
      canDecide: false,
      canMessage: false,
      explanation: 'This window cannot send messages.',
    },
    tasks: [],
    runs: [],
    presence: [],
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ThreadsView
        data={data}
        projectName="storefront"
        focus="m-q"
        onFocus={() => {}}
        onOpenRef={() => {}}
        overseer={OVERSEER}
      />
    </QueryClientProvider>
  );
  expect(screen.getByText('This window cannot send messages.')).toBeTruthy();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'New thread' })
      .disabled
  ).toBe(true);
  expect(client.getMailbox).not.toHaveBeenCalled();
  expect(client.listRecentThreads).not.toHaveBeenCalled();
  expect(client.openDecisions).not.toHaveBeenCalled();
  expect(client.listChannels).not.toHaveBeenCalled();
});

test('a teammate waits for the daemon to say who they are, with no reason given as a refusal', () => {
  const client = {
    getMailbox: mock(() => Promise.resolve({ items: [] })),
    listRecentThreads: mock(() => Promise.resolve({ threads: [] })),
    openDecisions: mock(() => Promise.resolve({ items: [] })),
    listChannels: mock(() => Promise.resolve({ channels: [] })),
    listAgentRoster: mock(() => Promise.resolve({ agents: [] })),
  };
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: null,
    messageAccess: {
      canDecide: false,
      canMessage: true,
      explanation: 'Answering approvals needs the decide tier.',
    },
    tasks: [],
    runs: [],
    presence: [],
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ThreadsView
        data={data}
        projectName="storefront"
        focus={null}
        onFocus={() => {}}
        onOpenRef={() => {}}
        overseer={OVERSEER}
      />
    </QueryClientProvider>
  );
  expect(
    screen.getByText('Waiting for the daemon to say who you are.')
  ).toBeTruthy();
  expect(
    screen.queryByText('Threads are not available in this window.')
  ).toBeNull();
  expect(
    screen.queryByText('Answering approvals needs the decide tier.')
  ).toBeNull();
  expect(
    screen.getByRole<HTMLButtonElement>('button', { name: 'New thread' })
      .disabled
  ).toBe(true);
});

test('a focus that names no message says the thread did not load', async () => {
  const client = {
    getMailbox: mock(() => Promise.resolve({ items: [] })),
    listRecentThreads: mock(() => Promise.resolve({ threads: [] })),
    openDecisions: mock(() => Promise.resolve({ items: [] })),
    getMessage: mock(() =>
      Promise.reject(new ApiError('no message m-gone', 404))
    ),
    listChannels: mock(() => Promise.resolve({ channels: [] })),
    listAgentRoster: mock(() => Promise.resolve({ agents: [] })),
  };
  const data = dataWith({
    client: client as unknown as ApiClient,
    port: 4000,
    me: 'human:wyat',
    messageAccess: { canDecide: true, canMessage: true, explanation: null },
    tasks: [],
    runs: [],
    presence: [],
  });
  render(
    <QueryClientProvider
      client={
        new QueryClient({ defaultOptions: { queries: { retry: false } } })
      }
    >
      <ThreadsView
        data={data}
        projectName="storefront"
        focus="m-gone"
        onFocus={() => {}}
        onOpenRef={() => {}}
        overseer={OVERSEER}
      />
    </QueryClientProvider>
  );
  expect(await screen.findByText('This thread did not load')).toBeTruthy();
  expect(screen.getByText('no message m-gone')).toBeTruthy();
});
