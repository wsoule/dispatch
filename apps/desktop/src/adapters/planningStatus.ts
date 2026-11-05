import type {
  AllocationBlockReason,
  MilestoneAssessment,
  MilestoneStatus,
  RiskReason,
  RubricGap,
} from '@dispatch/planning';
import {
  BLOCK_REASON_LABEL,
  missingLine,
  RUBRIC_GAP_SHORT_LABEL,
  STATUS_LABEL,
} from '@dispatch/planning';
import type { UiStatus, UiTone } from '@dispatch/ui';

// The one place @dispatch/planning's milestone statuses become @dispatch/ui
// marks and tones (packages/ui/README.md "Status vocabulary";
// docs/architecture.md §8.2 "Status colours" in Better-Tracker): the status
// diamond, the due date's colour and the progress fill's colour. Ported from
// the planner's lib/adapters/status.ts and the tone rules of its
// lib/adapters/projects.ts, so the timeline, the milestone section of the
// task drawer and (later) the projects register and dependency graph all
// read one definition. Pure functions over plain data.

/** Status → diamond: complete is the solid neutral done mark (never green),
 * on track the green edge, at risk the half-filled amber, overdue the solid
 * red, and anything missing an input (no date, no issues) the dotted mark. */
const STATUS_TO_UI: Record<MilestoneStatus, UiStatus> = {
  complete: 'done',
  on_track: 'on_track',
  at_risk: 'at_risk',
  overdue: 'overdue',
  unscheduled: 'missing',
  empty: 'missing',
};

export function uiStatus(status: MilestoneStatus): UiStatus {
  return STATUS_TO_UI[status];
}

/** The status's words ("On track", "No target date"). */
export function statusLabel(status: MilestoneStatus): string {
  return STATUS_LABEL[status];
}

/** A status mark: the diamond and the words assistive tech reads for it. */
export interface StatusMarkModel {
  status: UiStatus;
  label: string;
}

/**
 * Mark for an assessed milestone (or anything carrying its status and
 * rubric, such as a planning TimelineBar). A milestone that fails the rubric
 * but is otherwise on track reads as "missing input" (dotted), because the
 * missing input is what needs action; overdue and at-risk keep their own
 * marks (they are more urgent) and the drawer lists the gaps.
 */
export function assessmentMark(
  assessment: Pick<MilestoneAssessment, 'status' | 'rubric'>
): StatusMarkModel {
  if (assessment.status === 'on_track' && !assessment.rubric.valid) {
    return { status: 'missing', label: 'Missing input' };
  }
  return {
    status: uiStatus(assessment.status),
    label: statusLabel(assessment.status),
  };
}

/**
 * The status mark of an issue, in the same marks as milestones (the
 * planner's graph adapter): closed reads as done (the solid neutral
 * diamond), open and owned as open (the plain open diamond: an issue makes
 * no status claim of its own, its milestone does, so it never takes the
 * milestone's on-track green), and open with nobody assigned as a missing
 * input (dotted). The label is the state's own name.
 */
export function issueMark(input: {
  open: boolean;
  unassigned: boolean;
  stateName: string;
}): StatusMarkModel {
  if (!input.open) {
    return { status: uiStatus('complete'), label: input.stateName };
  }
  if (input.unassigned) {
    return { status: 'missing', label: `${input.stateName}, unassigned` };
  }
  return { status: 'open', label: input.stateName };
}

/**
 * Why a project's allocation is stopped, as one short line, worded the same
 * wherever it shows (a blocked chip's sub line, a banner row): the reason
 * alone ("Project has no lead"), or, for an invalid next milestone, the
 * rubric items it lacks ("Next milestone is missing: done means…") rather
 * than the generic "missing required details" followed by the same list.
 */
export function blockedReasonLine(
  reason: AllocationBlockReason,
  gaps: readonly RubricGap[]
): string {
  const label = BLOCK_REASON_LABEL[reason];
  if (gaps.length === 0) return label;
  if (reason === 'next_milestone_invalid') {
    const items = gaps.map((gap) => RUBRIC_GAP_SHORT_LABEL[gap]).join(', ');
    return `Next milestone is missing: ${items}`;
  }
  return `${label} · ${missingLine(gaps)}`;
}

/** A progress fill's tone (ProgressRule): see progressTone. */
export type ProgressTone = Extract<
  UiTone,
  'default' | 'danger' | 'warning' | 'success' | 'muted'
>;

/**
 * The progress fill when the progress itself is a status: muted in an
 * inactive project, success once complete, danger when overdue, warning
 * when there is more work left than time left (behind pace); otherwise
 * default (the accent fill). The one definition for every screen.
 */
export function progressTone(
  milestone: { status: MilestoneStatus; reasons: readonly RiskReason[] },
  muted = false
): ProgressTone {
  if (muted) return 'muted';
  if (milestone.status === 'complete') return 'success';
  if (milestone.status === 'overdue') return 'danger';
  return milestone.reasons.includes('behind_pace') ? 'warning' : 'default';
}

/** A due date's tone: see dueTone. */
export type DueTone = Extract<UiTone, 'default' | 'danger' | 'warning'>;

/**
 * A due date's colour: danger overdue, warning due today or tomorrow,
 * warning when undated (the date is a missing input), default later or
 * complete. The one definition for every screen; callers quiet it
 * themselves for an inactive project.
 */
export function dueTone(
  status: MilestoneStatus | null,
  daysLeft: number | null,
  undated: boolean
): DueTone {
  if (status === 'complete') return 'default';
  if (status === 'overdue') return 'danger';
  if (undated) return 'warning';
  if (daysLeft !== null && daysLeft >= 0 && daysLeft <= 1) return 'warning';
  return 'default';
}
