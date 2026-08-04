import type { RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { CONTINUE_PROMPT } from '../../lib/runState';
import { RunLogView } from './RunLogView';

const noop = async () => {};

// Only the fields RunLogView's composer actually reads; the rest of RunMeta is
// irrelevant to which buttons the terminal branch renders.
function meta(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-abc123',
    taskId: 't-abc123',
    taskTitle: 'a task',
    executor: 'claude',
    state: 'failed',
    branch: 'dispatch/t-abc123',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

function renderLog(
  runMeta: RunMeta,
  onRequestChanges: (text: string) => Promise<void> = noop
) {
  return render(
    <RunLogView
      meta={runMeta}
      entries={[]}
      pendingApproval={null}
      onApprove={noop}
      onSendMessage={noop}
      openQuestions={[]}
      onAnswerQuestion={noop}
      pendingScopeRequest={null}
      onDecideScopeRequest={noop}
      scopeDecide={{
        enabled: true,
        notice: null,
        explanation: null,
        restart: null,
      }}
      onRestartDaemon={noop}
      onRequestChanges={onRequestChanges}
    />
  );
}

// A run cut off with its session intact is the case the button exists for.
test('offers Continue on a run that stopped short', () => {
  renderLog(meta({ state: 'failed', sessionId: 'sess-1' }));
  expect(screen.getByRole('button', { name: /continue/i })).toBeDefined();
});

// The server's resume gate refuses a run with no session, so advertising the
// button there would only produce an error the human cannot act on.
test('hides Continue on a failed run with no session to resume', () => {
  renderLog(meta({ state: 'failed' }));
  expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
  // The composer is still there — feedback can still be sent.
  expect(
    screen.getByRole('button', { name: /request changes/i })
  ).toBeDefined();
});

test('hides Continue on a run that finished normally', () => {
  renderLog(meta({ state: 'finished', sessionId: 'sess-1' }));
  expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
});

// The point of one-click Continue: no typing required for a run that was
// interrupted rather than wrong.
test('Continue resumes with the canned prompt when nothing was typed', async () => {
  const sent: string[] = [];
  renderLog(meta({ state: 'failed', sessionId: 'sess-1' }), async (text) => {
    sent.push(text);
  });

  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  expect(sent).toEqual([CONTINUE_PROMPT]);
});

test('Continue sends the draft instead when the human typed one', async () => {
  const sent: string[] = [];
  renderLog(meta({ state: 'failed', sessionId: 'sess-1' }), async (text) => {
    sent.push(text);
  });

  await act(async () => {
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'finish the failing test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  expect(sent).toEqual(['finish the failing test']);
});
