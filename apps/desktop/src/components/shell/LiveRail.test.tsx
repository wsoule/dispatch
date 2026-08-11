import type { RunMeta, RunQuestion } from '@dispatch/client';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

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

const NO_QUESTIONS = new Map<string, RunQuestion[]>();

test('renders the idle copy with no runs', () => {
  render(
    <LiveRail
      runs={[]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
      collapsed={false}
      onSetCollapsed={() => {}}
    />
  );
  expect(screen.getByText('No agents running.')).toBeDefined();
  expect(screen.queryByText(/waiting on you/)).toBeNull();
});

test('renders a row per live run, clicking opens its task', () => {
  const onOpenTask = (
    taskId: string,
    tab: string,
    runId: string | undefined
  ) => {
    calls.push([taskId, tab, runId]);
  };
  const calls: unknown[] = [];
  render(
    <LiveRail
      runs={[run()]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={onOpenTask}
      onOpenInbox={() => {}}
      collapsed={false}
      onSetCollapsed={() => {}}
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
      runs={[run({ state: 'awaiting-approval' })]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {
        opened = true;
      }}
      collapsed={false}
      onSetCollapsed={() => {}}
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
  const { rerender } = render(
    <LiveRail
      runs={[run()]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
      collapsed={collapsed}
      onSetCollapsed={(next) => {
        collapsed = next;
      }}
    />
  );

  const expanded = screen.getByText('Live agents').closest('aside');
  expect(expanded?.className).toContain('w-60');

  fireEvent.click(
    screen.getByRole('button', { name: 'Collapse the live agents rail' })
  );
  expect(collapsed).toBe(true);

  rerender(
    <LiveRail
      runs={[run()]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {}}
      collapsed={collapsed}
      onSetCollapsed={(next) => {
        collapsed = next;
      }}
    />
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
      runs={[run({ state: 'awaiting-approval' })]}
      repoPrs={[]}
      openQuestions={NO_QUESTIONS}
      onOpenTask={() => {}}
      onOpenInbox={() => {
        opened = true;
      }}
      collapsed
      onSetCollapsed={() => {}}
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
