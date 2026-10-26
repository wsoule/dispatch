import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta, RunState } from '@dispatch/client';
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import { ShellActionsProvider } from '../components/shell/ShellActionsContext';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import type { TaskBucket } from '../lib/taskStatus';
import { GraphView, type GraphViewProps } from './GraphView';

// The Graph page over a fixture planning (PlanningProvider runs the chain
// over the task list below): two projects, three milestones and issues whose
// blocking relations cross the milestones, so the milestone level has arrows
// and a risk chain. Dates are relative to today so the overdue milestone
// stays overdue.

afterEach(cleanup);

beforeEach(() => {
  try {
    window.localStorage.clear();
  } catch {
    // No storage: the view opens on its defaults anyway.
  }
});

const DONE_MEANS = '## Description\n\nDone means: it ships.\n';

/**
 * Storefront (lead Ana): Beta due in 20 days, Launch in 40. Search (lead
 * Dev): Index due 3 days ago (overdue) with an unassigned open issue that
 * blocks Beta's cart work, which in turn blocks Launch's announcement: a
 * risk chain Index → Beta → Launch across the two projects.
 */
function fixture(): TaskListItem[] {
  return [
    taskDoc({
      id: 'p-store',
      title: 'Storefront',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc(
      {
        id: 'ms-beta',
        title: 'Beta',
        kind: 'milestone',
        parent: 'p-store',
        dueDate: dayFromNow(20),
      },
      DONE_MEANS
    ),
    taskDoc(
      {
        id: 'ms-launch',
        title: 'Launch',
        kind: 'milestone',
        parent: 'p-store',
        dueDate: dayFromNow(40),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
      blockedBy: ['t-rank'],
    }),
    taskDoc({
      id: 't-announce',
      title: 'Announce the launch',
      parent: 'ms-launch',
      status: 'ready',
      assignee: 'human:ana',
      blockedBy: ['t-cart'],
    }),
    taskDoc({
      id: 'p-search',
      title: 'Search',
      kind: 'project',
      status: 'working',
      assignee: 'human:dev',
    }),
    taskDoc(
      {
        id: 'ms-index',
        title: 'Index',
        kind: 'milestone',
        parent: 'p-search',
        dueDate: dayFromNow(-3),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-rank',
      title: 'Rank exact matches first',
      parent: 'ms-index',
      status: 'ready',
      assignee: 'none',
    }),
  ];
}

/** One project, one milestone and `count` issues: past the draw limit. */
function oversized(count: number): TaskListItem[] {
  const tasks = [
    taskDoc({
      id: 'p-big',
      title: 'Big',
      kind: 'project',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc(
      {
        id: 'ms-big',
        title: 'Everything',
        kind: 'milestone',
        parent: 'p-big',
        dueDate: dayFromNow(30),
      },
      DONE_MEANS
    ),
  ];
  for (let i = 0; i < count; i += 1) {
    tasks.push(
      taskDoc({
        id: `t-${i}`,
        title: `Issue ${i}`,
        parent: 'ms-big',
        status: 'ready',
        assignee: 'human:ana',
        blockedBy: i > 0 ? [`t-${i - 1}`] : [],
      })
    );
  }
  return tasks;
}

function input(tasks: TaskListItem[]): PlanningInput {
  return {
    tasks,
    config: null,
    people: [
      { ref: 'human:ana', name: 'Ana' },
      { ref: 'human:dev', name: 'Dev' },
    ],
    executors: null,
    me: 'human:ana',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    epicProgressById: new Map<string, EpicProgress>(),
  };
}

interface MountOptions {
  tasks?: TaskListItem[];
  peekTask?: (taskId: string) => void;
  bucketOf?: GraphViewProps['bucketOf'];
  selectedId?: string | null;
  readyIds?: Set<string>;
  liveRunStateByTaskId?: Map<string, RunState>;
  focus?: GraphViewProps['focus'];
}

function Providers({
  data,
  peekTask,
  children,
}: {
  data: PlanningInput;
  peekTask: (taskId: string) => void;
  children: ReactNode;
}) {
  return (
    <ShellActionsProvider value={{ ...SHELL, peekTask }}>
      <PlanningProvider data={data}>{children}</PlanningProvider>
    </ShellActionsProvider>
  );
}

/** The view under its providers, over one fixture planning. */
function tree(
  options: MountOptions,
  tasks: TaskListItem[],
  planning: PlanningInput
) {
  return (
    <Providers data={planning} peekTask={options.peekTask ?? (() => {})}>
      <GraphView
        data={{
          tasks,
          readyIds: options.readyIds ?? new Set(),
          liveRunStateByTaskId: options.liveRunStateByTaskId ?? new Map(),
          latestRunByTaskId: planning.latestRunByTaskId,
        }}
        bucketOf={options.bucketOf ?? (() => null)}
        selectedId={options.selectedId ?? null}
        focus={options.focus}
      />
    </Providers>
  );
}

/** Renders the view; `rerender(next)` re-renders it with changed options
 * over the same planning (the drawer closing, say). */
function mount(options: MountOptions = {}) {
  const tasks = options.tasks ?? fixture();
  const planning = input(tasks);
  const utils = render(tree(options, tasks, planning));
  return {
    ...utils,
    rerender: (next: MountOptions) =>
      utils.rerender(tree({ ...options, ...next }, tasks, planning)),
  };
}

function box(name: RegExp): HTMLElement {
  return screen.getByRole('button', { name });
}

/** The graph's frame, by the data attributes the canvas sets on it. */
function frame(): HTMLElement {
  const el = document.querySelector('[data-highlight]');
  if (!(el instanceof HTMLElement)) throw new Error('no graph frame');
  return el;
}

describe('GraphView', () => {
  test('opens on the workspace’s milestones: a box per milestone, framed by project, with the level tabs', () => {
    mount();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Dependencies' })
    ).toBeTruthy();
    expect(screen.getByText(/^3 milestones in 2 projects; /)).toBeTruthy();
    expect(
      screen.getByRole('img', { name: /^Milestone dependency graph/ })
    ).toBeTruthy();
    expect(box(/^Beta\b/)).toBeTruthy();
    expect(box(/^Launch\b/)).toBeTruthy();
    expect(box(/^Index\b/)).toBeTruthy();
    // Each box's name ends its context with the frame it sits in.
    expect(box(/^Beta\b/).getAttribute('aria-label')).toContain(
      'in Storefront'
    );
    // Projects / Milestones / Issues (no initiatives in this workspace).
    const tabs = screen.getByRole('navigation', { name: 'Graph level' });
    expect(
      within(tabs)
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Projects', 'Milestones', 'Issues']);
    expect(
      within(tabs)
        .getByRole('link', { name: 'Milestones' })
        .getAttribute('aria-current')
    ).toBe('page');
  });

  test('the level tabs switch the scope in place', () => {
    mount();
    const tabs = screen.getByRole('navigation', { name: 'Graph level' });
    fireEvent.click(within(tabs).getByRole('link', { name: 'Issues' }));
    expect(
      screen.getByRole('img', { name: /^Issue dependency graph/ })
    ).toBeTruthy();
    expect(box(/^Persist the cart\b/)).toBeTruthy();
    expect(box(/^Rank exact matches first\b/)).toBeTruthy();
    expect(
      within(screen.getByRole('navigation', { name: 'Graph level' }))
        .getByRole('link', { name: 'Issues' })
        .getAttribute('aria-current')
    ).toBe('page');
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Graph level' })).getByRole(
        'link',
        { name: 'Projects' }
      )
    );
    expect(box(/^Storefront\b/)).toBeTruthy();
    expect(box(/^Search\b/)).toBeTruthy();
  });

  test('the Risk highlight (the default) tints the overdue box and marks the risk chain; the pick is remembered', () => {
    mount();
    expect(frame().getAttribute('data-highlight')).toBe('risk');
    // Index is overdue: red under Risk, and its name says so.
    const index = box(/^Index\b/);
    expect(index.getAttribute('data-tone')).toBe('danger');
    expect(index.getAttribute('aria-label')).toContain('overdue');
    // Beta waits on it: a risk chain, said in the receipts and the legend.
    expect(screen.getByText(/^3 milestones .* 2 on a risk chain/)).toBeTruthy();
    const legend = screen.getByRole('group', { name: 'Graph legend: Risk' });
    expect(within(legend).getByText('Risk chain')).toBeTruthy();

    const switcher = screen.getByRole('radiogroup', { name: 'Highlight' });
    fireEvent.click(within(switcher).getByRole('radio', { name: 'Status' }));
    expect(frame().getAttribute('data-highlight')).toBe('status');
    expect(window.localStorage.getItem('dispatch:graph-highlight')).toBe(
      'status'
    );
    cleanup();
    mount();
    expect(frame().getAttribute('data-highlight')).toBe('status');
  });

  test('a press locks a box and a second press quick-looks its task through the shell', () => {
    const peekTask = mock((_id: string) => {});
    mount({ peekTask });
    const beta = box(/^Beta\b/);
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(beta.getAttribute('aria-pressed')).toBe('true');
    expect(frame().hasAttribute('data-locked')).toBe(true);
    expect(peekTask).not.toHaveBeenCalled();
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(peekTask).toHaveBeenLastCalledWith('ms-beta');
    // Open again: the host opens, never toggles.
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(peekTask).toHaveBeenCalledTimes(2);
  });

  test('the peeked task is the graph’s selection and the drawer’s width is kept clear', () => {
    mount({ selectedId: 'ms-index' });
    expect(box(/^Index\b/).getAttribute('data-state')).toBe('active');
  });

  test('Escape unlocks a locked box before the shell hears it; unlocked, the key goes on to the shell', () => {
    mount();
    // A stand-in for the shell's window listener (useGlobalKeyboard), which
    // ignores a key something nearer already handled.
    const shell = mock((_prevented: boolean) => {});
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') shell(event.defaultPrevented);
    };
    window.addEventListener('keydown', onKey);
    try {
      const beta = box(/^Beta\b/);
      fireEvent.keyDown(beta, { key: 'Enter' });
      expect(beta.getAttribute('aria-pressed')).toBe('true');
      // Focus left the graph (a click beside the frame): Escape still only
      // drops the lock.
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(beta.getAttribute('aria-pressed')).toBe('false');
      expect(shell).toHaveBeenLastCalledWith(true);
      // Nothing locked: the shell gets the key (it closes the drawer).
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(shell).toHaveBeenLastCalledWith(false);
      // From inside the graph the frame's own handler takes it first.
      fireEvent.keyDown(beta, { key: 'Enter' });
      fireEvent.keyDown(beta, { key: 'Escape' });
      expect(beta.getAttribute('aria-pressed')).toBe('false');
      expect(shell).toHaveBeenLastCalledWith(true);
    } finally {
      window.removeEventListener('keydown', onKey);
    }
  });

  test('an open drawer’s Escape goes before the lock: the drawer closes first, the next Escape unlocks', () => {
    // Beta is quick-looked: the graph's selection, and the drawer is open.
    const { rerender } = mount({ selectedId: 'ms-beta' });
    const beta = box(/^Beta\b/);
    fireEvent.keyDown(beta, { key: 'Enter' });
    expect(beta.getAttribute('aria-pressed')).toBe('true');
    // A stand-in for the task drawer (a SlideOver: a dialog that is not
    // modal on a desktop, with its own document-level Escape added after
    // the graph mounted).
    const panel = document.createElement('div');
    panel.setAttribute('role', 'dialog');
    document.body.append(panel);
    const closed = mock((_prevented: boolean) => {});
    const onPanelKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      closed(event.defaultPrevented);
      if (!event.defaultPrevented) {
        event.preventDefault();
        panel.remove();
      }
    };
    document.addEventListener('keydown', onPanelKey);
    try {
      fireEvent.keyDown(panel, { key: 'Escape' });
      // The drawer took the key; the lock (and its lit paths) stayed.
      expect(closed).toHaveBeenLastCalledWith(false);
      expect(beta.getAttribute('aria-pressed')).toBe('true');
      // The drawer closed: nothing is quick-looked, and the next Escape
      // drops the lock.
      rerender({ selectedId: null });
      fireEvent.keyDown(document.body, { key: 'Escape' });
      expect(beta.getAttribute('aria-pressed')).toBe('false');
    } finally {
      document.removeEventListener('keydown', onPanelKey);
      panel.remove();
    }
  });

  test('drilling into a project moves the scope and the trail', () => {
    mount();
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Graph level' })).getByRole(
        'link',
        { name: 'Projects' }
      )
    );
    // Shift + Enter follows the box's own graph: the project's milestones.
    fireEvent.keyDown(box(/^Storefront\b/), { key: 'Enter', shiftKey: true });
    expect(
      screen.getByRole('heading', { level: 1, name: /Storefront/ })
    ).toBeTruthy();
    const trail = screen.getByRole('navigation', { name: 'Graph scope' });
    expect(
      within(trail)
        .getAllByRole('listitem')
        .map((item) => item.textContent?.replace(/^\//, ''))
    ).toEqual(['Workspace', 'Storefront']);
    expect(box(/^Beta\b/)).toBeTruthy();
    expect(box(/^Launch\b/)).toBeTruthy();
    // Index is one relation away: drawn outside the scope.
    expect(box(/^Index\b/).getAttribute('aria-label')).toContain(
      'outside this scope'
    );
    // A project offers two levels, so the tabs are Milestones / Issues.
    expect(
      within(screen.getByRole('navigation', { name: 'Graph level' }))
        .getAllByRole('link')
        .map((link) => link.textContent)
    ).toEqual(['Milestones', 'Issues']);
    // The trail's Workspace crumb drills back up, in place.
    fireEvent.click(within(trail).getByRole('link', { name: 'Workspace' }));
    expect(
      screen.queryByRole('navigation', { name: 'Graph scope' })
    ).toBeNull();
    expect(box(/^Storefront\b/)).toBeTruthy();
  });

  test('a scoped link opens on that project’s milestones', () => {
    mount({ focus: { projectId: 'p-search' } });
    expect(box(/^Index\b/).getAttribute('aria-label')).not.toContain(
      'outside this scope'
    );
    // Beta waits on Index: drawn one hop away, outside the scope.
    expect(box(/^Beta\b/).getAttribute('aria-label')).toContain(
      'outside this scope'
    );
    expect(screen.queryByRole('button', { name: /^Launch\b/ })).toBeNull();
    expect(
      within(screen.getByRole('navigation', { name: 'Graph scope' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent?.replace(/^\//, ''))
    ).toEqual(['Workspace', 'Search']);
  });

  test('the Dispatch overlay chips the issue boxes with their bucket and the ready set', () => {
    const bucketOf = (task: TaskListItem): TaskBucket | null =>
      task.meta.id === 't-cart' ? 'need-you' : null;
    mount({ bucketOf, readyIds: new Set(['t-rank']) });
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Graph level' })).getByRole(
        'link',
        { name: 'Issues' }
      )
    );
    const cart = box(/^Persist the cart\b/);
    expect(cart.getAttribute('aria-label')).toContain('needs you');
    expect(cart.getAttribute('data-tone')).toBe('warning');
    // Containers carry the planning facts alone.
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Graph level' })).getByRole(
        'link',
        { name: 'Milestones' }
      )
    );
    expect(box(/^Beta\b/).getAttribute('aria-label')).not.toContain(
      'needs you'
    );
  });

  test('past the draw limit the notice and the narrower graphs stand where the canvas would', () => {
    mount({ tasks: oversized(701) });
    fireEvent.click(
      within(screen.getByRole('navigation', { name: 'Graph level' })).getByRole(
        'link',
        { name: 'Issues' }
      )
    );
    const block = screen.getByRole('region', { name: 'Too many to draw' });
    expect(
      within(block).getByText(/^Too many to draw: 701 issues/)
    ).toBeTruthy();
    expect(within(block).getByText(/draws at most 700 boxes/)).toBeTruthy();
    expect(screen.queryByRole('img')).toBeNull();
    // Narrow to a project, a graph link followed in place; inside it, to
    // its milestone.
    const rows = within(block).getByRole('list', { name: 'Narrow to' });
    const row = within(rows).getByRole('link', { name: 'Big: 701 on edges' });
    expect(row.getAttribute('href')).toBe('#/graph?project=p-big');
    fireEvent.click(row);
    expect(screen.getByRole('heading', { level: 1, name: /Big/ })).toBeTruthy();
    const inside = within(
      screen.getByRole('region', { name: 'Too many to draw' })
    ).getByRole('link', { name: /^Everything: / });
    expect(inside.getAttribute('href')).toBe('#/graph?milestone=ms-big');
  });

  test('the Mermaid toggle shows the source for the highlight on screen', () => {
    mount();
    expect(screen.queryByText('Mermaid source')).toBeNull();
    const toggle = screen.getByRole('button', { name: 'Mermaid' });
    fireEvent.click(toggle);
    expect(toggle.getAttribute('aria-pressed')).toBe('true');
    expect(screen.getByRole('button', { name: 'Copy Mermaid' })).toBeTruthy();
    expect(screen.getByText('Mermaid source')).toBeTruthy();
    expect(document.querySelector('code')?.textContent).toContain(
      'flowchart LR'
    );
    fireEvent.click(toggle);
    expect(screen.queryByText('Mermaid source')).toBeNull();
  });

  test('with no milestones the empty state keeps the level tabs in the title row', () => {
    mount({ tasks: [] });
    expect(screen.getByText('No milestones in the workspace.')).toBeTruthy();
    expect(screen.queryAllByRole('button', { pressed: false })).toHaveLength(0);
    expect(
      screen.getByRole('navigation', { name: 'Graph level' })
    ).toBeTruthy();
  });

  test('says so outside App, where no planning is provided', () => {
    render(
      <ShellActionsProvider value={SHELL}>
        <GraphView
          data={{
            tasks: [],
            readyIds: new Set(),
            liveRunStateByTaskId: new Map(),
            latestRunByTaskId: new Map(),
          }}
          bucketOf={() => null}
          selectedId={null}
        />
      </ShellActionsProvider>
    );
    expect(screen.getByTestId('graph-view').textContent).toContain(
      'The graph is not available here.'
    );
  });
});
