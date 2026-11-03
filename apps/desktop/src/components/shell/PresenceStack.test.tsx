import type { PresenceEntry } from '@dispatch/client';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { expect, mock, test } from 'bun:test';

import { AlsoViewing, presenceLine, PresenceStack } from './PresenceStack';

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

/** The initials each avatar in `root` shows, in order. */
function avatars(root: HTMLElement): string[] {
  return Array.from(root.querySelectorAll('[data-mark="avatar"]')).map(
    (avatar) => avatar.textContent ?? ''
  );
}

test('renders nothing for a solo project', () => {
  // A lone chip reading "you are here" is noise on every solo project.
  const { container } = mount([person('wyat')]);
  expect(container.querySelector('[data-slot=presence-stack]')).toBeNull();
});

test('shows everyone once a teammate is here, by avatar and handle', () => {
  mount([person('ada.lovelace'), person('wyat')]);
  const stack = screen.getByRole('group', { name: '2 people here' });
  expect(stack.getAttribute('data-slot')).toBe('presence-stack');
  // The handle's separators read as spaces, so a dotted handle gives two letters.
  expect(avatars(stack)).toEqual(['AL', 'W']);
  // Each avatar is followed by the handle for screen readers: never initials only.
  expect(
    Array.from(stack.querySelectorAll('.srOnly')).map((n) => n.textContent)
  ).toEqual(['ada.lovelace', 'wyat']);
  // The tint is decoration, picked from the name.
  expect(
    stack.querySelector('[data-mark="avatar"]')?.getAttribute('data-hue')
  ).toBeTruthy();
});

test('collapses past three into a count', () => {
  mount(['ada', 'bob', 'cy', 'dee', 'eve'].map((h) => person(h)));
  const stack = screen.getByRole('group', { name: '5 people here' });
  expect(avatars(stack)).toEqual(['A', 'B', 'C']);
  expect(stack.textContent).toContain('+2');
  expect(stack.textContent).not.toContain('dee');
});

test('someone with a live agent is ringed in the info tone', () => {
  mount([person('ada', { runs: ['r-1'] }), person('wyat')]);
  const stack = screen.getByRole('group', { name: '2 people here' });
  const rings = Array.from(stack.querySelectorAll('[aria-hidden="true"]'))
    .filter((node) => node.querySelector('[data-mark="avatar"]') !== null)
    .map((ring) => ring.getAttribute('data-tone'));
  expect(rings).toEqual(['info', null]);
});

test('with onOpenPerson each face is a button that opens that person', () => {
  const onOpenPerson = mock((_ref: string) => {});
  render(
    <PresenceStack
      presence={[person('ada'), person('wyat'), person('grace')]}
      onOpenPerson={onOpenPerson}
    />
  );
  const stack = screen.getByRole('group', { name: '3 people here' });
  expect(
    within(stack)
      .getAllByRole('button')
      .map((button) => button.getAttribute('aria-label'))
  ).toEqual(['Open ada', 'Open wyat', 'Open grace']);
  fireEvent.click(screen.getByRole('button', { name: 'Open wyat' }));
  expect(onOpenPerson.mock.calls).toEqual([['human:wyat']]);
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

test('AlsoViewing names who else is here, in a sentence, with their avatars', () => {
  render(
    <AlsoViewing
      viewers={[person('ada'), person('grace-hopper', { runs: ['r-1'] })]}
    />
  );
  const group = screen.getByRole('group', {
    name: 'ada and grace-hopper also have this open',
  });
  expect(group.getAttribute('data-slot')).toBe('also-viewing');
  expect(avatars(group)).toEqual(['A', 'GH']);
  expect(group.querySelector('[data-tone="info"]')).not.toBeNull();
});
