import type { LedgerEntry } from '@dispatch/core/browser';

// The phrase core's describePolicyAuthorization writes into every
// auto-decision's ledger detail — the one marker separating a policy receipt
// from a human ruling. policyReceipts.test.ts pins it against core's output.
const AUTO_DECIDED_MARKER = 'auto-decided by';

/** True for a ledger entry recording a policy auto-decision: a decision whose
 *  detail carries the authorization line the policy engine appends. */
export function isPolicyReceipt(entry: LedgerEntry): boolean {
  return (
    entry.kind === 'decision' && entry.detail.includes(AUTO_DECIDED_MARKER)
  );
}

/** The auto-decisions in a ledger, newest first, capped at `limit`. */
export function policyReceipts(
  entries: LedgerEntry[],
  limit: number
): LedgerEntry[] {
  return entries
    .filter(isPolicyReceipt)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .slice(0, limit);
}
