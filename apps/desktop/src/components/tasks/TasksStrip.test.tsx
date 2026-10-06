import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { TaskBucket, TaskStatusCounts } from '../../lib/taskStatus';
import { TasksStrip } from './TasksStrip';

const counts: TaskStatusCounts = {
  buckets: {
    'need-you': 1,
    failed: 1,
    working: 0,
    review: 4,
    landing: 0,
    ready: 0,
    draft: 0,
    blocked: 1,
  },
  open: 7,
  landed: 3,
  total: 10,
};

function mount(filter: TaskBucket | null) {
  const picked: (TaskBucket | null)[] = [];
  render(
    <TasksStrip
      counts={counts}
      filter={filter}
      onFilter={(bucket) => picked.push(bucket)}
    />
  );
  return picked;
}

describe('TasksStrip', () => {
  test('every bucket shows, zeros included, with landed over total', () => {
    mount(null);
    expect(screen.getByTestId('tasks-strip-working').textContent).toBe(
      '◐ 0 working'
    );
    expect(screen.getByText('✓ 3/10 landed')).toBeTruthy();
  });

  test('the top bar’s states filter; pressing the active one clears it', () => {
    const picked = mount('review');
    fireEvent.click(screen.getByTestId('tasks-strip-failed'));
    fireEvent.click(screen.getByTestId('tasks-strip-review'));
    expect(picked).toEqual(['failed', null]);
    expect(
      screen.getByTestId('tasks-strip-review').getAttribute('aria-pressed')
    ).toBe('true');
  });

  test('resting buckets are labels, not buttons', () => {
    mount(null);
    expect(screen.getByTestId('tasks-strip-blocked').tagName).toBe('SPAN');
  });
});
