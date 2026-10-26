import { act, fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { ListRow } from './list-row';

// Slots must land in Linear's order — checkbox, priority, id, status, title, then the
// right-aligned group — or a row reads differently from the reference.
test('slots render in reading order', () => {
  const { container } = render(
    <ListRow
      leading={<span>P</span>}
      id="DIS-5"
      status={<span>S</span>}
      title="Cache the search index"
      crumb="Search"
      trailing={<span>pill</span>}
      date="Sep 13"
      onSelectToggle={() => {}}
    />
  );
  const order = [...container.querySelectorAll('[data-slot^="list-row-"]')].map(
    (el) => el.getAttribute('data-slot')
  );
  expect(order).toEqual([
    'list-row-select',
    'list-row-leading',
    'list-row-id',
    'list-row-status',
    'list-row-title',
    'list-row-crumb',
    'list-row-trailing',
    'list-row-date',
  ]);
});

test('the row is 36px with no background and a neutral hover', () => {
  const { container } = render(<ListRow title="Row" />);
  const row = container.firstElementChild as HTMLElement;
  const classes = row.className.split(/\s+/);
  expect(classes).toContain('h-9');
  expect(classes).toContain('hover:bg-surface-hover');
  expect(classes.some((c) => c.startsWith('bg-') && !c.includes('hover'))).toBe(
    false
  );
});

// The checkbox exists only for selectable rows, is invisible at rest, and is shown
// whenever the row is hovered, focused or selected — never through the accent.
test('the checkbox is hidden at rest and shown when focused or selected', () => {
  const { container: plain } = render(<ListRow title="Row" />);
  expect(plain.querySelector('[data-slot="list-row-select"]')).toBeNull();

  const { container: rest } = render(
    <ListRow title="Row" onSelectToggle={() => {}} />
  );
  const restBox = rest.querySelector('[data-slot="list-row-select"]');
  expect(restBox?.className).toContain('opacity-0');
  expect(restBox?.className).toContain('group-hover/row:opacity-100');

  for (const props of [{ focused: true }, { selected: true }]) {
    const { container } = render(
      <ListRow title="Row" onSelectToggle={() => {}} {...props} />
    );
    const box = container.querySelector('[data-slot="list-row-select"]');
    expect(box?.className.split(/\s+/)).toContain('opacity-100');
    const row = container.firstElementChild as HTMLElement;
    expect(row.className).toContain('bg-surface-hover');
    expect(row.className).not.toContain('accent');
  }
});

test('toggling the checkbox does not open the row', () => {
  let opened = 0;
  let toggled: boolean | undefined;
  render(
    <ListRow
      title="Row"
      onClick={() => opened++}
      onSelectToggle={(next) => (toggled = next)}
    />
  );
  fireEvent.click(screen.getByRole('checkbox', { name: 'Select' }));
  expect(toggled).toBe(true);
  expect(opened).toBe(0);
});

test('a clickable row activates on Enter and Space', () => {
  let opened = 0;
  render(<ListRow title="Row" onClick={() => opened++} />);
  const row = screen.getByRole('row');
  expect(row.getAttribute('tabindex')).toBe('0');
  fireEvent.keyDown(row, { key: 'Enter' });
  fireEvent.keyDown(row, { key: ' ' });
  fireEvent.keyDown(row, { key: 'j' });
  expect(opened).toBe(2);
});

test('a nested row is indented with a tree connector', () => {
  const { container } = render(<ListRow title="Child" indent={1} />);
  const row = container.firstElementChild as HTMLElement;
  expect(row.getAttribute('data-indent')).toBe('1');
  expect(row.className.split(/\s+/)).toContain('ml-6');
  const connector = container.querySelector('[data-slot="list-row-connector"]');
  expect(connector?.className).toContain('border-l-[0.5px]');

  const { container: top } = render(<ListRow title="Parent" />);
  expect(top.querySelector('[data-slot="list-row-connector"]')).toBeNull();
});

test('the id is sans with Linear tracking, not mono', () => {
  const { container } = render(<ListRow title="Row" id="DIS-5" />);
  const id = container.querySelector('[data-slot="list-row-id"]');
  expect(id?.className).toContain('tracking-(--id-tracking)');
  expect(id?.className).not.toContain('font-mono');
  expect(id?.className).not.toContain('text-muted-foreground/70');
});

test('a nested row dims its id', () => {
  const { container } = render(<ListRow title="Child" id="DIS-6" indent={1} />);
  const id = container.querySelector('[data-slot="list-row-id"]');
  expect(id?.className).toContain('text-muted-foreground/70');
});

// `id` is the issue-id slot, so the DOM id a grid's `aria-activedescendant` points
// at needs its own prop.
test('domId lands as the DOM id, apart from the issue-id slot', () => {
  const { container } = render(
    <ListRow title="Row" id="DIS-5" domId="task-row-t-5" />
  );
  const row = container.firstElementChild as HTMLElement;
  expect(row.id).toBe('task-row-t-5');
  expect(
    container.querySelector('[data-slot="list-row-id"]')?.textContent
  ).toBe('DIS-5');
});

const everySlot = {
  leading: <span>P</span>,
  id: 'DIS-5',
  status: <span>S</span>,
  title: 'Row',
  crumb: 'Search',
  trailing: <span>pill</span>,
  date: 'Sep 13',
  onSelectToggle: () => {},
};

// Under the default `row` every slot is a `gridcell`; the crumb nests inside the
// title cell rather than being a cell of its own.
test('every slot is a gridcell under the default row role', () => {
  const { container } = render(<ListRow {...everySlot} />);
  const cells = [...container.querySelectorAll('[role="gridcell"]')].map((el) =>
    el.getAttribute('data-slot')
  );
  expect(cells).toEqual([
    'list-row-select',
    'list-row-leading',
    'list-row-id',
    'list-row-status',
    'list-row-title',
    'list-row-trailing',
    'list-row-date',
  ]);
  const crumb = container.querySelector('[data-slot="list-row-crumb"]');
  expect(crumb?.getAttribute('role')).toBeNull();
  expect(crumb?.closest('[role="gridcell"]')?.getAttribute('data-slot')).toBe(
    'list-row-title'
  );
});

test('with another role no slot carries a role', () => {
  const { container } = render(<ListRow {...everySlot} role="listitem" />);
  expect(container.querySelectorAll('[role="gridcell"]')).toHaveLength(0);
  const slots = container.querySelectorAll('[data-slot^="list-row-"]');
  expect(slots.length).toBeGreaterThan(0);
  for (const slot of slots) {
    expect(slot.getAttribute('role')).toBeNull();
  }
});

// A virtualized list mounts rows every scroll frame, so an idle, unticked row draws a
// native checkbox and the Base UI checkbox takes over on intent.
test('an idle row draws a plain select box that still ticks', () => {
  let toggled: boolean | undefined;
  render(<ListRow title="Row" onSelectToggle={(next) => (toggled = next)} />);
  const box = screen.getByRole('checkbox', { name: 'Select' });
  expect(box.tagName).toBe('INPUT');
  fireEvent.click(box);
  expect(toggled).toBe(true);
});

test('a selected or focused row renders the real checkbox', () => {
  for (const props of [{ selected: true }, { focused: true }]) {
    const { container, unmount } = render(
      <ListRow title="Row" onSelectToggle={() => {}} {...props} />
    );
    const box = container.querySelector('[data-slot="list-row-select"] > *');
    expect(box?.tagName).not.toBe('INPUT');
    unmount();
  }
});

test('keyboard focus moves onto the real checkbox when the plain one is focused', () => {
  render(<ListRow title="Row" onSelectToggle={() => {}} />);
  const cold = screen.getByRole('checkbox', { name: 'Select' });
  act(() => cold.focus());
  const live = screen.getByRole('checkbox', { name: 'Select' });
  expect(live).not.toBe(cold);
  expect(document.activeElement).toBe(live);
});
