import type {
  RunMeta,
  RunQuestion,
  WardenAction,
  WardenRecord,
} from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, expect, test } from 'bun:test';

import type { WardenSession } from '../../hooks/useWardenSession';
import { LiveRail, useLiveRailCollapsed } from './LiveRail';

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

// The same record/action fixtures wardenThread.test.ts builds — the rail's
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
    start: () => Promise.resolve(wardenRecord()),
    sendMessage: () => Promise.resolve(wardenRecord()),
    confirmAction: () => Promise.resolve(wardenRecord()),
    reset: () => {},
    ...over,
  };
}

const NO_QUESTIONS = new Map<string, RunQuestion[]>();

function railProps(over: Partial<Parameters<typeof LiveRail>[0]> = {}) {
  return {
    runs: [],
    repoPrs: [],
    openQuestions: NO_QUESTIONS,
    warden: wardenSession(),
    daemonReady: true,
    onOpenTask: () => {},
    onOpenInbox: () => {},
    collapsed: false,
    onSetCollapsed: () => {},
    ...over,
  };
}

// Radix Tabs activates a trigger on mousedown, not click — one helper so every
// test switches tabs the way the widget actually listens.
function selectTab(name: string | RegExp) {
  fireEvent.mouseDown(screen.getByRole('tab', { name }));
}

// The rail itself persists its active tab on mount, so every test must start
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
  const onOpenTask = (
    taskId: string,
    tab: string,
    runId: string | undefined
  ) => {
    calls.push([taskId, tab, runId]);
  };
  render(<LiveRail {...railProps({ runs: [run()], onOpenTask })} />);
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

// The rail is fixed-width and sits on every project screen, so at the window's 1040px
// minimum it is the difference between a readable Diff column and a 176px sliver. These pin
// the collapse at the level happy-dom can actually decide: which element is rendered and
// what width class it carries.
test('collapsing narrows the rail to a strip and back', () => {
  let collapsed = false;
  const onSetCollapsed = (next: boolean) => {
    collapsed = next;
  };
  const { rerender } = render(
    <LiveRail {...railProps({ runs: [run()], onSetCollapsed })} />
  );

  const expanded = screen.getByRole('tab', { name: 'Runs' }).closest('aside');
  expect(expanded?.className).toContain('w-60');

  fireEvent.click(
    screen.getByRole('button', { name: 'Collapse the live agents rail' })
  );
  expect(collapsed).toBe(true);

  rerender(
    <LiveRail {...railProps({ runs: [run()], onSetCollapsed, collapsed })} />
  );

  const strip = screen
    .getByRole('button', { name: 'Expand the live agents rail' })
    .closest('aside');
  expect(strip?.className).toContain('w-9');
  expect(strip?.className).not.toContain('w-60');

  fireEvent.click(
    screen.getByRole('button', { name: 'Expand the live agents rail' })
  );
  expect(collapsed).toBe(false);
});

// The spec's "never hides" rule: a collapsed rail must still say something is waiting, or
// collapsing it becomes a way to lose the only always-on signal in the shell.
test('the collapsed strip still shows the attention count and opens the inbox', () => {
  let opened = false;
  render(
    <LiveRail
      {...railProps({
        runs: [run({ state: 'awaiting-approval' })],
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

// The key and its '1'/'0' encoding are the stored contract with an already-installed app; a
// rename silently re-expands everyone's rail. `dispatch:overview-rail` is explicitly retired
// and must not be consulted — it meant "hidden", which this rail never is.
test('the collapse preference round-trips through dispatch:live-rail', () => {
  function Probe() {
    const [collapsed, setCollapsed] = useLiveRailCollapsed();
    return (
      <button type="button" onClick={() => setCollapsed(!collapsed)}>
        {collapsed ? 'collapsed' : 'expanded'}
      </button>
    );
  }

  window.localStorage.removeItem('dispatch:live-rail');
  window.localStorage.setItem('dispatch:overview-rail', '0');
  const first = render(<Probe />);
  expect(screen.getByRole('button').textContent).toBe('expanded');
  expect(window.localStorage.getItem('dispatch:live-rail')).toBe('0');

  fireEvent.click(screen.getByRole('button'));
  expect(window.localStorage.getItem('dispatch:live-rail')).toBe('1');
  first.unmount();

  render(<Probe />);
  expect(screen.getByRole('button').textContent).toBe('collapsed');
  window.localStorage.removeItem('dispatch:live-rail');
  window.localStorage.removeItem('dispatch:overview-rail');
});

test('the Warden tab swaps the run list for the warden composer, and back', () => {
  render(<LiveRail {...railProps({ runs: [run()] })} />);

  // Runs is the default tab: the run row shows, the composer does not exist
  // yet (the chat only mounts once the Warden tab has been opened).
  expect(screen.getByText('Do the thing')).toBeDefined();
  expect(screen.queryByLabelText('Warden opening question')).toBeNull();

  selectTab('Warden');
  expect(screen.queryByText('Do the thing')).toBeNull();
  const composer = screen.getByLabelText('Warden opening question');
  expect(composer.closest('.hidden')).toBeNull();

  // Back on Runs the chat stays mounted (it holds the draft) but hidden.
  selectTab('Runs');
  expect(screen.getByText('Do the thing')).toBeDefined();
  expect(composer.closest('.hidden')).not.toBeNull();
});

// The chat's composer is local state; unmounting it on every tab flip would
// throw away a half-typed message. The wrapper hides instead.
test('a composer draft survives switching tabs', () => {
  render(<LiveRail {...railProps()} />);
  selectTab('Warden');

  const composer = screen.getByLabelText('Warden opening question');
  fireEvent.change(composer, { target: { value: 'half a thought' } });

  selectTab('Runs');
  selectTab('Warden');
  expect(
    screen.getByLabelText<HTMLTextAreaElement>('Warden opening question').value
  ).toBe('half a thought');
});

// The attention strip is the rail's one always-on signal — switching to the
// warden conversation must not hide that something is waiting on a human.
test('the attention strip stays visible on the Warden tab', () => {
  render(
    <LiveRail {...railProps({ runs: [run({ state: 'awaiting-approval' })] })} />
  );
  selectTab('Warden');
  expect(screen.getByText('1 waiting on you →')).toBeDefined();
});

// The active tab is a per-device preference like the collapse flag: a fresh
// mount (restart, project switch, expand-after-collapse) lands on whatever
// tab was last active, via dispatch:live-rail-tab.
test('the active tab round-trips through dispatch:live-rail-tab', () => {
  const first = render(<LiveRail {...railProps()} />);
  expect(window.localStorage.getItem('dispatch:live-rail-tab')).toBe('runs');

  selectTab('Warden');
  expect(window.localStorage.getItem('dispatch:live-rail-tab')).toBe('warden');
  first.unmount();

  render(<LiveRail {...railProps()} />);
  expect(screen.getByLabelText('Warden opening question')).toBeDefined();
});

test('expanding the collapsed rail returns to the last active tab', () => {
  window.localStorage.setItem('dispatch:live-rail-tab', 'warden');
  const { rerender } = render(<LiveRail {...railProps({ collapsed: true })} />);
  // Collapsed strip has no tabs at all.
  expect(screen.queryByRole('tab', { name: 'Warden' })).toBeNull();

  rerender(<LiveRail {...railProps({ collapsed: false })} />);
  expect(
    screen.getByRole('tab', { name: 'Warden' }).getAttribute('aria-selected')
  ).toBe('true');
  expect(screen.getByLabelText('Warden opening question')).toBeDefined();
});

// The rail renders the same confirm card WardenView does — approval stays
// human-gated through the identical component, no rail-only shortcut.
test('a pending warden action renders the confirm card in the rail and decides through the session', () => {
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
      return Promise.resolve(record);
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
  expect(decisions).toEqual([['act-1', true]]);
});

// A warden turn in flight is an agent at work: it earns a Runs-tab row with
// the 'warden' kind label, and its "open" action is the rail's own Warden tab.
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
// rail must not go quiet while an approval is stranded on the human.
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

test('the collapsed strip surfaces a queued approval and expands onto the Warden tab', () => {
  let collapsed = true;
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready', pendingActions: [wardenAction()] }),
  });
  const { rerender } = render(
    <LiveRail
      {...railProps({
        warden,
        collapsed,
        onSetCollapsed: (next) => {
          collapsed = next;
        },
      })}
    />
  );
  fireEvent.click(
    screen.getByRole('button', { name: '1 warden action awaiting approval' })
  );
  expect(collapsed).toBe(false);

  rerender(<LiveRail {...railProps({ warden, collapsed })} />);
  expect(screen.getByText('Needs your approval')).toBeDefined();
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

// Warden conversations are in-memory in dispatchd: a cached record whose
// refetch now fails is usually a restart that wiped the conversation, so its
// pendingActions are ghosts — no waiting row, no tab badge, no collapsed
// badge for an action that no longer exists anywhere.
test('a stale record with a failing refetch shows no phantom approval signals', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({ state: 'ready', pendingActions: [wardenAction()] }),
    recordError: 'warden conversation w-1 not found (404)',
  });
  const { rerender } = render(<LiveRail {...railProps({ warden })} />);

  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText('Cancel run r-1')).toBeNull();
  expect(screen.getByRole('tab', { name: 'Warden' })).toBeDefined();
  expect(screen.queryByRole('tab', { name: 'Warden 1' })).toBeNull();

  rerender(<LiveRail {...railProps({ warden, collapsed: true })} />);
  expect(
    screen.queryByRole('button', { name: '1 warden action awaiting approval' })
  ).toBeNull();
});

// The chat is display:none on the Runs tab, where scrollHeight is 0 and every
// scroll pin is a no-op — returning to the Warden tab must re-pin the
// transcript to the newest row. scrollHeight/scrollTop are defined by hand
// because happy-dom has no layout.
test('returning to the Warden tab re-pins the transcript', () => {
  const warden = wardenSession({
    conversationId: 'w-1',
    record: wardenRecord({
      messages: [
        { role: 'user', text: 'status?', at: '2026-08-10T00:00:01Z' },
        { role: 'assistant', text: 'All quiet.', at: '2026-08-10T00:00:02Z' },
      ],
    }),
  });
  render(<LiveRail {...railProps({ warden })} />);
  selectTab('Warden');

  const log = screen.getByRole('log');
  Object.defineProperty(log, 'scrollHeight', {
    value: 480,
    configurable: true,
  });
  Object.defineProperty(log, 'scrollTop', {
    value: 0,
    writable: true,
    configurable: true,
  });

  selectTab('Runs');
  expect(log.scrollTop).toBe(0);
  selectTab('Warden');
  expect(log.scrollTop).toBe(480);
});
