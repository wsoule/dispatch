import type { LedgerEntry } from '@dispatch/client';

/** The project-wide (`epicId: null`) entries one task produced. A scope grant
 *  on a task with no parent lands there, where the epic ledger never looks. */
export function taskLedgerEntries(
  entries: LedgerEntry[],
  taskId: string
): LedgerEntry[] {
  return entries.filter(
    (entry) => entry.epicId === null && entry.sourceTaskId === taskId
  );
}
