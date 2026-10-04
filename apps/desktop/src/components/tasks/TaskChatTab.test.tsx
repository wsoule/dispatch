import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { MessageAccess } from '../../lib/daemonAuth';
import type { RunQuestion, RunScopeRequest } from '../../lib/gates';
import type { ShellActions } from '../shell/ShellActionsContext';
import { ShellActionsProvider } from '../shell/ShellActionsContext';
import { TaskChatTab } from './TaskChatTab';

function run(id: string, state: RunMeta['state']): RunMeta {
  return {
    id,
    taskId: 't-1',
    taskTitle: 'Checkout',
    executor: 'claude',
    state,
    branch: `dispatch/${id}`,
    baseBranch: 'main',
    worktreePath: `/wt/${id}`,
    createdAt: '2026-09-26T00:00:00.000Z',
    updatedAt: '2026-09-26T00:00:00.000Z',
  };
}

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

// Only what TaskChatTab and the RunLogView it renders read.
function dataWith(
  runs: RunMeta[],
  selected: RunMeta,
  log: string[],
  entries: NormalizedEntry[] = [],
  messageAccess: MessageAccess = DECIDER
): DispatchProjectData {
  return {
    runs,
    runDetail: { meta: selected, entries },
    me: 'human:wyat',
    messageAccess,
    readyIds: new Set(),
    pendingApprovals: new Map(),
    openQuestions: new Map([['r-1', [QUESTION]]]),
    pendingScopeRequests: new Map([['r-1', SCOPE]]),
    scopeDecide: {
      enabled: true,
      notice: null,
      explanation: null,
      restart: null,
    },
    handleApprove: () => Promise.resolve(),
    fetchApprovalInput: () => Promise.resolve(null),
    handleSendMessage: () => Promise.resolve(),
    handleAnswerQuestion: (
      runId: string,
      questionId: string,
      answer: string
    ) => {
      log.push(`answer:${runId}:${questionId}:${answer}`);
      return Promise.resolve();
    },
    handleDecideScopeRequest: (
      runId: string,
      requestId: string,
      granted: boolean
    ) => {
      log.push(`scope:${runId}:${requestId}:${granted}`);
      return Promise.resolve();
    },
    handleRestartDaemon: () => Promise.resolve(),
    handleRequestChanges: () => Promise.resolve(),
  } as unknown as DispatchProjectData;
}

// Only the thread link is exercised; it records where it led.
function shellWith(log: string[]): ShellActions {
  const noop = () => {};
  return {
    openTask: noop,
    openThread: (messageId) => log.push(`thread:${messageId}`),
    peekTask: noop,
    openCreateTask: noop,
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    toggleSidebar: noop,
    sidebarHidden: false,
    openOverseer: noop,
    setProjectView: noop,
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: noop,
  };
}

function renderChat(
  runs: RunMeta[],
  selected: RunMeta,
  log: string[],
  entries: NormalizedEntry[] = [],
  messageAccess: MessageAccess = DECIDER
) {
  return render(
    <ShellActionsProvider value={shellWith(log)}>
      <TaskChatTab
        data={dataWith(runs, selected, log, entries, messageAccess)}
        doc={{ meta: { id: 't-1' } } as TaskDoc}
        selectedRun={selected}
        onDispatch={() => {}}
      />
    </ShellActionsProvider>
  );
}

// An execute run's question and scope gate stay open after it ends, and a late
// answer reaches the task's next run, so the ended run still offers them.
test("an ended run's open question and scope gate stay answerable", async () => {
  const log: string[] = [];
  const ended = run('r-1', 'finished');
  renderChat([ended], ended, log);

  expect(screen.getByText('Which cart should it use?')).toBeDefined();
  expect(screen.getByText('src/payments/cart.ts')).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: /Grant/ }));
    await Promise.resolve();
  });
  expect(log).toEqual(['scope:r-1:m-s:true']);
});

// The run that picks the task up next is where the human is looking.
test("a successor run's chat shows the ended run's open asks", async () => {
  const log: string[] = [];
  const successor = { ...run('r-2', 'running'), resumedFrom: 'r-1' };
  renderChat([successor, run('r-1', 'failed')], successor, log);

  expect(screen.getByText('Which cart should it use?')).toBeDefined();
  expect(screen.getByText('src/payments/cart.ts')).toBeDefined();
  await act(async () => {
    fireEvent.click(screen.getByRole('radio', { name: 'new' }));
    await Promise.resolve();
  });
  expect(log).toEqual(['answer:r-1:q-1:new']);
});

// The composer sends through the bus, so the viewer's own lines come back
// addressed from them.
test("the viewer's own message in the chat reads as You", () => {
  const live = run('r-1', 'running');
  renderChat(
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
  expect(screen.getByText('use the new cart')).toBeDefined();
  expect(screen.getByText('You')).toBeDefined();
  expect(screen.queryByText('human:wyat')).toBeNull();
});

test('a message delivered to the run opens its thread', () => {
  const log: string[] = [];
  const live = run('r-1', 'running');
  renderChat([live], live, log, [
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
    screen.getByRole('button', { name: 'Open thread: question from run:r-9' })
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
test('a window that cannot message shows no thread links', () => {
  const live = run('r-1', 'running');
  renderChat([live], live, [], DELIVERED, {
    canDecide: false,
    canMessage: false,
    explanation: 'This window cannot send messages.',
  });
  expect(screen.getByText('Is the cart schema final?')).toBeDefined();
  expect(threadLinks()).toEqual([]);
});

test('a window below decide links only what it sent', () => {
  const live = run('r-1', 'running');
  renderChat([live], live, [], DELIVERED, {
    canDecide: false,
    canMessage: true,
    explanation: 'needs decide',
  });
  expect(threadLinks()).toEqual(['Open thread: message from human:wyat']);
});
