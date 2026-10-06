import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import type { TasksPreset } from '../../lib/tasksPresets';
import type { TaskStatusCounts } from '../../lib/taskStatus';
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

function mount(preset: TasksPreset) {
  const picked: TasksPreset[] = [];
  render(
    <TasksStrip
      counts={counts}
      preset={preset}
      onPreset={(next) => picked.push(next)}
    />
  );
  return picked;
}

describe('TasksStrip', () => {
  test('every bucket shows, zeros included, with landed over total', () => {
    mount('all');
    expect(screen.getByTestId('tasks-strip-working').textContent).toBe(
      '◐ 0 working'
    );
    expect(screen.getByText('✓ 3/10 landed')).toBeTruthy();
  });

  test('a chip opens its preset; pressing the active one goes back to All', () => {
    const picked = mount('review');
    fireEvent.click(screen.getByTestId('tasks-strip-failed'));
    fireEvent.click(screen.getByTestId('tasks-strip-working'));
    fireEvent.click(screen.getByTestId('tasks-strip-review'));
    expect(picked).toEqual(['failed', 'moving', 'all']);
    expect(
      screen.getByTestId('tasks-strip-review').getAttribute('aria-pressed')
    ).toBe('true');
  });

  test('resting buckets are labels, not buttons', () => {
    mount('all');
    expect(screen.getByTestId('tasks-strip-blocked').tagName).toBe('SPAN');
  });
});
