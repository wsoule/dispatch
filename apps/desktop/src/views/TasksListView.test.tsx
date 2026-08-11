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

/** Every dispatch the bulk bar made, in order. */
interface DispatchCall {
  taskId: string;
  batch: boolean | undefined;
}

function task(id: string, title: string): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'todo',
      priority: 2,
      parent: null,
      labels: [],
      assignee: null,
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

/** A `DispatchProjectData` stub carrying only what TasksListView reads. */
function dataWith(
  tasks: TaskDoc[],
  calls: DispatchCall[]
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
