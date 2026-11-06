import type {
  PlanningConfig,
  PlanningProjectStatus,
  PlanningTuningNumber,
} from '@dispatch-foo/core/browser';
import {
  PLANNING_PROJECT_STATUSES,
  PLANNING_TUNING_NUMBERS,
} from '@dispatch-foo/core/browser';
import {
  DEFAULT_TUNING,
  type MilestoneMeta,
  type ProjectStatusType,
  type Tuning,
} from '@dispatch/planning';

// The project's `planning:` config block as @dispatch/planning reads it: the
// tuning (each field set in config.yml overriding the planning's default) and
// each milestone's weight. Core (MIT) cannot import the planning package, so
// it mirrors Tuning's field names; the two assignments below fail to compile
// the moment either side renames or adds a field without the other.

type NumericTuningKey = {
  [K in keyof Tuning]: Tuning[K] extends number ? K : never;
}[keyof Tuning];

/** Compile-time: core lists every numeric Tuning field, and nothing else. */
const EVERY_TUNING_NUMBER: Record<NumericTuningKey, PlanningTuningNumber> &
  Record<PlanningTuningNumber, NumericTuningKey> = {
  warnLeadDays: 'warnLeadDays',
  paceWindowDays: 'paceWindowDays',
  stallDays: 'stallDays',
  overdueRepeatDays: 'overdueRepeatDays',
  newBadgeDays: 'newBadgeDays',
  timelineDaysBack: 'timelineDaysBack',
  timelineDaysAhead: 'timelineDaysAhead',
};

/** Every project status, as both sides name them. */
export const PROJECT_STATUSES: readonly ProjectStatusType[] =
  PLANNING_PROJECT_STATUSES satisfies readonly ProjectStatusType[];

/** Compile-time: the planning's project statuses are core's. */
const EVERY_PROJECT_STATUS: Record<ProjectStatusType, PlanningProjectStatus> = {
  backlog: 'backlog',
  planned: 'planned',
  started: 'started',
  paused: 'paused',
  completed: 'completed',
  canceled: 'canceled',
};

/** The tuning the planning runs on: config.yml's fields over the defaults. */
export function tuningFrom(planning: PlanningConfig | undefined): Tuning {
  const set = planning?.tuning ?? {};
  const tuning: Tuning = {
    ...DEFAULT_TUNING,
    activeProjectStatuses: [...DEFAULT_TUNING.activeProjectStatuses],
  };
  for (const key of PLANNING_TUNING_NUMBERS) {
    const value = set[key];
    if (value !== undefined) tuning[EVERY_TUNING_NUMBER[key]] = value;
  }
  if (set.activeProjectStatuses !== undefined) {
    tuning.activeProjectStatuses = set.activeProjectStatuses.map(
      (status) => EVERY_PROJECT_STATUS[status]
    );
  }
  return tuning;
}

/** Each weighted milestone's planner meta (its weight; "done means" lives in
 * the milestone's description, not here). */
export function milestoneMetaFrom(
  planning: PlanningConfig | undefined
): Map<string, MilestoneMeta> {
  const meta = new Map<string, MilestoneMeta>();
  for (const [milestoneId, weight] of Object.entries(planning?.weights ?? {})) {
    meta.set(milestoneId, {
      milestoneId,
      weight,
      doneMeans: null,
      updatedAt: '',
      updatedBy: null,
    });
  }
  return meta;
}
