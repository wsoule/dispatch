import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { EmptyState } from './empty-state';
import { SectionLabel } from './SectionLabel';

test('an empty state shows its message and action', () => {
  render(
    <EmptyState
      message="Nothing to land."
      action={<button type="button">Refresh</button>}
    />
  );
  expect(screen.getByText('Nothing to land.')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Refresh' })).toBeDefined();
});

// The Linear empty state: heading, description, an indigo primary pill with an
// inline keycap hint, and a control-surface secondary pill.
test('an empty state renders heading, description and both pills', () => {
  let primary = 0;
  let secondary = 0;
  const { container } = render(
    <EmptyState
      heading="No tasks yet"
      description="Plan work or dispatch an agent to get started."
      primary={{
        label: 'Plan work',
        hint: 'N then P',
        onClick: () => primary++,
      }}
      secondary={{ label: 'Import', onClick: () => secondary++ }}
    />
  );
  expect(screen.getByText('No tasks yet').className).toContain('font-medium');
  expect(
    screen.getByText('Plan work or dispatch an agent to get started.').className
  ).toContain('max-w-[340px]');
  const plan = screen.getByRole('button', { name: /Plan work/ });
  expect(plan.className).toContain('bg-primary');
  expect(plan.className).toContain('rounded-pill');
  expect(container.querySelector('kbd')?.textContent).toBe('N then P');
  fireEvent.click(plan);
  fireEvent.click(screen.getByRole('button', { name: 'Import' }));
  expect(primary).toBe(1);
  expect(secondary).toBe(1);
});

// SectionLabel is pre-existing; this only pins the count-and-rule behaviour
// its section-heading consumers rely on.
test('a section label renders its count and rule', () => {
  const { container } = render(
    <SectionLabel count={5} rule>
      History
    </SectionLabel>
  );
  expect(screen.getByText('History')).toBeDefined();
  expect(screen.getByText('5')).toBeDefined();
  expect(container.innerHTML).toContain('linear-gradient');
  expect(container.innerHTML).toContain('h-[0.5px]');
});
