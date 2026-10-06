import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { TwoViewTopBar, type TwoViewTopBarProps } from './TwoViewTopBar';

function bar(over: Partial<TwoViewTopBarProps> = {}) {
  const calls: string[] = [];
  const props: TwoViewTopBarProps = {
    view: 'overseer',
    orb: { tone: 'amber', count: 5, spinning: false },
    orbLabel: 'Overseer · 5 waiting on you (work 5)',
    postsDot: false,
    onShowOverseer: () => calls.push('overseer'),
    onShowTasks: () => calls.push('tasks'),
    onCount: (count) => calls.push(`count:${count}`),
    counts: { asks: 5, review: 1, failed: 0, working: 2 },
    settingsCount: 0,
    onOpenSettings: () => calls.push('settings'),
    settingsOpen: false,
    onOpenDocs: () => calls.push('docs'),
    onOpenThreads: () => calls.push('threads'),
    threadsUnread: 0,
    page: null,
    projectMenu: <span>storefront</span>,
    trafficLightInset: false,
    ...over,
  };
  render(<TwoViewTopBar {...props} />);
  return calls;
}

describe('TwoViewTopBar', () => {
  test('the orb badge and "tasks ●" show the same number', () => {
    bar();
    expect(screen.getByTestId('two-views-orb-count').textContent).toBe('5');
    expect(screen.getByTestId('two-views-count-asks').textContent).toBe('● 5');
  });

  test('a zero stays visible', () => {
    bar();
    expect(screen.getByTestId('two-views-count-failed').textContent).toBe(
      '✕ 0'
    );
  });

  test('each count, the word and the orb are their own click targets', () => {
    const calls = bar();
    fireEvent.click(screen.getByTestId('two-views-count-review'));
    fireEvent.click(screen.getByTestId('two-views-tasks'));
    fireEvent.click(screen.getByTestId('two-views-orb'));
    fireEvent.click(screen.getByTestId('two-views-settings'));
    expect(calls).toEqual(['count:review', 'tasks', 'overseer', 'settings']);
  });

  test('the orb is named by its tooltip, and marks the current view', () => {
    bar({ view: 'overseer' });
    const orb = screen.getByRole('button', {
      name: 'Overseer · 5 waiting on you (work 5)',
    });
    expect(orb.getAttribute('aria-current')).toBe('page');
  });

  test('settings shows its muted admin count only when there is one', () => {
    bar({ settingsCount: 0 });
    expect(screen.getByTestId('two-views-settings').textContent).toBe(
      'settings'
    );
  });

  test('the posts dot shows only in Tasks', () => {
    bar({ postsDot: true, view: 'overseer' });
    const overseerOrb = screen.getByTestId('two-views-orb');
    expect(overseerOrb.querySelectorAll('span').length).toBe(3);
  });

  test('docs and threads open their pages; threads carries a quiet unread count', () => {
    const calls = bar({ threadsUnread: 3, page: 'threads' });
    fireEvent.click(screen.getByTestId('two-views-docs'));
    const threads = screen.getByTestId('two-views-threads');
    expect(threads.textContent).toBe('threads ·3');
    expect(threads.getAttribute('aria-current')).toBe('page');
    fireEvent.click(threads);
    expect(calls).toEqual(['docs', 'threads']);
  });
});
