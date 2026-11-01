import type {
  InboxItem,
  InboxTriage,
  ReadinessReading,
} from '@dispatch/client';

// The words the board, the landing table and the inbox show for a judgment.
// Pure so the thresholds are testable without rendering; the components
// only decide where the words go.

/** A task whose spec the readiness reading found thin gets a badge; a
 *  well-specified one gets nothing, so the board stays quiet by default. */
const SPLIT_THRESHOLD = 0.7;

export function readinessBadges(
  reading: ReadinessReading | undefined
): string[] {
  if (reading === undefined) return [];
  const badges: string[] = [];
  if (reading.level === 0) badges.push('spec: title only');
  else if (reading.level === 1) badges.push('spec: no criteria');
  if (reading.splitProbability >= SPLIT_THRESHOLD) badges.push('split?');
  return badges;
}

/** "2/3 requirements", or null when the run has no checklist. */
export function checklistLabel(
  checklist: { passed: number; total: number } | undefined
): string | null {
  if (checklist === undefined || checklist.total === 0) return null;
  return `${checklist.passed}/${checklist.total} requirement${checklist.total === 1 ? '' : 's'}`;
}

/** The hint fragments under an inbox row: a re-type suggestion when the
 *  judged kind disagrees with the captured one, the suggested milestone, and the
 *  strongest possible duplicate. Empty for an item the triage agrees with. */
export function triageHints(
  item: Pick<InboxItem, 'kind'>,
  triage: InboxTriage | undefined
): string[] {
  if (triage === undefined) return [];
  const hints: string[] = [];
  if (triage.kind !== item.kind) hints.push(`looks like: ${triage.kind}`);
  if (triage.milestoneId !== null) {
    hints.push(`→ ${triage.milestoneTitle ?? triage.milestoneId}`);
  }
  const duplicate = triage.duplicates[0];
  if (duplicate !== undefined) hints.push(`≈ ${duplicate.id}`);
  return hints;
}
