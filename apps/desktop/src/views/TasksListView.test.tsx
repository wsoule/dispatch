import type { TaskDoc } from '@dispatch/core/browser';
import {
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from '../components/settings/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { TasksListView } from './TasksListView';
import { TooltipProvider } from '@/ui/tooltip';

/** Every dispatch the bulk bar made, in order. */
interface DispatchCall {
  taskId: string;
  batch: boolean | undefined;
}

function task(
  id: string,
  title: string,
  labels: string[] = [],
  parent: string | null = null
): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'todo',
      priority: 2,
      parent,
      labels,
      assignee: null,
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

/** A `DispatchProjectData` stub carrying everything `TasksListView` reads. */
function dataWith(
  tasks: TaskDoc[],
  calls: DispatchCall[] = []
): DispatchProjectData {
  return {
    config: testConfig,
    tasks,
    tasksIncludingArchived: tasks,
    archivedTasks: [],
    showArchived: false,
    epics: [],
    epicProgressById: new Map(),
    readyIds: new Set(tasks.map((t) => t.meta.id)),
    latestRunByTaskId: new Map(),
    liveRunStateByTaskId: new Map(),
    attentionByTaskId: new Map(),
    moveTaskStatus: async () => {},
    handleUpdate: async () => {},
    handleDispatch: (
      taskId: string,
      _executor?: 'fake' | 'claude',
      _model?: string,
      opts?: { batch?: boolean }
    ) => {
      calls.push({ taskId, batch: opts?.batch });
      return Promise.resolve();
    },
  } as unknown as DispatchProjectData;
}

/** Ticks each named row's select box, opens the bulk dialog from the selection bar, and
 *  confirms it. The bar and the dialog both label their button "Dispatch N", so the confirm
 *  is reached through the dialog rather than by name alone. */
function bulkDispatch(titles: string[]) {
  for (const title of titles) {
    fireEvent.click(screen.getByLabelText(`Select ${title}`));
  }
  fireEvent.click(
    screen.getByRole('button', { name: `Dispatch ${titles.length}` })
  );
  const dialog = within(screen.getByRole('dialog'));
  fireEvent.click(dialog.getByRole('button', { name: /^Dispatch \d+$/ }));
}

// The failure this covers: the bulk bar loops handleDispatch, so a naive implementation fires
// the hook's onRunDispatched once per task — the app yanks the user through each new run's
// Chat tab in turn and strands them on the last one, several history entries deep.
test('a bulk dispatch of several tasks does not follow any of them', async () => {
  const calls: DispatchCall[] = [];
  render(
    <TasksListView
      data={dataWith(
        [task('t-1', 'First task'), task('t-2', 'Second task')],
        calls
      )}
      onSelectTask={() => {}}
    />
  );

  bulkDispatch(['First task', 'Second task']);

  await waitFor(() => expect(calls.length).toBe(2));
  expect(calls.map((c) => c.taskId)).toEqual(['t-1', 't-2']);
  expect(calls.every((c) => c.batch === true)).toBe(true);
});

// A "batch" of exactly one is still a single dispatch, and jumping to the run you just started
// is the whole point of that gesture — only a batch of more than one is suppressed.
test('a bulk dispatch of one task still follows it', async () => {
  const calls: DispatchCall[] = [];
  render(
    <TasksListView
      data={dataWith(
        [task('t-1', 'First task'), task('t-2', 'Second task')],
        calls
      )}
      onSelectTask={() => {}}
    />
  );

  bulkDispatch(['First task']);

  await waitFor(() => expect(calls.length).toBe(1));
  expect(calls[0]?.batch).toBe(false);
});

test('renders each task as a row through RecordsTable, with an inline status picker and tags', () => {
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task', ['ui'])])}
      onSelectTask={() => {}}
    />
  );

  expect(screen.getByText('First task')).not.toBeNull();
  expect(screen.getByText('ui')).not.toBeNull();
  // Status is an inline icon picker (see `PropertyControls`), not a plain text label.
  expect(screen.getByRole('button', { name: 'Change status' })).not.toBeNull();
});

// The one interaction this view is required to preserve across the RecordsTable adoption:
// clicking a row still opens that exact task.
test('clicking a row navigates to that task', () => {
  const opened: string[] = [];
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task'), task('t-2', 'Second task')])}
      onSelectTask={(id) => opened.push(id)}
    />
  );

  fireEvent.click(screen.getByText('Second task'));

  expect(opened).toEqual(['t-2']);
});

test('the id/title filter narrows which rows render', () => {
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task'), task('t-2', 'Second task')])}
      onSelectTask={() => {}}
    />
  );

  fireEvent.change(screen.getByPlaceholderText('Filter by id or title…'), {
    target: { value: 'second' },
  });

  expect(screen.queryByText('First task')).toBeNull();
  expect(screen.getByText('Second task')).not.toBeNull();
});

test('an empty filter result shows the no-match empty state', () => {
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task')])}
      onSelectTask={() => {}}
    />
  );

  fireEvent.change(screen.getByPlaceholderText('Filter by id or title…'), {
    target: { value: 'nothing matches this' },
  });

  expect(screen.getByText('No tasks match this filter.')).not.toBeNull();
});

// Epic grouping: tasks bucket under their parent epic's collapsible header, "No epic" last.
// `epic` itself still carries `parent: null`, so — matching the pre-reskin list's own
// behavior, since `data.tasks` includes epic docs alongside plain ones (see
// `useDispatchProject`'s `epics` derivation) — its title renders twice: once as the group
// header, once as its own row in the "No epic" bucket.
test('tasks group under their epic, with a "No epic" bucket for the rest', () => {
  const epic = task('e-1', 'Payments epic');
  const data = dataWith([
    epic,
    task('t-1', 'Charge card', [], 'e-1'),
    task('t-2', 'Unrelated task'),
  ]);
  render(
    <TooltipProvider>
      <TasksListView
        data={{ ...data, epics: [epic] } as unknown as DispatchProjectData}
        onSelectTask={() => {}}
      />
    </TooltipProvider>
  );

  expect(screen.getAllByText('Payments epic').length).toBeGreaterThan(0);
  expect(screen.getByText('No epic')).not.toBeNull();
  expect(screen.getByText('Charge card')).not.toBeNull();
  expect(screen.getByText('Unrelated task')).not.toBeNull();
});

// Collapsing a group's header hides its rows — and takes them out of the bulk-select pool.
test('collapsing a group hides its rows', () => {
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task'), task('t-2', 'Second task')])}
      onSelectTask={() => {}}
    />
  );

  expect(screen.getByText('First task')).not.toBeNull();
  fireEvent.click(screen.getByText('No epic'));
  expect(screen.queryByText('First task')).toBeNull();
  expect(screen.queryByText('Second task')).toBeNull();
});
