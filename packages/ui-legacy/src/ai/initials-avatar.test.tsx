import { render } from '@testing-library/react';
import { expect, test } from 'bun:test';

import { colorFor, InitialsAvatar, initialsOf } from './initials-avatar';

test('initials take the first letter of the first two words', () => {
  expect(initialsOf('Wyat Soule')).toBe('WS');
  expect(initialsOf('  ada   lovelace  jr ')).toBe('AL');
});

test('a single word gives its first two letters; an empty name gives nothing', () => {
  expect(initialsOf('dispatch')).toBe('DI');
  expect(initialsOf('x')).toBe('X');
  expect(initialsOf('')).toBe('');
  expect(initialsOf('   ')).toBe('');
});

test('the colour is stable per name and a valid oklch hue', () => {
  expect(colorFor('Wyat Soule')).toBe(colorFor('Wyat Soule'));
  expect(colorFor('Wyat Soule')).not.toBe(colorFor('Ada Lovelace'));
  const hue = Number(
    /oklch\(0\.62 0\.16 (\d+)\)/.exec(colorFor('Wyat Soule'))?.[1]
  );
  expect(hue).toBeGreaterThanOrEqual(0);
  expect(hue).toBeLessThan(360);
});

test('the avatar is an 18px labelled image, round unless square', () => {
  const { container } = render(<InitialsAvatar name="Wyat Soule" />);
  const avatar = container.firstElementChild as HTMLElement;
  expect(avatar.getAttribute('role')).toBe('img');
  expect(avatar.getAttribute('aria-label')).toBe('Wyat Soule');
  expect(avatar.textContent).toBe('WS');
  expect(avatar.className).toContain('size-[18px]');
  expect(avatar.className).toContain('rounded-pill');

  const { container: square } = render(
    <InitialsAvatar name="Dispatch" square color="rgb(1, 2, 3)" />
  );
  const workspace = square.firstElementChild as HTMLElement;
  expect(workspace.className).toContain('rounded-[4px]');
  expect(workspace.style.backgroundColor).toBe('rgb(1, 2, 3)');
});
