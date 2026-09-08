import type { LedgerEntry } from '@dispatch/core/browser';

import { isPolicyReceipt } from '../../lib/policyReceipts';
import { Badge } from '@/ui/badge';

/** Marks a ledger entry the policy engine auto-decided, wherever ledger
 *  entries render, so a receipt never reads as a human ruling. Renders
 *  nothing for every other entry. */
export function PolicyReceiptBadge({ entry }: { entry: LedgerEntry }) {
  if (!isPolicyReceipt(entry)) return null;
  return (
    <Badge
      variant="outline"
      className="text-state-review border-state-review/40 px-1.5 py-0 text-[10px] leading-4"
    >
      auto-decided
    </Badge>
  );
}
