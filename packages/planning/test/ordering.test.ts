import { describe, expect, test } from 'bun:test';

import {
  compareIssues,
  compareMilestones,
  groupProjectsByInitiative,
  homeInitiativeIds,
  indexWorkspace,
  NO_INITIATIVE_ID,
  orderProjects,
} from '../src/index';
import type { Milestone, Snapshot } from '../src/index';
import {
  day,
  evaluate,
  initiative,
  issue,
  meta,
  milestone,
  project,
  STATE,
  workspace,
} from './helpers';

describe('compareMilestones (§2.7)', () => {
  // Each milestone gets one open, assigned issue so it is not empty/complete.
  function ordered(
    milestones: Milestone[],
    projects = [project('p1', { priority: 2 })],
    weights: Record<string, number> = {}
  ): string[] {
    const evaluated = evaluate(
      workspace({
        projects,
        milestones,
        issues: milestones.map((m) =>
          issue(`${m.id}-i`, {
            projectId: m.projectId,
            milestoneId: m.id,
            assigneeId: 'lead',
            stateId: STATE.started,
          })
        ),
      }),
      {
        meta: Object.entries(weights).map(([id, weight]) =>
          meta(id, { weight })
        ),
      }
    );
    return [...milestones]
      .sort(
        compareMilestones(
          evaluated.snapshot,
          evaluated.ctx,
          evaluated.assessments
        )
      )
      .map((m) => m.id);
  }

  test('overdue first, then by date, undated last', () => {
    expect(
      ordered([
        milestone('undated', 'p1', { targetDate: null }),
        milestone('later', 'p1', { targetDate: day(30) }),
        milestone('soon', 'p1', { targetDate: day(3) }),
        milestone('overdue', 'p1', { targetDate: day(-2) }),
      ])
    ).toEqual(['overdue', 'soon', 'later', 'undated']);
  });

  test('weight bumps a milestone within its group but never above overdue', () => {
    expect(
      ordered(
        [
          milestone('soon', 'p1', { targetDate: day(3) }),
          milestone('heavy', 'p1', { targetDate: day(30) }),
          milestone('overdue', 'p1', { targetDate: day(-2) }),
          milestone('negative', 'p1', { targetDate: day(1) }),
        ],
        undefined,
        { heavy: 5, negative: -1 }
      )
    ).toEqual(['overdue', 'heavy', 'soon', 'negative']);
  });

  test('same date: project priority (none last), then sortOrder, then id', () => {
    expect(
      ordered(
        [
          milestone('none', 'p-none', { targetDate: day(5) }),
          milestone('low', 'p-low', { targetDate: day(5) }),
          milestone('urgent-b', 'p-urgent', {
            targetDate: day(5),
            sortOrder: 2,
          }),
          milestone('urgent-a2', 'p-urgent', {
            targetDate: day(5),
            sortOrder: 1,
          }),
          milestone('urgent-a1', 'p-urgent', {
            targetDate: day(5),
            sortOrder: 1,
          }),
        ],
        [
          project('p-none', { priority: 0 }),
          project('p-low', { priority: 4 }),
          project('p-urgent', { priority: 1 }),
        ]
      )
    ).toEqual(['urgent-a1', 'urgent-a2', 'urgent-b', 'low', 'none']);
  });
});

describe('compareIssues (§2.7)', () => {
  test('priority (none last), then oldest first, then identifier', () => {
    const issues = [
      issue('none', {
        priority: 0,
        identifier: 'ENG-1',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      issue('low', {
        priority: 4,
        identifier: 'ENG-2',
        createdAt: '2026-01-01T00:00:00Z',
      }),
      issue('urgent-new', {
        priority: 1,
        identifier: 'ENG-3',
        createdAt: '2026-06-01T00:00:00Z',
      }),
      issue('urgent-old', {
        priority: 1,
        identifier: 'ENG-4',
        createdAt: '2026-02-01T00:00:00Z',
      }),
      issue('high-10', {
        priority: 2,
        identifier: 'ENG-10',
        createdAt: '2026-03-01T00:00:00Z',
      }),
      issue('high-9', {
        priority: 2,
        identifier: 'ENG-9',
        createdAt: '2026-03-01T00:00:00Z',
      }),
      issue('medium', {
        priority: 3,
        identifier: 'ENG-5',
        createdAt: '2026-01-01T00:00:00Z',
      }),
    ];
    expect([...issues].sort(compareIssues).map((i) => i.id)).toEqual([
      'urgent-old',
      'urgent-new',
      'high-9',
      'high-10',
      'medium',
      'low',
      'none',
    ]);
  });
});

// Three initiatives and projects in none, one or two of them; one project
// lists only an initiative id the mirror does not hold.
function initiativeWorkspace(): Snapshot {
  return indexWorkspace(
    workspace({
      initiatives: [
        initiative('i-low', { priority: 4, sortOrder: 0 }),
        initiative('i-urgent', { priority: 1, sortOrder: 5 }),
        initiative('i-none', { priority: 0, sortOrder: 0 }),
      ],
      projects: [
        project('loose', { priority: 1 }),
        project('in-low', { initiativeIds: ['i-low'], priority: 1 }),
        // Belongs to two initiatives: shown under the higher-ranked one.
        project('both', {
          initiativeIds: ['i-low', 'i-urgent'],
          priority: 3,
        }),
        // The same two, best-ranked listed first: still i-urgent, so the
        // rule is the rank, not the position in the list.
        project('both-urgent-first', {
          initiativeIds: ['i-urgent', 'i-low'],
          priority: 4,
        }),
        project('urgent-a', {
          initiativeIds: ['i-urgent'],
          priority: 2,
          sortOrder: 2,
        }),
        project('urgent-b', {
          initiativeIds: ['i-urgent'],
          priority: 2,
          sortOrder: 1,
        }),
        project('unmirrored', { initiativeIds: ['ghost'], priority: 0 }),
        project('in-none', { initiativeIds: ['i-none'] }),
      ],
    })
  );
}

describe('orderProjects (timeline order)', () => {
  test('initiative order, first initiative wins, then priority and sortOrder; no initiative last', () => {
    const snapshot = initiativeWorkspace();
    expect(orderProjects(snapshot).map((p) => p.id)).toEqual([
      'urgent-b',
      'urgent-a',
      'both',
      'both-urgent-first',
      'in-low',
      'in-none',
      'loose',
      'unmirrored',
    ]);
  });
});

describe('homeInitiativeIds (the timeline grouping, shared with the graph)', () => {
  test('each project’s best-ranked mirrored initiative, or null', () => {
    const home = homeInitiativeIds(initiativeWorkspace());
    expect([...home.entries()]).toEqual([
      ['loose', null],
      ['in-low', 'i-low'],
      // In two initiatives: the higher-ranked one, as on the timeline.
      ['both', 'i-urgent'],
      ['both-urgent-first', 'i-urgent'],
      ['urgent-a', 'i-urgent'],
      ['urgent-b', 'i-urgent'],
      // Its only initiative id is not mirrored: ignored.
      ['unmirrored', null],
      ['in-none', 'i-none'],
    ]);
    expect(NO_INITIATIVE_ID).toBe('none');
  });

  test('agrees with groupProjectsByInitiative', () => {
    const snapshot = initiativeWorkspace();
    const home = homeInitiativeIds(snapshot);
    for (const group of groupProjectsByInitiative(snapshot)) {
      for (const project of group.projects) {
        expect(home.get(project.id)).toBe(group.initiative?.id ?? null);
      }
    }
  });
});
