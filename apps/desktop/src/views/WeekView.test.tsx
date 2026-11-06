import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { MilestoneProgress, RunMeta } from '@dispatch/client';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, test } from 'bun:test';

import { ShellActionsProvider } from '../components/shell/ShellActionsContext';
import { SHELL } from '../components/tasks/page/pageHost.test-helper';
import { type PlanningInput, PlanningProvider } from '../hooks/usePlanning';
import { dayFromNow } from '../lib/taskDates';
import { taskDoc } from '../lib/taskDoc.test-helper';
import { WeekView } from './WeekView';

// My week over a fixture planning: Ana leads Storefront (Beta due in 2 days,
// her issue in it) and Search (no date, an unassigned issue: needs
// attention); Dev holds one issue with no milestone.

afterEach(cleanup);

const DONE_MEANS = '## Description\n\nDone means: it ships.\n';

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
        dueDate: dayFromNow(2),
      },
      DONE_MEANS
    ),
    taskDoc({
      id: 't-cart',
      title: 'Persist the cart',
      parent: 'ms-beta',
      status: 'working',
      assignee: 'human:ana',
    }),
    taskDoc({
      id: 't-pay',
      title: 'Take payments',
      parent: 'ms-beta',
      status: 'ready',
      assignee: 'none',
    }),
    taskDoc({
      id: 't-docs',
      title: 'Write the docs',
      parent: 'p-store',
      status: 'ready',
      assignee: 'human:dev',
    }),
  ];
}

function planningInput(tasks: TaskListItem[]): PlanningInput {
  return {
    tasks,
    config: null,
    people: [
      { ref: 'human:ana', name: 'Ana Lopez' },
      { ref: 'human:dev', name: 'Dev Patel' },
    ],
    executors: null,
    me: 'human:ana',
    linearLinks: {},
    latestRunByTaskId: new Map<string, RunMeta>(),
    milestoneProgressById: new Map<string, MilestoneProgress>(),
  };
}

function mount(me: string | null = 'human:ana') {
  const peeked: string[] = [];
  render(
    <ShellActionsProvider
      value={{ ...SHELL, peekTask: (id) => peeked.push(id) }}
    >
      <PlanningProvider data={planningInput(fixture())}>
        <WeekView me={me} />
      </PlanningProvider>
    </ShellActionsProvider>
  );
  return { peeked };
}

describe('WeekView', () => {
  test("shows the viewer's issues under This week, and quick-looks a row", () => {
    const { peeked } = mount();
    expect(screen.getByRole('heading', { level: 1 }).textContent).toMatch(
      /, Ana$/
    );
    expect(screen.getByText('Persist the cart')).toBeTruthy();
    expect(screen.queryByText('Write the docs')).toBeNull();
    fireEvent.click(screen.getByText('Persist the cart'));
    expect(peeked).toEqual(['t-cart']);
  });

  test('lists the milestone under upcoming deadlines and the unassigned work as needing attention', () => {
    mount();
    const deadlines = screen.getByRole('region', {
      name: 'Upcoming deadlines',
    });
    expect(deadlines.textContent).toContain('Beta');
    const attention = screen.getByRole('region', { name: 'Needs attention' });
    expect(attention.textContent).toContain('Storefront');
    expect(attention.textContent).toContain('1 unassigned');
  });

  test('says when the window does not know its person or anyone else', () => {
    render(
      <ShellActionsProvider value={SHELL}>
        <PlanningProvider data={{ ...planningInput([]), people: [], me: null }}>
          <WeekView me={null} />
        </PlanningProvider>
      </ShellActionsProvider>
    );
    expect(screen.getByText('No people yet')).toBeTruthy();
  });
});
