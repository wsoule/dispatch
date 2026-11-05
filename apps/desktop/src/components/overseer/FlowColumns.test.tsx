import type {
  MergeQueueEntry,
  MilestoneProgress,
  RunMeta,
} from '@dispatch/client';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { LEAVE_MS } from '../../lib/flowList';
import {
  ColumnInSheet,
  InflowColumn,
  OutflowColumn,
  outflowCount,
  SheetTitle,
  spendLine,
} from './FlowColumns';

function run(id: string, state: RunMeta['state'], title: string): RunMeta {
  return {
    id,
    taskId: `t-${id}`,
    taskTitle: title,
    state,
    createdAt: '2026-10-06T09:00:00Z',
    updatedAt: '2026-10-06T09:00:00Z',
  } as RunMeta;
}

test('Going out lists live runs, opens their task, and says so when nothing runs', () => {
  const opened: string[] = [];
  const view = render(
    <OutflowColumn
      runs={[
        run('a', 'running', 'Warm the cache'),
        run('b', 'finished', 'Done one'),
      ]}
      merges={[]}
      setAside={[]}
      onOpenTask={(id) => opened.push(id)}
    />
  );
  expect(screen.getByRole('heading', { name: /Going out\s*1/ })).toBeTruthy();
  expect(screen.queryByText('Done one')).toBeNull();
  fireEvent.click(screen.getByText('Warm the cache'));
  expect(opened).toEqual(['t-a']);
  view.unmount();

  render(
    <OutflowColumn runs={[]} merges={[]} setAside={[]} onOpenTask={() => {}} />
  );
  expect(screen.getByText('Nothing is running.')).toBeTruthy();
});

test('a run that finishes slides out before it leaves', async () => {
  const live = [run('a', 'running', 'Warm the cache')];
  const view = render(
    <OutflowColumn
      runs={live}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
    />
  );
  view.rerender(
    <OutflowColumn runs={[]} merges={[]} setAside={[]} onOpenTask={() => {}} />
  );
  // data-leaving is the module's hook for the slide out (and, without
  // motion, the dim); the row stops taking clicks meanwhile.
  const leaving = screen
    .getByText('Warm the cache')
    .closest('[data-leaving="true"]');
  expect(leaving).not.toBeNull();
  expect(leaving?.getAttribute('role')).toBe('listitem');
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, LEAVE_MS + 50));
  });
  expect(screen.queryByText('Warm the cache')).toBeNull();
});

test('Coming in counts what waits and says so when nothing does', () => {
  render(<InflowColumn count={0}>{null}</InflowColumn>);
  expect(screen.getByRole('heading', { name: /Coming in\s*0/ })).toBeTruthy();
  expect(screen.getByText('Nothing is waiting on you.')).toBeTruthy();
});

function session(
  milestoneId: string,
  state: 'active' | 'paused',
  live: number
): MilestoneProgress {
  return {
    milestoneId,
    active: state === 'active',
    session: { milestoneId, state, maxSpendUsd: 60 },
    spend: { settledUsd: 12.5, maxSpendUsd: 60 },
    children: [],
    waves: [],
    liveRuns: Array.from({ length: live }, (_, i) =>
      run(`${milestoneId}-${i}`, 'running', 'child')
    ),
  } as unknown as MilestoneProgress;
}

test('Going out lists live milestone sessions with their spend and opens them', () => {
  const opened: string[] = [];
  render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={(id) => opened.push(id)}
      sessions={[session('e-1', 'active', 2), session('e-2', 'paused', 0)]}
      milestoneTitle={(id) => (id === 'e-1' ? 'Checkout rework' : id)}
    />
  );
  expect(screen.getByRole('heading', { name: /Going out\s*2/ })).toBeTruthy();
  const rows = screen.getAllByTestId('overseer-session-row');
  expect(rows.map((r) => r.textContent)).toEqual([
    'Checkout rework › 2 running$12.50 / $60',
    'e-2 › paused$12.50 / $60',
  ]);
  fireEvent.click(screen.getByText('Checkout rework'));
  expect(opened).toEqual(['e-1']);
});

// The status table: paused is grey (muted), amber is for blocked. A paused
// session's mark is the muted pause glyph; a live one keeps the info mark.
test('a paused session is marked muted, a live one info', () => {
  render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      sessions={[session('e-1', 'active', 2), session('e-2', 'paused', 0)]}
    />
  );
  const [live, paused] = screen.getAllByTestId('overseer-session-row');
  const pausedMark = paused.querySelector('[data-slot="state-mark"]');
  expect(pausedMark?.getAttribute('data-state')).toBe('paused');
  expect(pausedMark?.getAttribute('data-tone')).toBe('muted');
  const liveMark = live.querySelector('[data-slot="state-mark"]');
  expect(liveMark?.getAttribute('data-state')).toBe('working');
  expect(liveMark?.getAttribute('data-tone')).toBe('info');
});

test('Landing offers Merge all ready while finished work waits, even with nothing queued', async () => {
  let merged = 0;
  const view = render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      mergeReady={3}
      onMergeAll={() => {
        merged++;
        return Promise.resolve();
      }}
    />
  );
  expect(screen.queryByText('Nothing is running.')).toBeNull();
  const button = screen.getByTestId('overseer-merge-all');
  expect(button.textContent).toBe('Merge all ready (3)');
  await act(async () => {
    fireEvent.click(button);
    await Promise.resolve();
  });
  expect(merged).toBe(1);
  view.rerender(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      mergeReady={0}
      onMergeAll={() => Promise.resolve()}
    />
  );
  expect(screen.queryByTestId('overseer-merge-all')).toBeNull();
  expect(screen.getByText('Nothing is running.')).toBeTruthy();
});

test('the head reads today’s spend and the live ceilings, and hides at zero', () => {
  expect(spendLine(4.5, null)).toBe('$4.50 today');
  expect(spendLine(0, null)).toBeNull();
  expect(spendLine(null, { live: 0, settledUsd: 0, ceilingUsd: null })).toBe(
    null
  );
  expect(spendLine(4.5, { live: 2, settledUsd: 41.2, ceilingUsd: 120 })).toBe(
    '$4.50 today · 2 milestones live · $41.20 of $120 ceilings'
  );
  render(
    <OutflowColumn
      runs={[]}
      merges={[]}
      setAside={[]}
      onOpenTask={() => {}}
      spendToday={4.5}
    />
  );
  expect(screen.getByTestId('overseer-spend').textContent).toBe('$4.50 today');
});

test('the column heads carry their glossary hints', () => {
  render(
    <>
      <InflowColumn count={0}>{null}</InflowColumn>
      <OutflowColumn
        runs={[]}
        merges={[]}
        setAside={[]}
        onOpenTask={() => {}}
      />
    </>
  );
  expect(document.querySelector('[data-glossary="comingIn"]')).not.toBeNull();
  expect(document.querySelector('[data-glossary="goingOut"]')).not.toBeNull();
  // The heading's name is unchanged by the hint.
  expect(screen.getByRole('heading', { name: /Coming in\s*0/ })).toBeTruthy();
});

test('each head is one h2 whose name carries its count', () => {
  render(
    <>
      <InflowColumn count={3}>{null}</InflowColumn>
      <OutflowColumn
        runs={[run('a', 'running', 'Warm the cache')]}
        merges={[]}
        setAside={[]}
        onOpenTask={() => {}}
      />
    </>
  );
  const heads = screen.getAllByRole('heading', { level: 2 });
  expect(heads.map((h) => h.textContent)).toEqual([
    'Coming in 3',
    'Going out 1',
  ]);
  expect(screen.getByRole('heading', { name: 'Coming in 3' })).toBeTruthy();
  expect(screen.getByRole('heading', { name: 'Going out 1' })).toBeTruthy();
  // The groups inside a column sit one level under its head.
  expect(
    screen.getByRole('heading', { level: 3, name: 'Running' })
  ).toBeTruthy();
  // A live run reads its state in the crumb; its dot is the info tone.
  const row = screen.getByText('Warm the cache').closest('[role="listitem"]');
  expect(row?.textContent).toContain('running');
  expect(row?.querySelector('[data-tone="info"]')).not.toBeNull();
});

// In a sheet the SlideOver's title (SheetTitle) is the column's name and
// count, so the column draws no head of its own and its groups stay h3
// under that h2.
test('in a sheet the columns take -sheet test ids and leave their name to the title', () => {
  render(
    <>
      <h2>
        <SheetTitle column="out" count={1} />
      </h2>
      <ColumnInSheet>
        <InflowColumn count={0}>{null}</InflowColumn>
        <OutflowColumn
          runs={[run('a', 'running', 'Warm the cache')]}
          merges={[]}
          setAside={[]}
          onOpenTask={() => {}}
        />
      </ColumnInSheet>
    </>
  );
  expect(screen.queryByTestId('overseer-inflow')).toBeNull();
  expect(screen.queryByTestId('overseer-outflow')).toBeNull();
  const inflow = screen.getByTestId('overseer-inflow-sheet');
  const outflow = screen.getByTestId('overseer-outflow-sheet');
  // The one h2 is the title, with the glossary term on the name.
  const title = screen.getByRole('heading', { level: 2, name: 'Going out 1' });
  expect(title.querySelector('[data-glossary="goingOut"]')).not.toBeNull();
  expect(within(inflow).queryAllByRole('heading')).toHaveLength(0);
  expect(
    within(outflow)
      .getAllByRole('heading')
      .map((heading) => `${heading.tagName} ${heading.textContent}`)
  ).toEqual(['H3 Running']);
});

test('outflowCount counts what Going out lists, as its head does', () => {
  const runs = [
    run('a', 'running', 'Warm the cache'),
    run('b', 'finished', 'Done already'),
  ];
  expect(outflowCount({ runs, merges: [], setAside: 2 })).toBe(3);
  render(
    <OutflowColumn
      runs={runs}
      merges={[]}
      setAside={[<div key="x" />, <div key="y" />]}
      onOpenTask={() => {}}
    />
  );
  expect(screen.getByRole('heading', { name: 'Going out 3' })).toBeTruthy();
});

test('Landing rows open their task and set-aside cards sit under their own head', () => {
  const opened: string[] = [];
  render(
    <OutflowColumn
      runs={[]}
      merges={[
        {
          runId: 'r-1',
          taskId: 't-1',
          taskTitle: 'Ship the cart',
          state: 'waiting-github',
        } as unknown as MergeQueueEntry,
      ]}
      setAside={[
        <div key="c" role="listitem">
          A docked talk
        </div>,
      ]}
      onOpenTask={(id) => opened.push(id)}
    />
  );
  expect(screen.getByRole('heading', { name: 'Going out 2' })).toBeTruthy();
  const row = screen.getByText('Ship the cart').closest('[role="listitem"]');
  // The merge state reads at the row's end, with its dash spelled out.
  expect(row?.querySelector('[data-slot="list-item-date"]')?.textContent).toBe(
    'waiting github'
  );
  fireEvent.click(screen.getByText('Ship the cart'));
  expect(opened).toEqual(['t-1']);
  expect(screen.getByRole('heading', { name: 'Set aside' })).toBeTruthy();
  expect(screen.getByText('A docked talk')).toBeTruthy();
});
