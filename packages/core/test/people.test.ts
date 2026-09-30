import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConfigError, loadConfig, updateConfig } from '../src/config.js';
import {
  canonicalAssignee,
  fanoutHolder,
  personError,
  personFor,
  resolvePeople,
} from '../src/people.js';

function writeConfig(contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-people-'));
  mkdirSync(join(dir, '.dispatch'), { recursive: true });
  writeFileSync(join(dir, '.dispatch/config.yml'), contents);
  return dir;
}

describe('people registry', () => {
  it('merges the roster with configured people, config winning', () => {
    const people = resolvePeople(
      [
        {
          ref: 'human:wyat',
          name: 'Wyat S.',
          avatarUrl: 'https://a/w.png',
          external: 'linear:u1',
        },
        { ref: 'human:ada', name: 'Ada' },
      ],
      [
        {
          handle: 'wyat',
          email: 'w@example.com',
          displayName: 'Wyat',
          emails: [],
        },
      ]
    );
    expect(people).toEqual([
      {
        ref: 'human:wyat',
        name: 'Wyat S.',
        email: 'w@example.com',
        avatarUrl: 'https://a/w.png',
        external: 'linear:u1',
      },
      {
        ref: 'human:ada',
        name: 'Ada',
        email: null,
        avatarUrl: null,
        external: null,
      },
    ]);
  });

  it('maps the legacy bare human to the local user', () => {
    expect(canonicalAssignee('human', 'human:wyat')).toBe('human:wyat');
    expect(canonicalAssignee('agent', 'human:wyat')).toBe('agent');
    const people = [{ ref: 'human:wyat', name: 'Wyat' }];
    expect(personFor('human', people, 'human:wyat')?.name).toBe('Wyat');
  });

  it('validates entries', () => {
    expect(personError({ ref: 'human:ada', name: 'Ada' })).toBeNull();
    expect(personError({ ref: 'agent:x', name: 'X' })).toMatch(/human/);
    expect(personError({ ref: 'human', name: 'X' })).toMatch(/human/);
    expect(personError({ ref: 'human:ada', name: '' })).toMatch(/name/);
  });

  it('loads, rejects and round-trips config people', () => {
    expect(
      loadConfig(writeConfig('statuses: [ready]\n')).people
    ).toBeUndefined();
    expect(() =>
      loadConfig(writeConfig('people:\n  - { ref: bob, name: Bob }\n'))
    ).toThrow(ConfigError);
    const root = writeConfig('statuses: [ready]\n');
    updateConfig(root, {
      people: [{ ref: 'human:ada', name: 'Ada', email: 'a@example.com' }],
    });
    expect(loadConfig(root).people).toEqual([
      {
        ref: 'human:ada',
        name: 'Ada',
        email: 'a@example.com',
        avatarUrl: null,
        external: null,
      },
    ]);
    updateConfig(root, { people: null });
    expect(loadConfig(root).people).toBeUndefined();
  });
});

describe('fanoutHolder', () => {
  const holder = (assignee: string) =>
    fanoutHolder(assignee, 'human:wyat', 'human:wyat');

  it('lets a fan-out start unassigned, agent and its starter’s own work', () => {
    for (const assignee of [
      'none',
      '',
      'agent',
      'agent:claude',
      'agent:wyat/claude',
      'human:wyat',
      'human',
    ]) {
      expect(holder(assignee)).toBeNull();
    }
  });

  it('names the teammate who holds anything else', () => {
    expect(holder('human:sam')).toBe('human:sam');
    expect(holder('agent:sam/claude')).toBe('human:sam');
    expect(holder('Sam Rivera')).toBe('Sam Rivera');
  });

  it('reads bare human as the local user, not the starter', () => {
    // A teammate's fan-out on a shared daemon: bare `human` is the operator.
    expect(fanoutHolder('human', 'human:ada', 'human:wyat')).toBe('human:wyat');
    expect(fanoutHolder('human:ada', 'human:ada', 'human:wyat')).toBeNull();
  });
});
