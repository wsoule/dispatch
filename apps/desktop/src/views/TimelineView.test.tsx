import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta } from '@dispatch/client';
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ReactNode } from 'react';

import { ShellActionsProvider } from '../components/shell/ShellActionsContext';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import { TimelineView, type TimelineViewProps } from './TimelineView';

// The Timeline page over a fixture planning (PlanningProvider runs the chain
// over the task list below): two projects, three milestones (one undated),
// one issue in no milestone. Dates are relative to today so the bars fall
// inside the planning's window (14 days back, 70 ahead).

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
 * Storefront (lead Ana): Beta due in 20 days with one issue moving, Launch
 * undated. Search (no lead): Index due 3 days ago (overdue) with one open
 * issue, and a loose issue under the project itself (unplanned).
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
    taskDoc({
      id: 'ms-launch',
      title: 'Launch',
      kind: 'milestone',
      parent: 'p-store',
    }),
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 'p-search',
      title: 'Search',
      kind: 'project',
      status: 'working',
      assignee: 'none',
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
    taskDoc({
      id: 't-loose',
      title: 'Rebuild the index nightly',
      parent: 'p-search',
      status: 'ready',
    }),
  ];
}

function input(tasks: TaskListItem[] = fixture()): PlanningInput {
  return {
    tasks,
    config: null,
    people: [{ ref: 'human:ana', name: 'Ana' }],
    executors: null,
    me: 'human:ana',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    epicProgressById: new Map<string, EpicProgress>(),
  };
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

function mount(
  over: Partial<TimelineViewProps> = {},
  options: { peekTask?: (taskId: string) => void; data?: PlanningInput } = {}
) {
  const props: TimelineViewProps = {
    readOnly: false,
    selectedId: null,
    onRedate: () => Promise.resolve(),
    ...over,
  };
  const utils = render(
    <Providers
      data={options.data ?? input()}
      peekTask={options.peekTask ?? (() => {})}
    >
      <TimelineView {...props} />
    </Providers>
  );
  // The phone cards render the same milestones (hidden by CSS), so chart
  // queries are scoped to the chart's region.
  const chart = within(utils.getByRole('region', { name: /^Timeline, / }));
  return { ...utils, chart };
}

async function flush() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

describe('TimelineView', () => {
  test('draws a lane per project, a bar per dated milestone and a chip for the undated one', () => {
    const { chart } = mount();
    expect(
      screen.getByRole('heading', { level: 1, name: 'Timeline' })
    ).toBeTruthy();
    expect(
      screen.getByText(/^2 projects · 3 milestones · 1 overdue/)
    ).toBeTruthy();
    // Both lanes sit under "No initiative", the lead (or its absence) under the name.
    expect(chart.getByRole('group', { name: 'Storefront, Ana' })).toBeTruthy();
    expect(chart.getByRole('group', { name: 'Search, No lead' })).toBeTruthy();
    expect(chart.getByRole('button', { name: /^Beta, On track/ })).toBeTruthy();
    expect(chart.getByRole('button', { name: /^Index, Overdue/ })).toBeTruthy();
    expect(
      chart.getByRole('button', { name: /^Launch, .*no due date$/ })
    ).toBeTruthy();
    // The lane name links to the project's task.
    expect(
      chart.getByRole('link', { name: 'Storefront' }).getAttribute('href')
    ).toBe('#/task/p-store');
  });

  test('Show "At risk" hides the on-track lanes and is remembered', () => {
    const { chart } = mount();
    const show = screen.getByRole('radiogroup', { name: 'Show projects' });
    fireEvent.click(within(show).getByRole('radio', { name: 'At risk' }));
    expect(chart.queryByRole('group', { name: 'Storefront, Ana' })).toBeNull();
    expect(chart.getByRole('group', { name: 'Search, No lead' })).toBeTruthy();
    expect(window.localStorage.getItem('dispatch:timeline-show')).toBe('risk');
    fireEvent.click(within(show).getByRole('radio', { name: 'All' }));
    expect(chart.getByRole('group', { name: 'Storefront, Ana' })).toBeTruthy();
  });

  test('the zoom is remembered and read back on the next mount', () => {
    mount();
    const zoom = screen.getByRole('radiogroup', { name: 'Zoom' });
    fireEvent.click(within(zoom).getByRole('radio', { name: 'Months' }));
    expect(window.localStorage.getItem('dispatch:timeline-zoom')).toBe(
      'months'
    );
    cleanup();
    mount();
    expect(
      within(screen.getByRole('radiogroup', { name: 'Zoom' }))
        .getByRole('radio', { name: 'Months' })
        .getAttribute('aria-checked')
    ).toBe('true');
  });

  test('a bar and a chip quick-look their milestone through the shell', () => {
    const peekTask = mock((_id: string) => {});
    const { chart } = mount({}, { peekTask });
    fireEvent.click(chart.getByRole('button', { name: /^Beta, On track/ }));
    expect(peekTask).toHaveBeenLastCalledWith('ms-beta');
    fireEvent.click(chart.getByRole('button', { name: /^Launch, / }));
    expect(peekTask).toHaveBeenLastCalledWith('ms-launch');
  });

  test('the peeked milestone is the chart’s current bar', () => {
    const { chart } = mount({ selectedId: 'ms-index' });
    expect(
      chart
        .getByRole('button', { name: /^Index, Overdue/ })
        .getAttribute('aria-current')
    ).toBe('true');
  });

  test('a keyboard re-date writes the new due date through the update verb', async () => {
    const onRedate = mock((_id: string, _end: string) => Promise.resolve());
    const { chart } = mount({ onRedate });
    const handle = chart.getByRole('slider', { name: 'Due date of Index' });
    fireEvent.keyDown(handle, { key: 'ArrowRight' });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    expect(onRedate).toHaveBeenCalledTimes(1);
    expect(onRedate).toHaveBeenCalledWith('ms-index', dayFromNow(-2));
    expect(screen.getByRole('status').textContent).toContain('Saved');
  });

  test('a refused re-date reaches the chart, which announces it and rolls the bar back', async () => {
    const onRedate = mock((_id: string, _end: string) =>
      Promise.reject(new Error('A request-tier token cannot edit tasks'))
    );
    const { chart } = mount({ onRedate });
    const before = chart
      .getByRole('button', { name: /^Index, Overdue/ })
      .getAttribute('aria-label');
    const handle = chart.getByRole('slider', { name: 'Due date of Index' });
    fireEvent.keyDown(handle, { key: 'ArrowRight', shiftKey: true });
    fireEvent.keyDown(handle, { key: 'Enter' });
    await flush();
    expect(onRedate).toHaveBeenCalledWith('ms-index', dayFromNow(4));
    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain(
        'A request-tier token cannot edit tasks'
      );
    });
    expect(
      chart
        .getByRole('button', { name: /^Index, Overdue/ })
        .getAttribute('aria-label')
    ).toBe(before);
  });

  test('a read-only window draws no re-date handles', () => {
    const { chart } = mount({ readOnly: true });
    expect(chart.queryAllByRole('slider')).toHaveLength(0);
    expect(chart.getByRole('button', { name: /^Index, Overdue/ })).toBeTruthy();
  });

  test('the banners name the project without a lead, the undated milestone and the unplanned issue', () => {
    mount();
    const banners = screen.getByRole('region', { name: 'Missing inputs' });
    expect(
      within(banners).getByText(/1 active project has no lead/)
    ).toBeTruthy();
    expect(
      within(banners).getByText(/1 milestone has no target date/)
    ).toBeTruthy();
    expect(
      within(banners).getByText(/1 open issue has no milestone/)
    ).toBeTruthy();
    fireEvent.click(
      within(banners).getAllByRole('button', { name: /^Show 1 item$/ })[2]
    );
    expect(
      within(banners)
        .getByRole('link', { name: 'Search › Rebuild the index nightly' })
        .getAttribute('href')
    ).toBe('#/task/t-loose');
    expect(
      within(banners)
        .getByRole('link', { name: 'Plan in Issues' })
        .getAttribute('href')
    ).toBe('#/issues');
  });

  test('with nothing to draw the chart says how to get a milestone on it', () => {
    render(
      <Providers data={input([])} peekTask={() => {}}>
        <TimelineView
          readOnly={false}
          selectedId={null}
          onRedate={() => Promise.resolve()}
        />
      </Providers>
    );
    expect(
      screen.getByText(/^No milestones with a target date yet/)
    ).toBeTruthy();
  });

  test('says so outside App, where no planning is provided', () => {
    render(
      <ShellActionsProvider value={SHELL}>
        <TimelineView
          readOnly={false}
          selectedId={null}
          onRedate={() => Promise.resolve()}
        />
      </ShellActionsProvider>
    );
    expect(
      screen.getByText('The timeline is not available here.')
    ).toBeTruthy();
  });
});
