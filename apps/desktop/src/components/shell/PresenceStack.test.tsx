import type { PresenceEntry } from '@dispatch/client';
import { render, screen } from '@testing-library/react';
import { expect, test } from 'bun:test';

import {
  AlsoViewing,
  initialsFor,
  presenceLine,
  PresenceStack,
} from './PresenceStack';

const person = (
  handle: string,
  over: Partial<PresenceEntry> = {}
): PresenceEntry => ({
  handle,
  ref: `human:${handle}`,
  connections: 1,
  since: '2026-09-22T12:00:00.000Z',
  runs: [],
  viewing: null,
  ...over,
});

function mount(presence: PresenceEntry[]) {
  return render(<PresenceStack presence={presence} />);
}

test('renders nothing for a solo project', () => {
  // A lone chip reading "you are here" is noise on every solo project.
  const { container } = mount([person('wyat')]);
  expect(container.querySelector('[data-slot=presence-stack]')).toBeNull();
});

test('shows everyone once a teammate is here', () => {
  mount([person('ada'), person('wyat')]);
  const stack = screen.getByRole('group', { name: '2 people here' });
  expect(stack.textContent).toContain('AD');
  expect(stack.textContent).toContain('WY');
});

test('collapses past three into a count', () => {
  mount(['ada', 'bob', 'cy', 'dee', 'eve'].map((h) => person(h)));
  const stack = screen.getByRole('group', { name: '5 people here' });
  expect(stack.textContent).toContain('+2');
  expect(stack.textContent).not.toContain('DE');
});

test('initials come from both halves of a dotted handle', () => {
  expect(initialsFor('ada.lovelace')).toBe('AL');
  expect(initialsFor('grace-hopper')).toBe('GH');
  expect(initialsFor('ada')).toBe('AD');
  expect(initialsFor('x')).toBe('X');
});

test('a tooltip line says what someone is running', () => {
  expect(presenceLine(person('ada', { runs: ['r-1'] }))).toContain(
    'running 1 agent'
  );
  expect(presenceLine(person('ada', { runs: ['r-1', 'r-2'] }))).toContain(
    'running 2 agents'
  );
  expect(presenceLine(person('ada'))).toContain('not running anything');
});

test('the tooltip line says what someone has open, by title when known', () => {
  const ada = person('ada', { viewing: 't-abc123' });
  expect(presenceLine(ada)).toContain('viewing t-abc123');
  expect(
    presenceLine(ada, (id) => (id === 't-abc123' ? 'Fix login' : undefined))
  ).toContain('viewing Fix login');
  expect(presenceLine(person('wyat'))).not.toContain('viewing');
});

test('AlsoViewing is silent until someone else has the task open', () => {
  const { container } = render(<AlsoViewing viewers={[]} />);
  expect(container.querySelector('[data-slot=also-viewing]')).toBeNull();
});

test('AlsoViewing names who else is here, in a sentence', () => {
  render(<AlsoViewing viewers={[person('ada'), person('grace')]} />);
  expect(
    screen.getByRole('group', { name: 'ada and grace also have this open' })
  ).toBeTruthy();
});
