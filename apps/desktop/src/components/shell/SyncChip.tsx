import type { ReceiptsStatus, SyncStatus } from '@dispatch/client';
import { useState } from 'react';

import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';

interface SyncChipProps {
  /** `null` until the first `GET /api/sync` resolves — nothing renders yet. */
  status: SyncStatus | null;
  /** Flips `.dispatch/config.yml`'s `autoCommit` off — the kill switch. */
  onDisableAutoCommit: () => void;
}

// Tailwind can't build class names at runtime, so this is spelled out rather
// than templated — same reason StateDot.tsx keeps its own map.
const DOT_CLASS: Record<SyncStatus['state'], string> = {
  idle: 'bg-state-review',
  'local-only': 'bg-state-waiting',
  blocked: 'bg-state-failed',
  disabled: 'bg-state-blocked',
  off: 'bg-state-ready',
};

// The receipt log's own dot colours. A database-backed project has no board
// syncer, so `status.state` is permanently `disabled` there and rendering it
// would tell the user their sync is broken when it is working exactly as
// designed — the audit trail just reaches git through the exporter instead.
const RECEIPTS_DOT_CLASS: Record<ReceiptsStatus['state'], string> = {
  committed: 'bg-state-ready',
  clean: 'bg-state-ready',
  failed: 'bg-state-failed',
  idle: 'bg-state-review',
  disabled: 'bg-state-blocked',
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

// One line a user can act on per state, per the plan's copy requirement:
// `idle` says when, `local-only`/`blocked` say why (from `detail`),
// `disabled` says what to do about it (a restart — see api.ts's
// DISABLED_SYNC_DETAIL for why nothing here can recover it on its own), and
// `off` says how to turn it on (Settings — this is the ordinary, expected
// state for a project that has never opted in, not a problem to fix).
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
      return status.detail ?? 'Board sync is off';
    case 'off':
      return 'Board sync is off · enable auto-commit in Settings';
  }
}

/**
 * The board syncer's status: a one-line chip in the sidebar footer showing
 * last-synced (or why it isn't), what's still pending in each direction, and
 * the kill switch for the `autoCommit` setting that drives it.
 *
 * Fed by `useDispatchProject`'s `syncStatus` (a plain `GET /api/sync` query,
 * refetched on the `board.sync` WS event) — this component itself does no
 * fetching, matching every other shell widget's props-in shape.
 */
export function SyncChip({ status, onDisableAutoCommit }: SyncChipProps) {
  // Owned here (not `<details>`'s native toggle state) so the disclosure can be a controlled
  // Collapsible — must run before the `status === null` early return, same as any other hook.
  const [warningOpen, setWarningOpen] = useState(false);

  if (status === null) return null;

  // A project has a board syncer or a receipts exporter, never both, so the
  // chip reports whichever one is actually running rather than always reading
  // the board-sync fields.
  const receipts = usesReceipts(status);
  const message = receipts
    ? receiptsMessageFor(status.receipts)
    : messageFor(status);

  return (
    <div className="flex flex-col gap-1 px-2 pt-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            receipts
              ? RECEIPTS_DOT_CLASS[status.receipts.state]
              : DOT_CLASS[status.state]
          )}
        />
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate"
          title={message}
        >
          {message}
        </span>
      </div>
      {!receipts &&
        (status.pendingOutgoing > 0 || status.pendingIncoming > 0) && (
          <div className="text-muted-foreground/80 flex items-center gap-2 pl-3">
            {status.pendingOutgoing > 0 && (
              <span>{status.pendingOutgoing} to push</span>
            )}
            {status.pendingIncoming > 0 && (
              <span>{status.pendingIncoming} incoming</span>
            )}
          </div>
        )}
      {/* A broken merge driver never blocks sync itself — git still resolves a
          genuine conflict correctly without it — so this is a standalone
          warning line, not folded into `message` above.

          A disclosure rather than one truncated line: the warning is three
          sentences and the sidebar is ~200px, so truncating showed about four
          words and hid the remedy. The summary fits the width; the body wraps
          instead of truncating. */}
      {status.mergeDriverWarning !== null && (
        <Collapsible
          open={warningOpen}
          onOpenChange={setWarningOpen}
          className="pl-3"
        >
          <CollapsibleTrigger className="text-state-waiting cursor-pointer text-left">
            <span className="underline decoration-dotted underline-offset-2">
              Task merge driver not set up
            </span>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <p className="text-muted-foreground mt-1 leading-snug text-pretty">
              {status.mergeDriverWarning}
            </p>
          </CollapsibleContent>
        </Collapsible>
      )}
      {/* No point offering the kill switch once sync is already off — flipping
          autoCommit doesn't stop anything that isn't running. */}
      {/* autoCommit drives the board syncer only — there is nothing for it to
          turn off on a project whose trail goes to the receipt log. */}
      {!receipts && status.state !== 'disabled' && status.state !== 'off' && (
        <Button
          type="button"
          variant="link"
          size="xs"
          onClick={onDisableAutoCommit}
          className="text-muted-foreground/70 hover:text-foreground h-auto self-start p-0 text-[10px] font-normal underline-offset-2"
        >
          Turn off auto-commit
        </Button>
      )}
    </div>
  );
}
