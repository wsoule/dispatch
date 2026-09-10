import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { useState } from 'react';

import { toggleCollapsedEpic } from '../../lib/collapsedEpics';
import { TaskBoard } from './TaskBoard';
import { TooltipProvider } from '@/ui/tooltip';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind = 'task'
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status,
      kind,
      priority: 2,
      parent,
      labels: [],
      assignee: null,
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const STATUSES = ['todo', 'in-progress', 'done'];

const EPICS = [
  task('e-1', 'Payments epic', 'todo', null, 'epic'),
  task('e-2', 'Search epic', 'todo', null, 'epic'),
  task('e-empty', 'Nothing here epic', 'todo', null, 'epic'),
];

const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1'),
  task('t-2', 'Card two', 'todo', 'e-1'),
  task('t-3', 'Card three', 'done', 'e-1'),
  task('t-4', 'Card four', 'todo', 'e-2'),
  task('t-loose', 'Unparented card', 'done'),
];

/** Owns the collapsed-lane state the same way `BoardView` does, so a click on a lane header
 * actually folds the lane in the test rather than being swallowed by a static prop. */
function Harness(props: Partial<Parameters<typeof TaskBoard>[0]> = {}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  return (
    <TooltipProvider>
      <TaskBoard
        tasks={TASKS}
        statuses={STATUSES}
        epics={EPICS}
        readyIds={new Set()}
        blockedIds={new Set()}
        liveRunStateByTaskId={new Map()}
        latestRunByTaskId={new Map()}
        epicProgressById={new Map()}
        epicConcurrencyDefault={3}
        collapsedLaneKeys={collapsed}
        onToggleLane={(key) =>
          setCollapsed((prev) => toggleCollapsedEpic(prev, key))
        }
        onSelect={() => {}}
        onWorkEpic={async () => {}}
        onStopEpic={async () => {}}
        {...props}
      />
    </TooltipProvider>
  );
}

/** Every card @dnd-kit has actually made draggable, by the title it renders. A card `useDraggable`
 * was told to disable keeps the draggable role description but reports `aria-disabled`, so the
 * selector has to exclude those or a disabled card reads as a live drag handle. */
function draggableTitles(): string[] {
  return screen
    .getAllByRole('button')
    .filter(
      (el) =>
        el.getAttribute('aria-roledescription') === 'draggable' &&
        el.getAttribute('aria-disabled') !== 'true'
    )
    .map((el) => (el.textContent ?? '').replace(/\s+/g, ' '));
}

function laneToggle(name: RegExp) {
  return screen.getByRole('button', { name });
}

test('every epic with children heads a lane, and the no-epic lane comes last', () => {
  render(<Harness />);
  const lanes = screen
    .getAllByRole('button', { expanded: true })
    .map((el) => el.textContent ?? '');
  expect(lanes).toHaveLength(3);
  expect(lanes[0]).toContain('Payments epic');
  expect(lanes[1]).toContain('Search epic');
  expect(lanes[2]).toContain('No epic');
});

// Twenty epics with three active ones must not render seventeen blank rows.
test('an epic with no children in the configured statuses is not rendered', () => {
  render(<Harness />);
  expect(screen.queryByText('Nothing here epic')).toBeNull();
});

test('clicking an epic header hides its cards, and clicking again brings them back', () => {
  render(<Harness />);
  expect(screen.queryByText('Card one')).not.toBeNull();

  fireEvent.click(laneToggle(/Payments epic/));
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card three')).toBeNull();
  // A sibling lane is untouched — collapse is per epic, not a board-wide mode.
  expect(screen.queryByText('Card four')).not.toBeNull();

  fireEvent.click(laneToggle(/Payments epic/));
  expect(screen.queryByText('Card one')).not.toBeNull();
});

// The count in a column header must never quietly shrink when work is folded away — the
// hidden cards are still there, and the header has to say so.
test('a collapsed epic moves its cards into a "+N hidden" badge on the affected columns', () => {
  render(<Harness />);
  expect(screen.queryByText(/hidden/)).toBeNull();

  fireEvent.click(laneToggle(/Payments epic/));
  const hidden = screen.getAllByText(/hidden/).map((el) => el.textContent);
  // "todo" hides t-1 and t-2, "done" hides t-3, "in-progress" had none so gets no badge.
  expect(hidden).toEqual(['+2 hidden', '+1 hidden']);
});

test('the no-epic lane collapses like any other', () => {
  render(<Harness />);
  fireEvent.click(laneToggle(/No epic/));
  expect(screen.queryByText('Unparented card')).toBeNull();
});

// Epics are containers, not objects on the board: they head a lane and are never dragged.
test('only plain task cards are draggable', () => {
  render(<Harness />);
  const titles = draggableTitles();
  expect(titles).toHaveLength(5);
  for (const epic of EPICS) {
    expect(titles.some((t) => t.includes(epic.meta.title))).toBe(false);
  }
  expect(titles.some((t) => t.includes('Card one'))).toBe(true);
});

test('an archived card is not draggable', () => {
  render(<Harness archivedTaskIds={new Set(['t-1'])} />);
  const titles = draggableTitles();
  expect(titles.some((t) => t.includes('Card one'))).toBe(false);
  expect(titles.some((t) => t.includes('Card two'))).toBe(true);
});

test('the epic header carries the epic dispatch and graph controls', () => {
  render(<Harness />);
  expect(screen.queryByRole('button', { name: 'Open e-1' })).not.toBeNull();
  expect(
    screen.queryByRole('button', { name: 'View dependency graph for e-1' })
  ).not.toBeNull();
  expect(
    screen.queryByLabelText('Epic dispatch concurrency for e-1')
  ).not.toBeNull();
  // The "No epic" lane has nothing to dispatch, so it gets none of them.
  expect(screen.getAllByRole('button', { name: 'Work' })).toHaveLength(2);
});

test('the epic dispatch button routes through the confirmation preview', () => {
  const requested: string[] = [];
  render(<Harness onRequestWorkEpic={(id) => requested.push(id)} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Work' })[0]);
  expect(requested).toEqual(['e-1']);
});

// The land affordance follows the server's own readiness rule (every child done or
// cancelled): a finished epic's header swaps the then-useless Work button for Land.
test('a finished epic swaps Work for a Land button that lands it', () => {
  const landed: string[] = [];
  const progress = new Map([
    [
      'e-1',
      {
        epicId: 'e-1',
        active: false,
        children: [
          { id: 't-1', title: 'Card one', status: 'landed' },
          { id: 't-2', title: 'Card two', status: 'dropped' },
          { id: 't-3', title: 'Card three', status: 'landed' },
        ],
        liveRuns: [],
      },
    ],
  ]);
  render(
    <Harness
      epicProgressById={progress}
      onLandEpic={(id) => {
        landed.push(id);
        return Promise.resolve();
      }}
    />
  );
  // e-1 is finished, so its lane offers Land; e-2 (no progress yet) keeps Work.
  const land = screen.getAllByRole('button', { name: 'Land' });
  expect(land).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Work' })).toHaveLength(1);
  fireEvent.click(land[0]);
  expect(landed).toEqual(['e-1']);
});

test('no Land button renders without land wiring or finished progress', () => {
  render(<Harness />);
  expect(screen.queryByRole('button', { name: 'Land' })).toBeNull();
});

test('a column header "+" opens the create modal pre-set to that status', () => {
  const added: string[] = [];
  render(<Harness onAddTask={(status) => added.push(status)} />);
  fireEvent.click(screen.getByRole('button', { name: 'New task in done' }));
  expect(added).toEqual(['done']);
});
