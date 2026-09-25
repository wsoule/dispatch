import type { ReceiptsStatus, SyncStatus } from '@dispatch/client';

import { formatRelativeTimeFromIso } from '@/lib/format';

/** The dot colour in the status strip's sync pill, by run-state hue: green means synced,
 * amber means something is waiting on a push, red means a conflict, grey means off. */
export type SyncTone = 'review' | 'waiting' | 'failed' | 'blocked' | 'ready';

export interface SyncSummary {
  tone: SyncTone;
  /** The one line the pill shows. */
  message: string;
  /** Extra lines for the pill's tooltip: pending counts, the merge-driver warning. */
  detail: string[];
  /** Whether the pill offers "Stop committing" (turns off "Commit task files to the main
   * branch") — only while the file-backed syncer runs, not on a receipts project or one
   * already off. */
  canDisableAutoCommit: boolean;
}

const SYNC_TONE: Record<SyncStatus['state'], SyncTone> = {
  idle: 'review',
  'local-only': 'waiting',
  blocked: 'failed',
  disabled: 'blocked',
  off: 'ready',
};

// The receipt log's own tones. A database-backed project has no board
// syncer, so `status.state` is permanently `disabled` there and rendering it
// would tell the user their sync is broken when it is working exactly as
// designed — the audit trail just reaches git through the exporter instead.
const RECEIPTS_TONE: Record<ReceiptsStatus['state'], SyncTone> = {
  committed: 'ready',
  clean: 'ready',
  failed: 'failed',
  idle: 'review',
  disabled: 'blocked',
};

// Whether this project's audit trail goes to the receipt log rather than to
// committed task files. `disabled` is exactly the file backend (see
// receiptsStatus in packages/server/src/api.ts), so anything else means the
// exporter is the thing worth reporting.
function usesReceipts(status: SyncStatus): boolean {
  return status.receipts.state !== 'disabled';
}

function receiptsMessageFor(receipts: ReceiptsStatus): string {
  switch (receipts.state) {
    case 'committed':
      return receipts.lastExportedAt === null
        ? 'Receipts committed'
        : `Receipts committed ${formatRelativeTimeFromIso(receipts.lastExportedAt)}`;
    case 'clean':
      return receipts.lastExportedAt === null
        ? 'Receipts up to date'
        : `Receipts up to date ${formatRelativeTimeFromIso(receipts.lastExportedAt)}`;
    case 'failed':
      return receipts.detail === null
        ? 'Receipt export failed'
        : `Receipt export failed: ${receipts.detail}`;
    case 'idle':
      return 'No receipts exported yet';
    case 'disabled':
      return receipts.detail ?? 'Receipts are off';
  }
}

// One line a user can act on per state: `idle` says when, `local-only`/`blocked` say why
// (from `detail`), `disabled` says what to do about it (a restart — see api.ts's
// DISABLED_SYNC_DETAIL for why nothing here can recover it on its own), and `off` says where
// to turn it on (Settings → Board sync — the ordinary state for a project never opted in).
function messageFor(status: SyncStatus): string {
  switch (status.state) {
    case 'idle':
      return status.lastSyncedAt === null
        ? 'Not synced yet'
        : `Synced ${formatRelativeTimeFromIso(status.lastSyncedAt)}`;
    case 'local-only':
      return status.detail === null
        ? 'Committed locally, but the push failed'
        : `Committed locally, but the push failed: ${status.detail}`;
    case 'blocked':
      return status.detail === null
        ? 'A sync conflict needs resolving'
        : `Sync conflict: ${status.detail}`;
    case 'disabled':
      return status.detail ?? 'Task files not committed';
    case 'off':
      return 'Task files not committed · Settings → Board sync';
  }
}

/**
 * The board syncer's status as the frame status strip's pill reads it: one line, a dot
 * hue, and the detail lines that used to be a disclosure in the rail footer. A project has
 * a board syncer or a receipts exporter, never both, so this reports whichever one is
 * actually running. Fed by `useDispatchProject`'s `syncStatus` (a plain `GET /api/sync`
 * query, refetched on the `board.sync` WS event).
 */
export function syncSummary(status: SyncStatus): SyncSummary {
  if (usesReceipts(status)) {
    return {
      tone: RECEIPTS_TONE[status.receipts.state],
      message: receiptsMessageFor(status.receipts),
      detail: [],
      canDisableAutoCommit: false,
    };
  }
  const detail: string[] = [];
  if (status.pendingOutgoing > 0)
    detail.push(`${status.pendingOutgoing} to push`);
  if (status.pendingIncoming > 0)
    detail.push(`${status.pendingIncoming} incoming`);
  // A broken merge driver never blocks sync itself — git still resolves a genuine
  // conflict correctly without it — so it is a standalone line, not folded into `message`.
  if (status.mergeDriverWarning !== null) {
    detail.push(`Task merge driver not set up: ${status.mergeDriverWarning}`);
  }
  return {
    tone: SYNC_TONE[status.state],
    message: messageFor(status),
    detail,
    canDisableAutoCommit: status.state !== 'disabled' && status.state !== 'off',
  };
}
