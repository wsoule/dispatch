import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { EmptyState } from './empty-state';
import { SectionLabel } from './SectionLabel';
import { Toolbar } from './toolbar';
import { ViewHeader } from './view-header';

test('a view header renders title, subtitle and actions', () => {
  render(
    <ViewHeader
      title="Review"
      subtitle="Local diffs"
      actions={<button type="button">Go</button>}
    />
  );
  expect(screen.getByRole('heading', { name: 'Review' })).toBeDefined();
  expect(screen.getByText('Local diffs')).toBeDefined();
  expect(screen.getByRole('button', { name: 'Go' })).toBeDefined();
});

// Headers and toolbars clipped at ~1036px before the primitive layer existed;
// wrapping is the fix and must not regress.
test('a toolbar wraps rather than clipping', () => {
  const { container } = render(<Toolbar>filter</Toolbar>);
  expect(container.innerHTML).toContain('flex-wrap');
});

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

// SectionLabel is pre-existing; this only pins the behaviour Plan 2 relies on
// when it migrates the 16 dense-label sites onto it.
test('a section label renders its count and rule', () => {
  const { container } = render(
    <SectionLabel count={5} rule>
      History
    </SectionLabel>
  );
  expect(screen.getByText('History')).toBeDefined();
  expect(screen.getByText('5')).toBeDefined();
  expect(container.innerHTML).toContain('linear-gradient');
});
