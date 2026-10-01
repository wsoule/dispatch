import type {
  EpicProgress,
  EpicProgressChild,
  EpicSession,
  FixLoopState,
  RunMeta,
} from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { statusModelOf } from '@dispatch/core/browser';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from '@testing-library/react';
import { afterEach, beforeEach, expect, test } from 'bun:test';
import { type ReactNode, useEffect } from 'react';

import {
  linearWorkflowConfig,
  testConfig,
} from '../components/settings/fixtures.test-helper';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import { pieDashOffset } from '../components/tasks/StatusIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import {
  COLLAPSED_GROUPS_STORAGE_KEY,
  TOGGLED_MILESTONES_STORAGE_KEY,
} from '../lib/collapsedEpics';
import type { WorkEpicOptions } from '../lib/epicSession';
import { setActiveStatusModel } from '../lib/statusModel';
import { type FocusEpicRequest, MilestonesView } from './MilestonesView';

// Collapse state is session-scoped; start every test with nothing folded.
beforeEach(() => window.sessionStorage.clear());
// Unmount before resetting, so the reset does not redraw a mounted view outside act.
afterEach(() => {
  cleanup();
  setActiveStatusModel(null);
});

function task(
  id: string,
  title: string,
  overrides: Partial<TaskDoc['meta']> = {}
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'ready',
      kind: 'task',
      priority: 'medium',
      parent: null,
      milestone: null,
      labels: [],
      assignee: 'none',
      blockedBy: [],
      writes: [],
      created: '2026-08-10T12:00:00.000Z',
      updated: '2026-09-13T12:00:00.000Z',
      ...overrides,
    },
    body: '',
  } as unknown as TaskDoc;
}

function run(taskId: string, state: RunMeta['state'] = 'running'): RunMeta {
  return {
    id: `r-${taskId}`,
    taskId,
    taskTitle: taskId,
    executor: 'claude',
    state,
    branch: 'b',
    baseBranch: 'main',
    worktreePath: '/tmp',
    createdAt: '2026-09-13T12:00:00.000Z',
    updatedAt: '2026-09-13T12:00:00.000Z',
  } as RunMeta;
}

/** What the fan-out handlers were asked, in order. */
interface EpicCalls {
  work: [string, number | WorkEpicOptions][];
  pause: string[];
  resume: [string, Partial<WorkEpicOptions> | undefined][];
  stop: string[];
  land: string[];
}

function dataWith(
  tasks: TaskDoc[],
  epics: TaskDoc[],
  runs: RunMeta[] = [],
  extras: {
    progress?: EpicProgress[];
    fixLoops?: Map<string, FixLoopState>;
    calls?: EpicCalls;
  } = {}
): DispatchProjectData {
  const calls = extras.calls ?? {
    work: [],
    pause: [],
    resume: [],
    stop: [],
    land: [],
  };
  return {
    client: {},
    portLoading: false,
    portError: false,
    config: testConfig,
    tasks,
    tasksIncludingArchived: tasks,
    archivedTasks: [],
    showArchived: false,
    epics,
    readyIds: new Set(tasks.map((t) => t.meta.id)),
    latestRunByTaskId: new Map(runs.map((r) => [r.taskId, r])),
    liveRunStateByTaskId: new Map(
      runs.filter((r) => r.state === 'running').map((r) => [r.taskId, r.state])
    ),
    attentionByTaskId: new Map(),
    epicProgressById: new Map(
      (extras.progress ?? []).map((p) => [p.epicId, p])
    ),
    fixLoops: extras.fixLoops ?? new Map(),
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: async () => {},
    handleWorkEpic: (id: string, opts: number | WorkEpicOptions) => {
      calls.work.push([id, opts]);
      return Promise.resolve();
    },
    handlePauseEpic: (id: string) => {
      calls.pause.push(id);
      return Promise.resolve();
    },
    handleResumeEpic: (id: string, opts?: Partial<WorkEpicOptions>) => {
      calls.resume.push([id, opts]);
      return Promise.resolve();
    },
    handleStopEpic: (id: string) => {
      calls.stop.push(id);
      return Promise.resolve();
    },
    handleLandEpic: (id: string) => {
      calls.land.push(id);
      return Promise.resolve();
    },
  } as unknown as DispatchProjectData;
}

function child(
  id: string,
  phase: EpicProgressChild['phase'],
  overrides: Partial<EpicProgressChild> = {}
): EpicProgressChild {
  return {
    id,
    title: id,
    status: phase === 'landed' ? 'landed' : 'working',
    phase,
    wave: 1,
    openFindings: 0,
    ...overrides,
  };
}

function session(
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

function progress(
  children: EpicProgressChild[],
  overrides: Partial<EpicProgress> = {}
): EpicProgress {
  return {
    epicId: 'e-1',
    active: overrides.session?.state === 'active',
    session: null,
    spend: {
      settledUsd: 41.2,
      liveCount: 3,
      estimatedLiveUsd: 30,
      runsStarted: 7,
      maxSpendUsd: 100,
      maxRuns: 20,
    },
    children,
    waves: [],
    liveRuns: [],
    ...overrides,
  };
}

// A header verb clears its busy flag after its handler settles, and the dialog's confirm
// closes it a tick later; drain the queue before asserting on either.
async function settle(work: () => void) {
  await act(async () => {
    work();
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

function shellWith(log: { presets: CreateTaskPreset[]; views: string[] }) {
  const noop = () => {};
  const actions = {
    openTask: noop,
    openThread: noop,
    peekTask: noop,
    openCreateTask: (preset?: CreateTaskPreset) =>
      log.presets.push(preset ?? {}),
    createPreset: null,
    closeCreateTask: noop,
    openPalette: noop,
    toggleSidebar: noop,
    sidebarHidden: false,
    openOverseer: noop,
    setProjectView: (view: string) => log.views.push(view),
    setGlobalView: noop,
    openShortcuts: noop,
    copyTaskId: noop,
  } as unknown as ShellActions;
  return function Shell({ children }: { children: ReactNode }) {
    return (
      <ShellActionsProvider value={actions}>{children}</ShellActionsProvider>
    );
  };
}

function renderMilestones(
  data: DispatchProjectData,
  onOpenTask: (id: string, tab?: TaskTab, runId?: string) => void = () => {},
  focusEpic: FocusEpicRequest | null = null
) {
  const log = { presets: [] as CreateTaskPreset[], views: [] as string[] };
  const Shell = shellWith(log);
  const result = render(
    <Shell>
      <MilestonesView
        data={data}
        onOpenTask={onOpenTask}
        focusEpic={focusEpic}
      />
    </Shell>
  );
  return { ...result, log };
}

function dialogTitle(): string | null {
  return (
    document.querySelector('[data-slot=dialog-title]')?.textContent ?? null
  );
}

const payments = task('e-1', 'Payments', { kind: 'milestone' });
const shipped = task('e-2', 'Shipped', { kind: 'milestone' });

test('each milestone is a status-tinted GroupHeader with a ◔ n/m progress glyph over ListRows', () => {
  const { container } = renderMilestones(
    dataWith(
      [
        payments,
        task('t-1', 'Charge card', { parent: 'e-1', status: 'working' }),
        task('t-2', 'Refund flow', { parent: 'e-1', status: 'landed' }),
      ],
      [payments]
    )
  );

  const header = container.querySelector<HTMLElement>(
    '[data-slot="group-header"]'
  );
  if (header === null) throw new Error('no milestone header');
  expect(header.className.split(/\s+/)).toContain('h-9');
  expect(header.style.getPropertyValue('--tint')).toBe(
    'var(--status-progress)'
  );
  expect(
    header.querySelector('[data-slot="group-header-name"]')?.textContent
  ).toBe('Payments');
  expect(header.querySelector('[aria-label="Status: working"]')).not.toBeNull();
  const progress = header.querySelector<HTMLElement>(
    '[data-slot="milestone-progress"]'
  );
  expect(progress?.textContent).toBe('1/2');
  expect(progress?.getAttribute('aria-label')).toBe('1 of 2 landed');
  // The pie is StatusIcon's r=2 circle, so a half milestone hides half of its dash.
  const pie = progress?.querySelectorAll('circle')[1];
  expect(pie?.getAttribute('stroke-dasharray')).toBe(
    `${pieDashOffset(0)} ${pieDashOffset(0) * 2}`
  );
  expect(Number(pie?.getAttribute('stroke-dashoffset'))).toBeCloseTo(
    pieDashOffset(0.5),
    3
  );
  // No progress bar, no card, no dimming.
  expect(container.querySelector('[role="progressbar"]')).toBeNull();
  expect(container.querySelector('.saturate-50')).toBeNull();
  expect(
    container.querySelector('[data-slot="pill"][class*="dense"]')
  ).toBeNull();

  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="list-row"]')
  );
  expect(rows.map((r) => r.dataset.rowId)).toEqual(['t-1', 't-2']);
  expect(rows[0]?.className.split(/\s+/)).toContain('h-9');
});

test('rows are editable through the same pickers as the list, without the epic chip', () => {
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments]
    )
  );

  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Change priority' })
  ).not.toBeNull();
  expect(
    screen.getByRole('button', { name: 'Change assignee' })
  ).not.toBeNull();
  expect(screen.queryByTitle('Payments')).toBeNull();
});

test('health reads as one pill: N running on the working yellow, At risk on amber', () => {
  const { unmount } = renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [run('t-1')]
    )
  );
  expect(screen.getByText('1 running')).not.toBeNull();
  unmount();

  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [run('t-1', 'failed')]
    )
  );
  const pill = screen.getByText('At risk').closest('[data-slot="label-pill"]');
  expect(pill?.getAttribute('title')).toBe('1 has failed.');
});

test('a finished milestone sinks to the bottom, starts collapsed, and reopens on its chevron', () => {
  const { container } = renderMilestones(
    dataWith(
      [
        shipped,
        task('t-9', 'Old work', { parent: 'e-2', status: 'landed' }),
        payments,
        task('t-1', 'Charge card', { parent: 'e-1' }),
      ],
      [shipped, payments]
    )
  );

  const names = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="group-header-name"]')
  ).map((n) => n.innerText);
  expect(names).toEqual(['Payments', 'Shipped']);
  expect(screen.queryByText('Old work')).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Expand group' }));
  expect(screen.getByText('Old work')).not.toBeNull();
  // Stored as "flipped from default" under this page's own key — never the list's, where
  // the same entry would mean "collapsed".
  expect(window.sessionStorage.getItem(TOGGLED_MILESTONES_STORAGE_KEY)).toBe(
    '["milestone:e-2"]'
  );
  expect(
    window.sessionStorage.getItem(COLLAPSED_GROUPS_STORAGE_KEY)
  ).toBeNull();
});

test('a mirrored workflow folds, sinks and tints a finished milestone on its first load', () => {
  const tasks = [
    shipped,
    task('t-9', 'Old work', { parent: 'e-2', status: 'Done' }),
    task('t-8', 'Dropped work', { parent: 'e-2', status: 'Canceled' }),
    payments,
    task('t-1', 'Charge card', { parent: 'e-1', status: 'QA' }),
    task('t-2', 'Refund flow', { parent: 'e-1', status: 'Todo' }),
  ];
  const Shell = shellWith({ presets: [], views: [] });
  // As in useDispatchProject: config lands after the tasks, and the open project's model
  // is set in an effect after the render that carries it.
  function App({ config }: { config: DispatchProjectData['config'] }) {
    useEffect(() => {
      setActiveStatusModel(config === null ? null : statusModelOf(config));
    }, [config]);
    const data = {
      ...dataWith(tasks, [shipped, payments]),
      config,
    } as DispatchProjectData;
    return (
      <Shell>
        <MilestonesView data={data} onOpenTask={() => {}} />
      </Shell>
    );
  }
  const { container, rerender } = render(<App config={null} />);
  act(() => rerender(<App config={linearWorkflowConfig} />));

  const headers = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="group-header"]')
  );
  const nameOf = (h: HTMLElement | undefined) =>
    h?.querySelector('[data-slot="group-header-name"]')?.textContent;
  expect(headers.map(nameOf)).toEqual(['Payments', 'Shipped']);
  // Shipped is finished under Linear's types: folded, done-tinted, every child counted.
  expect(screen.queryByText('Old work')).toBeNull();
  expect(headers[1]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-done)'
  );
  expect(
    headers[1]?.querySelector('[data-slot="milestone-progress"]')?.textContent
  ).toBe('2/2');
  // Payments rolls up to its review-role status, not the built-in `ready`.
  expect(headers[0]?.querySelector('[aria-label="Status: QA"]')).not.toBeNull();
  expect(headers[0]?.style.getPropertyValue('--tint')).toBe(
    'var(--status-progress)'
  );
});

test('j/k and Enter walk and open the rows; + files the new task under the milestone', () => {
  const opened: string[] = [];
  const { log } = renderMilestones(
    dataWith(
      [
        payments,
        task('t-1', 'Charge card', { parent: 'e-1' }),
        task('t-2', 'Refund flow', { parent: 'e-1' }),
      ],
      [payments]
    ),
    (id) => opened.push(id)
  );
  const grid = screen.getByRole('grid', { name: 'Milestones' });
  // The grid takes focus on mount so the keys work without a click first.
  expect(document.activeElement).toBe(grid);

  // The first row is the cursor on mount; the grid names it for assistive tech.
  expect(grid.getAttribute('aria-activedescendant')).toBe('milestone-row-t-1');
  fireEvent.keyDown(grid, { key: 'j' });
  expect(grid.getAttribute('aria-activedescendant')).toBe('milestone-row-t-2');
  expect(
    document.getElementById('milestone-row-t-2')?.getAttribute('data-row-id')
  ).toBe('t-2');
  fireEvent.keyDown(grid, { key: 'Enter' });
  expect(opened).toEqual(['t-2']);

  fireEvent.keyDown(grid, { key: 'p' });
  expect(
    document
      .querySelector('[data-row-id="t-2"] [aria-label="Change priority"]')
      ?.getAttribute('aria-expanded')
  ).toBe('true');

  fireEvent.click(screen.getByRole('button', { name: 'New task in Payments' }));
  // The container is the new task's parent, not a free-text milestone.
  expect(log.presets).toEqual([{ epic: 'e-1' }]);
});

test('milestones sit under their project, and a parent issue is a row, not a milestone', () => {
  const project = task('p-1', 'Storefront', { kind: 'project' });
  const beta = task('m-1', 'Beta', { kind: 'milestone', parent: 'p-1' });
  const parentIssue = task('t-1', 'Checkout', { parent: 'm-1' });
  const { container, log } = renderMilestones(
    dataWith(
      [
        project,
        beta,
        parentIssue,
        task('t-2', 'Card form', { parent: 't-1' }),
        task('t-3', 'Receipt', { parent: 't-1' }),
      ],
      // Every container, the parent issue included, as the app derives it.
      [project, beta, parentIssue]
    )
  );
  const names = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="group-header-name"]')
  ).map((n) => n.textContent);
  expect(names).toEqual(['Storefront › Beta']);
  const rows = Array.from(
    container.querySelectorAll<HTMLElement>('[data-slot="list-row"]')
  ).map((r) => r.dataset.rowId);
  expect(rows).toEqual(['t-1', 't-2', 't-3']);
  expect(
    container.querySelector('[data-slot="milestone-progress"]')?.textContent
  ).toBe('0/3');

  fireEvent.click(
    screen.getByRole('button', { name: 'New task in Storefront › Beta' })
  );
  expect(log.presets).toEqual([{ epic: 'm-1' }]);
});

test('with no milestones the empty state offers Plan work…', () => {
  const { log } = renderMilestones(dataWith([task('t-1', 'Loose task')], []));

  expect(screen.getByText('No milestones yet')).not.toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Plan work…' }));
  expect(log.views).toEqual(['plans']);
});

test('an idle milestone offers Send agents…, which opens the fan-out dialog for it', async () => {
  const calls: EpicCalls = {
    work: [],
    pause: [],
    resume: [],
    stop: [],
    land: [],
  };
  renderMilestones(
    dataWith(
      [
        payments,
        task('t-1', 'Charge card', { parent: 'e-1', status: 'working' }),
        task('t-2', 'Refund flow', { parent: 'e-1', status: 'landed' }),
      ],
      [payments],
      [run('t-1')],
      {
        progress: [progress([child('t-1', 'working'), child('t-2', 'landed')])],
        calls,
      }
    )
  );
  // The health pill and the glyph stay; nothing about a session shows yet.
  expect(screen.getByText('1 running')).not.toBeNull();
  expect(
    document.querySelector('[data-slot=milestone-progress]')?.textContent
  ).toBe('1/2');
  expect(document.querySelector('[data-slot=phase-pill]')).toBeNull();
  expect(dialogTitle()).toBeNull();

  fireEvent.click(screen.getByRole('button', { name: 'Send agents…' }));
  expect(dialogTitle()).toBe('Send agents · Payments');
  expect(
    screen.getByRole('button', { name: /Send \d+ agents?/ })
  ).not.toBeNull();

  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: /Send \d+ agents?/ }));
  });
  expect(calls.work).toHaveLength(1);
  expect(calls.work[0]?.[0]).toBe('e-1');
  expect(calls.work[0]?.[1]).toMatchObject({ concurrency: 3, maxRuns: 2 });
  expect(dialogTitle()).toBeNull();
});

test('an active session shows phase chips, the spend pill, Pause and Stop in the header', async () => {
  const calls: EpicCalls = {
    work: [],
    pause: [],
    resume: [],
    stop: [],
    land: [],
  };
  renderMilestones(
    dataWith(
      [
        payments,
        ...['t-1', 't-2', 't-3', 't-4', 't-5', 't-6'].map((id) =>
          task(id, id, { parent: 'e-1' })
        ),
      ],
      [payments],
      [run('t-1')],
      {
        progress: [
          progress(
            [
              child('t-1', 'working'),
              child('t-2', 'working'),
              child('t-3', 'working'),
              child('t-4', 'queued'),
              child('t-5', 'queued'),
              child('t-6', 'capped'),
            ],
            { session: session('active') }
          ),
        ],
        calls,
      }
    )
  );
  const header = document.querySelector<HTMLElement>(
    '[data-slot=group-header]'
  );
  expect(header?.className.split(/\s+/)).toContain('h-9');
  const chips = Array.from(
    header?.querySelectorAll<HTMLElement>('[data-slot=phase-chip]') ?? []
  );
  expect(chips.map((c) => c.textContent)).toEqual([
    '3Working',
    '2Queued',
    '1Capped',
  ]);
  const spend = header?.querySelector('[data-slot=spend-pill]');
  expect(spend?.textContent).toBe('$41.20 / $100');
  // The phase chips carry the live count; the health pill stays out of the way.
  expect(screen.queryByText('1 running')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Send agents…' })).toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Stop' }));
  });
  expect(calls.pause).toEqual(['e-1']);
  expect(calls.stop).toEqual(['e-1']);
  expect(document.querySelector('[role=progressbar]')).toBeNull();
  expect(document.querySelector('.saturate-50')).toBeNull();
});

test('with nothing live and a capped loop the header waits on a ruling', () => {
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [],
      {
        progress: [
          progress([child('t-1', 'capped')], {
            session: session('active'),
            spend: {
              settledUsd: 12,
              liveCount: 0,
              estimatedLiveUsd: 0,
              runsStarted: 2,
              maxSpendUsd: 60,
              maxRuns: 20,
            },
          }),
        ],
      }
    )
  );
  expect(screen.getByText('Waiting on 1 ruling')).not.toBeNull();
});

test('a paused session shows why, Resume, and Raise ceiling… pre-filled from the session', async () => {
  const calls: EpicCalls = {
    work: [],
    pause: [],
    resume: [],
    stop: [],
    land: [],
  };
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [run('t-1')],
      {
        progress: [
          progress([child('t-1', 'queued')], {
            session: session('paused', {
              pausedReason: 'budget',
              maxSpendUsd: 60,
              maxRuns: 20,
            }),
          }),
        ],
        calls,
      }
    )
  );
  expect(screen.getByText('Paused — budget ceiling')).not.toBeNull();
  // The spend pill stays beside the reason; the health pill does not.
  expect(document.querySelector('[data-slot=spend-pill]')?.textContent).toBe(
    '$41.20 / $100'
  );
  expect(screen.queryByText('1 running')).toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
  });
  expect(calls.resume).toEqual([['e-1', undefined]]);

  fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling…' }));
  expect(dialogTitle()).toBe('Raise ceiling · Payments');
  // Pre-filled from the paused session's ceilings.
  expect(screen.getByDisplayValue('60').getAttribute('aria-label')).toBe(
    'Spend ceiling'
  );
  expect(screen.getByDisplayValue('20').getAttribute('aria-label')).toBe(
    'Max runs'
  );
  fireEvent.change(screen.getByLabelText('Spend ceiling'), {
    target: { value: '120' },
  });
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Raise ceiling' }));
  });
  expect(calls.resume[1]).toEqual([
    'e-1',
    { concurrency: 3, maxSpendUsd: 120, maxRuns: 20 },
  ]);
  expect(dialogTitle()).toBeNull();
});

test('every child landed with no live session offers Land', async () => {
  const calls: EpicCalls = {
    work: [],
    pause: [],
    resume: [],
    stop: [],
    land: [],
  };
  renderMilestones(
    dataWith(
      [
        payments,
        task('t-1', 'Charge card', { parent: 'e-1', status: 'landed' }),
        task('t-2', 'Refund flow', { parent: 'e-1', status: 'landed' }),
      ],
      [payments],
      [],
      {
        progress: [
          progress([child('t-1', 'landed'), child('t-2', 'landed')], {
            session: session('complete'),
          }),
        ],
        calls,
      }
    )
  );
  expect(screen.queryByRole('button', { name: 'Send agents…' })).toBeNull();
  await settle(() => {
    fireEvent.click(screen.getByRole('button', { name: 'Land' }));
  });
  expect(calls.land).toEqual(['e-1']);
});

test('rows under a session carry a phase pill, the run cost and open findings, and drill by phase', () => {
  const opened: [string, TaskTab | undefined, string | undefined][] = [];
  renderMilestones(
    dataWith(
      [
        payments,
        task('t-1', 'Charge card', { parent: 'e-1', status: 'working' }),
        task('t-2', 'Refund flow', { parent: 'e-1', status: 'ready' }),
        task('t-3', 'Webhooks', { parent: 'e-1', status: 'working' }),
      ],
      [payments],
      [],
      {
        progress: [
          progress(
            [
              child('t-1', 'working', { costUsd: 8.2, openFindings: 2 }),
              child('t-2', 'queued'),
              child('t-3', 'failed', { runId: 'r-9', reason: 'tests failed' }),
            ],
            { session: session('active') }
          ),
        ],
      }
    ),
    (id, tab, runId) => opened.push([id, tab, runId])
  );
  const rowOf = (id: string): HTMLElement => {
    const row = document.querySelector<HTMLElement>(`[data-row-id="${id}"]`);
    if (row === null) throw new Error(`no row ${id}`);
    return row;
  };
  const working = rowOf('t-1');
  expect(working.querySelector('[data-slot=phase-pill]')?.textContent).toBe(
    'Working'
  );
  expect(working.textContent).toContain('$8.20');
  expect(working.querySelector('[title="open findings"]')?.textContent).toBe(
    '2'
  );
  // `queued` says nothing the status glyph does not, so no pill.
  expect(rowOf('t-2').querySelector('[data-slot=phase-pill]')).toBeNull();
  const failed = rowOf('t-3').querySelector('[data-slot=phase-pill]');
  expect(failed?.textContent).toBe('Failed');
  expect(failed?.getAttribute('title')).toBe('tests failed');

  fireEvent.click(rowOf('t-3'));
  fireEvent.click(rowOf('t-1'));
  fireEvent.click(rowOf('t-2'));
  expect(opened).toEqual([
    ['t-3', 'run', 'r-9'],
    ['t-1', 'auto', undefined],
    ['t-2', undefined, undefined],
  ]);
});

test('a capped row reads its fix loop’s own line when the loop state is known', () => {
  const loop = {
    taskId: 't-1',
    state: 'capped',
    round: 3,
    cap: 3,
    stopReason: 'rounds-exhausted',
  } as unknown as FixLoopState;
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [],
      {
        progress: [
          progress([child('t-1', 'capped')], { session: session('active') }),
        ],
        fixLoops: new Map([['t-1', loop]]),
      }
    )
  );
  const pill = document.querySelector(
    '[data-row-id="t-1"] [data-slot=phase-pill]'
  );
  expect(pill?.textContent).toMatch(/^Capped at 3\/3/);
});

test('rows show no phase until the milestone has a session', () => {
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [],
      {
        progress: [
          progress([
            child('t-1', 'working', { costUsd: 8.2, openFindings: 2 }),
          ]),
        ],
      }
    )
  );
  expect(document.querySelector('[data-slot=phase-pill]')).toBeNull();
  expect(screen.queryByText('$8.20')).toBeNull();
});

test('a focusEpic request unfolds a finished milestone and opens the dialog when asked', () => {
  const { container } = renderMilestones(
    dataWith(
      [
        shipped,
        task('t-9', 'Old work', { parent: 'e-2', status: 'landed' }),
        payments,
        task('t-1', 'Charge card', { parent: 'e-1' }),
      ],
      [shipped, payments]
    ),
    () => {},
    { epicId: 'e-2', dispatch: true, nonce: 1 }
  );
  // Shipped is finished and would start collapsed; the request opens it (the dialog's
  // preview lists the same task, so look for the row).
  expect(container.querySelector('[data-row-id="t-9"]')).not.toBeNull();
  expect(window.sessionStorage.getItem(TOGGLED_MILESTONES_STORAGE_KEY)).toBe(
    '["milestone:e-2"]'
  );
  expect(
    container.querySelector('[data-group-key="milestone:e-2"]')
  ).not.toBeNull();
  expect(dialogTitle()).toBe('Send agents · Shipped');
});

test('a focusEpic request without dispatch scrolls the milestone into view and nothing more', () => {
  const scrolled: [string | null, ScrollToOptions | undefined][] = [];
  const original = Element.prototype.scrollTo;
  Element.prototype.scrollTo = function (
    this: Element,
    arg?: number | ScrollToOptions
  ) {
    scrolled.push([
      this.getAttribute('aria-label'),
      typeof arg === 'object' ? arg : undefined,
    ]);
  } as typeof Element.prototype.scrollTo;
  // happy-dom has no layout; give each scroller a browser's extent so offsets are not clamped.
  const extent = Object.getOwnPropertyDescriptors(HTMLElement.prototype);
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', {
    configurable: true,
    get: () => 10_000,
  });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get: () => 500,
  });
  try {
    renderMilestones(
      dataWith(
        [
          task('e-0', 'Onboarding', { kind: 'milestone' }),
          task('t-0', 'Welcome mail', { parent: 'e-0' }),
          payments,
          task('t-1', 'Charge card', { parent: 'e-1' }),
        ],
        [task('e-0', 'Onboarding', { kind: 'milestone' }), payments]
      ),
      () => {},
      { epicId: 'e-1', dispatch: false, nonce: 1 }
    );
  } finally {
    Element.prototype.scrollTo = original;
    for (const key of ['scrollHeight', 'clientHeight'] as const) {
      const descriptor = extent[key];
      if (descriptor === undefined)
        delete (HTMLElement.prototype as never)[key];
      else Object.defineProperty(HTMLElement.prototype, key, descriptor);
    }
  }
  // The virtual grid scrolls itself until Payments' header (row 2, under Onboarding's
  // header and task) starts the viewport.
  const headerIndex = Number(
    document
      .querySelector('[data-group-key="milestone:e-1"]')
      ?.parentElement?.getAttribute('data-index')
  );
  expect(headerIndex).toBe(2);
  expect(scrolled.every(([label]) => label === 'Milestones')).toBe(true);
  expect(scrolled.at(-1)?.[1]?.top).toBe(2 * 36);
  expect(screen.getByText('Charge card')).not.toBeNull();
  expect(dialogTitle()).toBeNull();
});

test('an empty milestone reads ◔ 0/0 with nothing to send', () => {
  renderMilestones(dataWith([payments], [payments]));
  const progress = document.querySelector('[data-slot=milestone-progress]');
  expect(progress?.textContent).toBe('0/0');
  expect(progress?.getAttribute('aria-label')).toBe('0 of 0 landed');
  expect(screen.queryByRole('button', { name: 'Send agents…' })).toBeNull();
});

test('a stopped session hands the header back to the health pill', () => {
  renderMilestones(
    dataWith(
      [payments, task('t-1', 'Charge card', { parent: 'e-1' })],
      [payments],
      [run('t-1')],
      {
        progress: [
          progress([child('t-1', 'working')], { session: session('stopped') }),
        ],
      }
    )
  );
  expect(screen.getByText('1 running')).not.toBeNull();
  expect(document.querySelector('[data-slot=phase-chip]')).toBeNull();
  expect(screen.getByRole('button', { name: 'Send agents…' })).not.toBeNull();
});
