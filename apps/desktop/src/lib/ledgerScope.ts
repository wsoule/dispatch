import type { LedgerEntry } from '@dispatch/client';

/** The project-wide (`milestoneId: null`) entries one task produced. A scope grant
 *  on a task with no parent lands there, where the milestone ledger never looks. */
export function taskLedgerEntries(
  entries: LedgerEntry[],
  taskId: string
): LedgerEntry[] {
  return entries.filter(
    (entry) => entry.milestoneId === null && entry.sourceTaskId === taskId
  );
}
