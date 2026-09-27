import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import type { RunQuestion, RunScopeRequest } from '../../lib/gates';
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

// Only what TaskChatTab and the RunLogView it renders read.
function dataWith(
  runs: RunMeta[],
  selected: RunMeta,
  log: string[]
): DispatchProjectData {
  return {
    runs,
    runDetail: { meta: selected, entries: [] },
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

function renderChat(runs: RunMeta[], selected: RunMeta, log: string[]) {
  return render(
    <TaskChatTab
      data={dataWith(runs, selected, log)}
      doc={{ meta: { id: 't-1' } } as TaskDoc}
      selectedRun={selected}
      onDispatch={() => {}}
    />
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
