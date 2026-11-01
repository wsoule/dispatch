import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { PageHead, TasksBackButton } from './PageHead';

test('a full head: back chip, crumb trail, heading, meta, receipts and actions', () => {
  const onBack = mock(() => {});
  render(
    <PageHead
      data-testid="head"
      onBack={onBack}
      crumbs={['dispatch', 'Projects']}
      title="Projects"
      meta="Synced a minute ago"
      receipts="9 projects in 3 initiatives"
      actions={<button type="button">New project</button>}
    />
  );
  const head = screen.getByTestId('head');
  expect(head.tagName).toBe('HEADER');
  expect(head.getAttribute('data-slot')).toBe('page-header');
  expect(
    within(head).getByRole('heading', { level: 1, name: 'Projects' })
  ).toBeDefined();
  expect(within(head).getByText('Synced a minute ago')).toBeDefined();
  expect(within(head).getByText('9 projects in 3 initiatives')).toBeDefined();
  expect(
    within(head).getByRole('button', { name: 'New project' })
  ).toBeDefined();

  fireEvent.click(within(head).getByTestId('tasks-back'));
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('the crumb is one Breadcrumb trail; only the last segment is the page', () => {
  render(<PageHead crumbs={['dispatch', 'Drafts', 'Draft']} />);
  const trail = screen.getByRole('navigation', { name: 'Breadcrumb' });
  expect(trail.getAttribute('data-slot')).toBe('page-header-crumb');
  // The separators are hidden from assistive tech; the text still reads in order.
  expect(trail.textContent).toBe('dispatch›Drafts›Draft');
  const current = trail.querySelectorAll('[aria-current="page"]');
  expect(current).toHaveLength(1);
  expect(current[0]?.textContent).toBe('Draft');
  for (const separator of Array.from(
    trail.querySelectorAll('[aria-hidden="true"]')
  )) {
    expect(separator.textContent).toBe('›');
  }
  // A crumb-only head has no heading.
  expect(screen.queryByRole('heading')).toBeNull();
});

test('titleLevel 2 draws an h2, and absent parts draw nothing', () => {
  render(<PageHead title="Usage" titleLevel={2} />);
  expect(
    screen.getByRole('heading', { level: 2, name: 'Usage' })
  ).toBeDefined();
  expect(screen.queryByRole('navigation')).toBeNull();
  expect(screen.queryByTestId('tasks-back')).toBeNull();
  expect(screen.queryByRole('button')).toBeNull();
});

test('TasksBackButton says Tasks and is named Back to tasks', () => {
  const onBack = mock(() => {});
  render(<TasksBackButton onBack={onBack} />);
  const back = screen.getByRole('button', { name: 'Back to tasks' });
  expect(back.getAttribute('data-testid')).toBe('tasks-back');
  expect(back.textContent).toBe('Tasks');
  // The chevron is decorative.
  expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
});
