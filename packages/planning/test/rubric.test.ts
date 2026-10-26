import { describe, expect, test } from 'bun:test';

import {
  evaluateRubric,
  indexWorkspace,
  milestoneProgress,
  resolveDoneMeans,
  RUBRIC_GAP_LABEL,
} from '../src/index';
import type { DoneMeans, RubricGap } from '../src/index';
import {
  issue,
  meta,
  milestone,
  project,
  STATE,
  user,
  workspace,
} from './helpers';

describe('milestoneProgress', () => {
  test('counts per §2.2: canceled and duplicates leave scope, triage counts as unassigned', () => {
    const snapshot = indexWorkspace(
      workspace({
        projects: [project('p1')],
        milestones: [milestone('m1', 'p1')],
        issues: [
          issue('done1', {
            milestoneId: 'm1',
            stateId: STATE.done,
            assigneeId: 'lead',
          }),
          issue('done2', { milestoneId: 'm1', stateId: STATE.done }),
          issue('canceled', { milestoneId: 'm1', stateId: STATE.canceled }),
          issue('duplicate', { milestoneId: 'm1', stateId: STATE.duplicate }),
          issue('triage', { milestoneId: 'm1', stateId: STATE.triage }),
          issue('backlog', { milestoneId: 'm1', stateId: STATE.backlog }),
          issue('started', {
            milestoneId: 'm1',
            stateId: STATE.started,
            assigneeId: 'lead',
          }),
          issue('elsewhere', { milestoneId: 'm2' }),
        ],
      })
    );
    expect(milestoneProgress(snapshot, 'm1')).toEqual({
      total: 7,
      completed: 2,
      canceled: 2,
      scope: 5,
      open: 3,
      openUnassigned: 2,
      openTriage: 1,
    });
  });

  test('an unknown milestone has all-zero progress', () => {
    const snapshot = indexWorkspace(workspace());
    expect(milestoneProgress(snapshot, 'nope')).toEqual({
      total: 0,
      completed: 0,
      canceled: 0,
      scope: 0,
      open: 0,
      openUnassigned: 0,
      openTriage: 0,
    });
  });
});

describe('resolveDoneMeans', () => {
  test.each<[string, string | null, string | null, DoneMeans]>([
    [
      'planner text wins',
      '  Users can export  ',
      'Done means: from Linear',
      { text: 'Users can export', source: 'planner' },
    ],
    [
      'blank planner text falls through',
      '   ',
      'Done means: from Linear',
      { text: 'from Linear', source: 'linear_description' },
    ],
    [
      'colon',
      null,
      'Done means: CSV export works',
      { text: 'CSV export works', source: 'linear_description' },
    ],
    [
      'em dash',
      null,
      'done means — beta is live',
      { text: 'beta is live', source: 'linear_description' },
    ],
    [
      'markdown bold label',
      null,
      '**Done means:** shipped to all teams',
      { text: 'shipped to all teams', source: 'linear_description' },
    ],
    [
      'markdown list item',
      null,
      'Context first.\n- Done means: invoices export to CSV',
      { text: 'invoices export to CSV', source: 'linear_description' },
    ],
    [
      'emphasised outcome',
      null,
      '> Done means: **beta is live**',
      { text: 'beta is live', source: 'linear_description' },
    ],
    [
      'bold label with nothing after it',
      null,
      '**Done means:**',
      { text: null, source: null },
    ],
    [
      'no separator',
      null,
      'Done means the beta is live',
      { text: 'the beta is live', source: 'linear_description' },
    ],
    [
      'leading space, caps',
      null,
      '   DONE MEANS - shipped',
      { text: 'shipped', source: 'linear_description' },
    ],
    [
      'first matching line',
      null,
      '## Scope\r\nSome notes\r\nDone means: second line\nDone means: third',
      { text: 'second line', source: 'linear_description' },
    ],
    [
      'word boundary required',
      null,
      'Done meanswhile nothing',
      { text: null, source: null },
    ],
    [
      'not at line start',
      null,
      'Note: done means shipped',
      { text: null, source: null },
    ],
    ['empty outcome', null, 'Done means:   ', { text: null, source: null }],
    // The separator alone is not an outcome (it used to resolve to ":").
    ['bare colon', null, 'Done means:', { text: null, source: null }],
    ['bare dash', null, 'Done means —', { text: null, source: null }],
    [
      'a bare heading line is skipped for a later outcome',
      null,
      'Done means:\nDone means: beta is live',
      { text: 'beta is live', source: 'linear_description' },
    ],
    ['no description', null, null, { text: null, source: null }],
  ])('%s', (_name, plannerText, description, expected) => {
    const m = milestone('m1', 'p1', { description });
    const metaRow =
      plannerText === null ? undefined : meta('m1', { doneMeans: plannerText });
    expect(resolveDoneMeans(m, metaRow)).toEqual(expected);
  });
});

describe('evaluateRubric', () => {
  test.each<
    [
      string,
      { date: boolean; doneMeans: boolean; lead: boolean; issues: boolean },
      RubricGap[],
    ]
  >([
    ['valid', { date: true, doneMeans: true, lead: true, issues: true }, []],
    [
      'no date',
      { date: false, doneMeans: true, lead: true, issues: true },
      ['no_target_date'],
    ],
    [
      'no done means',
      { date: true, doneMeans: false, lead: true, issues: true },
      ['no_done_means'],
    ],
    [
      'no lead',
      { date: true, doneMeans: true, lead: false, issues: true },
      ['no_project_lead'],
    ],
    [
      'no issues',
      { date: true, doneMeans: true, lead: true, issues: false },
      ['no_issues'],
    ],
    [
      'everything missing, in display order',
      { date: false, doneMeans: false, lead: false, issues: false },
      ['no_target_date', 'no_done_means', 'no_project_lead', 'no_issues'],
    ],
    [
      'lead and issues missing',
      { date: true, doneMeans: true, lead: false, issues: false },
      ['no_project_lead', 'no_issues'],
    ],
  ])('%s', (_name, has, gaps) => {
    const snapshot = indexWorkspace(
      workspace({
        projects: [project('p1', { leadId: has.lead ? 'lead' : null })],
        milestones: [
          milestone('m1', 'p1', {
            targetDate: has.date ? '2026-11-01' : null,
            description: has.doneMeans ? 'Done means: shipped' : 'Notes only',
          }),
        ],
        issues: has.issues ? [issue('i1', { milestoneId: 'm1' })] : [],
      })
    );
    expect(evaluateRubric(snapshot, 'm1', undefined)).toEqual({
      valid: gaps.length === 0,
      gaps,
    });
  });

  test('done means from the planner satisfies item (b)', () => {
    const snapshot = indexWorkspace(
      workspace({
        projects: [project('p1')],
        milestones: [milestone('m1', 'p1', { description: null })],
        issues: [issue('i1', { milestoneId: 'm1' })],
      })
    );
    expect(evaluateRubric(snapshot, 'm1', undefined).gaps).toEqual([
      'no_done_means',
    ]);
    expect(
      evaluateRubric(snapshot, 'm1', meta('m1', { doneMeans: 'Shipped' })).valid
    ).toBe(true);
  });

  test('a deactivated lead still counts as a lead for the rubric', () => {
    const snapshot = indexWorkspace(
      workspace({
        users: [user('lead', { active: false })],
        projects: [project('p1')],
        milestones: [milestone('m1', 'p1')],
        issues: [issue('i1', { milestoneId: 'm1' })],
      })
    );
    expect(evaluateRubric(snapshot, 'm1', undefined).valid).toBe(true);
  });

  test('an unknown milestone fails every item', () => {
    const snapshot = indexWorkspace(workspace());
    expect(evaluateRubric(snapshot, 'nope', undefined).gaps).toEqual([
      'no_target_date',
      'no_done_means',
      'no_project_lead',
      'no_issues',
    ]);
  });

  test('every gap has plain copy', () => {
    expect(RUBRIC_GAP_LABEL).toEqual({
      no_target_date: 'Missing a target date',
      no_done_means: 'Missing "done means…"',
      no_project_lead: 'Project has no lead',
      no_issues: 'No issues yet',
    });
  });
});
