import type { Person } from '@dispatch-foo/core/browser';
import type { ExecutorInfo } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import {
  AGENT_POOL,
  AGENT_POOL_LABEL,
  agentChoiceId,
  AGENTS_GROUP,
  assigneeDisplay,
  buildPersonChoices,
} from './people';

const WYAT: Person = {
  ref: 'human:wyat',
  name: 'Wyatt Soule',
  email: 'wyat@example.com',
};
const ANA: Person = { ref: 'human:ana', name: 'Ana Moreno', email: null };
const PLACEHOLDER: Person = {
  ref: 'human:linear-user',
  name: 'Unknown Linear user',
  placeholder: true,
};

const EXECUTORS: ExecutorInfo[] = [
  { name: 'claude', reportsCost: true, reportsTurns: true, enforcesCaps: true },
  {
    name: 'codex',
    reportsCost: false,
    reportsTurns: false,
    enforcesCaps: false,
  },
];

describe('buildPersonChoices', () => {
  test('people first (you on top, then registry order), then the Agents group', () => {
    const choices = buildPersonChoices({
      people: [ANA, WYAT],
      executors: EXECUTORS,
      me: 'human:wyat',
    });
    expect(choices.map((c) => c.id)).toEqual([
      'human:wyat',
      'human:ana',
      'agent',
      'agent:wyat/claude',
      'agent:wyat/codex',
    ]);
    expect(choices.map((c) => c.kind)).toEqual([
      'human',
      'human',
      'agent',
      'agent',
      'agent',
    ]);
    expect(choices.map((c) => c.group)).toEqual([
      undefined,
      undefined,
      AGENTS_GROUP,
      AGENTS_GROUP,
      AGENTS_GROUP,
    ]);
  });

  test('a person carries the handle as hint, email and handle as search words, and an initials avatar', () => {
    const [wyat, ana] = buildPersonChoices({
      people: [WYAT, ANA],
      executors: [],
      me: null,
    });
    expect(wyat).toEqual({
      id: 'human:wyat',
      name: 'Wyatt Soule',
      hint: 'wyat',
      keywords: ['wyat@example.com', 'wyat'],
      mark: { kind: 'avatar', name: 'Wyatt Soule' },
      kind: 'human',
    });
    // A null email is not a search word.
    expect(ana.keywords).toEqual(['ana']);
  });

  test('a placeholder person is never offered', () => {
    const choices = buildPersonChoices({
      people: [PLACEHOLDER, ANA],
      executors: [],
      me: null,
    });
    expect(choices.filter((c) => c.kind === 'human').map((c) => c.id)).toEqual([
      'human:ana',
    ]);
  });

  test('the Agents group starts with the pool, labelled "Any agent", with no avatar mark', () => {
    const choices = buildPersonChoices({
      people: [WYAT],
      executors: ['claude'],
      me: 'human:wyat',
    });
    const pool = choices.find((c) => c.id === AGENT_POOL);
    expect(pool).toEqual({
      id: 'agent',
      name: AGENT_POOL_LABEL,
      group: AGENTS_GROUP,
      kind: 'agent',
    });
    expect(pool?.mark).toBeUndefined();
  });

  test('an executor is an agent owned by you, searchable by its full ref; names and infos both work', () => {
    const fromInfos = buildPersonChoices({
      people: [WYAT],
      executors: EXECUTORS,
      me: 'human:wyat',
    });
    const fromNames = buildPersonChoices({
      people: [WYAT],
      executors: ['claude', 'codex'],
      me: 'human:wyat',
    });
    expect(fromInfos).toEqual(fromNames);
    expect(fromInfos.find((c) => c.name === 'claude')).toEqual({
      id: 'agent:wyat/claude',
      name: 'claude',
      keywords: ['agent:wyat/claude'],
      group: AGENTS_GROUP,
      kind: 'agent',
    });
  });

  test('before the daemon says who you are, an executor is an unowned agent', () => {
    const choices = buildPersonChoices({
      people: [WYAT],
      executors: ['claude'],
      me: null,
    });
    expect(choices.map((c) => c.id)).toEqual([
      'human:wyat',
      'agent',
      'agent:claude',
    ]);
  });

  test('without a registry the one person on offer is you, by handle', () => {
    const choices = buildPersonChoices({
      people: [],
      executors: [],
      me: 'human:wyat',
    });
    expect(choices.map((c) => c.id)).toEqual(['human:wyat', 'agent']);
    expect(choices[0]).toMatchObject({
      name: 'wyat',
      kind: 'human',
      mark: { kind: 'avatar', name: 'wyat' },
    });
    expect(choices[0].hint).toBeUndefined();
  });

  test('without a registry or a signed-in person, the legacy bare human stands in', () => {
    const choices = buildPersonChoices({ people: [], executors: [], me: null });
    expect(choices.map((c) => c.id)).toEqual(['human', 'agent']);
    expect(choices[0].name).toBe('Human');
  });

  test('a registry of only placeholders counts as no registry', () => {
    const choices = buildPersonChoices({
      people: [PLACEHOLDER],
      executors: [],
      me: 'human:wyat',
    });
    expect(choices.map((c) => c.id)).toEqual(['human:wyat', 'agent']);
  });
});

describe('agentChoiceId', () => {
  test("names the executor as your agent, or as nobody's before sign-in", () => {
    expect(agentChoiceId('human:wyat', 'claude')).toBe('agent:wyat/claude');
    expect(agentChoiceId(null, 'claude')).toBe('agent:claude');
  });
});

describe('assigneeDisplay', () => {
  const personFor = (assignee: string) =>
    assignee === 'human:wyat' ? { name: 'Wyatt Soule' } : undefined;

  test('nobody reads "Unassigned", muted', () => {
    for (const value of ['none', null, undefined, ''] as const) {
      expect(assigneeDisplay(value, personFor)).toEqual({
        label: 'Unassigned',
        tone: 'muted',
        isAgent: false,
      });
    }
  });

  test('a registered person is named by the registry, an unknown one by the handle', () => {
    expect(assigneeDisplay('human:wyat', personFor)).toEqual({
      label: 'Wyatt Soule',
      isAgent: false,
    });
    expect(assigneeDisplay('human:ana', personFor)).toEqual({
      label: 'ana',
      isAgent: false,
    });
    // The legacy bare `human` is a person with no handle.
    expect(assigneeDisplay('human', personFor)).toEqual({
      label: 'Human',
      isAgent: false,
    });
  });

  test('an agent reads by its handle, the pool as "Any agent"', () => {
    expect(assigneeDisplay('agent:wyat/claude', personFor)).toEqual({
      label: 'claude',
      isAgent: true,
    });
    expect(assigneeDisplay('agent:claude', personFor)).toEqual({
      label: 'claude',
      isAgent: true,
    });
    expect(assigneeDisplay('agent', personFor)).toEqual({
      label: AGENT_POOL_LABEL,
      isAgent: true,
    });
  });

  test('a malformed ref reads as a person with the raw value for a handle', () => {
    expect(assigneeDisplay('Someone Else', personFor)).toEqual({
      label: 'Someone Else',
      isAgent: false,
    });
  });
});
