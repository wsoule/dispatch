import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { BackChip, PageHead, RUNS_BACK, TasksBackButton } from './PageHead';

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

test('the back prop names another parent: Runs, named Back to runs, test id kept', () => {
  const onBack = mock(() => {});
  render(<PageHead title="Live" back={{ ...RUNS_BACK, onBack }} />);
  const back = screen.getByRole('button', { name: 'Back to runs' });
  expect(back.getAttribute('data-testid')).toBe('tasks-back');
  expect(back.textContent).toBe('Runs');
  expect(screen.queryByRole('button', { name: 'Back to tasks' })).toBeNull();
  // The chip leads the head, before the heading.
  expect(
    back.compareDocumentPosition(
      screen.getByRole('heading', { level: 1, name: 'Live' })
    ) & Node.DOCUMENT_POSITION_FOLLOWING
  ).toBeTruthy();
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
});

test('back defaults to the Tasks chip, and wins over onBack when both are given', () => {
  const fromBack = mock(() => {});
  const fromOnBack = mock(() => {});
  render(
    <PageHead
      back={{ onBack: fromBack, testId: 'docs-back' }}
      onBack={fromOnBack}
    />
  );
  // One chip only: the back prop's, with the Tasks label and name.
  expect(screen.getAllByRole('button')).toHaveLength(1);
  const back = screen.getByRole('button', { name: 'Back to tasks' });
  expect(back.getAttribute('data-testid')).toBe('docs-back');
  expect(back.textContent).toBe('Tasks');
  fireEvent.click(back);
  expect(fromBack).toHaveBeenCalledTimes(1);
  expect(fromOnBack).not.toHaveBeenCalled();
});

test('BackChip draws every field it is given, with a decorative chevron', () => {
  const onBack = mock(() => {});
  render(
    <BackChip
      label="Docs"
      name="Back to docs"
      testId="docs-back"
      onBack={onBack}
    />
  );
  const back = screen.getByRole('button', { name: 'Back to docs' });
  expect(back.getAttribute('data-testid')).toBe('docs-back');
  expect(back.textContent).toBe('Docs');
  expect(back.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
});
