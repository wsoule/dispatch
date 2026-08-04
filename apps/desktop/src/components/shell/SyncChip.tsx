import type { SyncStatus } from '@dispatch/client';

import { formatRelativeTimeFromIso } from '@/lib/format';
import { cn } from '@/lib/utils';

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
  if (status === null) return null;

  const message = messageFor(status);

  return (
    <div className="flex flex-col gap-1 px-2 pt-2 text-[11px]">
      <div className="flex items-center gap-1.5">
        <span
          aria-hidden
          className={cn(
            'size-1.5 shrink-0 rounded-full',
            DOT_CLASS[status.state]
          )}
        />
        <span
          className="text-muted-foreground min-w-0 flex-1 truncate"
          title={message}
        >
          {message}
        </span>
      </div>
      {(status.pendingOutgoing > 0 || status.pendingIncoming > 0) && (
        <div className="text-muted-foreground/80 flex items-center gap-2 pl-3">
          {status.pendingOutgoing > 0 && (
            <span>{status.pendingOutgoing} to push</span>
          )}
          {status.pendingIncoming > 0 && (
            <span>{status.pendingIncoming} incoming</span>
          )}
        </div>
      )}
      {/* No point offering the kill switch once sync is already off — flipping
          autoCommit doesn't stop anything that isn't running. */}
      {status.state !== 'disabled' && status.state !== 'off' && (
        <button
          type="button"
          onClick={onDisableAutoCommit}
          className="text-muted-foreground/70 hover:text-foreground self-start text-[10px] underline-offset-2 hover:underline"
        >
          Turn off auto-commit
        </button>
      )}
    </div>
  );
}
