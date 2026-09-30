import { describe, expect, it } from 'bun:test';

import { DEFAULT_STATUS_MAP } from '../src/linearMap.js';
import type { LinearWorkflowState } from '../src/linearMap.js';
import {
  defaultStatusRoles,
  migrateStatus,
  primaryStatusRoles,
  reconcileStatusRoles,
  renamesForTeam,
  statusesFromTeams,
  statusesFromWorkflowStates,
  statusRenames,
  statusTypeOfState,
} from '../src/linearStatuses.js';
import { DEFAULT_STATUS_MODEL } from '../src/status.js';
import type { StatusModel } from '../src/status.js';
import { STATES } from './linearFixtures.js';

describe('statusesFromWorkflowStates', () => {
  it('mirrors the team’s states in Linear’s board order, with types and colors', () => {
    const { definitions, names } = statusesFromWorkflowStates(
      [...STATES].reverse()
    );
    expect(definitions.map((d) => d.name)).toEqual([
      'Triage',
      'Backlog',
      'Todo',
      'In Progress',
      'QA',
      'In Review',
      'Done',
      'Canceled',
      'Duplicate',
    ]);
    expect(definitions.find((d) => d.name === 'QA')).toEqual({
      name: 'QA',
      type: 'started',
      color: '#26b5ce',
    });
    expect(definitions.find((d) => d.name === 'Duplicate')?.type).toBe(
      'canceled'
    );
    expect(names['s-qa']).toBe('QA');
  });

  it('round-trips every state, custom ones included, through its status name', () => {
    const { names } = statusesFromWorkflowStates(STATES);
    const back = new Map(Object.entries(names).map(([id, name]) => [name, id]));
    for (const state of STATES)
      expect(back.get(names[state.id])).toBe(state.id);
  });

  it('never generates a name the legacy alias layer would rewrite', () => {
    const states: LinearWorkflowState[] = [
      { id: 'a', name: 'done', type: 'completed' },
      { id: 'b', name: 'todo', type: 'unstarted' },
    ];
    const { names } = statusesFromWorkflowStates(states);
    expect(names).toEqual({ a: 'Done', b: 'Todo' });
  });

  it('keeps two states that spell the same name apart', () => {
    const states: LinearWorkflowState[] = [
      { id: 'a', name: 'Doing', type: 'started', position: 0 },
      { id: 'b', name: 'Doing', type: 'started', position: 1 },
    ];
    expect(statusesFromWorkflowStates(states).names).toEqual({
      a: 'Doing',
      b: 'Doing (2)',
    });
  });

  it('types an unknown state type as backlog', () => {
    expect(statusTypeOfState('mystery')).toBe('backlog');
  });
});

describe('statusesFromTeams', () => {
  // A second team on a customized workflow: a QA-less board with a Design
  // state of its own, and a "Review" that means done there.
  const OPS: LinearWorkflowState[] = [
    { id: 'o-backlog', name: 'Backlog', type: 'backlog', position: 0 },
    { id: 'o-todo', name: 'todo', type: 'unstarted', position: 0 },
    { id: 'o-progress', name: 'In Progress', type: 'started', position: 0 },
    { id: 'o-design', name: 'Design', type: 'started', position: 1 },
    { id: 'o-review', name: 'In Review', type: 'completed', position: 0 },
    { id: 'o-done', name: 'Done', type: 'completed', position: 1 },
    { id: 'o-canceled', name: 'Canceled', type: 'canceled', position: 0 },
  ];

  it('merges states by name and type, one status per shared state', () => {
    const { definitions, names } = statusesFromTeams([STATES, OPS]);
    expect(definitions.map((d) => [d.name, d.type])).toEqual([
      ['Triage', 'triage'],
      ['Backlog', 'backlog'],
      ['Todo', 'unstarted'],
      ['In Progress', 'started'],
      // Ops' Design follows the state before it on Ops' board.
      ['Design', 'started'],
      ['QA', 'started'],
      ['In Review', 'started'],
      // Same name, other type: a status of its own.
      ['In Review (2)', 'completed'],
      ['Done', 'completed'],
      ['Canceled', 'canceled'],
      ['Duplicate', 'canceled'],
    ]);
    expect(names['o-todo']).toBe('Todo');
    expect(names['o-progress']).toBe(names['s-progress']);
    expect(names['o-review']).toBe('In Review (2)');
    expect(names['s-review']).toBe('In Review');
  });

  it('never renames the primary team’s statuses when a team is linked', () => {
    const alone = statusesFromTeams([STATES]).names;
    const linked = statusesFromTeams([STATES, OPS]).names;
    for (const state of STATES) expect(linked[state.id]).toBe(alone[state.id]);
  });

  it('is the single-team generation for one team', () => {
    expect(statusesFromTeams([STATES])).toEqual(
      statusesFromWorkflowStates(STATES)
    );
  });
});

describe('defaultStatusRoles', () => {
  it('routes runs to started, review to the review-named state, landing nowhere', () => {
    const { definitions } = statusesFromWorkflowStates(STATES);
    expect(defaultStatusRoles(definitions)).toEqual({
      ready: 'Todo',
      dispatched: 'In Progress',
      review: 'In Review',
      landing: null,
      landed: 'Done',
      dropped: 'Canceled',
    });
  });

  it('falls back to the first started state when none is named like review', () => {
    const { definitions } = statusesFromWorkflowStates(
      STATES.filter((s) => s.id !== 's-review')
    );
    expect(defaultStatusRoles(definitions).review).toBe('In Progress');
  });

  it('takes several teams’ roles from the primary team’s statuses alone', () => {
    const ops: LinearWorkflowState[] = [
      { id: 'o-design', name: 'Design', type: 'started', position: 0 },
      { id: 'o-shipped', name: 'Shipped', type: 'completed', position: 0 },
    ];
    const generated = statusesFromTeams([STATES, ops]);
    expect(generated.definitions.map((d) => d.name)).toContain('Design');
    expect(primaryStatusRoles(generated, STATES)).toEqual(
      defaultStatusRoles(statusesFromWorkflowStates(STATES).definitions)
    );
  });

  it('makes do with a team that has no unstarted or canceled states', () => {
    const { definitions } = statusesFromWorkflowStates([
      { id: 'b', name: 'Ideas', type: 'backlog' },
      { id: 's', name: 'Doing', type: 'started' },
      { id: 'd', name: 'Shipped', type: 'completed' },
    ]);
    expect(defaultStatusRoles(definitions)).toMatchObject({
      ready: 'Ideas',
      dropped: 'Shipped',
    });
  });
});

describe('reconcileStatusRoles', () => {
  const fresh = defaultStatusRoles(
    statusesFromWorkflowStates(STATES).definitions
  );
  const names = statusesFromWorkflowStates(STATES).definitions.map(
    (d) => d.name
  );

  it('takes the fresh defaults on the first link', () => {
    const current = { ...fresh, review: 'QA' };
    expect(
      reconcileStatusRoles(current, null, fresh, names, new Map())
    ).toEqual(fresh);
  });

  it('keeps a role the user changed since the last generation', () => {
    const current = { ...fresh, review: 'QA' };
    expect(
      reconcileStatusRoles(current, fresh, fresh, names, new Map()).review
    ).toBe('QA');
  });

  it('follows a renamed state, and drops an override whose state is gone', () => {
    const current = { ...fresh, review: 'QA', landed: 'Shipped' };
    const renamed = names.map((n) => (n === 'QA' ? 'Verify' : n));
    const out = reconcileStatusRoles(
      current,
      fresh,
      fresh,
      renamed,
      new Map([['QA', 'Verify']])
    );
    expect(out.review).toBe('Verify');
    expect(out.landed).toBe('Done');
  });

  it('keeps a landing role the user switched on', () => {
    const current = { ...fresh, landing: 'In Review' };
    expect(
      reconcileStatusRoles(current, fresh, fresh, names, new Map()).landing
    ).toBe('In Review');
  });
});

describe('statusRenames and migrateStatus', () => {
  const generated = statusesFromWorkflowStates(STATES);
  const after: StatusModel = {
    definitions: generated.definitions,
    roles: defaultStatusRoles(generated.definitions),
  };
  const migration = {
    renames: new Map<string, string>(),
    before: DEFAULT_STATUS_MODEL,
    after,
    legacyMap: DEFAULT_STATUS_MAP,
    states: STATES,
    names: generated.names,
  };

  it('moves every built-in status to the state the old map pointed at', () => {
    const moved = Object.fromEntries(
      [
        'draft',
        'ready',
        'working',
        'review',
        'landing',
        'landed',
        'dropped',
      ].map((s) => [s, migrateStatus(s, migration)])
    );
    expect(moved).toEqual({
      draft: 'Backlog',
      ready: 'Todo',
      working: 'In Progress',
      review: 'In Review',
      landing: 'In Review',
      landed: 'Done',
      dropped: 'Canceled',
    });
  });

  it('falls back to the role, then the type, for a status the map never named', () => {
    const before: StatusModel = {
      definitions: [
        ...DEFAULT_STATUS_MODEL.definitions,
        { name: 'blocked', type: 'started', color: null },
      ],
      roles: DEFAULT_STATUS_MODEL.roles,
    };
    expect(
      migrateStatus('blocked', { ...migration, before, legacyMap: {} })
    ).toBe('In Progress');
  });

  it('renames a status when its state was renamed in Linear', () => {
    const renames = statusRenames({ 's-qa': 'QA' }, { 's-qa': 'Verify' });
    expect([...renames.shared]).toEqual([['QA', 'Verify']]);
    expect(migrateStatus('QA', { ...migration, renames: renames.shared })).toBe(
      'Verify'
    );
  });

  it('moves a shared status only for the team that renamed its state', () => {
    // Both teams' Todo merged into one status; only Ops renamed its own.
    const renames = statusRenames(
      { 's-todo': 'Todo', 'o-todo': 'Todo' },
      { 's-todo': 'Todo', 'o-todo': 'Ready' },
      new Map([
        ['s-todo', 'team-1'],
        ['o-todo', 'team-2'],
      ])
    );
    expect([...renames.shared]).toEqual([]);
    expect([...renamesForTeam(renames, 'team-2')]).toEqual([['Todo', 'Ready']]);
    expect([...renamesForTeam(renames, 'team-1')]).toEqual([]);
    expect([...renamesForTeam(renames, null)]).toEqual([]);
  });

  it('moves a shared status for everyone when every team renamed it alike', () => {
    const renames = statusRenames(
      { 's-todo': 'Todo', 'o-todo': 'Todo' },
      { 's-todo': 'Ready', 'o-todo': 'Ready' }
    );
    expect([...renames.shared]).toEqual([['Todo', 'Ready']]);
  });

  it('leaves a status that is still defined alone', () => {
    expect(migrateStatus('QA', migration)).toBe('QA');
  });
});
