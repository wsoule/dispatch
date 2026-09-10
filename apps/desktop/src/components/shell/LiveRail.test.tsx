import type { RunMeta, WardenAction, WardenRecord } from '@dispatch/client';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';
import { useState } from 'react';

import type { WardenSession } from '../../hooks/useWardenSession';
import { LiveRail } from './LiveRail';

function run(over: Partial<RunMeta> = {}): RunMeta {
  return {
    id: 'r-1',
    taskId: 't-1',
    taskTitle: 'Do the thing',
    executor: 'claude',
    state: 'running',
    branch: 'dispatch/t-1',
    baseBranch: 'main',
    worktreePath: '/tmp/wt',
    createdAt: '2026-08-04T00:00:00.000Z',
    updatedAt: '2026-08-04T00:00:00.000Z',
    ...over,
  } as RunMeta;
}

// The same record/action fixtures wardenThread.test.ts builds — the section's
// Warden tab renders through the identical WardenSession seam WardenView
// uses, so a fake session with a canned record is the whole test backend.
function wardenRecord(over: Partial<WardenRecord> = {}): WardenRecord {
  return {
    id: 'w-1',
    prompt: 'what is going on?',
    backendName: 'fake',
    state: 'ready',
    messages: [],
    pendingActions: [],
    undeliveredDecisions: [],
    createdAt: '2026-08-10T00:00:00Z',
    updatedAt: '2026-08-10T00:00:05Z',
    ...over,
  };
}

function wardenAction(over: Partial<WardenAction> = {}): WardenAction {
  return {
    id: 'act-1',
    tool: 'cancel_run',
    input: { runId: 'r-1' },
    summary: 'Cancel run r-1',
    createdAt: '2026-08-10T00:00:02Z',
    status: 'pending',
    ...over,
  };
}

function wardenSession(over: Partial<WardenSession> = {}): WardenSession {
  return {
    conversationId: null,
    record: undefined,
    recordError: null,
    submit: () => Promise.resolve(),
    sending: false,
    sendError: null,
    confirmAction: () => Promise.resolve(),
    decidingActionId: null,
    decideError: null,
    reset: () => {},
    draft: '',
    setDraft: () => {},
    ...over,
  };
}

function railProps(over: Partial<Parameters<typeof LiveRail>[0]> = {}) {
  return {
    runs: [],
    attentionCount: 0,
    warden: wardenSession(),
    daemonReady: true,
    onOpenTask: () => {},
    onOpenInbox: () => {},
    onOpenWarden: () => {},
    collapsed: false,
    ...over,
  };
}

// Radix Tabs activates a trigger on mousedown, not click — one helper so every
// test switches tabs the way the widget actually listens.
function selectTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
}

// The section unmounts the warden chat whenever its tab is not showing, so the
// composer draft has to be state that outlives it — App holds it in
// useWardenSession. This is that seam, so the draft tests exercise the real
// arrangement rather than a chat that merely never unmounted.
function RailWithDraft(props: Parameters<typeof LiveRail>[0]) {
  const [draft, setDraft] = useState('');
  return <LiveRail {...props} warden={{ ...props.warden, draft, setDraft }} />;
}

// The section persists its active tab on mount, so every test must start
// from a known key state or inherit whatever tab the previous test left.
beforeEach(() => {
  window.localStorage.removeItem('dispatch:live-rail-tab');
});

test('renders the idle copy with no runs', () => {
  render(<LiveRail {...railProps()} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText(/waiting on you/)).toBeNull();
});

test('renders a row per live run, clicking opens its task', () => {
  const calls: unknown[] = [];
  render(
    <LiveRail
      {...railProps({
        runs: [run()],
        onOpenTask: (taskId, tab, runId) => {
          calls.push([taskId, tab, runId]);
        },
      })}
    />
  );
  const row = screen.getByText('Do the thing');
  fireEvent.click(row);
  expect(calls).toEqual([['t-1', 'chat', 'r-1']]);
});

test('shows the attention strip when something is waiting, and it navigates to the inbox', () => {
  let opened = false;
  render(
    <LiveRail
      {...railProps({
        runs: [run({ state: 'awaiting-approval' })],
        attentionCount: 1,
        onOpenInbox: () => {
          opened = true;
        },
      })}
    />
  );
  const strip = screen.getByText('1 waiting on you →');
  fireEvent.click(strip);
  expect(opened).toBe(true);
});

// The "never hides" rule survives the move into the sidebar: the collapsed icon strip must
// still say something is waiting, or collapsing the sidebar becomes a way to lose the only
// always-on signal in the shell.
test('the collapsed strip still shows the attention count and opens the inbox', () => {
  let opened = false;
  render(
    <LiveRail
      {...railProps({
        runs: [run({ state: 'awaiting-approval' })],
        attentionCount: 1,
        onOpenInbox: () => {
          opened = true;
        },
        collapsed: true,
      })}
    />
  );

  const badge = screen.getByRole('button', { name: '1 waiting on you' });
  expect(badge.textContent).toBe('1');
  fireEvent.click(badge);
  expect(opened).toBe(true);
});

// Collapsed, the run rows and headings disappear — only the essentials survive: the
// attention count (above), a queued warden approval, and that agents are running at all.
test('the collapsed strip drops rows but keeps the running count', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [run(), run({ id: 'r-2', taskId: 't-2', taskTitle: 'Other' })],
        collapsed: true,
      })}
    />
  );
  expect(screen.queryByText('Live agents')).toBeNull();
  expect(screen.queryByText('Do the thing')).toBeNull();
  expect(screen.getByTitle('2 agents running').textContent).toContain('2');
});

test('the Warden tab swaps the run list for the warden composer, and back', () => {
  render(<LiveRail {...railProps({ runs: [run()] })} />);

  // Ordinary radix tab bodies: only the selected panel is mounted.
  expect(screen.getByText('Do the thing')).toBeDefined();
  expect(screen.queryByLabelText('Warden opening question')).toBeNull();

  selectTab('Warden');
  expect(screen.queryByText('Do the thing')).toBeNull();
  expect(screen.getByLabelText('Warden opening question')).toBeDefined();

  selectTab('Runs');
  expect(screen.getByText('Do the thing')).toBeDefined();
  expect(screen.queryByLabelText('Warden opening question')).toBeNull();
});

// Each trigger sets aria-controls unconditionally, so a section that renders
// its tab bodies outside the Tabs root points them at nothing. The panel has
// to exist, carry role=tabpanel, and name itself after its trigger.
test('the selected tab controls a real, labelled tabpanel', () => {
  render(<LiveRail {...railProps()} />);

  for (const name of ['Runs', 'Warden']) {
    selectTab(name);
    const trigger = screen.getByRole('tab', { name });
    const panelId = trigger.getAttribute('aria-controls') ?? '';
    expect(panelId).not.toBe('');

    const panel = document.getElementById(panelId);
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('role')).toBe('tabpanel');
    expect(panel?.getAttribute('aria-labelledby')).toBe(trigger.id);
  }
});

// The chat unmounts on every tab flip like any other tab body, so a half-typed
// message only survives because the draft belongs to the session.
test('a composer draft survives switching tabs', () => {
  render(<RailWithDraft {...railProps()} />);
  selectTab('Warden');

  fireEvent.change(screen.getByLabelText('Warden opening question'), {
    target: { value: 'half a thought' },
  });

  selectTab('Runs');
  selectTab('Warden');
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Warden opening question').value
  ).toBe('half a thought');
});

// Collapsing the sidebar drops the whole expanded tree, chat included — the
// draft lives on the session precisely so the collapse cannot lose it.
test('a composer draft survives the sidebar collapsing and expanding', () => {
  function Harness({ collapsed }: { collapsed: boolean }) {
    const [draft, setDraft] = useState('half a thought');
    return (
      <LiveRail
        {...railProps({
          warden: { ...wardenSession(), draft, setDraft },
          collapsed,
        })}
      />
    );
  }
  window.localStorage.setItem('dispatch:live-rail-tab', 'warden');
  const view = render(<Harness collapsed={false} />);
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Warden opening question').value
  ).toBe('half a thought');

  view.rerender(<Harness collapsed />);
  expect(screen.queryByLabelText('Warden opening question')).toBeNull();

  view.rerender(<Harness collapsed={false} />);
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Warden opening question').value
  ).toBe('half a thought');
});

// The attention strip is the section's one always-on signal — switching to the
// warden conversation must not hide that something is waiting on a human.
test('the attention strip stays visible on the Warden tab', () => {
  render(
    <LiveRail
      {...railProps({
        runs: [run({ state: 'awaiting-approval' })],
        attentionCount: 1,
      })}
    />
  );
  selectTab('Warden');
  expect(screen.getByText('1 waiting on you →')).toBeDefined();
});

// The active tab is a per-device preference: a fresh mount (restart, project
// switch, sidebar expand) lands on whatever tab was last active.
test('the active tab round-trips through dispatch:live-rail-tab', () => {
  const first = render(<LiveRail {...railProps()} />);
  expect(window.localStorage.getItem('dispatch:live-rail-tab')).toBe('runs');

  selectTab('Warden');
  expect(window.localStorage.getItem('dispatch:live-rail-tab')).toBe('warden');
  first.unmount();

  render(<LiveRail {...railProps()} />);
  expect(screen.getByLabelText('Warden opening question')).toBeDefined();
});

test('a pending warden action renders the confirm card in the section and decides through the session', async () => {
  const decisions: unknown[] = [];
  const record = wardenRecord({
    state: 'ready',
    messages: [
      { role: 'user', text: 'cancel r-1', at: '2026-08-10T00:00:01Z' },
      {
        role: 'action',
        actionId: 'act-1',
        outcome: 'pending',
        text: 'Queued: Cancel run r-1',
        at: '2026-08-10T00:00:02Z',
      },
    ],
    pendingActions: [wardenAction()],
  });
  const warden = wardenSession({
    conversationId: 'w-1',
    record,
    confirmAction: (actionId: string, approve: boolean) => {
      decisions.push([actionId, approve]);
      return Promise.resolve();
    },
  });
  render(<LiveRail {...railProps({ warden })} />);
  // The pending count rides the tab's accessible name ("Warden 1").
  selectTab(/^Warden/);

  expect(screen.getByText('Needs your approval')).toBeDefined();
  expect(screen.getByText('Cancel run r-1')).toBeDefined();
  fireEvent.click(
    screen.getByRole('button', { name: 'Approve: Cancel run r-1' })
  );
  // decide() clears `decidingId` in a `finally`, a microtask after the click.
  // Settling it inside `act` keeps that update from landing after this test.
  await act(async () => {
    await Promise.resolve();
  });
  expect(decisions).toEqual([['act-1', true]]);
});

// Radix drops the inactive tab's children, so a tab flip really does unmount
// the chat. Approving runs the mutation server-side before the call resolves,
// which leaves seconds to flip — and coming back to cards that look decidable
// again is how a second click reaches an action the server already claimed.
// The lock lives on the session precisely so the remount cannot lose it.
test('a decision in flight stays locked across a tab flip', () => {
  const record = wardenRecord({
    messages: [
      {
        role: 'action',
        actionId: 'act-1',
        outcome: 'pending',
        text: 'Queued: Cancel run r-1',
        at: '2026-08-10T00:00:02Z',
      },
    ],
    pendingActions: [wardenAction()],
  });
  const warden = wardenSession({
    conversationId: 'w-1',
    record,
    decidingActionId: 'act-1',
  });
  render(<LiveRail {...railProps({ warden })} />);
  selectTab(/^Warden/);
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Approve: Cancel run r-1',
    }).disabled
  ).toBe(true);

  selectTab('Runs');
  expect(screen.queryByText('Needs your approval')).toBeNull();
  selectTab(/^Warden/);

  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Approve: Cancel run r-1',
    }).disabled
  ).toBe(true);
  expect(
    screen.getByRole<HTMLButtonElement>('button', {
      name: 'Deny: Cancel run r-1',
    }).disabled
  ).toBe(true);
});

// A warden turn in flight is an agent at work: it earns a Runs-tab row with
// the 'warden' kind label, and its "open" action is the section's Warden tab.
test('a running warden turn shows on the Runs tab and clicking it switches tabs', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'running' }),
  });
  render(<LiveRail {...railProps({ runs: [run()], warden })} />);

  expect(screen.getByText('warden')).toBeDefined();
  fireEvent.click(screen.getByText('what is going on?'));
  expect(screen.getByLabelText('Follow-up message')).toBeDefined();
  expect(window.localStorage.getItem('dispatch:live-rail-tab')).toBe('warden');
});

test('a settled warden conversation does not add a Runs-tab row', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready' }),
  });
  render(<LiveRail {...railProps({ warden })} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText('warden')).toBeNull();
});

// A failed record fetch (daemon restart → the stale id 404s, and the query has
// retry: false) leaves record undefined forever. That is a broken
// conversation, not an agent at work — no phantom running row.
test('a failed warden record fetch does not fake a running row', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'warden conversation w-1 not found (404)',
  });
  render(<LiveRail {...railProps({ warden })} />);
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText('warden')).toBeNull();
});

// A settled turn holding a queued mutation is state 'ready' — idle — but the
// section must not go quiet while an approval is stranded on the human.
test('a queued approval keeps the warden visible: waiting row plus tab badge', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready', pendingActions: [wardenAction()] }),
  });
  render(<LiveRail {...railProps({ warden })} />);

  expect(screen.queryByText('No agents running.')).toBeNull();
  expect(screen.getByText('warden')).toBeDefined();
  // The row names the thing that is actually waiting — the queued action —
  // not the conversation's opening question from possibly hours earlier.
  expect(screen.getByText('Cancel run r-1')).toBeDefined();
  expect(screen.queryByText('what is going on?')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Warden 1' })).toBeDefined();
});

test('the collapsed strip counts a live warden turn as a running agent', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'running' }),
  });
  render(
    <LiveRail {...railProps({ runs: [run()], warden, collapsed: true })} />
  );
  expect(screen.getByTitle('2 agents running').textContent).toContain('2');
});

// The collapsed icon strip cannot expand the sidebar it lives in, so a queued
// approval leads to the full Warden page instead of an inline tab.
test('the collapsed strip surfaces a queued approval and opens the Warden page', () => {
  let opened = false;
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready', pendingActions: [wardenAction()] }),
  });
  render(
    <LiveRail
      {...railProps({
        warden,
        collapsed: true,
        onOpenWarden: () => {
          opened = true;
        },
      })}
    />
  );
  fireEvent.click(
    screen.getByRole('button', { name: '1 action awaiting your approval' })
  );
  expect(opened).toBe(true);
});

// Same gate WardenView applies: no composer whose first Ask would throw a
// developer-facing 'client not ready' error.
test('the Warden tab explains when the daemon is unavailable instead of rendering a composer', () => {
  render(<LiveRail {...railProps({ daemonReady: false })} />);
  selectTab('Warden');
  expect(screen.queryByLabelText('Warden opening question')).toBeNull();
  expect(screen.getByText(/daemon isn't available/)).toBeDefined();
});

// A single failed *background* refetch mid-turn keeps the cached running
// record — the warden is demonstrably at work, and the row must not flicker
// out on a transient error.
test('a transient refetch error mid-turn keeps the running row', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'running' }),
    recordError: 'daemon busy (500)',
  });
  render(<LiveRail {...railProps({ warden })} />);
  expect(screen.getByText('warden')).toBeDefined();
  expect(screen.queryByText('No agents running.')).toBeNull();
});

// A conversation dispatchd has lost arrives here as `record: undefined` —
// useWardenSession does that veto on the 404 itself — so there is nothing left
// to advertise: no waiting row, no tab badge, no collapsed badge.
test('a conversation the daemon has lost shows no phantom approval signals', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: undefined,
    recordError: 'warden conversation w-1 not found (404)',
  });
  const { rerender } = render(<LiveRail {...railProps({ warden })} />);

  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText('Cancel run r-1')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Warden' })).toBeDefined();
  expect(screen.queryByRole('tab', { name: 'Warden 1' })).toBeNull();

  rerender(<LiveRail {...railProps({ warden, collapsed: true })} />);
  expect(
    screen.queryByRole('button', { name: '1 action awaiting your approval' })
  ).toBeNull();
});

// The other direction, which a blanket recordError veto used to break: the
// action is real and still queued server-side, so every signal has to hold.
// Going quiet here is the one failure this section exists to prevent.
test('a transient refetch error keeps every queued-approval signal', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready', pendingActions: [wardenAction()] }),
    recordError: 'daemon busy (500)',
  });
  const { rerender } = render(<LiveRail {...railProps({ warden })} />);

  expect(screen.getByText('Cancel run r-1')).toBeDefined();
  expect(screen.getByRole('tab', { name: 'Warden 1' })).toBeDefined();

  rerender(<LiveRail {...railProps({ warden, collapsed: true })} />);
  expect(
    screen.getByRole('button', { name: '1 action awaiting your approval' })
  ).toBeDefined();
});

// The section's Warden control must never be a *button* named "Warden": the
// sidebar's global nav already has one, and Playwright resolves
// `getByRole('button', { name: 'Warden' })` across the whole page under strict
// mode. A second exact match anywhere makes that locator throw, which takes
// out warden.spec.ts at its first navigation step — the only automated
// coverage of the human-gated approve path. Radix renders TabsTrigger as
// role=tab, which is what keeps the two apart; this pins that so a swap to a
// plain <Button> cannot land quietly.
test('the Warden tab is a tab, not a second button named "Warden"', () => {
  render(<LiveRail {...railProps({ runs: [run()] })} />);

  expect(screen.getByRole('tab', { name: 'Warden' })).toBeDefined();
  expect(screen.queryAllByRole('button', { name: 'Warden' })).toHaveLength(0);

  // Also on the Warden panel itself, where the compact reset lives — it is
  // deliberately named "Start a new conversation" for this reason.
  selectTab('Warden');
  expect(screen.queryAllByRole('button', { name: 'Warden' })).toHaveLength(0);
});

// The collapsed strip is the other surface that could reintroduce the clash:
// its approval badge is named for what is waiting, not for the warden.
test('the collapsed strip has no button named "Warden" either', () => {
  render(
    <LiveRail
      {...railProps({
        collapsed: true,
        warden: wardenSession({
          conversationId: 'w-1',
          record: wardenRecord({ pendingActions: [wardenAction()] }),
        }),
      })}
    />
  );

  expect(screen.queryAllByRole('button', { name: 'Warden' })).toHaveLength(0);
});

// warden.spec.ts finds the Runs-tab waiting row by the accessible name
// `/with the fake executor warden/` — the queued action's summary followed by
// the row's kind label. That label is lowercase in the DOM and only *looks*
// capitalised (Tailwind `capitalize`), which is invisible from the spec and
// would silently stop matching if the markup started capitalising it for real.
test('the waiting row is named by its action summary and a lowercase kind', () => {
  render(
    <LiveRail
      {...railProps({
        warden: wardenSession({
          conversationId: 'w-1',
          record: wardenRecord({ pendingActions: [wardenAction()] }),
        }),
      })}
    />
  );

  expect(
    screen.getByRole('button', { name: /Cancel run r-1 warden/ })
  ).toBeDefined();
});
