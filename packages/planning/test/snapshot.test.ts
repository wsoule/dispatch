import { describe, expect, test } from 'bun:test';

import {
  findIssue,
  indexWorkspace,
  isOpenState,
  issueStateType,
  priorityRank,
} from '../src/index';
import type { Priority, WorkflowStateType } from '../src/index';
import {
  day,
  issue,
  milestone,
  project,
  STATE,
  user,
  workspace,
} from './helpers';

describe('isOpenState', () => {
  test.each([
    ['triage', true],
    ['backlog', true],
    ['unstarted', true],
    ['started', true],
    ['completed', false],
    ['canceled', false],
  ] as [WorkflowStateType, boolean][])('%s → %s', (type, expected) => {
    expect(isOpenState(type)).toBe(expected);
  });
});

describe('priorityRank', () => {
  test.each([
    [1, 1],
    [2, 2],
    [3, 3],
    [4, 4],
    [0, 5],
  ] as [Priority, number][])('priority %d ranks %d', (p, rank) => {
    expect(priorityRank(p)).toBe(rank);
  });
});

describe('indexWorkspace', () => {
  const data = workspace({
    users: [user('lead'), user('ana')],
    projects: [project('p1'), project('p2')],
    milestones: [
      milestone('m-undated-b', 'p1', { targetDate: null, sortOrder: 2 }),
      milestone('m-late', 'p1', { targetDate: day(30) }),
      milestone('m-undated-a', 'p1', { targetDate: null, sortOrder: 1 }),
      milestone('m-early-2', 'p1', { targetDate: day(5), sortOrder: 2 }),
      milestone('m-early-1', 'p1', { targetDate: day(5), sortOrder: 1 }),
      milestone('m-bad-date', 'p1', { targetDate: '2026-02-30', sortOrder: 0 }),
    ],
    issues: [
      issue('i1', {
        projectId: 'p1',
        milestoneId: 'm-late',
        assigneeId: 'ana',
      }),
      issue('i2', { projectId: 'p1', milestoneId: 'm-late' }),
      issue('i3', { projectId: 'p1' }),
      issue('i4', { assigneeId: 'ana' }),
    ],
    relations: [
      { id: 'r1', blockerId: 'i1', blockedId: 'i2' },
      // Same pair again: counted once.
      { id: 'r2', blockerId: 'i1', blockedId: 'i2' },
      { id: 'r3', blockerId: 'i3', blockedId: 'i2' },
      // Blocker not mirrored: ignored.
      { id: 'r4', blockerId: 'ghost', blockedId: 'i2' },
      // Blocked not mirrored: ignored.
      { id: 'r5', blockerId: 'i1', blockedId: 'ghost' },
    ],
  });
  const snapshot = indexWorkspace(data);

  test('builds id maps for every entity', () => {
    expect(snapshot.users.get('ana')?.name).toBe('Ana');
    expect(snapshot.projects.size).toBe(2);
    expect(snapshot.milestones.size).toBe(6);
    expect(snapshot.issues.size).toBe(4);
    expect(snapshot.states.get(STATE.todo)?.type).toBe('unstarted');
    expect(snapshot.teams.has('team-eng')).toBe(true);
  });

  test('orders milestonesByProject by date, undated last, then sortOrder', () => {
    expect(snapshot.milestonesByProject.get('p1')?.map((m) => m.id)).toEqual([
      'm-early-1',
      'm-early-2',
      'm-late',
      // A malformed date counts as undated.
      'm-bad-date',
      'm-undated-a',
      'm-undated-b',
    ]);
    expect(snapshot.milestonesByProject.get('p2')).toEqual([]);
  });

  test('groups issues by milestone, project and assignee', () => {
    expect(snapshot.issuesByMilestone.get('m-late')?.map((i) => i.id)).toEqual([
      'i1',
      'i2',
    ]);
    expect(snapshot.issuesByMilestone.get('m-early-1')).toEqual([]);
    expect(snapshot.issuesByProject.get('p1')?.map((i) => i.id)).toEqual([
      'i1',
      'i2',
      'i3',
    ]);
    expect(snapshot.issuesByAssignee.get('ana')?.map((i) => i.id)).toEqual([
      'i1',
      'i4',
    ]);
  });

  test('indexes blocks relations both ways, ignoring unmirrored and duplicates', () => {
    expect(snapshot.blockersOf.get('i2')).toEqual(['i1', 'i3']);
    expect(snapshot.blocking.get('i1')).toEqual(['i2']);
    expect(snapshot.blocking.get('i3')).toEqual(['i2']);
    expect(snapshot.blockersOf.has('ghost')).toBe(false);
    expect(snapshot.blocking.has('ghost')).toBe(false);
  });

  test('an issue whose state is not mirrored counts as backlog (open)', () => {
    const ghost = issue('g', { stateId: 'missing-state' });
    const snap = indexWorkspace(workspace({ issues: [ghost] }));
    expect(issueStateType(snap, ghost)).toBe('backlog');
  });
});

describe('findIssue (moved from the planner)', () => {
  const snapshot = indexWorkspace(
    workspace({
      issues: [issue('iss-24', { identifier: 'ENG-24' }), issue('iss-3')],
    })
  );

  test('finds an issue by id, or by identifier in any case', () => {
    expect(findIssue(snapshot.issues, 'iss-24')?.identifier).toBe('ENG-24');
    expect(findIssue(snapshot.issues, 'ENG-24')?.id).toBe('iss-24');
    expect(findIssue(snapshot.issues, 'eng-24')?.id).toBe('iss-24');
    expect(findIssue(snapshot.issues, 'ENG-999')).toBeUndefined();
  });
});
