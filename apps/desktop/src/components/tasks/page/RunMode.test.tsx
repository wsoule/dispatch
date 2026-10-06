import type { ApiClient, NormalizedEntry, RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import type { MessageAccess } from '../../../lib/daemonAuth';
import type { RunQuestion, RunScopeRequest } from '../../../lib/gates';
import type { ShellActions } from '../../shell/ShellActionsContext';
import {
  fakeHost,
  newLog,
  PageProviders,
  run,
  SHELL,
  task,
} from './pageHost.test-helper';
import type { TaskPageProject } from './TaskPageHost';

// The Review mode pulls in the Pierre diff, whose worker import only Vite resolves.
void mock.module('@/components/runs/PierreWorkerPool', () => ({
  PierreWorkerPool: ({ children }: { children: ReactNode }) => children,
}));

const { TaskPage } = await import('./TaskPage');

const QUESTION: RunQuestion = {
  id: 'q-1',
  runId: 'r-1',
  question: 'Which cart should it use?',
  options: ['old', 'new'],
  askedAt: '2026-09-26T00:01:00.000Z',
  answer: null,
  answeredAt: null,
};

const SCOPE: RunScopeRequest = {
  id: 'm-s',
  runId: 'r-1',
  paths: ['src/payments/cart.ts'],
  reason: 'the cart lives there',
  requestedAt: '2026-09-26T00:02:00.000Z',
  granted: null,
  decisionReason: null,
  decidedAt: null,
  decidedBy: null,
};

const DECIDER: MessageAccess = {
  canDecide: true,
  canMessage: true,
  explanation: null,
};

// Mounts the page in Run mode on `selected`, whose transcript holds `entries`;
// every answer, scope decision and thread link lands in `log`.
function mountRun(
  runs: RunMeta[],
  selected: RunMeta,
  log: string[],
  entries: NormalizedEntry[] = [],
  messageAccess: MessageAccess = DECIDER
) {
  const project: Partial<TaskPageProject> = {
    messageAccess,
    openQuestions: new Map([['r-1', [QUESTION]]]),
    pendingScopeRequests: new Map([['r-1', SCOPE]]),
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    handleAnswerQuestion: (runId, questionId, answer) => {
      log.push(`answer:${runId}:${questionId}:${answer}`);
      return Promise.resolve();
    },
    handleDecideScopeRequest: (runId, requestId, granted) => {
      log.push(`scope:${runId}:${requestId}:${granted}`);
      return Promise.resolve();
    },
  };
  const host = fakeHost(newLog(), {
    tasks: [task('t-1', { status: 'working' })],
    runs,
    client: {
      fetchRun: (id: string) =>
        Promise.resolve({
          meta: runs.find((r) => r.id === id) ?? selected,
          entries,
        }),
    } as Partial<ApiClient>,
    project,
  });
  const shell: ShellActions = {
    ...SHELL,
    openThread: (messageId) => log.push(`thread:${messageId}`),
  };
  return render(
    <PageProviders host={host} shell={shell}>
      <TaskPage taskId="t-1" layout="full" mode="run" runId={selected.id} />
    </PageProviders>
  );
}

// An execute run's question and scope gate stay open after it ends, and a late
// answer reaches the task's next run, so the ended run still offers them.
test("an ended run's open question and scope gate stay answerable", async () => {
  const log: string[] = [];
  const ended = run({ state: 'finished' });
  mountRun([ended], ended, log);

  expect(await screen.findByText('Which cart should it use?')).toBeDefined();
  expect(screen.getByText('src/payments/cart.ts')).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Grant/ }));
    await Promise.resolve();
  });
  expect(log).toEqual(['scope:r-1:m-s:true']);
});

// The run that picks the task up next is where the human is looking.
test("a successor run shows the ended run's open asks", async () => {
  const log: string[] = [];
  const successor = run({
    id: 'r-2',
    state: 'running',
    resumedFrom: 'r-1',
    createdAt: '2026-09-23T11:00:00.000Z',
  });
  mountRun([successor, run({ state: 'failed' })], successor, log);

  expect(await screen.findByText('Which cart should it use?')).toBeDefined();
  expect(screen.getByText('src/payments/cart.ts')).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'new' }));
    await Promise.resolve();
  });
  expect(log).toEqual(['answer:r-1:q-1:new']);
});

// The composer sends through the bus, so the viewer's own lines come back
// addressed from them.
test("the viewer's own message in the transcript reads as You", async () => {
  const live = run({ state: 'running' });
  mountRun(
    [live],
    live,
    [],
    [
      {
        ts: '2026-09-26T00:03:00.000Z',
        kind: 'message',
        from: 'user',
        fromLabel: 'human:wyat',
        messageId: 'm-1',
        text: '[message from human:wyat · message · m-1]\n│ use the new cart',
      },
    ]
  );
  expect(await screen.findByText('use the new cart')).toBeDefined();
  expect(screen.getByText('You')).toBeDefined();
  expect(screen.queryByText('human:wyat')).toBeNull();
});

test('a message delivered to the run opens its thread', async () => {
  const log: string[] = [];
  const live = run({ state: 'running' });
  mountRun([live], live, log, [
    {
      ts: '2026-09-26T00:04:00.000Z',
      kind: 'message',
      from: 'agent',
      fromLabel: 'run:r-9',
      messageId: 'm-9',
      text: '[message from run:r-9 · question · m-9]\n│ Is the cart schema final?',
    },
  ]);
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'Open thread: question from run:r-9',
    })
  );
  expect(log).toEqual(['thread:m-9']);
});

const DELIVERED: NormalizedEntry[] = [
  {
    ts: '2026-09-26T00:04:00.000Z',
    kind: 'message',
    from: 'agent',
    fromLabel: 'run:r-9',
    messageId: 'm-9',
    text: '[message from run:r-9 · question · m-9]\n│ Is the cart schema final?',
  },
  {
    ts: '2026-09-26T00:05:00.000Z',
    kind: 'message',
    from: 'user',
    fromLabel: 'human:wyat',
    messageId: 'm-10',
    text: '[message from human:wyat · message · m-10]\n│ use the new cart',
  },
];

const threadLinks = () =>
  screen
    .queryAllByRole('button', { name: /Open thread/ })
    .map((button) => button.getAttribute('aria-label'));

// Threads refuse a window holding the agent token, so it gets no links to them.
test('a window that cannot message shows no thread links', async () => {
  const live = run({ state: 'running' });
  mountRun([live], live, [], DELIVERED, {
    canDecide: false,
    canMessage: false,
    explanation: 'This window cannot send messages.',
  });
  expect(await screen.findByText('Is the cart schema final?')).toBeDefined();
  expect(threadLinks()).toEqual([]);
});

test('a window below decide links only what it sent', async () => {
  const live = run({ state: 'running' });
  mountRun([live], live, [], DELIVERED, {
    canDecide: false,
    canMessage: true,
    explanation: 'needs decide',
  });
  await screen.findByText('Is the cart schema final?');
  expect(threadLinks()).toEqual(['Open thread: message from human:wyat']);
});
