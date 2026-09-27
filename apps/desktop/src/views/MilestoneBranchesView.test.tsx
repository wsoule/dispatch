import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'bun:test';
import type { ReactNode } from 'react';

import { testConfig } from '../components/settings/fixtures.test-helper';
import {
  type CreateTaskPreset,
  type ShellActions,
  ShellActionsProvider,
} from '../components/shell/ShellActionsContext';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { DEFAULT_TASKS_DISPLAY } from '../lib/tasksPrefs';
import {
  BRANCHES_TOGGLED_STORAGE_KEY,
  MilestoneBranchesView,
  pathSummaryLabel,
} from './MilestoneBranchesView';

// Collapse state is session-scoped; start every test with nothing folded.
beforeEach(() => window.sessionStorage.clear());

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

function dataWith(
  tasks: TaskDoc[],
  epics: TaskDoc[],
  runs: RunMeta[] = []
): DispatchProjectData {
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
    epicProgressById: new Map(),
    fixLoops: new Map(),
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: async () => {},
  } as unknown as DispatchProjectData;
}

interface ShellLog {
  presets: CreateTaskPreset[];
  peeked: string[];
}

function shellWith(log: ShellLog) {
  const noop = () => {};
  const actions = {
    openTask: noop,
    openThread: noop,
    peekTask: (id: string) => log.peeked.push(id),
    openCreateTask: (preset?: CreateTaskPreset) =>
      log.presets.push(preset ?? {}),
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
  } as unknown as ShellActions;
  return function Shell({ children }: { children: ReactNode }) {
    return (
      <ShellActionsProvider value={actions}>{children}</ShellActionsProvider>
    );
  };
}

function renderBranches(
  data: DispatchProjectData,
  props: Partial<{
    onOpenTask: (id: string) => void;
    taskFilter: (doc: TaskDoc) => boolean;
    onRequestFilter: () => void;
    onRequestDisplay: () => void;
    onPlanWork: () => void;
    display: typeof DEFAULT_TASKS_DISPLAY;
  }> = {}
) {
  const log: ShellLog = { presets: [], peeked: [] };
  const Shell = shellWith(log);
  const result = render(
    <Shell>
      <MilestoneBranchesView
        data={data}
        onOpenTask={props.onOpenTask ?? (() => {})}
        {...props}
      />
    </Shell>
  );
  return { ...result, log };
}

function grid(): HTMLElement {
  return screen.getByRole('grid', { name: 'Branches' });
}

function lineIds(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll<HTMLElement>('[data-slot="branch-line"]')
  ).map((line) => line.dataset['taskId'] ?? '');
}

function summaries(root: ParentNode): string[] {
  return Array.from(
    root.querySelectorAll('[data-slot="branch-path-summary"]')
  ).map((el) => el.textContent ?? '');
}

const payments = task('e-1', 'Payments', { kind: 'epic' });
const shipped = task('e-2', 'Shipped', { kind: 'epic' });

// A → B, A → C, B,C → D under Payments; passed in reverse so the layout, not the input,
// decides the order.
const diamond = [
  task('t-d', 'Ship it', { parent: 'e-1', blockedBy: ['t-b', 't-c'] }),
  task('t-c', 'Refund flow', { parent: 'e-1', blockedBy: ['t-a'] }),
  task('t-b', 'Charge card', { parent: 'e-1', blockedBy: ['t-a'] }),
  task('t-a', 'Schema', { parent: 'e-1' }),
];

describe('MilestoneBranchesView', () => {
  test('each milestone with tasks renders a tinted header, a path summary and its graph in blocker-first order', () => {
    const { container } = renderBranches(
      dataWith(
        [
          payments,
          ...diamond,
          task('t-x', 'Loose task'),
          task('e-3', 'Empty milestone', { kind: 'epic' }),
        ],
        [payments, task('e-3', 'Empty milestone', { kind: 'epic' })]
      )
    );

    const headers = container.querySelectorAll<HTMLElement>(
      '[data-slot="group-header"]'
    );
    expect(headers).toHaveLength(1);
    const header = headers[0];
    if (header === undefined) throw new Error('no header');
    expect(header.style.getPropertyValue('--tint')).toBe('var(--status-todo)');
    expect(
      header.querySelector('[data-slot="group-header-name"]')?.textContent
    ).toBe('Payments');
    expect(header.querySelector('[aria-label="Status: ready"]')).not.toBeNull();
    expect(summaries(container)).toEqual([
      '3 of 3 on the path remain · next t-a',
    ]);

    // The graph, not the loose task.
    expect(
      screen.getByRole('group', { name: 'Payments branches' })
    ).not.toBeNull();
    expect(lineIds(container)).toEqual(['t-a', 't-b', 't-c', 't-d']);
    expect(container.querySelector('[data-task-id="t-x"]')).toBeNull();
    expect(
      container.querySelectorAll('[data-slot="branch-edge"]')
    ).toHaveLength(4);
  });

  test('the path summary follows a task landing', () => {
    const data = dataWith([payments, ...diamond], [payments]);
    const { container, rerender } = renderBranches(data);
    expect(summaries(container)).toEqual([
      '3 of 3 on the path remain · next t-a',
    ]);

    const landed = diamond.map((t) =>
      t.meta.id === 't-a'
        ? task('t-a', 'Schema', { parent: 'e-1', status: 'landed' })
        : t
    );
    const Shell = shellWith({ presets: [], peeked: [] });
    rerender(
      <Shell>
        <MilestoneBranchesView
          data={dataWith([payments, ...landed], [payments])}
          onOpenTask={() => {}}
        />
      </Shell>
    );
    expect(summaries(container)).toEqual([
      '2 of 3 on the path remain · next t-b',
    ]);
  });

  test('pathSummaryLabel reads All landed with nothing remaining and drops next without one', () => {
    expect(pathSummaryLabel({ remaining: 0, total: 4, nextId: null })).toBe(
      'All landed'
    );
    expect(pathSummaryLabel({ remaining: 2, total: 5, nextId: null })).toBe(
      '2 of 5 on the path remain'
    );
  });

  test('clicking a line opens the task', () => {
    const opened: string[] = [];
    const { container } = renderBranches(
      dataWith([payments, ...diamond], [payments]),
      { onOpenTask: (id) => opened.push(id) }
    );
    const line = container.querySelector<HTMLElement>(
      '[data-slot="branch-line"][data-task-id="t-c"]'
    );
    if (line === null) throw new Error('no line');
    fireEvent.click(line);
    expect(opened).toEqual(['t-c']);
  });

  test('j/k walk the lines across milestones in drawn order and Enter opens the focused one', () => {
    const opened: string[] = [];
    const { container, log } = renderBranches(
      dataWith(
        [
          payments,
          shipped,
          task('t-b', 'Charge card', { parent: 'e-1', blockedBy: ['t-a'] }),
          task('t-a', 'Schema', { parent: 'e-1' }),
          task('t-s', 'Second milestone task', { parent: 'e-2' }),
        ],
        [payments, shipped]
      ),
      { onOpenTask: (id) => opened.push(id) }
    );
    const focusedId = () =>
      container.querySelector<HTMLElement>(
        '[data-slot="branch-line"][data-focused]'
      )?.dataset['taskId'];

    expect(focusedId()).toBe('t-a');
    fireEvent.keyDown(grid(), { key: 'j' });
    expect(focusedId()).toBe('t-b');
    fireEvent.keyDown(grid(), { key: 'j' });
    expect(focusedId()).toBe('t-s');
    // Clamped at the last line.
    fireEvent.keyDown(grid(), { key: 'j' });
    expect(focusedId()).toBe('t-s');
    fireEvent.keyDown(grid(), { key: 'k' });
    expect(focusedId()).toBe('t-b');

    fireEvent.keyDown(grid(), { key: 'Enter' });
    expect(opened).toEqual(['t-b']);
    fireEvent.keyDown(grid(), { key: 'o' });
    expect(opened).toEqual(['t-b', 't-b']);
    fireEvent.keyDown(grid(), { key: ' ' });
    expect(log.peeked).toEqual(['t-b']);
  });

  test('ArrowDown/ArrowUp move the cursor like j/k, and only a keyboard move scrolls', () => {
    const scrolled: string[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      scrolled.push(this.getAttribute('data-task-id') ?? '');
    };
    try {
      const { container } = renderBranches(
        dataWith([payments, ...diamond], [payments])
      );
      const focusedId = () =>
        container.querySelector<HTMLElement>(
          '[data-slot="branch-line"][data-focused]'
        )?.dataset['taskId'];
      expect(focusedId()).toBe('t-a');
      fireEvent.keyDown(grid(), { key: 'ArrowDown' });
      expect(focusedId()).toBe('t-b');
      expect(scrolled).toEqual(['t-b']);
      fireEvent.keyDown(grid(), { key: 'ArrowUp' });
      expect(focusedId()).toBe('t-a');
      expect(scrolled).toEqual(['t-b', 't-a']);

      const line = container.querySelector(
        '[data-slot="branch-line"][data-task-id="t-d"]'
      );
      if (line === null) throw new Error('no line');
      fireEvent.click(line);
      expect(scrolled).toEqual(['t-b', 't-a']);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  test('Enter and Space on a header control activate it rather than the focused line', () => {
    const opened: string[] = [];
    const { log } = renderBranches(
      dataWith([payments, ...diamond], [payments]),
      { onOpenTask: (id) => opened.push(id) }
    );
    const add = screen.getByRole('button', { name: 'New task in Payments' });
    add.focus();
    fireEvent.keyDown(add, { key: 'Enter' });
    fireEvent.keyDown(add, { key: ' ' });
    expect(opened).toEqual([]);
    expect(log.peeked).toEqual([]);
    // `o` is nobody's activation key, so it still opens the focused line.
    fireEvent.keyDown(add, { key: 'o' });
    expect(opened).toEqual(['t-a']);
  });

  test('tabbing onto a line moves the cursor there', () => {
    const { container } = renderBranches(
      dataWith([payments, ...diamond], [payments])
    );
    const focusedId = () =>
      container.querySelector<HTMLElement>(
        '[data-slot="branch-line"][data-focused]'
      )?.dataset['taskId'];
    expect(focusedId()).toBe('t-a');
    const line = container.querySelector<HTMLElement>(
      '[data-slot="branch-line"][data-task-id="t-c"]'
    );
    if (line === null) throw new Error('no line');
    fireEvent.focusIn(line);
    expect(focusedId()).toBe('t-c');
    expect(
      container.querySelectorAll('[data-slot="branch-line"][data-focused]')
    ).toHaveLength(1);
  });

  test('f and shift+V ask the page for its filter and display menus', () => {
    const asked: string[] = [];
    renderBranches(dataWith([payments, ...diamond], [payments]), {
      onRequestFilter: () => asked.push('filter'),
      onRequestDisplay: () => asked.push('display'),
    });
    fireEvent.keyDown(grid(), { key: 'f' });
    fireEvent.keyDown(grid(), { key: 'V', shiftKey: true });
    // A modifier chord is somebody else's shortcut.
    fireEvent.keyDown(grid(), { key: 'f', metaKey: true });
    expect(asked).toEqual(['filter', 'display']);
  });

  test('finished milestones render last, start collapsed, and the fold persists for the session', () => {
    const tasks = [
      shipped,
      payments,
      task('t-old', 'Done work', { parent: 'e-2', status: 'landed' }),
      task('t-a', 'Schema', { parent: 'e-1' }),
    ];
    const epics = [shipped, payments];
    const { container, unmount } = renderBranches(dataWith(tasks, epics));

    const blocks = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(
          '[data-slot="milestone-branch"]'
        )
      );
    expect(blocks().map((b) => b.dataset['groupKey'])).toEqual([
      'milestone:e-1',
      'milestone:e-2',
    ]);
    expect(blocks()[1]?.dataset['finished']).toBe('true');
    expect(summaries(container)).toEqual([
      '1 of 1 on the path remain · next t-a',
      'All landed',
    ]);
    // Folded: no lines under Shipped, and j/k skip it.
    expect(lineIds(container)).toEqual(['t-a']);
    fireEvent.keyDown(grid(), { key: 'j' });
    expect(
      container.querySelector<HTMLElement>(
        '[data-slot="branch-line"][data-focused]'
      )?.dataset['taskId']
    ).toBe('t-a');

    const expand = screen.getAllByRole('button', { name: 'Expand group' })[0];
    if (expand === undefined) throw new Error('no expand control');
    fireEvent.click(expand);
    expect(lineIds(container)).toEqual(['t-a', 't-old']);
    expect(window.sessionStorage.getItem(BRANCHES_TOGGLED_STORAGE_KEY)).toBe(
      JSON.stringify(['milestone:e-2'])
    );

    // A fresh mount in the same session keeps the fold the way it was left.
    unmount();
    const again = renderBranches(dataWith(tasks, epics));
    expect(lineIds(again.container)).toEqual(['t-a', 't-old']);
  });

  test('the fold, order and header tint read the unfiltered milestone, not what the filter kept', () => {
    const tasks = [
      shipped,
      payments,
      task('t-old', 'Done work', { parent: 'e-2', status: 'landed' }),
      task('t-a', 'Schema', { parent: 'e-1', status: 'landed' }),
      task('t-b', 'Charge card', { parent: 'e-1', blockedBy: ['t-a'] }),
    ];
    const { container } = renderBranches(dataWith(tasks, [shipped, payments]), {
      taskFilter: (doc) => doc.meta.status === 'landed',
    });
    const blocks = Array.from(
      container.querySelectorAll<HTMLElement>('[data-slot="milestone-branch"]')
    );
    // Payments still has open work, so it stays first and open with its landed line drawn;
    // Shipped is the one that is actually finished.
    expect(blocks.map((b) => b.dataset['groupKey'])).toEqual([
      'milestone:e-1',
      'milestone:e-2',
    ]);
    expect(blocks.map((b) => b.dataset['finished'])).toEqual([
      undefined,
      'true',
    ]);
    expect(lineIds(container)).toEqual(['t-a']);
    const header = container.querySelector<HTMLElement>(
      '[data-slot="group-header"]'
    );
    expect(header?.style.getPropertyValue('--tint')).toBe('var(--status-todo)');
    expect(
      header?.querySelector('[aria-label="Status: ready"]')
    ).not.toBeNull();
  });

  test('a sub-task under a task is no milestone of its own', () => {
    const { container } = renderBranches(
      dataWith(
        [
          payments,
          task('t-a', 'Schema', { parent: 'e-1' }),
          task('t-a-1', 'Migration', { parent: 't-a' }),
        ],
        [payments]
      )
    );
    expect(
      container.querySelectorAll('[data-slot="group-header"]')
    ).toHaveLength(1);
    expect(container.textContent).not.toContain('t-a-1');

    // Only sub-tasks, no milestone children: the empty state, not a header titled by a task id.
    const { container: none } = renderBranches(
      dataWith(
        [
          payments,
          task('t-x', 'Loose'),
          task('t-x-1', 'Sub', { parent: 't-x' }),
        ],
        [payments]
      )
    );
    expect(none.textContent).toContain('No milestones with tasks yet');
    expect(none.querySelector('[data-slot="group-header"]')).toBeNull();
  });

  test('a taskFilter that drops a blocker still lays out and the header + presets the milestone', () => {
    const { container, log } = renderBranches(
      dataWith([payments, ...diamond], [payments]),
      { taskFilter: (doc) => doc.meta.id !== 't-a' }
    );
    expect(lineIds(container)).toEqual(['t-b', 't-c', 't-d']);
    // Two edges left: B→D and C→D.
    expect(
      container.querySelectorAll('[data-slot="branch-edge"]')
    ).toHaveLength(2);
    expect(summaries(container)).toEqual([
      '2 of 2 on the path remain · next t-b',
    ]);

    fireEvent.click(
      screen.getByRole('button', { name: 'New task in Payments' })
    );
    expect(log.presets).toEqual([{ milestone: 'e-1' }]);
  });

  test('the trailing slot is the live run mark, else the assignee avatar when shown', () => {
    const { container } = renderBranches(
      dataWith(
        [
          payments,
          task('t-a', 'Schema', {
            parent: 'e-1',
            status: 'working',
            assignee: 'agent',
          }),
          task('t-b', 'Charge card', { parent: 'e-1', assignee: 'human' }),
        ],
        [payments],
        [run('t-a')]
      )
    );
    const trailing = (id: string) =>
      container.querySelector(
        `[data-slot="branch-line"][data-task-id="${id}"] [data-slot="branch-line-trailing"]`
      );
    expect(
      trailing('t-a')?.querySelector('[data-slot="run-state-mark"]')
    ).not.toBeNull();
    expect(
      trailing('t-b')?.querySelector('[data-slot="run-state-mark"]')
    ).toBeNull();
    expect(trailing('t-b')).not.toBeNull();

    // Assignee off in the Display popover: no avatar, and no slot at all.
    const { container: bare } = renderBranches(
      dataWith(
        [
          payments,
          task('t-b', 'Charge card', { parent: 'e-1', assignee: 'human' }),
        ],
        [payments]
      ),
      {
        display: {
          ...DEFAULT_TASKS_DISPLAY,
          properties: new Set(
            [...DEFAULT_TASKS_DISPLAY.properties].filter(
              (p) => p !== 'assignee'
            )
          ),
        },
      }
    );
    expect(bare.querySelector('[data-slot="branch-line-trailing"]')).toBeNull();
  });

  test('an empty state when no milestone has tasks, with Plan work… only when the caller offers it', () => {
    const { container, log } = renderBranches(
      dataWith([payments, task('t-x', 'Loose task')], [payments]),
      { onPlanWork: () => {} }
    );
    expect(screen.queryByRole('grid')).toBeNull();
    expect(container.textContent).toContain('No milestones with tasks yet');
    expect(screen.getByRole('button', { name: /Plan work/ })).not.toBeNull();
    fireEvent.click(screen.getByRole('button', { name: /New task/ }));
    expect(log.presets).toEqual([{}]);

    const { container: none } = renderBranches(
      dataWith([payments], [payments])
    );
    expect(none.querySelector('button[aria-label]')).toBeNull();
    expect(none.textContent).not.toContain('Plan work');
  });

  test('a filter that matches nothing says so instead of claiming there are no milestones', () => {
    const { container } = renderBranches(
      dataWith([payments, ...diamond], [payments]),
      { taskFilter: () => false }
    );
    expect(container.textContent).toContain('No tasks match');
    expect(container.textContent).not.toContain('No milestones with tasks yet');
  });
});
