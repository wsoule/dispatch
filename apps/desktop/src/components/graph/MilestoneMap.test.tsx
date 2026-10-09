import type { TaskListItem } from '@dispatch-foo/core/browser';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'bun:test';

import type { TaskTab } from '../../lib/appNav';
import type { ListGroup } from '../../lib/listGrouping';
import { taskDoc } from '../../lib/taskDoc.test-helper';
import type { TaskBucket } from '../../lib/taskStatus';
import { MilestoneMapView, type MilestoneMapViewProps } from './MilestoneMap';

function task(id: string, status = 'ready', blockedBy: string[] = []) {
  return taskDoc({
    id,
    title: `Task ${id}`,
    status,
    blockedBy,
  }) as TaskListItem;
}

function group(epicId: string, label: string, tasks: TaskListItem[]) {
  return {
    key: `milestone:${epicId}`,
    kind: 'milestone',
    label,
    tint: null,
    icon: { kind: 'epic', epicId },
    rows: tasks.map((doc) => ({ doc, indent: 0 })),
    preset: {},
    epicId,
    archived: false,
  } as ListGroup;
}

const BUCKETS: Record<string, TaskBucket> = {
  a2: 'failed',
  a3: 'ready',
  b1: 'need-you',
  b2: 'working',
};

function mount(layouts?: MilestoneMapViewProps['layouts']) {
  const opened: [string, TaskTab | undefined][] = [];
  return { opened, ...mountWith(opened, layouts) };
}

function mountWith(
  opened: [string, TaskTab | undefined][],
  layouts?: MilestoneMapViewProps['layouts']
) {
  return render(
    <MilestoneMapView
      groups={[
        group('m1', 'Checkout', [task('a1', 'landed'), task('a2'), task('a3')]),
        group('m2', 'Search', [task('b1', 'ready', ['a2']), task('b2')]),
      ]}
      bucketOf={(doc) => BUCKETS[doc.meta.id] ?? null}
      asksByTask={new Map([['b1', 2]])}
      projectKey="test"
      dueDateOf={(id) => (id === 'm2' ? '2026-11-03' : null)}
      layouts={layouts}
      onOpenTask={(id, tab) => opened.push([id, tab])}
    />
  );
}

function node(title: string): HTMLElement {
  const found = screen
    .getAllByTestId('milestone-node')
    .find((el) => el.textContent?.includes(title));
  if (found === undefined) throw new Error(`no node ${title}`);
  return found;
}

beforeEach(() => localStorage.clear());

describe('MilestoneMapView', () => {
  test('a node shows landed over total and the four urgent counts', () => {
    mount();
    const checkout = within(node('Checkout'));
    expect(node('Checkout').textContent).toContain('1/3 landed · 33%');
    expect(checkout.getByTestId('milestone-node-failed').textContent).toBe(
      '✕ 1'
    );
    const search = within(node('Search'));
    expect(search.getByTestId('milestone-node-asks').textContent).toBe('● 2');
    expect(search.getByTestId('milestone-node-working').textContent).toBe(
      '◐ 1'
    );
    expect(node('Search').textContent).toContain('due');
  });

  test('open tasks list most urgent first, the next ready one marked', () => {
    mount();
    const rows = within(node('Checkout')).getAllByTestId('milestone-node-task');
    expect(rows.map((r) => r.title)).toEqual(['Task a2', 'Task a3']);
    expect(rows[1].textContent).toContain('next');
  });

  test('the title drills into the flight plan; a row opens its task', () => {
    const { opened } = mount();
    fireEvent.click(within(node('Search')).getByTestId('milestone-node-open'));
    fireEvent.click(
      within(node('Search')).getAllByTestId('milestone-node-task')[0]
    );
    expect(opened).toEqual([
      ['m2', 'plan'],
      ['b1', undefined],
    ]);
  });

  test('a wait across milestones is a counted edge and named on the node', () => {
    mount();
    expect(screen.getByTestId('milestone-map-summary').textContent).toContain(
      '1 wait between them'
    );
    expect(node('Search').textContent).toContain('waits on Checkout');
    const label = document.querySelector('[data-slot="graph-edge"] text');
    expect(label?.textContent).toBe('1');
  });
});

const LAYOUTS: MilestoneMapViewProps['layouts'] = {
  projects: {
    body: <div data-testid="projects-body" />,
    actions: <span data-testid="projects-action" />,
  },
  branches: { body: <div data-testid="branches-body" /> },
  live: { body: <div data-testid="live-body" /> },
};

function layoutNames(): string[] {
  const group = screen.getByRole('group', { name: 'Graph of' });
  return within(group)
    .getAllByRole('button')
    .map((b) => b.textContent ?? '');
}

describe('MilestoneMapView layouts', () => {
  test('the toggle offers only the layouts it was given', () => {
    mount();
    expect(layoutNames()).toEqual(['Milestones', 'Tasks']);
  });

  test('every layout is offered, map modes in between', () => {
    mount(LAYOUTS);
    expect(layoutNames()).toEqual([
      'Projects',
      'Milestones',
      'Branches',
      'Tasks',
      'Live',
    ]);
  });

  test('a layout swaps the map, its summary and Copy for its own body and actions', () => {
    mount(LAYOUTS);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    expect(screen.getByTestId('projects-body')).toBeTruthy();
    expect(screen.getByTestId('projects-action')).toBeTruthy();
    expect(screen.queryByTestId('milestone-map-summary')).toBeNull();
    expect(screen.queryByText('Copy as Mermaid')).toBeNull();
    expect(screen.queryAllByTestId('milestone-node')).toHaveLength(0);
  });

  test('the choice is remembered per project and restored', () => {
    const first = mount(LAYOUTS);
    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    first.unmount();
    mount(LAYOUTS);
    expect(screen.getByTestId('live-body')).toBeTruthy();
  });

  test('a remembered layout no longer offered falls back to Milestones', () => {
    const first = mount(LAYOUTS);
    fireEvent.click(screen.getByRole('button', { name: 'Branches' }));
    first.unmount();
    mount();
    expect(screen.getAllByTestId('milestone-node')).toHaveLength(2);
  });
});
