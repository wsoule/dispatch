// Milestone status, risk reasons and "next milestone" (§2.5–2.6).

import { DAY_MS, diffDays } from './dates';
import { progressOf } from './progress';
import { resolveDoneMeans, rubricFrom } from './rubric';
import { milestoneTargetDate } from './snapshot';
import type {
  EvalContext,
  IsoDateTime,
  MilestoneAssessment,
  MilestoneStatus,
  Progress,
  RiskReason,
  Snapshot,
  Tuning,
} from './types';

/**
 * Risk reasons for a milestone with open issues and a date (§2.5), in the
 * order unassigned_open, stalled, behind_pace.
 *
 * - stalled compares elapsed time: more than `stallDays × 24h` since the
 *   latest state change of any of its issues (closed ones count).
 * - behind_pace compares fractions without floating point:
 *   open/scope > clamp(daysLeft, 0, window)/window
 *   ⇔ open × window > clamp(daysLeft, 0, window) × scope.
 *   A window of 0 or less turns the check off.
 */
export function riskReasons(input: {
  progress: Progress;
  daysLeft: number;
  lastStateChangeMs: number | null;
  nowMs: number;
  tuning: Tuning;
}): RiskReason[] {
  const { progress, daysLeft, tuning } = input;
  const reasons: RiskReason[] = [];
  if (progress.openUnassigned > 0) reasons.push('unassigned_open');
  if (
    input.lastStateChangeMs !== null &&
    input.nowMs - input.lastStateChangeMs > tuning.stallDays * DAY_MS
  ) {
    reasons.push('stalled');
  }
  const window = tuning.paceWindowDays;
  if (window > 0 && progress.scope > 0) {
    const remainingDays = Math.min(Math.max(daysLeft, 0), window);
    if (progress.open * window > remainingDays * progress.scope) {
      reasons.push('behind_pace');
    }
  }
  return reasons;
}

/**
 * Status by the §2.5 precedence: empty, complete, unscheduled, overdue,
 * at_risk (due within warnLeadDays with a risk reason), on_track.
 */
export function statusOf(input: {
  progress: Progress;
  daysLeft: number | null;
  reasons: readonly RiskReason[];
  warnLeadDays: number;
}): MilestoneStatus {
  if (input.progress.total === 0) return 'empty';
  if (input.progress.open === 0) return 'complete';
  if (input.daysLeft === null) return 'unscheduled';
  if (input.daysLeft < 0) return 'overdue';
  if (input.daysLeft <= input.warnLeadDays && input.reasons.length > 0) {
    return 'at_risk';
  }
  return 'on_track';
}

/**
 * Assesses every mirrored milestone in one pass over its issues, then marks
 * each project's next milestone. O(issues + milestones).
 */
export function assessWorkspace(
  snapshot: Snapshot,
  ctx: EvalContext
): Map<string, MilestoneAssessment> {
  const nowMs = Date.parse(ctx.now);
  const assessments = new Map<string, MilestoneAssessment>();

  for (const milestone of snapshot.data.milestones) {
    const issues = snapshot.issuesByMilestone.get(milestone.id) ?? [];
    const progress = progressOf(snapshot, issues);

    // Latest state change among all its issues, compared as instants so
    // mixed ISO offsets still order correctly.
    let lastStateChangeAt: IsoDateTime | null = null;
    let lastStateChangeMs: number | null = null;
    for (const issue of issues) {
      const ms = Date.parse(issue.lastStateChangeAt);
      if (Number.isNaN(ms)) continue;
      if (lastStateChangeMs === null || ms > lastStateChangeMs) {
        lastStateChangeMs = ms;
        lastStateChangeAt = issue.lastStateChangeAt;
      }
    }

    const targetDate = milestoneTargetDate(milestone);
    const daysLeft =
      targetDate === null ? null : diffDays(targetDate, ctx.today);
    const meta = ctx.meta.get(milestone.id);
    const doneMeans = resolveDoneMeans(milestone, meta);
    const rubric = rubricFrom({
      milestone,
      project: snapshot.projects.get(milestone.projectId),
      progress,
      doneMeans,
    });

    const candidateReasons =
      daysLeft !== null && progress.open > 0
        ? riskReasons({
            progress,
            daysLeft,
            lastStateChangeMs,
            nowMs,
            tuning: ctx.tuning,
          })
        : [];
    const status = statusOf({
      progress,
      daysLeft,
      reasons: candidateReasons,
      warnLeadDays: ctx.tuning.warnLeadDays,
    });

    assessments.set(milestone.id, {
      milestoneId: milestone.id,
      projectId: milestone.projectId,
      status,
      daysLeft,
      // Reasons are reported for at_risk and overdue milestones only.
      reasons:
        status === 'at_risk' || status === 'overdue' ? candidateReasons : [],
      progress,
      rubric,
      doneMeans,
      isNext: false,
      lastStateChangeAt,
    });
  }

  for (const projectId of snapshot.milestonesByProject.keys()) {
    const nextId = nextMilestoneId(snapshot, projectId, assessments);
    const next = nextId === null ? undefined : assessments.get(nextId);
    if (next !== undefined) next.isNext = true;
  }

  return assessments;
}

/**
 * The project's next milestone (§2.6, §6.11): the first in date order (undated
 * last) that is not complete. Empty and overdue milestones stay next, so a
 * missing input blocks the project instead of being skipped. A milestone
 * without an assessment is treated as not complete for the same reason.
 * Weight overrides never affect this.
 */
export function nextMilestoneId(
  snapshot: Snapshot,
  projectId: string,
  assessments: ReadonlyMap<string, MilestoneAssessment>
): string | null {
  for (const milestone of snapshot.milestonesByProject.get(projectId) ?? []) {
    if (assessments.get(milestone.id)?.status !== 'complete') {
      return milestone.id;
    }
  }
  return null;
}
