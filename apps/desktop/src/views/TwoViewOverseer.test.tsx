import type { ApiClient, OverseerRecord, RunMeta } from '@dispatch/client';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { useState } from 'react';

import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { OverseerSession } from '../hooks/useOverseerSession';
import { type OverseerFocus, TwoViewOverseer } from './TwoViewOverseer';

function record(id: string, prompt: string): OverseerRecord {
  return {
    id,
    prompt,
    backendName: 'fake',
    state: 'ready',
    messages: [{ role: 'user', text: prompt, at: '2026-10-06T09:00:00Z' }],
    pendingActions: [],
    pendingApprovals: [],
    undeliveredDecisions: [],
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-06T09:00:00Z',
  };
}

function session(over: Partial<OverseerSession>): OverseerSession {
  return {
    conversationId: 'w-1',
    record: record('w-1', 'why did r-41 fail?'),
    recordError: null,
    submit: () => Promise.resolve(),
    reply: () => Promise.resolve(),
    sending: false,
    sendError: null,
    revoked: false,
    confirmAction: () => Promise.resolve(),
    decidingActionId: null,
    decideApproval: () => Promise.resolve(),
    decidingRequestId: null,
    decideError: null,
    model: 'claude-opus-5-5',
    setModel: () => {},
    effortId: 'default',
    setEffortId: () => {},
    configuredEffort: undefined,
    reset: () => {},
    stop: () => Promise.resolve(),
    setConversationOptions: () => Promise.resolve(),
    submitNew: () => Promise.resolve(),
    open: () => {},
    draft: '',
    setDraft: () => {},
    ...over,
  };
}

function Harness({
  overseer,
  client,
}: {
  overseer: OverseerSession;
  client: Partial<ApiClient>;
}) {
  const [draft, setDraft] = useState('');
  const [queryClient] = useState(() => new QueryClient());
  const data = {
    client: client as ApiClient,
    port: 4321,
    portLoading: false,
    portError: false,
  } as unknown as DispatchProjectData;
  return (
    <QueryClientProvider client={queryClient}>
      <TwoViewOverseer
        data={data}
        overseer={{ ...overseer, draft, setDraft }}
        projectPath="/repo"
        asks={0}
        revoked={false}
        onShowAsks={() => {}}
        onOpenConnectedAgents={() => {}}
        onOpenDoor={() => {}}
      />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  window.localStorage.removeItem('dispatch:overseer-dock:/repo');
});

async function send(text: string): Promise<void> {
  const box = screen.getByRole('textbox', { name: 'Follow-up message' });
  fireEvent.change(box, { target: { value: text } });
  await act(async () => {
    fireEvent.keyDown(box, { key: 'Enter' });
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

test('a message Jev reads as a new topic opens a new conversation and sets this one aside', async () => {
  const calls: string[] = [];
  render(
    <Harness
      overseer={session({
        submit: (text) => {
          calls.push(`submit:${text}`);
          return Promise.resolve();
        },
        submitNew: (text) => {
          calls.push(`new:${text}`);
          return Promise.resolve();
        },
      })}
      client={{
        judgeOverseerTopic: () =>
          Promise.resolve({ newTopic: true, confidence: 0.9 }),
        getOverseer: (id: string) => Promise.resolve(record(id, 'old')),
      }}
    />
  );
  await send('plan the checkout redesign');
  expect(calls).toEqual(['new:plan the checkout redesign']);
  expect(
    JSON.parse(
      window.localStorage.getItem('dispatch:overseer-dock:/repo') ?? '[]'
    )
  ).toEqual(['w-1']);
  expect(screen.getByRole('status').textContent).toContain('Put it back');
});

test('a follow-up, a slash command, or no reading stays in the conversation', async () => {
  const calls: string[] = [];
  let judged = 0;
  render(
    <Harness
      overseer={session({
        submit: (text) => {
          calls.push(`submit:${text}`);
          return Promise.resolve();
        },
        submitNew: (text) => {
          calls.push(`new:${text}`);
          return Promise.resolve();
        },
      })}
      client={{
        judgeOverseerTopic: () => {
          judged++;
          return Promise.reject(new Error('down'));
        },
      }}
    />
  );
  await send('rerun it');
  await send('/compact');
  expect(calls).toEqual(['submit:rerun it', 'submit:/compact']);
  expect(judged).toBe(1);
});

test('Set aside docks the conversation and empties the composer', () => {
  let resets = 0;
  render(
    <Harness
      overseer={session({
        reset: () => {
          resets++;
        },
      })}
      client={{ getOverseer: (id: string) => Promise.resolve(record(id, 'x')) }}
    />
  );
  fireEvent.click(screen.getByTestId('overseer-minimize'));
  expect(resets).toBe(1);
  expect(
    JSON.parse(
      window.localStorage.getItem('dispatch:overseer-dock:/repo') ?? '[]'
    )
  ).toEqual(['w-1']);
});

function FocusHarness({ runs }: { runs: RunMeta[] }) {
  const [focus, setFocus] = useState<OverseerFocus | null>(null);
  const [draft, setDraft] = useState('');
  const [queryClient] = useState(() => new QueryClient());
  const data = {
    client: {} as ApiClient,
    port: 4321,
    portLoading: false,
    portError: false,
  } as unknown as DispatchProjectData;
  return (
    <QueryClientProvider client={queryClient}>
      <TwoViewOverseer
        data={data}
        overseer={{ ...session({}), draft, setDraft }}
        projectPath="/repo"
        asks={0}
        revoked={false}
        runs={runs}
        focus={focus}
        onFocus={setFocus}
        renderFocus={(f, onClose) => (
          <div>
            <span>focused {f.kind === 'task' ? f.taskId : f.address}</span>
            <button type="button" onClick={onClose}>
              close focus
            </button>
          </div>
        )}
        onShowAsks={() => {}}
        onOpenConnectedAgents={() => {}}
        onOpenDoor={() => {}}
      />
    </QueryClientProvider>
  );
}

test('a run on the right opens its task in the middle; Esc gives the talk back', () => {
  render(
    <FocusHarness
      runs={[
        {
          id: 'r-1',
          taskId: 't-9',
          taskTitle: 'Warm the cache',
          state: 'running',
          createdAt: '2026-10-06T09:00:00Z',
          updatedAt: '2026-10-06T09:00:00Z',
        } as RunMeta,
      ]}
    />
  );
  fireEvent.click(screen.getByText('Warm the cache'));
  expect(screen.getByTestId('overseer-focus').textContent).toContain(
    'focused t-9'
  );
  // The talk is hidden, not gone, so the draft survives.
  expect(
    screen.getByRole('textbox', { name: 'Follow-up message', hidden: true })
  ).toBeTruthy();
  fireEvent.keyDown(window, { key: 'Escape' });
  expect(screen.queryByTestId('overseer-focus')).toBeNull();
});
