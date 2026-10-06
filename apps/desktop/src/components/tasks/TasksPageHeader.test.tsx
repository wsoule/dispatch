import { fireEvent, render, screen } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { CrumbLink, TasksPageHeader } from './TasksPageHeader';

test('a side page leads with ‹ tasks, then its crumb; the last segment is the page', () => {
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
  expect(back.textContent).toBe('‹ tasks');
  expect(screen.getByText('Auth refactor').getAttribute('aria-current')).toBe(
    'page'
  );
  fireEvent.click(back);
  expect(onBack).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'All docs' }));
  expect(onAll).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'New doc' })).toBeDefined();
});
