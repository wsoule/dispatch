import type { TaskDoc } from '@dispatch/core/browser';
import { isDoneStatus } from '@dispatch/core/browser';

/**
 * The client-side v0 of the planning queue's weighted scoring (epic e-ba8bf1): a task's
 * weight from named factors, each reported alongside the total so the UI can explain every
 * ranking rather than presenting a black box. Only the factors computable without the
 * daemon's hierarchy entities exist yet — urgency, dependency-unblocking value, and age;
 * initiative/project rank and milestone due-date proximity join when the scoring service
 * lands server-side and this module becomes a thin client of it.
 */
export interface TaskWeight {
  score: number;
  factors: {
    /** Priority mapped onto a numeric scale — urgent tasks dominate. */
    urgency: number;
    /** Dependency-unblocking value: how much open work this task is holding up. */
    unblocks: number;
    /** Age pressure — old tasks drift up so the backlog can't silently rot. */
    age: number;
  };
  /** How many open (non-terminal) tasks list this one as a blocker — the count behind
   * `factors.unblocks`, kept separately so the breakdown can say "unblocks 3 tasks". */
  unblocksCount: number;
}

const URGENCY_SCORE: Record<string, number> = {
  urgent: 8,
  high: 5,
  medium: 3,
  low: 1,
  none: 0,
};

// Each open dependent adds a fixed bump — holding up two tasks matters twice as much as
// holding up one, with no cap (a true bottleneck should rank like one).
const UNBLOCK_POINTS_PER_TASK = 2;

// Age climbs linearly and saturates at 30 days / 3 points: enough to float a stale task
// over a fresh same-priority one, never enough to outrank a real urgency difference.
const AGE_SATURATION_DAYS = 30;
const AGE_MAX_POINTS = 3;

const MS_PER_DAY = 86_400_000;

/**
 * Scores every task in one pass. Terminal tasks (landed/dropped) score 0 — they're out of
 * the queue — and don't count as "blocked" for anyone's unblocking value.
 */
export function computeTaskWeights(
  tasks: TaskDoc[],
  now: Date
): Map<string, TaskWeight> {
  // Open dependents per blocker id: only a non-terminal dependent is really waiting.
  const openDependents = new Map<string, number>();
  for (const doc of tasks) {
    if (isDoneStatus(doc.meta.status)) continue;
    for (const blockerId of doc.meta.blockedBy) {
      openDependents.set(blockerId, (openDependents.get(blockerId) ?? 0) + 1);
    }
  }

  const weights = new Map<string, TaskWeight>();
  for (const doc of tasks) {
    if (isDoneStatus(doc.meta.status)) {
      weights.set(doc.meta.id, {
        score: 0,
        factors: { urgency: 0, unblocks: 0, age: 0 },
        unblocksCount: 0,
      });
      continue;
    }
    const urgency = URGENCY_SCORE[doc.meta.priority] ?? 0;
    const unblocksCount = openDependents.get(doc.meta.id) ?? 0;
    const unblocks = unblocksCount * UNBLOCK_POINTS_PER_TASK;
    const createdMs = new Date(doc.meta.created).getTime();
    const days = Number.isNaN(createdMs)
      ? 0
      : Math.max(0, (now.getTime() - createdMs) / MS_PER_DAY);
    const age =
      (Math.min(days, AGE_SATURATION_DAYS) / AGE_SATURATION_DAYS) *
      AGE_MAX_POINTS;
    weights.set(doc.meta.id, {
      score: urgency + unblocks + age,
      factors: { urgency, unblocks, age },
      unblocksCount,
    });
  }
  return weights;
}

/** One-line explainable breakdown for a weight — the tooltip/aria text next to a score. */
export function describeWeight(weight: TaskWeight): string {
  const parts = [
    `Urgency ${String(weight.factors.urgency)}`,
    weight.unblocksCount > 0
      ? `Unblocks ${String(weight.unblocksCount)} ${
          weight.unblocksCount === 1 ? 'task' : 'tasks'
        } +${String(weight.factors.unblocks)}`
      : 'Unblocks nothing',
    `Age +${weight.factors.age.toFixed(1)}`,
  ];
  return parts.join(' · ');
}
