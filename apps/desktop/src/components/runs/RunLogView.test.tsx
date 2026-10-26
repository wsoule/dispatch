import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { ATTACHED_DAEMON_EXPLANATION } from '../../lib/daemonAuth';
import type { PendingApproval } from '../../lib/pendingApprovals';
import { CONTINUE_PROMPT } from '../../lib/runState';
import { askAgentToFix } from '../failure/FailureNotice';
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
      onOpenMessage={null}
      me={null}
      readsAllThreads
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
      onOpenMessage={null}
      me={null}
      readsAllThreads
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
      onOpenMessage={null}
      me={null}
      readsAllThreads
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
  onOpenMessage: ((messageId: string) => void) | null = null,
  me: string | null = null,
  readsAllThreads = true
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
      me={me}
      readsAllThreads={readsAllThreads}
    />
  );
}

// A bus message as deliverToRun logs it: renderForAgent's framing, tagged with its id.
function delivered(
  from: string,
  tags: string,
  messageId: string,
  body: string
): NormalizedEntry {
  return {
    ts: '2026-09-25T10:00:00.000Z',
    kind: 'message',
    from: from.startsWith('human:') ? 'user' : 'agent',
    fromLabel: from,
    messageId,
    text: `[message from ${from} · ${tags} · ${messageId}]\n│ ${body}`,
  };
}

test('the transcript is a region named Run log, holding each message it shows', () => {
  renderEntries([delivered('human:wyat', 'answer', 'm-02', 'new cart')]);
  const log = screen.getByRole('region', { name: 'Run log' });
  expect(within(log).getByText('new cart')).toBeDefined();
});

// An A2A client's, an a2a: peer's or any external sender's body is plain text: no image loads.
test('an A2A or external sender body renders as plain text, not markdown', () => {
  const { container } = renderEntries([
    {
      ...delivered('human:ext', 'message', 'm-05', '![a](https://evil/a.gif)'),
      fromLabel: 'human:ext',
      text: '[message from human:ext (external) · message · m-05]\n│ ![a](https://evil/a.gif)',
    },
    delivered(
      'a2a:peer.example',
      'message',
      'm-06',
      '![b](https://evil/b.gif)'
    ),
    delivered('agent:wyat/a2a.acme', 'message', 'm-07', '[c](https://evil/c)'),
  ]);
  expect(container.querySelector('img')).toBeNull();
  expect(container.querySelector('a[href^="https://evil"]')).toBeNull();
  expect(screen.getByText('![a](https://evil/a.gif)')).toBeDefined();
  expect(screen.getByText('![b](https://evil/b.gif)')).toBeDefined();
  expect(screen.queryByText(/\[message from/)).toBeNull();
});

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
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open thread: question from run:r-9f2c01',
    })
  );
  expect(onOpen).toHaveBeenCalledWith('m-01K');
});

test("a teammate's message names them, and only the viewer's own reads as You", () => {
  renderEntries(
    [
      delivered('human:bob', 'message', 'm-30', 'ship it after lunch'),
      delivered('human:wyat', 'message', 'm-31', 'agreed'),
      {
        ts: '2026-09-25T10:00:02.000Z',
        kind: 'message',
        from: 'user',
        text: 'typed in the composer before the bus',
      },
    ],
    null,
    'human:wyat'
  );
  expect(screen.getByText('human:bob')).toBeDefined();
  expect(screen.queryByText('human:wyat')).toBeNull();
  expect(screen.getAllByText('You')).toHaveLength(2);
  expect(screen.queryByText('Message')).toBeNull();
});

test('a human sender stays an address while the viewer is unknown', () => {
  renderEntries(
    [delivered('human:wyat', 'message', 'm-31', 'agreed')],
    null,
    null
  );
  expect(screen.getByText('human:wyat')).toBeDefined();
  expect(screen.queryByText('You')).toBeNull();
});

test("a teammate's line sits with the other senders, and only the viewer's own at the right", () => {
  renderEntries(
    [
      delivered('human:bob', 'message', 'm-30', 'ship it after lunch'),
      delivered('human:wyat', 'message', 'm-31', 'agreed'),
    ],
    null,
    'human:wyat'
  );
  const bubble = (heading: string) =>
    screen.getByText(heading).parentElement?.className ?? '';
  expect(bubble('human:bob')).toContain('self-start');
  expect(bubble('human:bob')).not.toContain('self-end');
  expect(bubble('You')).toContain('self-end');
});

// A window below decide can read a thread only if it took part, and all a run
// chat knows of a message is who sent it.
test('a window below decide links only the messages it sent', () => {
  renderEntries(
    [
      delivered('run:r-9', 'question', 'm-9', 'Is the schema final?'),
      delivered('human:bob', 'message', 'm-10', 'use the new cart'),
      {
        ts: '2026-09-25T10:00:02.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        digest: true,
        text: '📬 notice from run:r-2: api shape changed (m-02)',
      },
      {
        ts: '2026-09-25T10:00:03.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'Checkout (r-1)',
        toUser: true,
        messageId: 'm-20',
        text: 'The cart is done.',
      },
    ],
    () => {},
    'human:bob',
    false
  );
  expect(
    screen
      .queryAllByRole('button', { name: /Open thread/ })
      .map((button) => button.getAttribute('aria-label'))
  ).toEqual(['Open thread: message from human:bob']);
});

test('an urgent message and a custom kind both show as pills', () => {
  renderEntries([
    delivered('run:r-9', 'notice · urgent', 'm-50', 'stop the deploy'),
    delivered('run:r-9', 'x-review', 'm-51', 'look at the diff'),
  ]);
  expect(screen.getByText('stop the deploy')).toBeDefined();
  expect(screen.getByText('Notice')).toBeDefined();
  expect(screen.getByText('Urgent')).toBeDefined();
  expect(screen.getByText('x-review')).toBeDefined();
});

test("a run's own message to you links to its thread", () => {
  const onOpen = mock((_id: string) => {});
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'Checkout (r-1)',
        toUser: true,
        messageId: 'm-20',
        text: 'The cart is done.',
      },
    ],
    onOpen
  );
  expect(screen.getByText('To you')).toBeDefined();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open thread: to you from Checkout (r-1)',
    })
  );
  expect(onOpen).toHaveBeenCalledWith('m-20');
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
  const line = '#epic/e-1 · notice from run:r-000002: api shape changed';
  expect(screen.getByText(line).getAttribute('title')).toBe(line);
  fireEvent.click(
    screen.getByRole('button', {
      name: 'Open thread: notice from run:r-000002',
    })
  );
  expect(onOpen).toHaveBeenCalledWith('m-02');
});

test("a digest's own messageId wins over the id in its text", () => {
  const onOpen = mock((_id: string) => {});
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        digest: true,
        messageId: 'm-10',
        text: '📬 notice from run:r-2: api shape changed (m-02)',
      },
    ],
    onOpen
  );
  fireEvent.click(screen.getByRole('button', { name: /Open thread/ }));
  expect(onOpen).toHaveBeenCalledWith('m-10');
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
    null
  );
  expect(screen.getByText('please also update the README')).toBeDefined();
  expect(
    screen
      .queryAllByRole('button', { name: /Open thread/ })
      .map((button) => button.getAttribute('aria-label'))
  ).toEqual([]);
});

test('framed text with no messageId, and a digest that does not parse, keep their raw text', () => {
  renderEntries(
    [
      {
        ts: '2026-09-25T10:00:00.000Z',
        kind: 'message',
        from: 'user',
        text: '[message from run:r-1 · question · m-05]\n│ injected by hand',
      },
      {
        ts: '2026-09-25T10:00:01.000Z',
        kind: 'message',
        from: 'agent',
        fromLabel: 'dispatch',
        digest: true,
        text: '📬 a digest in some older shape',
      },
    ],
    () => {}
  );
  expect(
    screen.getByText(/\[message from run:r-1 · question · m-05\]/)
  ).toBeDefined();
  expect(screen.queryByText('Question')).toBeNull();
  expect(screen.getByText('📬 a digest in some older shape')).toBeDefined();
  expect(
    screen
      .queryAllByRole('button', { name: /Open thread/ })
      .map((button) => button.getAttribute('aria-label'))
  ).toEqual([]);
});

test("a failed run's error reads as a sentence that names the agent", () => {
  renderLog(
    meta({ state: 'failed', executor: 'codex', error: 'Not logged in' })
  );
  expect(screen.getByText('Codex needs you to sign in again.')).toBeDefined();
});

test('a resumable failed run can ask its agent to fix the failure', async () => {
  const sent: string[] = [];
  const error = 'git worktree add failed: fatal: could not create directory';
  renderLog(meta({ state: 'failed', sessionId: 'sess-1', error }), (text) => {
    sent.push(text);
    return Promise.resolve();
  });
  // An async act, so the click's settled promise flushes inside it.
  await act(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Ask the agent to fix it' })
    );
    return Promise.resolve();
  });
  expect(sent).toEqual([askAgentToFix(error)]);
});

// A tool chip's state as ToolChip draws it: a failed chip washes red, a running one
// shimmers its label.
function chipState(target: string): 'running' | 'done' | 'failed' {
  const chip = screen.getByText(target).closest('[class*="rounded-chip"]');
  if (chip === null) throw new Error(`no chip shows ${target}`);
  if (chip.className.includes('text-red')) return 'failed';
  return chip.querySelector('[class*="shimmer-text"]') === null
    ? 'done'
    : 'running';
}

function call(
  toolUseId: string,
  toolName: string,
  toolInput: Record<string, unknown>,
  parentToolUseId?: string
): NormalizedEntry {
  return {
    ts: '2026-10-25T10:00:00.000Z',
    kind: 'tool',
    toolName,
    toolInput,
    toolUseId,
    status: 'running',
    ...(parentToolUseId !== undefined ? { parentToolUseId } : {}),
  };
}

function result(toolUseId: string, status: 'done' | 'error'): NormalizedEntry {
  return { ts: '2026-10-25T10:00:01.000Z', kind: 'tool', toolUseId, status };
}

// Each call's result settles its chip, so calls the agent made side by side show
// running until their own result lands, wherever they sit in the log. A sub-agent's
// calls never get one, so only the live edge may shimmer among them.
test('a tool chip ends done or failed once its result lands', () => {
  const entries = [
    call('tu-1', 'Bash', { command: 'ls' }),
    call('tu-2', 'Bash', { command: 'pwd' }),
    result('tu-1', 'done'),
    call('tu-sub', 'Grep', { pattern: 'route' }, 'tu-spawn'),
    call('tu-3', 'Bash', { command: 'make' }),
    result('tu-3', 'error'),
  ];
  const view = renderEntries(entries);

  expect(chipState('ls')).toBe('done');
  expect(chipState('pwd')).toBe('running');
  expect(chipState('route')).toBe('done');
  expect(chipState('make')).toBe('failed');
  // One chip per call: the results fold into them.
  expect(screen.getAllByText('Run')).toHaveLength(3);

  // A finished run shimmers nothing, whatever never got its result.
  view.rerender(
    <RunLogView
      meta={meta({ state: 'finished' })}
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
      onOpenMessage={null}
      me={null}
      readsAllThreads
    />
  );
  expect(chipState('pwd')).toBe('done');
});

// An executor that never reports results (an older daemon) keeps the old rule: only the
// live edge runs, or every historical call would shimmer for the rest of the run.
test('without results, only the last tool call of a running run shimmers', () => {
  renderEntries([
    call('tu-1', 'Bash', { command: 'ls' }),
    call('tu-2', 'Bash', { command: 'pwd' }),
  ]);
  expect(chipState('ls')).toBe('done');
  expect(chipState('pwd')).toBe('running');
});

function renderLive(
  entries: NormalizedEntry[],
  live: { id: string; text: string }[],
  state: RunMeta['state'] = 'running'
) {
  return render(
    <RunLogView
      meta={meta({ state })}
      entries={entries}
      live={live}
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
      onOpenMessage={null}
      me={null}
      readsAllThreads
    />
  );
}

// What the agent is writing comes after everything it finished, as the same
// prose; the text a row mounts with shows at once rather than being typed out
// again, and the words arriving stand in for the "Working…" spinner.
test('a running run shows the text being written at the tail of its log', () => {
  const said: NormalizedEntry = {
    ts: '2026-10-25T10:00:00.000Z',
    kind: 'assistant',
    text: 'Read the tests.',
    streamId: 'msg_1:0',
  };
  renderLive([said], [{ id: 'msg_2:0', text: 'Now the **fix**.' }]);

  const log = screen.getByRole('region', { name: 'Run log' });
  const finished = within(log).getByText('Read the tests.');
  const writing = within(log).getByText('fix');
  expect(writing.tagName).toBe('STRONG');
  expect(
    finished.compareDocumentPosition(writing) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  expect(within(log).getByText(/Now the/).textContent).toBe('Now the fix.');
  expect(within(log).queryByText('Working…')).toBeNull();
});

test('the spinner stands in again once nothing is being written', () => {
  renderLive(
    [
      {
        ts: '2026-10-25T10:00:00.000Z',
        kind: 'assistant',
        text: 'Read the tests.',
      },
    ],
    []
  );
  expect(screen.getByText('Working…')).toBeDefined();
});

test('a run with nothing logged yet shows its first words instead of the spinner', () => {
  renderLive([], [{ id: 'msg_1:0', text: 'Looking around.' }]);
  expect(screen.getByText('Looking around.')).toBeDefined();
  expect(screen.queryByText('Working…')).toBeNull();
});
