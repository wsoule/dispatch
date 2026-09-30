import { describe, expect, it } from 'bun:test';

import type { LinearUser } from '../src/linearMap.js';
import {
  linearUserExternal,
  peopleIndex,
  syncLinearPeople,
} from '../src/linearPeople.js';
import type { Person } from '../src/people.js';

const ME: LinearUser = {
  id: 'u-me',
  name: 'Wyat Soule',
  displayName: 'wyat',
  email: 'wyat@example.com',
  avatarUrl: 'https://a.test/w.png',
  active: true,
};
const ANA: LinearUser = {
  id: 'u-ana',
  name: 'Ana Lima',
  displayName: 'ana',
  email: 'ana@example.com',
  avatarUrl: null,
  active: true,
};

function run(
  users: LinearUser[],
  configured: Person[] = [],
  roster: Person[] = []
) {
  return syncLinearPeople({
    configured,
    known: [...roster, ...configured],
    users,
    viewerId: 'u-me',
    localRef: 'human:owner',
  });
}

describe('syncLinearPeople', () => {
  it('makes the API key’s user the local human and gives teammates handles', () => {
    const { configured, changed } = run([ME, ANA]);
    expect(changed).toBe(true);
    expect(configured).toEqual([
      {
        ref: 'human:owner',
        name: 'Wyat Soule',
        email: 'wyat@example.com',
        avatarUrl: 'https://a.test/w.png',
        external: 'linear:u-me',
      },
      {
        ref: 'human:ana',
        name: 'Ana Lima',
        email: 'ana@example.com',
        avatarUrl: null,
        external: 'linear:u-ana',
      },
    ]);
  });

  it('is idempotent', () => {
    const first = run([ME, ANA]).configured;
    const second = run([ME, ANA], first);
    expect(second.changed).toBe(false);
    expect(second.configured).toEqual(first);
  });

  it('matches a roster member by email instead of inventing a second person', () => {
    const roster: Person[] = [
      { ref: 'human:anna', name: 'Ana', email: 'ANA@example.com' },
    ];
    const { configured } = run([ANA], [], roster);
    expect(configured.map((p) => [p.ref, p.external])).toEqual([
      ['human:anna', 'linear:u-ana'],
    ]);
  });

  it('keeps a linked person’s ref when Linear renames them', () => {
    const linked: Person[] = [
      {
        ref: 'human:ana',
        name: 'Ana Lima',
        external: linearUserExternal('u-ana'),
      },
    ];
    const { configured } = run(
      [{ ...ANA, name: 'Ana Lima-Smith', displayName: 'ana.smith' }],
      linked
    );
    expect(configured[0].ref).toBe('human:ana');
    expect(configured[0].name).toBe('Ana Lima-Smith');
  });

  it('suffixes a handle another person already holds', () => {
    const taken: Person[] = [{ ref: 'human:ana', name: 'Another Ana' }];
    const { configured } = run([ANA], taken);
    expect(configured.map((p) => p.ref)).toEqual(['human:ana', 'human:ana-2']);
  });

  it('indexes people by Linear user in both directions', () => {
    const index = peopleIndex(run([ME, ANA]).configured, 'human:owner');
    expect(index.refByUser.get('u-ana')).toBe('human:ana');
    expect(index.userByRef.get('human:owner')).toBe('u-me');
  });
});
