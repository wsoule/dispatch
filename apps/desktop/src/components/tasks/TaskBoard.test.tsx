import type {
  EpicProgress,
  EpicProgressChild,
  EpicSession,
  ReadinessReading,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { PRIORITY_ORDER } from '@dispatch/core/browser';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { Profiler, type ReactNode, useState } from 'react';

import { toggleCollapsedGroup } from '../../lib/collapsedEpics';
import type { WorkEpicOptions } from '../../lib/epicSession';
import { priorityLabel } from '../../lib/taskDisplay';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksSubGrouping,
} from '../../lib/tasksPrefs';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../shell/ShellActionsContext';
import { TaskBoard } from './TaskBoard';
import { TooltipProvider } from '@/ui/tooltip';

function task(
  id: string,
  title: string,
  status: string,
  parent: string | null = null,
  kind = 'task',
  extra: { priority?: string; assignee?: string; labels?: string[] } = {}
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status,
      kind,
      priority: extra.priority ?? 'medium',
      parent,
      milestone: null,
      labels: extra.labels ?? [],
      assignee: extra.assignee ?? 'none',
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

const STATUSES = ['todo', 'in-progress', 'done'];
const NO_KEYS: ReadonlySet<string> = new Set();

// A progress row with the session/spend/wave halves defaulted, so a test states only the
// children it cares about.
function progressFor(
  epicId: string,
  children: Pick<EpicProgressChild, 'id' | 'title' | 'status'>[],
  overrides: Partial<EpicProgress> = {}
): EpicProgress {
  return {
    epicId,
    active: false,
    session: null,
    spend: {
      settledUsd: 0,
      liveCount: 0,
      estimatedLiveUsd: 0,
      runsStarted: 0,
      maxSpendUsd: null,
      maxRuns: null,
    },
    children: children.map((c) => ({
      ...c,
      phase: c.status === 'landed' ? 'landed' : 'queued',
      wave: 1,
      openFindings: 0,
    })),
    waves: [],
    liveRuns: [],
    ...overrides,
  };
}

function sessionWith(
  state: EpicSession['state'],
  overrides: Partial<EpicSession> = {}
): EpicSession {
  return {
    epicId: 'e-1',
    concurrency: 3,
    executor: 'claude',
    state,
    maxSpendUsd: 60,
    maxRuns: 20,
    startedAt: '2026-09-20T00:00:00.000Z',
    startedBy: null,
    scope: 'plan',
    updatedAt: '2026-09-20T00:00:00.000Z',
    active: state === 'active',
    ...overrides,
  };
}

const EPICS = [
  task('e-1', 'Payments epic', 'todo', null, 'epic'),
  task('e-2', 'Search epic', 'todo', null, 'epic'),
  task('e-empty', 'Nothing here epic', 'todo', null, 'epic'),
];

const TASKS = [
  ...EPICS,
  task('t-1', 'Card one', 'todo', 'e-1', 'task', {
    priority: 'urgent',
    assignee: 'human:wyat',
    labels: ['ui'],
  }),
  task('t-2', 'Card two', 'todo', 'e-1', 'task', {
    priority: 'low',
    assignee: 'agent:claude',
    labels: ['docs'],
  }),
  task('t-3', 'Card three', 'done', 'e-1', 'task', {
    priority: 'urgent',
    assignee: 'human:alice',
  }),
  task('t-4', 'Card four', 'todo', 'e-2', 'task', { priority: 'none' }),
  task('t-loose', 'Unparented card', 'done'),
];

/** The display model with one sub-grouping — the lanes the board draws. */
function display(subGrouping: TasksSubGrouping) {
  return { ...DEFAULT_TASKS_DISPLAY, subGrouping };
}

/** The shell seam the board needs: `+` presets and task opens. Records what it was asked. */
function shellWith(
  presets: CreateTaskPreset[],
  opened: [string, string | undefined][] = []
) {
  const noop = () => {};
  const actions = {
    openTask: (taskId: string, tab?: string) => {
      opened.push([taskId, tab]);
    },
    openThread: noop,
    peekTask: noop,
    openCreateTask: (preset?: CreateTaskPreset) => {
      presets.push(preset ?? {});
    },
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
  } satisfies ShellActions;
  return function Shell({ children }: { children: ReactNode }) {
    return (
      <ShellActionsProvider value={actions}>{children}</ShellActionsProvider>
    );
  };
}

/** Owns the collapsed-lane state the same way `BoardView` does, so a click on a lane header
 * actually folds the lane in the test rather than being swallowed by a static prop. */
function Harness({
  presets = [],
  opened = [],
  ...props
}: Partial<Parameters<typeof TaskBoard>[0]> & {
  presets?: CreateTaskPreset[];
  opened?: [string, string | undefined][];
}) {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const Shell = shellWith(presets, opened);
  return (
    <Shell>
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
          display={display('epic')}
          collapsedLaneKeys={collapsed}
          onToggleLane={(key) =>
            setCollapsed((prev) => toggleCollapsedGroup(prev, key))
          }
          onSelect={() => {}}
          onWorkEpic={async () => {}}
          onStopEpic={async () => {}}
          {...props}
        />
      </TooltipProvider>
    </Shell>
  );
}

// A menu positions itself a microtask after mount (floating-ui) and a header verb clears
// its busy flag after its handler resolves, so both run inside an async `act` that lets the
// queue drain before asserting.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
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

/** The lane headers on screen, by title, in order. */
function laneTitles(): string[] {
  return Array.from(document.querySelectorAll('[data-lane-key]')).map(
    (section) =>
      section.querySelector('[data-slot=group-header-name] button')
        ?.textContent ?? ''
  );
}

/** The lane's title button — an exact name, since the lane's `+` is named after it too. */
function laneToggle(name: string) {
  return screen.getByRole('button', { name });
}

function columnHeaders(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot=board-column-header]')
  );
}

test('every epic with children heads a lane, and the no-epic lane comes last', () => {
  render(<Harness />);
  expect(laneTitles()).toEqual(['Payments epic', 'Search epic', 'No epic']);
  for (const title of laneTitles()) {
    expect(laneToggle(title).getAttribute('aria-expanded')).toBe('true');
  }
});

// Twenty epics with three active ones must not render seventeen blank rows.
test('an epic with no children in the configured statuses is not rendered', () => {
  render(<Harness />);
  expect(screen.queryByText('Nothing here epic')).toBeNull();
});

test('clicking an epic header hides its cards, and clicking again brings them back', () => {
  render(<Harness />);
  expect(screen.queryByText('Card one')).not.toBeNull();

  fireEvent.click(laneToggle('Payments epic'));
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card three')).toBeNull();
  // A sibling lane is untouched — collapse is per epic, not a board-wide mode.
  expect(screen.queryByText('Card four')).not.toBeNull();

  fireEvent.click(laneToggle('Payments epic'));
  expect(screen.queryByText('Card one')).not.toBeNull();
});

// The column count is the one number that never moves: folding a lane hides cards, it does
// not remove work from the status.
test('a column header keeps its plain count when a lane collapses', () => {
  render(<Harness />);
  const todo = columnHeaders()[0];
  expect(todo.textContent).toContain('3');
  fireEvent.click(laneToggle('Payments epic'));
  expect(columnHeaders()[0].textContent).toContain('3');
  expect(screen.queryByText(/hidden/)).toBeNull();
});

test('the no-epic lane collapses like any other', () => {
  render(<Harness />);
  fireEvent.click(laneToggle('No epic'));
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

test('the epic header carries the epic dispatch and flight plan controls as pills', () => {
  const opened: [string, string | undefined][] = [];
  render(<Harness opened={opened} />);
  // The id chip is the one open affordance; the shared controls' Open button stays off.
  expect(screen.queryByRole('button', { name: 'Open e-1' })).not.toBeNull();
  expect(
    screen.queryByRole('button', { name: 'Open Payments epic' })
  ).toBeNull();
  // The graph button opens the epic's full Flight Plan.
  fireEvent.click(
    screen.getByRole('button', { name: 'Open the flight plan for e-1' })
  );
  expect(opened).toEqual([['e-1', 'plan']]);
  const concurrency = screen.getByLabelText(
    'Epic dispatch concurrency for e-1'
  );
  expect(concurrency.tagName).toBe('BUTTON');
  expect(concurrency.textContent).toBe('3×');
  expect(concurrency.className).toContain('rounded-pill');
  // The "No epic" lane has nothing to dispatch, so it gets none of them.
  const work = screen.getAllByRole('button', { name: 'Send agents…' });
  expect(work).toHaveLength(2);
  expect(work[0]?.className).toContain('rounded-pill');
});

test('the epic dispatch button routes through the confirmation preview', () => {
  const requested: string[] = [];
  render(<Harness onRequestWorkEpic={(id) => requested.push(id)} />);
  fireEvent.click(screen.getAllByRole('button', { name: 'Send agents…' })[0]);
  expect(requested).toEqual(['e-1']);
});

test('without a preview handler Send agents… starts a session at the picked concurrency', async () => {
  const worked: [string, WorkEpicOptions][] = [];
  render(
    <Harness
      onWorkEpic={(id, opts) => {
        worked.push([id, opts]);
        return Promise.resolve();
      }}
    />
  );
  await settle(() => {
    fireEvent.click(screen.getAllByRole('button', { name: 'Send agents…' })[0]);
  });
  expect(worked).toEqual([['e-1', { concurrency: 3 }]]);
});

test('an active session shows Pause and Stop, and a paused one Resume and Raise ceiling…', async () => {
  const paused: string[] = [];
  const resumed: string[] = [];
  const raised: string[] = [];
  const children = [
    { id: 't-1', title: 'Card one', status: 'working' },
    { id: 't-2', title: 'Card two', status: 'todo' },
    { id: 't-3', title: 'Card three', status: 'done' },
  ];
  const { unmount } = render(
    <Harness
      epicProgressById={
        new Map([
          [
            'e-1',
            progressFor('e-1', children, {
              active: true,
              session: sessionWith('active'),
            }),
          ],
        ])
      }
      onPauseEpic={(id) => {
        paused.push(id);
        return Promise.resolve();
      }}
      onResumeEpic={(id) => {
        resumed.push(id);
        return Promise.resolve();
      }}
      onRaiseCeilingEpic={(id) => raised.push(id)}
    />
  );
  // The concurrency picker belongs to a fresh session; a live one chose it already.
  expect(
    screen.queryByLabelText('Epic dispatch concurrency for e-1')
  ).toBeNull();
  expect(screen.getAllByRole('button', { name: 'Send agents…' })).toHaveLength(
    1
  );
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  });
  expect(paused).toEqual(['e-1']);
  expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
  unmount();

  render(
    <Harness
      epicProgressById={
        new Map([
          [
            'e-1',
            progressFor('e-1', children, {
              session: sessionWith('paused', { pausedReason: 'budget' }),
            }),
          ],
        ])
      }
      onResumeEpic={(id) => {
        resumed.push(id);
        return Promise.resolve();
      }}
      onRaiseCeilingEpic={(id) => raised.push(id)}
    />
  );
  expect(screen.getByText('Paused — budget ceiling')).not.toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  });
  fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling…' }));
  expect(resumed).toEqual(['e-1']);
  expect(raised).toEqual(['e-1']);
});

test('a header without pause wiring shows only Stop on an active session', () => {
  render(
    <Harness
      epicProgressById={
        new Map([
          [
            'e-1',
            progressFor(
              'e-1',
              [{ id: 't-1', title: 'Card one', status: 'working' }],
              {
                active: true,
                session: sessionWith('active'),
              }
            ),
          ],
        ])
      }
    />
  );
  expect(screen.queryByRole('button', { name: 'Pause' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Stop' })).not.toBeNull();
});

// The land affordance follows the server's own readiness rule (every child done or
// cancelled): a finished epic's header swaps the then-useless Work button for Land.
test('a finished epic swaps Work for a Land button that lands it', async () => {
  const landed: string[] = [];
  const progress = new Map([
    [
      'e-1',
      progressFor('e-1', [
        { id: 't-1', title: 'Card one', status: 'landed' },
        { id: 't-2', title: 'Card two', status: 'dropped' },
        { id: 't-3', title: 'Card three', status: 'landed' },
      ]),
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
  // e-1 is finished, so its lane offers Land; e-2 (no progress yet) keeps Send agents….
  const land = screen.getAllByRole('button', { name: 'Land' });
  expect(land).toHaveLength(1);
  expect(screen.getAllByRole('button', { name: 'Send agents…' })).toHaveLength(
    1
  );
  // The `◔ 3/3` progress glyph sits beside it.
  expect(
    document.querySelector('[data-slot=milestone-progress]')?.textContent
  ).toBe('3/3');
  await settle(() => {
    fireEvent.click(land[0]);
  });
  expect(landed).toEqual(['e-1']);
});

// The regression this guards: a dash length computed from a wider circle than the pie is
// drawn on filled the disk at twice the real fraction (a full disk at 50%).
test('the ◔ progress pie exposes exactly the done fraction of its arc', () => {
  const progress = new Map([
    [
      'e-1',
      progressFor('e-1', [
        { id: 't-1', title: 'Card one', status: 'landed' },
        { id: 't-2', title: 'Card two', status: 'ready' },
      ]),
    ],
  ]);
  render(<Harness epicProgressById={progress} />);
  expect(
    document.querySelector('[data-slot=milestone-progress]')?.textContent
  ).toBe('1/2');
  const pie = document.querySelector(
    '[data-slot=milestone-progress] circle[r="2"]'
  );
  const [dash] = (pie?.getAttribute('stroke-dasharray') ?? '').split(' ');
  const offset = Number(pie?.getAttribute('stroke-dashoffset'));
  // The pie is `StatusIcon`'s: a 12.19 arc, half of it hidden by the offset at 1/2 done.
  expect(Number(dash)).toBeCloseTo(12.19, 2);
  expect(offset).toBeCloseTo(6.09, 2);
});

test('the concurrency pill opens a radio menu with the current choice checked', async () => {
  render(<Harness />);
  await settle(() => {
    fireEvent.click(
      screen.getAllByLabelText('Epic dispatch concurrency for e-1')[0]
    );
  });
  const items = screen.getAllByRole('menuitemradio');
  expect(items.map((item) => item.textContent)).toEqual([
    '1×',
    '2×',
    '3×',
    '4×',
  ]);
  expect(
    items.map((item) => item.getAttribute('aria-checked') === 'true')
  ).toEqual([false, false, true, false]);
  await settle(() => {
    fireEvent.click(items[0]);
  });
  expect(
    screen.getAllByLabelText('Epic dispatch concurrency for e-1')[0].textContent
  ).toBe('1×');
});

test('no Land button renders without land wiring or finished progress', () => {
  render(<Harness />);
  expect(screen.queryByRole('button', { name: 'Land' })).toBeNull();
});

test('columns are 348px with 12px side padding, headers 44px, cards 322px', () => {
  render(<Harness />);
  const headers = columnHeaders();
  expect(headers).toHaveLength(3);
  for (const header of headers) {
    expect(header.className).toContain('w-[348px]');
    expect(header.className).toContain('px-3');
    expect(header.className).toContain('h-11');
  }
  // Glyph, 12px muted name, plain count — nothing mono, no pill around the name.
  const todo = headers[0];
  expect(todo.querySelector('svg[aria-label="Status: todo"]')).not.toBeNull();
  expect(todo.querySelector('.text-\\[12px\\]')?.textContent).toBe('Todo');
  expect(todo.className).not.toContain('font-mono');
  const card = screen.getByText('Card one').closest('[data-slot=task-card]');
  expect(card?.className).toContain('w-[322px]');
  expect(card?.className).toContain('bg-surface-quaternary');
  expect(card?.className).toContain('shadow-card');
  // Column stacks carry no background of their own — cards sit on the panel.
  const column = document.querySelector('[data-slot=board-column]');
  expect(column?.className).not.toMatch(/\bbg-(?!surface-hover)/);
});

test('the column ··· menu offers collapse, hide and dispatch-all', async () => {
  const collapsed: string[] = [];
  const hidden: string[] = [];
  render(
    <Harness
      onToggleColumnCollapsed={(s) => collapsed.push(s)}
      onHideColumn={(s) => hidden.push(s)}
    />
  );
  await settle(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Todo column options' })
    );
  });
  const items = screen.getAllByRole('menuitem').map((i) => i.textContent);
  expect(items).toEqual([
    'Collapse column',
    'Hide column',
    'Dispatch all ready',
  ]);
  await settle(() => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Collapse column' }));
  });
  expect(collapsed).toEqual(['todo']);
  await settle(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Done column options' })
    );
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('menuitem', { name: 'Hide column' }));
  });
  expect(hidden).toEqual(['done']);
});

test('Dispatch all ready dispatches every ready card in the column', async () => {
  const dispatched: string[] = [];
  render(
    <Harness
      readyIds={new Set(['t-1', 't-4', 't-loose'])}
      onDispatch={(id) => {
        dispatched.push(id);
        return Promise.resolve();
      }}
    />
  );
  await settle(() => {
    fireEvent.click(
      screen.getByRole('button', { name: 'Todo column options' })
    );
  });
  await settle(() => {
    fireEvent.click(
      screen.getByRole('menuitem', { name: 'Dispatch all ready (2)' })
    );
  });
  expect(dispatched.sort()).toEqual(['t-1', 't-4']);
});

test('a collapsed column folds to a strip that expands on click', () => {
  const toggled: string[] = [];
  render(
    <Harness
      collapsedColumns={new Set(['in-progress'])}
      onToggleColumnCollapsed={(s) => toggled.push(s)}
    />
  );
  const strip = columnHeaders()[1];
  expect(strip.dataset['collapsed']).toBe('true');
  expect(strip.className).toContain('w-11');
  fireEvent.click(
    screen.getByRole('button', { name: 'Expand In Progress column' })
  );
  expect(toggled).toEqual(['in-progress']);
});

test('a column header "+" opens the creator pre-set to that status', () => {
  const presets: CreateTaskPreset[] = [];
  render(<Harness presets={presets} />);
  fireEvent.click(screen.getByRole('button', { name: 'New task in done' }));
  expect(presets).toEqual([{ status: 'done' }]);
});

test('a lane header "+" presets the epic', () => {
  const presets: CreateTaskPreset[] = [];
  render(<Harness presets={presets} />);
  fireEvent.click(
    screen.getByRole('button', { name: 'New task in Payments epic' })
  );
  expect(presets).toEqual([{ epic: 'e-1' }]);
});

test('the flat board has no lane headers and crumbs each card with its epic', () => {
  render(<Harness display={display('none')} />);
  expect(document.querySelector('[data-slot=group-header]')).toBeNull();
  expect(
    document.querySelector('[data-lane-key]')?.getAttribute('data-lane-key')
  ).toBe('all');
  const card = screen.getByText('Card one').closest('[data-slot=task-card]');
  const meta = card?.querySelector('[data-slot=task-card-meta]');
  expect(meta?.textContent).toContain('t-1');
  expect(meta?.querySelector('[data-slot=task-card-crumb]')?.textContent).toBe(
    'Payments epic'
  );
});

/** The `group-header` lane headers on screen: their icon slot and title, in order. */
function groupHeaders(): { title: string; icon: Element | null }[] {
  return Array.from(document.querySelectorAll('[data-slot=group-header]')).map(
    (header) => ({
      title:
        header.querySelector('[data-slot=group-header-name] button')
          ?.textContent ?? '',
      icon: header.querySelector('[data-slot=group-header-icon] > *'),
    })
  );
}

// Sub-grouping › Assignee: agents lead, then people by handle, then the unassigned lane —
// each header the assignee's own 16px avatar, and the cards keep their epic crumb.
test('assignee lanes put agents first and Unassigned last, avatar on every header', () => {
  render(<Harness display={display('assignee')} />);
  const headers = groupHeaders();
  expect(headers.map((h) => h.title)).toEqual([
    'claude',
    'alice',
    'wyat',
    'Unassigned',
  ]);
  // An initials avatar for the agent and the people, the dashed ring for Unassigned.
  expect(headers.map((h) => h.icon?.getAttribute('data-slot'))).toEqual([
    'initials-avatar',
    'initials-avatar',
    'initials-avatar',
    'assignee-avatar',
  ]);
  expect(headers[0]?.icon?.getAttribute('data-kind')).toBe('agent');
  expect(
    Array.from(document.querySelectorAll('[data-lane-key]')).map((s) =>
      s.getAttribute('data-lane-key')
    )
  ).toEqual([
    'assignee:agent:claude',
    'assignee:human:alice',
    'assignee:human:wyat',
    'assignee:none',
  ]);
  // Epics head epic lanes only; on any other board they are not cards either.
  expect(draggableTitles()).toHaveLength(5);
  expect(draggableTitles().some((t) => t.startsWith('e-'))).toBe(false);
  const card = screen.getByText('Card one').closest('[data-slot=task-card]');
  expect(card?.querySelector('[data-slot=task-card-crumb]')?.textContent).toBe(
    'Payments epic'
  );
  // No `+` on the lane headers (the column headers keep theirs): a new task cannot be
  // preset to an assignee.
  expect(
    screen
      .getAllByRole('button', { name: /^New task in/ })
      .map((b) => b.getAttribute('aria-label'))
  ).toEqual([
    'New task in todo',
    'New task in in-progress',
    'New task in done',
  ]);
});

test('priority lanes follow PRIORITY_ORDER with the glyph on each header', () => {
  render(<Harness display={display('priority')} />);
  const headers = groupHeaders();
  const present = (
    Object.keys(PRIORITY_ORDER) as (keyof typeof PRIORITY_ORDER)[]
  )
    .filter((p) => ['urgent', 'medium', 'low', 'none'].includes(p))
    .map(priorityLabel);
  expect(headers.map((h) => h.title)).toEqual(present);
  expect(headers.map((h) => h.icon?.getAttribute('data-priority'))).toEqual([
    'urgent',
    'medium',
    'low',
    'none',
  ]);
  for (const header of Array.from(
    document.querySelectorAll('[data-slot=group-header]')
  )) {
    expect(header.className).toContain('h-9');
    expect(header.className).not.toContain('status-tint');
  }
  // Every lane is a full row of the status columns.
  const lane = document.querySelector('[data-lane-key="priority:urgent"]');
  expect(lane?.querySelectorAll('[data-slot=board-column]')).toHaveLength(3);
});

test('collapsing a priority lane hides its cards and nothing else', () => {
  render(<Harness display={display('priority')} />);
  fireEvent.click(laneToggle('Urgent'));
  expect(screen.queryByText('Card one')).toBeNull();
  expect(screen.queryByText('Card three')).toBeNull();
  expect(screen.queryByText('Card two')).not.toBeNull();
  expect(laneToggle('Urgent').getAttribute('aria-expanded')).toBe('false');
  fireEvent.click(laneToggle('Urgent'));
  expect(screen.queryByText('Card one')).not.toBeNull();
});

// A drop in any lane's column moves the card's status — the lane itself is not a target.
// Driven through @dnd-kit's keyboard sensor (Space lifts, arrows move 25px a press, Space
// drops) over hand-measured column rects, since happy-dom lays nothing out.
test('a drop in a priority lane column still moves status', async () => {
  const moved: [string, string][] = [];
  render(
    <Harness
      display={display('priority')}
      onMoveStatus={(id, status) => {
        moved.push([id, status]);
        return Promise.resolve();
      }}
    />
  );
  const rect = (x: number): DOMRect =>
    ({
      x,
      y: 0,
      top: 0,
      left: x,
      right: x + 300,
      bottom: 200,
      width: 300,
      height: 200,
      toJSON: () => ({}),
    }) as DOMRect;
  const columns = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-lane-key="priority:low"] [data-slot=board-column]'
    )
  );
  expect(columns).toHaveLength(3);
  columns.forEach((column, i) => {
    column.getBoundingClientRect = () => rect(i * 348);
  });
  // Card two (low, todo) lives in the Low lane's first column; drag it two columns right.
  const card = screen
    .getByText('Card two')
    .closest<HTMLElement>('[aria-roledescription="draggable"]');
  if (card === null) throw new Error('no card');
  card.getBoundingClientRect = () => rect(0);
  const press = async (key: string, code: string) => {
    await act(async () => {
      fireEvent.keyDown(card, { key, code });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  };
  await press(' ', 'Space');
  for (let i = 0; i < 28; i++) await press('ArrowRight', 'ArrowRight');
  await press(' ', 'Space');
  expect(moved).toEqual([['t-2', 'done']]);
});

/** Every lane header's sticky wrapper — the `px-3` div around an epic, assignee or priority
 * lane's header — in lane order. */
function laneHeaderWrappers(): HTMLElement[] {
  return Array.from(
    document.querySelectorAll<HTMLElement>('[data-slot=board-lane-header]')
  );
}

// The header pins to the scroll container's left edge so its actions stay on-screen while
// the (wider) column strip below scrolls sideways. Nothing measures in happy-dom, so the
// unmeasured board sets no inline width — the header just spans its lane.
test('lane headers are sticky to the left with no inline width before a measure', () => {
  const { unmount } = render(<Harness />);
  const wrappers = laneHeaderWrappers();
  expect(wrappers).toHaveLength(3);
  for (const wrapper of wrappers) {
    expect(wrapper.className).toContain('sticky');
    expect(wrapper.className).toContain('left-0');
    expect(wrapper.className).toContain('px-3');
    expect(wrapper.style.width).toBe('');
  }
  unmount();
  render(<Harness display={display('priority')} />);
  for (const wrapper of laneHeaderWrappers()) {
    expect(wrapper.className).toContain('sticky left-0');
  }
});

// A `ResizeObserver` stand-in that records each observer's callback and the elements it
// watches, so a test can play the board's measurement without a layout engine. (The lane
// stack has an observer of its own, for the virtual columns' offsets.)
test('a measured board sizes every lane header to its visible width', () => {
  const Original = globalThis.ResizeObserver;
  const observers: { callback: ResizeObserverCallback; targets: Element[] }[] =
    [];
  let boardDisconnected = false;
  class FakeResizeObserver {
    private entry: { callback: ResizeObserverCallback; targets: Element[] };
    constructor(cb: ResizeObserverCallback) {
      this.entry = { callback: cb, targets: [] };
      observers.push(this.entry);
    }
    observe(target: Element) {
      this.entry.targets.push(target);
    }
    unobserve() {}
    disconnect() {
      if (this.entry.targets.some((t) => t.matches('[data-slot=task-board]'))) {
        boardDisconnected = true;
      }
    }
  }
  globalThis.ResizeObserver =
    FakeResizeObserver as unknown as typeof ResizeObserver;
  try {
    const { unmount } = render(<Harness />);
    const board = document.querySelector<HTMLElement>('[data-slot=task-board]');
    if (board === null) throw new Error('no board');
    // Compared by identity: a deep `toEqual` on DOM nodes walks the whole document. The
    // virtual columns watch the board as their viewport too, so every watcher replays.
    const boardCallbacks = observers
      .filter((o) => o.targets.some((t) => t === board))
      .map((o) => o.callback);
    expect(boardCallbacks.length).toBeGreaterThan(0);
    const measureBoard = () => {
      for (const callback of boardCallbacks) {
        callback([], {} as ResizeObserver);
      }
    };
    Object.defineProperty(board, 'clientWidth', {
      configurable: true,
      get: () => 1200,
    });
    act(measureBoard);
    const wrappers = laneHeaderWrappers();
    expect(wrappers).toHaveLength(3);
    for (const wrapper of wrappers) {
      expect(wrapper.style.width).toBe('1200px');
    }
    // A narrower window re-measures; the column strip itself is never resized.
    Object.defineProperty(board, 'clientWidth', {
      configurable: true,
      get: () => 900,
    });
    act(measureBoard);
    expect(laneHeaderWrappers()[0]?.style.width).toBe('900px');
    expect(
      document.querySelector<HTMLElement>('[data-lane-key] .flex.items-start')
        ?.style.width
    ).toBe('');
    unmount();
    expect(boardDisconnected).toBe(true);
  } finally {
    globalThis.ResizeObserver = Original;
  }
});

test('the label catalogue reaches every card', async () => {
  render(<Harness display={display('none')} />);
  await settle(() => {
    fireEvent.click(
      screen.getAllByRole('button', { name: 'Change labels' })[0]
    );
  });
  expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
    'docs',
    'ui',
  ]);
});

// A 300-card column: the board mounts a screenful, not the column.
const LONG_COLUMN = Array.from({ length: 300 }, (_, i) =>
  task(`t-${String(i).padStart(3, '0')}`, `Card ${i}`, 'todo')
);

// The cards inside the columns — not the drag overlay's lifted copy.
function cardIds(): string[] {
  return Array.from(
    document.querySelectorAll(
      '[data-slot=board-column] [data-slot=task-card] [data-slot=task-card-meta]'
    )
  ).map((meta) => meta.textContent ?? '');
}

test('a long column mounts only the cards near the viewport', () => {
  render(<Harness tasks={LONG_COLUMN} epics={[]} display={display('none')} />);
  const mounted = cardIds();
  expect(mounted.length).toBeGreaterThan(0);
  expect(mounted.length).toBeLessThan(40);
  expect(mounted[0]).toContain('t-000');
});

test('the keyboard cursor keeps its card mounted far down a column', () => {
  render(
    <Harness
      tasks={LONG_COLUMN}
      epics={[]}
      display={display('none')}
      focusedTaskId="t-250"
    />
  );
  const mounted = cardIds();
  expect(mounted.some((id) => id.includes('t-250'))).toBe(true);
  expect(mounted.some((id) => id.includes('t-150'))).toBe(false);
});

test('a dragged card stays mounted when the board scrolls it out of view', async () => {
  render(<Harness tasks={LONG_COLUMN} epics={[]} display={display('none')} />);
  const card = document.querySelector<HTMLElement>('[data-slot=task-card]');
  if (card === null) throw new Error('no card');
  expect(card.textContent).toContain('t-000');
  // Pick it up with the keyboard sensor, as someone dragging with Space would.
  await settle(() => {
    card.focus();
    fireEvent.keyDown(card, { key: ' ', code: 'Space' });
  });
  const board = document.querySelector<HTMLElement>('[data-slot=task-board]');
  if (board === null) throw new Error('no board');
  await settle(() => {
    board.scrollTop = 200 * 112;
    fireEvent.scroll(board);
  });
  const mounted = cardIds();
  // The window moved down the column…
  expect(mounted.some((id) => id.includes('t-200'))).toBe(true);
  expect(mounted.some((id) => id.includes('t-001'))).toBe(false);
  // …but the card in hand never unmounted.
  expect(mounted.some((id) => id.includes('t-000'))).toBe(true);
});

// Each column is its own virtualizer on the board's one scroller. A scroll renders them all
// in one commit (not one layout per column), and inside the scroll event itself: a render
// left for later paints that frame with the columns' new rows missing.
test('a scroll renders every column in one commit, before its event returns', () => {
  const tall = STATUSES.flatMap((status) =>
    Array.from({ length: 60 }, (_, i) =>
      task(`t-${status}-${i}`, `Card ${status} ${i}`, status)
    )
  );
  let commits = 0;
  render(
    <Profiler id="board" onRender={() => (commits += 1)}>
      <Harness tasks={tall} epics={[]} display={display('none')} />
    </Profiler>
  );
  const board = document.querySelector<HTMLElement>('[data-slot=task-board]');
  if (board === null) throw new Error('no board');
  commits = 0;
  let atEvent = { commits: -1, cards: [] as string[] };
  // act holds back anything not rendered synchronously until it returns.
  act(() => {
    // Far past the three cards of overscan.
    board.scrollTop = 30 * 112;
    fireEvent.scroll(board);
    atEvent = { commits, cards: cardIds() };
  });
  expect(atEvent.commits).toBe(1);
  for (const status of STATUSES) {
    expect(atEvent.cards.some((id) => id.includes(`t-${status}-30`))).toBe(
      true
    );
  }
});

// A reading whose `splitProbability` counts reads: a card reads it once per render, and
// nothing above the card reads it at all, so the count is the card's render count.
function countedReading(renders: Map<string, number>, id: string) {
  return {
    level: 3,
    label: 'clear',
    confidence: 1,
    get splitProbability() {
      renders.set(id, (renders.get(id) ?? 0) + 1);
      return 0;
    },
  } as ReadinessReading;
}

// Every board render used to hand each card new drag listeners, so a cursor move (or a
// dispatch) redrew every mounted card rather than the ones it touched.
test('moving the cursor redraws only the two cards it moves between', () => {
  const cards = TASKS.filter((t) => t.meta.kind === 'task');
  const renders = new Map<string, number>();
  const readinessById = new Map(
    cards.map((t) => [t.meta.id, countedReading(renders, t.meta.id)])
  );
  const readyIds = new Set<string>();
  const blockedIds = new Set<string>();
  const runs = new Map();
  const progress = new Map();
  const shell = shellWith([]);
  const onToggleLane = () => {};
  const onSelect = () => {};
  const onEpic = async () => {};
  const board = (focusedTaskId: string) => (
    <TooltipProvider>
      <TaskBoard
        tasks={TASKS}
        statuses={STATUSES}
        epics={EPICS}
        readyIds={readyIds}
        blockedIds={blockedIds}
        liveRunStateByTaskId={runs}
        latestRunByTaskId={runs}
        readinessById={readinessById}
        epicProgressById={progress}
        epicConcurrencyDefault={3}
        display={DEFAULT_TASKS_DISPLAY}
        collapsedLaneKeys={NO_KEYS}
        onToggleLane={onToggleLane}
        onSelect={onSelect}
        onWorkEpic={onEpic}
        onStopEpic={onEpic}
        focusedTaskId={focusedTaskId}
      />
    </TooltipProvider>
  );
  const { rerender } = render(board('t-1'), { wrapper: shell });
  expect([...renders.keys()].sort()).toEqual(
    cards.map((t) => t.meta.id).sort()
  );
  renders.clear();

  rerender(board('t-2'));
  expect([...renders.keys()].sort()).toEqual(['t-1', 't-2']);
});
