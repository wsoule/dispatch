import type { TaskListItem } from '@dispatch-foo/core/browser';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { TaskTab } from '../../lib/appNav';
import type { ListGroup } from '../../lib/listGrouping';
import { taskDoc } from '../../lib/taskDoc.test-helper';
import type { TaskBucket } from '../../lib/taskStatus';
import { MilestoneMapView } from './MilestoneMap';

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

function mount() {
  const opened: [string, TaskTab | undefined][] = [];
  render(
    <MilestoneMapView
      groups={[
        group('m1', 'Checkout', [task('a1', 'landed'), task('a2'), task('a3')]),
        group('m2', 'Search', [task('b1', 'ready', ['a2']), task('b2')]),
      ]}
      bucketOf={(doc) => BUCKETS[doc.meta.id] ?? null}
      asksByTask={new Map([['b1', 2]])}
      projectKey="test"
      dueDateOf={(id) => (id === 'm2' ? '2026-11-03' : null)}
      onOpenTask={(id, tab) => opened.push([id, tab])}
    />
  );
  return opened;
}

function node(title: string): HTMLElement {
  const found = screen
    .getAllByTestId('milestone-node')
    .find((el) => el.textContent?.includes(title));
  if (found === undefined) throw new Error(`no node ${title}`);
  return found;
}

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
    const opened = mount();
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
