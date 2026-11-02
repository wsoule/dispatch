import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { PeopleProvider } from '../people/PeopleContext';
import { AssigneeAvatar } from './AssigneeAvatar';

const css = readFileSync(
  join(import.meta.dir, 'AssigneeAvatar.module.css'),
  'utf8'
);

describe('AssigneeAvatar', () => {
  test('an agent is AG on the info tone', () => {
    render(<AssigneeAvatar assignee="agent" />);
    const avatar = screen.getByRole('img', { name: 'Agent' });
    expect(avatar.dataset['slot']).toBe('assignee-avatar');
    expect(avatar.dataset['kind']).toBe('agent');
    expect(avatar.dataset['tone']).toBe('info');
    expect(avatar.textContent).toBe('AG');
    expect(avatar.getAttribute('style')).toBeNull();
    expect(css).toMatch(/\.agent\s*\{[^}]*background:\s*var\(--tone-soft\)/);
    expect(css).toMatch(/\.agent\s*\{[^}]*color:\s*var\(--tone-ink\)/);
  });

  test('a person is their initials in the library avatar, hidden behind the named wrapper', () => {
    render(<AssigneeAvatar assignee="human:wyat" name="Wyat Soule" />);
    const avatar = screen.getByRole('img', { name: 'Wyat Soule' });
    expect(avatar.dataset['slot']).toBe('assignee-avatar');
    expect(avatar.dataset['kind']).toBe('human');
    expect(avatar.getAttribute('title')).toBe('Wyat Soule');
    expect(avatar.textContent).toBe('WS');
    const inner = avatar.querySelector('[data-mark=avatar]');
    expect(inner?.getAttribute('aria-hidden')).toBe('true');
    // The library hashes a decorative hue from the name, never a status hue.
    expect(['violet', 'teal', 'rose', 'orange']).toContain(
      inner?.getAttribute('data-hue') ?? ''
    );
    expect(avatar.dataset['tone']).toBeUndefined();
  });

  test('a person without a name falls back to the handle', () => {
    render(<AssigneeAvatar assignee="human:wyat" />);
    expect(screen.getByRole('img', { name: 'wyat' }).textContent).toBe('W');
  });

  test('unassigned is an empty dashed ring in the control edge colour', () => {
    render(<AssigneeAvatar assignee="none" />);
    const ring = screen.getByRole('img', { name: 'Unassigned' });
    expect(ring.dataset['slot']).toBe('assignee-avatar');
    expect(ring.dataset['kind']).toBe('none');
    expect(ring.textContent).toBe('');
    expect(css).toMatch(
      /\.empty\s*\{[^}]*border:\s*1px dashed var\(--control-border\)/
    );
  });

  test('defaults to 18px and shrinks to 16px on request', () => {
    render(
      <>
        <AssigneeAvatar assignee="agent" />
        <AssigneeAvatar assignee="agent" size={16} name="small" />
        <AssigneeAvatar assignee="none" size={16} />
        <AssigneeAvatar assignee="human:wyat" size={16} />
      </>
    );
    const [large, small] = screen.getAllByRole('img', { name: 'Agent' });
    expect(large?.dataset['size']).toBe('18');
    expect(small?.dataset['size']).toBe('16');
    expect(small?.getAttribute('title')).toBe('small');
    expect(
      screen.getByRole('img', { name: 'Unassigned' }).dataset['size']
    ).toBe('16');
    expect(screen.getByRole('img', { name: 'wyat' }).dataset['size']).toBe(
      '16'
    );
    // Both sizes reach the library avatar inside through its --sz.
    expect(css).toMatch(/\.avatar\s*\{[^}]*--sz:\s*18px/);
    expect(css).toMatch(/\.avatar\[data-size='16'\]\s*\{[^}]*--sz:\s*16px/);
    expect(css).toMatch(
      /\.avatar\[data-size='16'\] \[data-mark='avatar'\]\s*\{[^}]*--sz:\s*16px/
    ); // The initials are half the circle (8px at 16, 9px at 18), on the agent's AG and on
    // the library avatar inside alike.
    expect(css).toMatch(
      /\.avatar\s*\{[^}]*font-size:\s*calc\(var\(--sz\) \* 0\.5\)/
    );
    expect(css).toMatch(
      /\.avatar \[data-mark='avatar'\]\s*\{[^}]*font-size:\s*calc\(var\(--sz\) \* 0\.5\)/
    );
  });

  test('a caller class is kept', () => {
    render(<AssigneeAvatar assignee="agent" className="host-class" />);
    expect(
      screen
        .getByRole('img', { name: 'Agent' })
        .classList.contains('host-class')
    ).toBe(true);
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
