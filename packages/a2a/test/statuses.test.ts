import { CANONICAL_STATUSES } from '@dispatch-foo/core';
import { describe, expect, it } from 'bun:test';

import {
  handoffStatuses,
  handoffSupported,
  namedStatusVocabulary,
} from '../src/statuses.js';
import type { StatusVocabulary } from '../src/statuses.js';

// A project mirroring Linear's default workflow: no built-in names at all.
const LINEAR: StatusVocabulary = {
  definitions: [
    { name: 'Triage', type: 'triage' },
    { name: 'Backlog', type: 'backlog' },
    { name: 'Todo', type: 'unstarted' },
    { name: 'In Progress', type: 'started' },
    { name: 'In Review', type: 'started' },
    { name: 'Merging', type: 'started' },
    { name: 'Done', type: 'completed' },
    { name: 'Canceled', type: 'canceled' },
    { name: 'Duplicate', type: 'canceled' },
  ],
  roles: {
    ready: 'Todo',
    review: 'In Review',
    landing: 'Merging',
    landed: 'Done',
    dropped: 'Canceled',
  },
};

describe('handoffStatuses', () => {
  it('reads a Linear-style workflow by type and role, never by name', () => {
    const s = handoffStatuses(LINEAR);
    expect(handoffSupported(s)).toBe(true);
    expect(s).toMatchObject({
      draft: 'Backlog',
      ready: 'Todo',
      landed: 'Done',
      dropped: 'Canceled',
    });
    expect(LINEAR.definitions.map((d) => [d.name, s.phase(d.name)])).toEqual([
      ['Triage', 'draft'],
      ['Backlog', 'draft'],
      ['Todo', 'queued'],
      ['In Progress', 'working'],
      ['In Review', 'review'],
      ['Merging', 'landing'],
      ['Done', 'landed'],
      ['Canceled', 'dropped'],
      ['Duplicate', 'dropped'],
    ]);
  });

  it('drafts into triage when the workflow has no backlog', () => {
    const s = handoffStatuses({
      ...LINEAR,
      definitions: LINEAR.definitions.filter((d) => d.type !== 'backlog'),
    });
    expect(s.draft).toBe('Triage');
  });

  it('keeps the built-in names, legacy aliases included, and treats a custom name as in progress', () => {
    const s = handoffStatuses(
      namedStatusVocabulary([...CANONICAL_STATUSES, 'qa'])
    );
    expect(handoffSupported(s)).toBe(true);
    expect(s.draft).toBe('draft');
    expect(
      [
        'backlog',
        'ready',
        'working',
        'review',
        'landing',
        'done',
        'cancelled',
        'qa',
      ].map((n) => s.phase(n))
    ).toEqual([
      'draft',
      'queued',
      'working',
      'review',
      'landing',
      'landed',
      'dropped',
      'working',
    ]);
  });

  it('cannot hand off without a draft, ready, landed and dropped status', () => {
    expect(
      handoffSupported(
        handoffStatuses(namedStatusVocabulary(['todo', 'doing', 'done']))
      )
    ).toBe(false);
    expect(
      handoffSupported(
        handoffStatuses({ ...LINEAR, roles: { ...LINEAR.roles, landed: null } })
      )
    ).toBe(false);
  });
});
