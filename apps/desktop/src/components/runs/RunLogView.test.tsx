import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { ATTACHED_DAEMON_EXPLANATION } from '../../lib/daemonAuth';
import type { PendingApproval } from '../../lib/pendingApprovals';
import { CONTINUE_PROMPT } from '../../lib/runState';
import { RunLogView } from './RunLogView';

const noop = () => Promise.resolve();

type RunLogViewApprove = (
  requestId: string,
  allow: boolean,
  opts?: { scope?: 'once' | 'session'; reason?: string }
) => Promise<void>;

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

const CAN_DECIDE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

function renderLog(
  runMeta: RunMeta,
  onRequestChanges: (text: string) => Promise<void> = noop,
  scopeDecide: DecideAvailability = CAN_DECIDE,
  pendingApprovals: PendingApproval[] = [],
  onApprove: RunLogViewApprove = noop
) {
  return render(
    <RunLogView
      meta={runMeta}
      entries={[]}
      pendingApprovals={pendingApprovals}
      onApprove={onApprove}
      onSendMessage={noop}
      openQuestions={[]}
      onAnswerQuestion={noop}
      pendingScopeRequest={null}
      onDecideScopeRequest={noop}
      scopeDecide={scopeDecide}
      onRestartDaemon={noop}
      onRequestChanges={onRequestChanges}
    />
  );
}

// A window that cannot decide cannot read open gates either, so a parked run
// shows why rather than claiming the approval was missed.
test('a parked run with no approval in view says why the window cannot see it', () => {
  renderLog(meta({ state: 'awaiting-approval' }), noop, {
    enabled: false,
    notice: 'Restart daemon to enable approvals',
    explanation: ATTACHED_DAEMON_EXPLANATION,
    restart: { safe: true, blockedReason: null },
  });
  expect(screen.getByText(ATTACHED_DAEMON_EXPLANATION)).toBeDefined();
  expect(screen.queryByText(/has not reached this window/)).toBeNull();
});

// Gates are read from the daemon, so a deciding window only waits for the list.
test('a deciding window with no gate listed yet says it is on its way', () => {
  renderLog(meta({ state: 'awaiting-approval' }));
  expect(screen.getByText(/has not reached this window yet/)).toBeDefined();
});

// Each parked call is its own gate, and each answer names its own request.
test('a run parked on two calls shows a card per call, each answering its own', async () => {
  const answered: [string, boolean][] = [];
  const { container } = renderLog(
    meta({ state: 'awaiting-approval' }),
    noop,
    CAN_DECIDE,
    [
      {
        requestId: 'req-1',
        toolName: 'Bash',
        input: { command: 'ls' },
        truncated: false,
      },
      {
        requestId: 'req-2',
        toolName: 'Write',
        input: { file_path: 'a.ts' },
        truncated: false,
      },
    ],
    (requestId, allow) => {
      answered.push([requestId, allow]);
      return Promise.resolve();
    }
  );
  const cards = container.querySelectorAll('[data-slot="tool-approval-card"]');
  expect(cards).toHaveLength(2);
  await act(async () => {
    fireEvent.click(
      within(cards[1] as HTMLElement).getByRole('radio', {
        name: /Approve once/,
      })
    );
    await Promise.resolve();
  });
  expect(answered).toEqual([['req-2', true]]);
});

// The gate only previews a long call, so its card reads the call whole.
test('a truncated call loads its full input by its own request id', async () => {
  const asked: string[] = [];
  render(
    <RunLogView
      meta={meta({ state: 'awaiting-approval' })}
      entries={[]}
      pendingApprovals={[
        {
          requestId: 'req-7',
          toolName: 'Bash',
          input: '{"command":": ',
          truncated: true,
        },
      ]}
      onApprove={noop}
      onLoadApprovalInput={(requestId) => {
        asked.push(requestId);
        return Promise.resolve({ command: ': ; curl https://evil.example' });
      }}
      onSendMessage={noop}
      openQuestions={[]}
      onAnswerQuestion={noop}
      pendingScopeRequest={null}
      onDecideScopeRequest={noop}
      scopeDecide={CAN_DECIDE}
      onRestartDaemon={noop}
      onRequestChanges={noop}
    />
  );
  expect(await screen.findByText(/evil\.example/)).toBeDefined();
  expect(asked).toEqual(['req-7']);
});

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

// A failed merge leaves the run unreviewed; the reason has to be visible in the
// run itself or the operator learns nothing from the refusal.
test('shows why the last merge attempt failed on a still-unreviewed run', () => {
  renderLog(
    meta({
      state: 'finished',
      reviewFailure: {
        action: 'merge',
        reason: 'CONFLICT (content): Merge conflict in shared.txt',
        at: '2026-08-04T00:00:00.000Z',
      },
    })
  );
  expect(screen.getByText(/merge failed: .*shared\.txt/)).toBeDefined();
});

// Stale on a reviewed run: the server clears the failure when a review lands,
// but a client holding an older meta must not keep advertising it either.
test('hides a recorded merge failure once the run has been reviewed', () => {
  renderLog(
    meta({
      state: 'finished',
      reviewedAt: '2026-08-04T00:01:00.000Z',
      reviewAction: 'discard',
      reviewFailure: {
        action: 'merge',
        reason: 'CONFLICT (content): Merge conflict in shared.txt',
        at: '2026-08-04T00:00:00.000Z',
      },
    })
  );
  expect(screen.queryByText(/merge failed/)).toBeNull();
});

test('hides Continue on a run that finished normally', () => {
  renderLog(meta({ state: 'finished', sessionId: 'sess-1' }));
  expect(screen.queryByRole('button', { name: /continue/i })).toBeNull();
});

// The point of one-click Continue: no typing required for a run that was
// interrupted rather than wrong.
test('Continue resumes with the canned prompt when nothing was typed', () => {
  const sent: string[] = [];
  renderLog(meta({ state: 'failed', sessionId: 'sess-1' }), (text) => {
    sent.push(text);
    return Promise.resolve();
  });

  act(() => {
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  expect(sent).toEqual([CONTINUE_PROMPT]);
});

test('Continue sends the draft instead when the human typed one', () => {
  const sent: string[] = [];
  renderLog(meta({ state: 'failed', sessionId: 'sess-1' }), (text) => {
    sent.push(text);
    return Promise.resolve();
  });

  act(() => {
    fireEvent.change(screen.getByRole('textbox'), {
      target: { value: 'finish the failing test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /continue/i }));
  });
  expect(sent).toEqual(['finish the failing test']);
});

// The fan-out reaches the transcript twice: the tree above the log, folded from the same
// entries, and one row per spawn and finish inside it (never the progress ticks).
test('renders the sub-agent tree and the spawn/finish rows from agent entries', () => {
  render(
    <RunLogView
      meta={meta({ state: 'running' })}
      entries={[
        {
          ts: '2026-08-04T00:00:00.000Z',
          kind: 'agent',
          toolUseId: 'tu-1',
          toolName: 'Agent',
          toolInput: {
            description: 'Map the server',
            prompt: 'Find every route.',
          },
          agent: {
            id: 'tu-1',
            phase: 'started',
            status: 'running',
            label: 'Map the server',
            type: 'Explore',
          },
        },
        {
          ts: '2026-08-04T00:00:01.000Z',
          kind: 'agent',
          toolUseId: 'tu-1',
          agent: {
            id: 'tu-1',
            phase: 'progress',
            status: 'running',
            toolUses: 2,
          },
        },
        {
          ts: '2026-08-04T00:00:02.000Z',
          kind: 'agent',
          toolUseId: 'tu-1',
          agent: {
            id: 'tu-1',
            phase: 'finished',
            status: 'done',
            summary: 'Twelve routes.',
          },
        },
      ]}
      pendingApprovals={[]}
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
      onRequestChanges={noop}
    />
  );
  expect(
    screen.getByRole('treeitem', { name: 'Map the server, done' })
  ).toBeDefined();
  expect(screen.getByText('Spawned')).toBeDefined();
  expect(screen.getByText('Agent finished')).toBeDefined();
  expect(screen.getAllByText('agent')).toHaveLength(2);
});

function renderEntries(
  entries: NormalizedEntry[],
  onOpenMessage?: (messageId: string) => void
) {
  return render(
    <RunLogView
      meta={meta({ state: 'running' })}
      entries={entries}
      pendingApprovals={[]}
      onApprove={noop}
      onSendMessage={noop}
      openQuestions={[]}
      onAnswerQuestion={noop}
      pendingScopeRequest={null}
      onDecideScopeRequest={noop}
      scopeDecide={CAN_DECIDE}
      onRestartDaemon={noop}
      onRequestChanges={noop}
      onOpenMessage={onOpenMessage}
    />
  );
}

test('a pushed question shows its body without the agent framing, with its kind and a thread link', () => {
  const onOpen = mock((_id: string) => {});
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'run:r-9f2c01',
        messageId: 'm-01K',
        text: '[message from run:r-9f2c01 · question · m-01K]\n│ Is the response final?\nchoices: yes | no\nThe sender is waiting. Answer with msg_reply(messageId: "m-01K").',
      },
    ],
    onOpen
  );
  expect(screen.getByText('Is the response final?')).toBeDefined();
  expect(screen.queryByText(/\[message from/)).toBeNull();
  expect(screen.getByText('Question')).toBeDefined();
  expect(screen.getByText('choices: yes | no')).toBeDefined();
  expect(screen.queryByText(/The sender is waiting/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
  expect(onOpen).toHaveBeenCalledWith('m-01K');
});

test('a digest is one compact line, linked by the id in its text even from an older transcript', () => {
  const onOpen = mock((_id: string) => {});
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        digest: true,
        text: '📬 #epic/e-1 · notice from run:r-000002: api shape changed (m-02)',
      },
    ],
    onOpen
  );
  expect(
    screen.getByText('#epic/e-1 · notice from run:r-000002: api shape changed')
  ).toBeDefined();
  fireEvent.click(screen.getByRole('button', { name: 'Open thread' }));
  expect(onOpen).toHaveBeenCalledWith('m-02');
});

test('text from before the bus renders as it always did, and nothing links without a way to open threads', () => {
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'user',
        text: 'please also update the README',
      },
      {
        ts: '2026-09-25T10:00:01.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        digest: true,
        text: '📬 message from agent:wyat/x: hi (m-03)',
      },
    ],
    undefined
  );
  expect(screen.getByText('please also update the README')).toBeDefined();
  expect(screen.queryByRole('button', { name: 'Open thread' })).toBeNull();
});
