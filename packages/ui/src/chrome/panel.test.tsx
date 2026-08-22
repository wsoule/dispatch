import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';
import { createRef } from 'react';

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

// A header wanting a hairline or an inline toggle used to have to drop back to
// raw markup, because these two never reached the SectionLabel underneath.
test('a panel header forwards the rule and trailing content', () => {
  const { container } = render(
    <PanelHeader rule trailing={<button type="button">Only mine</button>}>
      Merge queue
    </PanelHeader>
  );
  expect(screen.getByRole('button', { name: 'Only mine' })).toBeDefined();
  expect(container.innerHTML).toContain('linear-gradient');
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

// A clickable row must still be reachable by keyboard so the app's global focus
// ring applies and j/k roving focus can move DOM focus onto it.
test('a clickable row exposes the button role and is focusable', () => {
  render(<PanelRow onClick={() => {}}>Open</PanelRow>);
  const row = screen.getByRole('button', { name: 'Open' });
  expect(row.tagName).toBe('DIV');
  expect(row.getAttribute('tabindex')).toBe('0');
});

test('a clickable row activates on Enter and Space only', () => {
  let clicks = 0;
  render(<PanelRow onClick={() => clicks++}>Open</PanelRow>);
  const row = screen.getByRole('button', { name: 'Open' });
  fireEvent.keyDown(row, { key: 'Enter' });
  fireEvent.keyDown(row, { key: ' ' });
  fireEvent.keyDown(row, { key: 'a' });
  expect(clicks).toBe(2);
});

// FeedRow — the canonical panel row — nests up to two action buttons inside the
// clickable row, which a `<button>` wrapper would make invalid HTML.
test('a nested action button is not wrapped in another button element', () => {
  const { container } = render(
    <PanelRow onClick={() => {}}>
      Retry the run
      <button type="button">Retry</button>
    </PanelRow>
  );
  expect(container.querySelector('button button')).toBeNull();
  expect(container.querySelectorAll('button')).toHaveLength(1);
});

test('a row without onClick claims no role', () => {
  render(<PanelRow>Fine</PanelRow>);
  expect(screen.queryByRole('button')).toBeNull();
});

test('a row forwards a ref and arbitrary DOM props', () => {
  const ref = createRef<HTMLDivElement>();
  render(
    <PanelRow ref={ref} data-run-id="r-7" title="Open the run">
      Open
    </PanelRow>
  );
  expect(ref.current?.getAttribute('data-run-id')).toBe('r-7');
  expect(ref.current?.getAttribute('title')).toBe('Open the run');
});
