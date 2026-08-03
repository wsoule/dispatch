import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { Panel, PanelHeader, PanelRow } from './panel';

test('a panel header shows its label and count', () => {
  render(
    <Panel>
      <PanelHeader count={5}>Needs review</PanelHeader>
    </Panel>
  );
  expect(screen.getByText('Needs review')).toBeDefined();
  expect(screen.getByText('5')).toBeDefined();
});

// The urgent tier is marked by a left edge bar rather than a red fill, since
// the palette has no hue to spend (see the spec's Section 2).
test('an urgent row carries the left edge bar', () => {
  const { container } = render(<PanelRow urgent>Failed</PanelRow>);
  expect(container.innerHTML).toContain('border-l-2');
});

test('a normal row carries no edge bar', () => {
  const { container } = render(<PanelRow>Fine</PanelRow>);
  expect(container.innerHTML).not.toContain('border-l-2');
});

// Views used to hand-roll containers 85 different ways; a clickable row must
// still be a real button so the app's global focus ring applies.
test('a clickable row is a button', () => {
  render(<PanelRow onClick={() => {}}>Open</PanelRow>);
  expect(screen.getByRole('button', { name: 'Open' })).toBeDefined();
});
