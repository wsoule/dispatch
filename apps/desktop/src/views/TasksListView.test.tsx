import type { TaskDoc } from '@dispatch/core/browser';
import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { testConfig } from '../components/settings/fixtures.test-helper';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { TasksListView } from './TasksListView';

function task(id: string, title: string, labels: string[] = []): TaskDoc {
  return {
    meta: {
      id,
      title,
      status: 'in-progress',
      priority: 2,
      parent: null,
      labels,
      assignee: null,
      blockedBy: [],
      created: '2026-08-10T00:00:00.000Z',
      updated: '2026-08-10T00:00:00.000Z',
    },
    body: '',
  } as unknown as TaskDoc;
}

/** A `DispatchProjectData` stub carrying only what TasksListView reads. */
function dataWith(tasks: TaskDoc[]): DispatchProjectData {
  return {
    config: testConfig,
    tasks,
    tasksIncludingArchived: tasks,
    archivedTasks: [],
    showArchived: false,
  } as unknown as DispatchProjectData;
}

test('renders each task as a row through RecordsTable, with its status and tags', () => {
  render(
    <TasksListView
      data={dataWith([task('t-1', 'First task', ['ui'])])}
      onSelectTask={() => {}}
    />
  );

  expect(screen.getByText('First task')).not.toBeNull();
  expect(screen.getByText('In Progress')).not.toBeNull();
  expect(screen.getByText('ui')).not.toBeNull();
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
