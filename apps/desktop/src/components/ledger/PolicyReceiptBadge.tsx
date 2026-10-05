import type { LedgerEntry } from '@dispatch-foo/core/browser';

import { isPolicyReceipt } from '../../lib/policyReceipts';
import { LabelPill } from '@/ui/ai/pill';

/** Marks a ledger entry the policy engine auto-decided, wherever ledger
 *  entries render, so a receipt never reads as a human ruling: a label pill
 *  with a green dot. Renders nothing for every other entry. */
export function PolicyReceiptBadge({ entry }: { entry: LedgerEntry }) {
  if (!isPolicyReceipt(entry)) return null;
  return (
    <LabelPill color="var(--status-green)" data-receipt="policy">
      Auto-decided
    </LabelPill>
  );
}
