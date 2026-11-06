import { describe, expect, test } from 'bun:test';

import { LinearApiError } from '../../src/planner/linear/gateway.js';
import {
  approximateLastStateChangeAt,
  isArchivedNode,
  mapBlockingRelation,
  mapInitiative,
  mapIssue,
  mapMilestone,
  mapPriority,
  mapProject,
  mapProjectStatusType,
  mapTeam,
  mapTeamMembership,
  mapTeamVisibility,
  mapUser,
  mapWorkflowState,
  mapWorkflowStateType,
} from '../../src/planner/linear/map.js';
import {
  issueNode,
  milestoneNode,
  projectNode,
  recordingLogger,
  relationNode,
  userNode,
} from './helpers.js';

describe('mapPriority', () => {
  test.each([
    [0, 0],
    [1, 1],
    [2.4, 2],
    [2.5, 3],
    [3.6, 4],
    [4, 4],
    [7, 4],
    [-1, 0],
    [Number.NaN, 0],
    ['2', 0],
    [null, 0],
  ] as const)('%p → %p', (input, expected) => {
    expect(mapPriority(input)).toBe(expected);
  });
});

describe('mapWorkflowStateType', () => {
  test('known types pass through', () => {
    for (const type of [
      'triage',
      'backlog',
      'unstarted',
      'started',
      'completed',
      'canceled',
    ] as const) {
      expect(mapWorkflowStateType(type)).toBe(type);
    }
  });

  test('duplicate is a closed (canceled) state, without a warning', () => {
    const { logger, lines } = recordingLogger();
    expect(mapWorkflowStateType('duplicate', logger)).toBe('canceled');
    expect(lines).toEqual([]);
  });

  test('unknown types become backlog and log a warning', () => {
    const { logger, lines } = recordingLogger();
    expect(mapWorkflowStateType('review_pending', logger, 'st-9')).toBe(
      'backlog'
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]?.level).toBe('warn');
    expect(lines[0]?.fields).toEqual({
      type: 'review_pending',
      stateId: 'st-9',
    });
  });

  test('mapWorkflowState keeps the name and team of a duplicate state', () => {
    const state = mapWorkflowState({
      id: 'st-dup',
      name: 'Duplicate',
      type: 'duplicate',
      position: 7,
      team: { id: 'team-1' },
    });
    expect(state).toEqual({
      id: 'st-dup',
      teamId: 'team-1',
      name: 'Duplicate',
      type: 'canceled',
      position: 7,
    });
  });
});

describe('project status', () => {
  test('ProjectStatus.type maps to statusType, name to statusName', () => {
    const project = mapProject(
      projectNode('p1', { status: { type: 'paused', name: 'On hold' } })
    );
    expect(project.statusType).toBe('paused');
    expect(project.statusName).toBe('On hold');
  });

  test('unknown status types are inactive (backlog) with a warning', () => {
    const { logger, lines } = recordingLogger();
    expect(mapProjectStatusType('frozen', logger, 'p1')).toBe('backlog');
    expect(lines[0]?.level).toBe('warn');
  });

  test('missing status is a malformed response', () => {
    expect(() => mapProject(projectNode('p1', { status: null }))).toThrow(
      LinearApiError
    );
  });

  test('a full project node maps every field', () => {
    expect(
      mapProject(
        projectNode('p1', {
          priority: 1,
          lead: null,
          initiatives: { nodes: [{ id: 'i1' }, { id: 'i2' }] },
          teams: { nodes: [{ id: 't1' }] },
          targetDate: '2026-12-01',
        })
      )
    ).toEqual({
      id: 'p1',
      name: 'Project p1',
      url: 'https://linear.app/acme/project/p1',
      leadId: null,
      priority: 1,
      sortOrder: 1.5,
      statusType: 'started',
      statusName: 'In Progress',
      initiativeIds: ['i1', 'i2'],
      teamIds: ['t1'],
      startDate: '2026-10-01',
      targetDate: '2026-12-01',
    });
  });
});

describe('project id lists', () => {
  test('a cut-off initiative or team list is kept and logged, not silent', () => {
    const { logger, lines } = recordingLogger();
    const project = mapProject(
      projectNode('p1', {
        initiatives: {
          nodes: [{ id: 'i1' }],
          pageInfo: { hasNextPage: true },
        },
        teams: { nodes: [{ id: 't1' }], pageInfo: { hasNextPage: false } },
      }),
      logger
    );
    expect(project.initiativeIds).toEqual(['i1']);
    expect(project.teamIds).toEqual(['t1']);
    expect(lines).toEqual([
      {
        level: 'warn',
        message: 'linear id list truncated; only the first page is kept',
        fields: { entity: 'Project', field: 'initiatives', id: 'p1', kept: 1 },
      },
    ]);
  });
});

describe('approximateLastStateChangeAt', () => {
  test('is the latest of created/started/completed/canceled', () => {
    expect(
      approximateLastStateChangeAt({
        createdAt: '2026-10-01T00:00:00.000Z',
        startedAt: '2026-10-05T00:00:00.000Z',
        completedAt: '2026-10-03T00:00:00.000Z',
        canceledAt: null,
      })
    ).toBe('2026-10-05T00:00:00.000Z');
    expect(
      approximateLastStateChangeAt({
        createdAt: '2026-10-01T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        canceledAt: '2026-10-09T12:00:00.000Z',
      })
    ).toBe('2026-10-09T12:00:00.000Z');
    expect(
      approximateLastStateChangeAt({
        createdAt: '2026-10-01T00:00:00.000Z',
        startedAt: null,
        completedAt: null,
        canceledAt: null,
      })
    ).toBe('2026-10-01T00:00:00.000Z');
  });

  test('mapIssue fills lastStateChangeAt with the approximation', () => {
    const issue = mapIssue(
      issueNode('1', {
        startedAt: '2026-10-04T08:00:00Z',
        completedAt: '2026-10-06T08:00:00Z',
      })
    );
    expect(issue.lastStateChangeAt).toBe('2026-10-06T08:00:00.000Z');
    // Timestamps are normalised to toISOString() form.
    expect(issue.startedAt).toBe('2026-10-04T08:00:00.000Z');
  });
});

describe('mapIssue', () => {
  test('maps references, rounds Float priority, keeps nulls', () => {
    expect(
      mapIssue(
        issueNode('7', {
          priority: 1.0000001,
          assignee: { id: 'user-1' },
          project: null,
          projectMilestone: null,
        })
      )
    ).toEqual({
      id: '7',
      identifier: 'ENG-7',
      title: 'Issue 7',
      url: 'https://linear.app/acme/issue/ENG-7',
      teamId: 'team-1',
      projectId: null,
      milestoneId: null,
      assigneeId: 'user-1',
      stateId: 'state-1',
      priority: 1,
      createdAt: '2026-10-01T10:00:00.000Z',
      updatedAt: '2026-10-02T10:00:00.000Z',
      startedAt: null,
      completedAt: null,
      canceledAt: null,
      lastStateChangeAt: '2026-10-01T10:00:00.000Z',
      dueDate: null,
    });
  });

  test('maps the due date; a malformed or absent one reads null', () => {
    expect(mapIssue(issueNode('8', { dueDate: '2026-11-02' })).dueDate).toBe(
      '2026-11-02'
    );
    expect(mapIssue(issueNode('9', { dueDate: 'next week' })).dueDate).toBe(
      null
    );
    expect(mapIssue(issueNode('10', { dueDate: null })).dueDate).toBe(null);
    expect(mapIssue(issueNode('11')).dueDate).toBe(null);
  });

  test('missing required fields raise a graphql LinearApiError', () => {
    const error = (() => {
      try {
        mapIssue(issueNode('1', { state: null }));
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(LinearApiError);
    expect((error as LinearApiError).kind).toBe('graphql');
    expect((error as LinearApiError).message).toContain('Issue.state.id');
    expect(() => mapIssue('not an object')).toThrow(LinearApiError);
  });
});

describe('mapUser', () => {
  test('app users and nullable email', () => {
    expect(
      mapUser(userNode('app', { app: true, email: '', avatarUrl: 'https://a' }))
    ).toEqual({
      id: 'app',
      name: 'Name app',
      displayName: 'app',
      email: null,
      avatarUrl: 'https://a',
      active: true,
      app: true,
      guest: false,
    });
    expect(mapUser(userNode('u', { email: null })).email).toBeNull();
    expect(mapUser(userNode('u', { active: false })).active).toBe(false);
    expect(mapUser(userNode('g', { guest: true })).guest).toBe(true);
  });
});

describe('mapTeam', () => {
  test('visibility, parent and the members read beside it', () => {
    expect(
      mapTeam(
        {
          id: 'team-sec',
          key: 'SEC',
          name: 'Security',
          visibility: 'private',
          parent: { id: 'team-eng' },
        },
        ['u1', 'u2']
      )
    ).toEqual({
      id: 'team-sec',
      key: 'SEC',
      name: 'Security',
      visibility: 'private',
      parentId: 'team-eng',
      memberIds: ['u1', 'u2'],
    });
    expect(
      mapTeam({
        id: 't',
        key: 'T',
        name: 'T',
        visibility: 'public',
        parent: null,
      })
    ).toMatchObject({ parentId: null, memberIds: [] });
  });

  test('an unknown visibility reads as private, and is logged', () => {
    const { logger, lines } = recordingLogger();
    expect(mapTeamVisibility('secret-ish', logger)).toBe('private');
    expect(mapTeamVisibility(undefined)).toBe('private');
    expect(mapTeamVisibility('restricted')).toBe('restricted');
    expect(lines.map((l) => l.message)).toEqual([
      'unknown Linear team visibility; treating it as private',
    ]);
  });

  test('memberships map to pairs; a broken node is dropped', () => {
    expect(
      mapTeamMembership({ team: { id: 't1' }, user: { id: 'u1' } })
    ).toEqual({ teamId: 't1', userId: 'u1' });
    expect(mapTeamMembership({ team: null, user: { id: 'u1' } })).toBeNull();
  });
});

describe('milestones, initiatives, relations', () => {
  test('milestone TimelessDate is kept as YYYY-MM-DD', () => {
    expect(
      mapMilestone(
        milestoneNode('m1', { targetDate: '2026-11-03', sortOrder: 2.5 })
      )
    ).toEqual({
      id: 'm1',
      projectId: 'proj-1',
      name: 'Milestone m1',
      description: null,
      targetDate: '2026-11-03',
      sortOrder: 2.5,
    });
    expect(
      mapMilestone(milestoneNode('m2', { targetDate: 'soon' })).targetDate
    ).toBeNull();
  });

  test('initiative Int priority is clamped', () => {
    expect(
      mapInitiative({
        id: 'i',
        name: 'I',
        sortOrder: 3,
        priority: 9,
        targetDate: null,
      })
    ).toEqual({
      id: 'i',
      name: 'I',
      sortOrder: 3,
      priority: 4,
      targetDate: null,
    });
  });

  test('only "blocks" relations map; issue blocks relatedIssue', () => {
    expect(mapBlockingRelation(relationNode('r1', 'blocks', 'a', 'b'))).toEqual(
      {
        id: 'r1',
        blockerId: 'a',
        blockedId: 'b',
      }
    );
    for (const type of ['related', 'duplicate', 'similar']) {
      expect(mapBlockingRelation(relationNode('r', type, 'a', 'b'))).toBeNull();
    }
  });

  test('isArchivedNode', () => {
    expect(isArchivedNode({ archivedAt: '2026-10-01T00:00:00Z' })).toBe(true);
    expect(isArchivedNode({ archivedAt: null, trashed: true })).toBe(true);
    expect(isArchivedNode({ archivedAt: null, trashed: false })).toBe(false);
  });
});
