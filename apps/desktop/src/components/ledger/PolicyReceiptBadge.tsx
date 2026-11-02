import type { LedgerEntry } from '@dispatch-foo/core/browser';
import { Chip } from '@dispatch/ui';

import { isPolicyReceipt } from '../../lib/policyReceipts';

/** Marks a ledger entry the policy engine auto-decided, wherever ledger
 *  entries render, so a receipt never reads as a human ruling: a success
 *  status chip (the green dot beside the words) inside a
 *  `data-receipt="policy"` wrapper, the hook a host or test finds it by.
 *  Renders nothing for every other entry. */
export function PolicyReceiptBadge({ entry }: { entry: LedgerEntry }) {
  if (!isPolicyReceipt(entry)) return null;
  return (
    <span data-receipt="policy">
      <Chip tone="success">Auto-decided</Chip>
    </span>
  );
}
