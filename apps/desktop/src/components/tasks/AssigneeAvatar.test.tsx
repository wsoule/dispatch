import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';

import { PeopleProvider } from '../people/PeopleContext';
import { AssigneeAvatar } from './AssigneeAvatar';

describe('AssigneeAvatar', () => {
  test('an agent is AG on the in-progress colour', () => {
    render(<AssigneeAvatar assignee="agent" />);
    const avatar = screen.getByRole('img', { name: 'Agent' });
    expect(avatar.dataset['slot']).toBe('initials-avatar');
    expect(avatar.dataset['kind']).toBe('agent');
    expect(avatar.textContent).toBe('AG');
    expect(avatar.style.backgroundColor).toBe('var(--status-progress)');
  });

  test('a person is their initials on a colour hashed from the name', () => {
    render(<AssigneeAvatar assignee="human:wyat" name="Wyat Soule" />);
    const avatar = screen.getByRole('img', { name: 'Wyat Soule' });
    expect(avatar.dataset['kind']).toBe('human');
    expect(avatar.textContent).toBe('WS');
    expect(avatar.style.backgroundColor).not.toBe('');
    expect(avatar.style.backgroundColor).not.toBe('var(--status-progress)');
  });

  test('a person without a name falls back to the handle', () => {
    render(<AssigneeAvatar assignee="human:wyat" />);
    expect(screen.getByRole('img', { name: 'wyat' }).textContent).toBe('WY');
  });

  test('unassigned is an empty dashed ring', () => {
    render(<AssigneeAvatar assignee="none" />);
    const ring = screen.getByRole('img', { name: 'Unassigned' });
    expect(ring.dataset['slot']).toBe('assignee-avatar');
    expect(ring.textContent).toBe('');
    expect(ring.className).toContain('border-dashed');
    expect(ring.className).toContain('border-[0.5px]');
    expect(ring.className).toContain('rounded-pill');
  });

  test('defaults to the 18px primitive and shrinks to 16px on request', () => {
    render(
      <>
        <AssigneeAvatar assignee="agent" />
        <AssigneeAvatar assignee="agent" size={16} name="small" />
        <AssigneeAvatar assignee="none" size={16} />
      </>
    );
    const [large, small] = screen.getAllByRole('img', { name: 'Agent' });
    expect(large?.className).toContain('size-[18px]');
    expect(large?.className).toContain('text-[9px]');
    expect(small?.className).toContain('size-4');
    expect(small?.className).toContain('text-[8px]');
    expect(small?.className).not.toContain('size-[18px]');
    // The primitive's line-height survives the size override.
    expect(large?.className).toContain('leading-none');
    expect(small?.className).toContain('leading-none');
    expect(screen.getByRole('img', { name: 'Unassigned' }).className).toContain(
      'size-4'
    );
  });
});

describe('AssigneeAvatar with the people registry', () => {
  const people = [
    { ref: 'human:maya', name: 'Maya Chen' },
    {
      ref: 'human:lena',
      name: 'Lena Park',
      avatarUrl: 'https://example.com/lena.png',
    },
  ];

  test('a registered person reads by their name', () => {
    render(
      <PeopleProvider people={people} me="human:maya">
        <AssigneeAvatar assignee="human:maya" />
      </PeopleProvider>
    );
    expect(screen.getByRole('img', { name: 'Maya Chen' }).textContent).toBe(
      'MC'
    );
  });

  test('the legacy bare human is me', () => {
    render(
      <PeopleProvider people={people} me="human:maya">
        <AssigneeAvatar assignee="human" />
      </PeopleProvider>
    );
    expect(screen.getByRole('img', { name: 'Maya Chen' })).not.toBeNull();
  });

  test('a person with a photo shows it', () => {
    render(
      <PeopleProvider people={people} me={null}>
        <AssigneeAvatar assignee="human:lena" />
      </PeopleProvider>
    );
    const photo = screen.getByRole('img', { name: 'Lena Park' });
    expect(photo.tagName).toBe('IMG');
    expect(photo.getAttribute('src')).toBe('https://example.com/lena.png');
  });

  test('a photo that will not load (a host the CSP refuses) falls back to initials', () => {
    render(
      <PeopleProvider people={people} me={null}>
        <AssigneeAvatar assignee="human:lena" />
      </PeopleProvider>
    );
    fireEvent.error(screen.getByRole('img', { name: 'Lena Park' }));
    const fallback = screen.getByRole('img', { name: 'Lena Park' });
    expect(fallback.tagName).not.toBe('IMG');
    expect(fallback.textContent).toBe('LP');
  });
});
