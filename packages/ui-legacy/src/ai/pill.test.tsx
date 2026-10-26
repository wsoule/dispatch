import { fireEvent, render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  LabelPill,
  Pill,
  PILL_BUTTON_CLASS,
  PillButton,
  SelectPill,
} from './pill';

const classesOf = (el: Element | null) =>
  (el?.getAttribute('class') ?? '').split(/\s+/);

// A pill is the 24px read-only chip: quaternary surface, chip ring, no hover.
test('Pill is a 24px quaternary chip with a half-pixel ring', () => {
  const { container } = render(<Pill>Bug</Pill>);
  const classes = classesOf(container.firstElementChild);
  expect(classes).toContain('h-6');
  expect(classes).toContain('rounded-pill');
  expect(classes).toContain('border-[0.5px]');
  expect(classes).toContain('border-border-chip');
  expect(classes).toContain('bg-surface-quaternary');
  expect(classes.some((c) => c.startsWith('hover:'))).toBe(false);
});

test('LabelPill leads with an 8px dot in the given colour', () => {
  const { container } = render(<LabelPill color="#eb5757">Bug</LabelPill>);
  const dot = container.querySelector('span[aria-hidden]') as HTMLElement;
  expect(classesOf(dot)).toContain('size-2');
  expect(dot.style.backgroundColor).not.toBe('');
  expect(screen.getByText('Bug')).toBeDefined();
});

// PillButton is the 28px secondary button: control surface, hover to active.
test('PillButton is a 28px control-surface pill that clicks', () => {
  let clicks = 0;
  render(<PillButton onClick={() => clicks++}>Filter</PillButton>);
  const button = screen.getByRole('button', { name: 'Filter' });
  const classes = classesOf(button);
  expect(classes).toContain('h-7');
  expect(classes).toContain('bg-surface-control');
  expect(classes).toContain('hover:bg-surface-active');
  fireEvent.click(button);
  expect(clicks).toBe(1);
});

test('SelectPill is a PillButton with a trailing chevron', () => {
  render(<SelectPill>Status</SelectPill>);
  const button = screen.getByRole('button', { name: 'Status' });
  for (const c of PILL_BUTTON_CLASS.split(/\s+/)) {
    expect(classesOf(button)).toContain(c);
  }
  expect(button.querySelector('svg')?.getAttribute('class')).toContain(
    'size-3'
  );
});

// A Base UI trigger merges its props onto the element it renders as, so the pill must
// forward arbitrary props and its ref for `render={<SelectPill />}` to work.
test('SelectPill forwards props and ref', () => {
  const seen: Element[] = [];
  render(
    <SelectPill
      ref={(el) => {
        if (el) seen.push(el);
      }}
      aria-haspopup="listbox"
      data-testid="pill"
    >
      Priority
    </SelectPill>
  );
  const button = screen.getByTestId('pill');
  expect(button.getAttribute('aria-haspopup')).toBe('listbox');
  expect(seen[0]).toBe(button);
});
