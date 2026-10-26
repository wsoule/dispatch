import type { Progress, TimelineBar } from '@dispatch/planning';
import { describe, expect, test } from 'bun:test';

import {
  assessmentMark,
  blockedReasonLine,
  dueTone,
  issueMark,
  progressTone,
  statusLabel,
  uiStatus,
} from './planningStatus';

// Hand-built planning bars: only the status, reasons and rubric are read
// here; the rest are plausible defaults (Wed Oct 21, 2026).

function progress(overrides: Partial<Progress> = {}): Progress {
  return {
    total: 4,
    completed: 1,
    canceled: 0,
    scope: 4,
    open: 3,
    openUnassigned: 0,
    openTriage: 0,
    ...overrides,
  };
}

function bar(overrides: Partial<TimelineBar> = {}): TimelineBar {
  return {
    milestoneId: 'ms-1',
    name: 'Dual-write',
    projectId: 'proj-1',
    start: '2026-10-01',
    end: '2026-10-28',
    status: 'on_track',
    reasons: [],
    rubric: { valid: true, gaps: [] },
    doneMeans: { text: 'Both stores agree', source: 'planner' },
    progress: progress(),
    isNext: true,
    daysLeft: 7,
    weight: null,
    ...overrides,
  };
}

describe('uiStatus and statusLabel', () => {
  test('every planning status has a diamond and its words', () => {
    expect(uiStatus('complete')).toBe('done');
    expect(uiStatus('on_track')).toBe('on_track');
    expect(uiStatus('at_risk')).toBe('at_risk');
    expect(uiStatus('overdue')).toBe('overdue');
    // A missing input (no date, no issues) is the dotted mark.
    expect(uiStatus('unscheduled')).toBe('missing');
    expect(uiStatus('empty')).toBe('missing');
    expect(statusLabel('complete')).toBe('Complete');
    expect(statusLabel('unscheduled')).toBe('No target date');
    expect(statusLabel('empty')).toBe('No issues yet');
  });
});

describe('assessmentMark', () => {
  test('on track but failing the rubric reads as a missing input', () => {
    expect(assessmentMark(bar())).toEqual({
      status: 'on_track',
      label: 'On track',
    });
    expect(
      assessmentMark(bar({ rubric: { valid: false, gaps: ['no_done_means'] } }))
    ).toEqual({ status: 'missing', label: 'Missing input' });
    // Overdue and at risk are more urgent than the gap: they keep their marks.
    expect(
      assessmentMark(
        bar({
          status: 'at_risk',
          rubric: { valid: false, gaps: ['no_done_means'] },
        })
      )
    ).toEqual({ status: 'at_risk', label: 'At risk' });
    expect(assessmentMark(bar({ status: 'overdue' }))).toEqual({
      status: 'overdue',
      label: 'Overdue',
    });
    expect(assessmentMark(bar({ status: 'complete' })).status).toBe('done');
    expect(assessmentMark(bar({ status: 'empty' })).status).toBe('missing');
  });
});

describe('issueMark', () => {
  test('closed is done, open is open, open and unassigned is a missing input', () => {
    expect(
      issueMark({ open: false, unassigned: false, stateName: 'Done' })
    ).toEqual({ status: 'done', label: 'Done' });
    expect(
      issueMark({ open: true, unassigned: false, stateName: 'In Progress' })
    ).toEqual({ status: 'open', label: 'In Progress' });
    expect(
      issueMark({ open: true, unassigned: true, stateName: 'Todo' })
    ).toEqual({ status: 'missing', label: 'Todo, unassigned' });
    // A closed issue nobody owned is still done.
    expect(
      issueMark({ open: false, unassigned: true, stateName: 'Canceled' })
    ).toEqual({ status: 'done', label: 'Canceled' });
  });
});

describe('progressTone', () => {
  test('danger when overdue, warning when behind pace, success complete', () => {
    expect(progressTone(bar())).toBe('default');
    // Complete reads as done; an inactive project's is muted whatever its
    // status (the one definition for every screen).
    expect(progressTone(bar({ status: 'complete' }))).toBe('success');
    expect(progressTone(bar({ status: 'overdue' }), true)).toBe('muted');
    expect(progressTone(bar({ status: 'overdue' }))).toBe('danger');
    expect(
      progressTone(
        bar({ status: 'overdue', reasons: ['behind_pace', 'stalled'] })
      )
    ).toBe('danger');
    expect(
      progressTone(bar({ status: 'at_risk', reasons: ['behind_pace'] }))
    ).toBe('warning');
    expect(progressTone(bar({ status: 'at_risk', reasons: ['stalled'] }))).toBe(
      'default'
    );
  });
});

describe('dueTone', () => {
  test('a due date is danger overdue, a warning today, tomorrow or undated', () => {
    expect(dueTone('overdue', -3, false)).toBe('danger');
    expect(dueTone('on_track', 0, false)).toBe('warning');
    expect(dueTone('at_risk', 1, false)).toBe('warning');
    expect(dueTone('on_track', 2, false)).toBe('default');
    expect(dueTone('unscheduled', null, true)).toBe('warning');
    // A complete milestone is never late or due.
    expect(dueTone('complete', 0, false)).toBe('default');
    expect(dueTone(null, null, false)).toBe('default');
  });
});

describe('blockedReasonLine', () => {
  test('the reason alone, or what the next milestone lacks', () => {
    expect(blockedReasonLine('no_lead', [])).toBe('Project has no lead');
    expect(blockedReasonLine('lead_inactive', [])).toBe(
      'Project lead is deactivated'
    );
    expect(blockedReasonLine('next_milestone_invalid', [])).toBe(
      'Next milestone is missing required details'
    );
    expect(
      blockedReasonLine('next_milestone_invalid', [
        'no_target_date',
        'no_done_means',
      ])
    ).toBe('Next milestone is missing: target date, done means…');
    // Another reason with rubric gaps keeps its label and lists them.
    expect(blockedReasonLine('no_lead', ['no_project_lead'])).toBe(
      'Project has no lead · missing: project lead'
    );
  });
});
