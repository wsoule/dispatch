import type { LedgerEntry } from '@dispatch-foo/core/browser';
import { Chip } from '@dispatch/ui';

import { isPolicyReceipt } from '../../lib/policyReceipts';

/** Marks a ledger entry the policy engine auto-decided, wherever ledger
 *  entries render, so a receipt never reads as a human ruling: a status pill
 *  with a green dot. Renders nothing for every other entry. */
export function PolicyReceiptBadge({ entry }: { entry: LedgerEntry }) {
  if (!isPolicyReceipt(entry)) return null;
  return <Chip tone="success">Auto-decided</Chip>;
}
