import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { CrumbLink, TasksBackButton, TasksPageHeader } from './TasksPageHeader';

test('a side page leads with the back chip, then its crumb; the last segment is the page', () => {
  const onBack = mock(() => {});
  const onAll = mock(() => {});
  render(
    <TasksPageHeader
      onBack={onBack}
      crumb={[
        <CrumbLink key="all" onClick={onAll}>
          All docs
        </CrumbLink>,
        'Auth refactor',
      ]}
      actions={<button type="button">New doc</button>}
    />
  );
  const back = screen.getByTestId('tasks-back');
  expect(back).toBe(screen.getByRole('button', { name: 'Back to tasks' }));
  expect(back.textContent).toBe('Tasks');
  expect(screen.getByText('Auth refactor').getAttribute('aria-current')).toBe(
    'page'
  );
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);

  const allDocs = screen.getByRole('button', { name: 'All docs' });
  expect(allDocs.getAttribute('type')).toBe('button');
  expect(allDocs.closest('[aria-current]')).toBeNull();
  fireEvent.click(allDocs);
  expect(onAll).toHaveBeenCalledTimes(1);

  expect(screen.getByRole('button', { name: 'New doc' })).toBeDefined();
  expect(
    document.querySelector('[data-slot="page-header"]')?.contains(back)
  ).toBe(true);
});

test('TasksBackButton is re-exported for the pages that lead their own head', () => {
  const onBack = mock(() => {});
  render(<TasksBackButton onBack={onBack} />);
  fireEvent.click(screen.getByRole('button', { name: 'Back to tasks' }));
  expect(onBack).toHaveBeenCalledTimes(1);
});
