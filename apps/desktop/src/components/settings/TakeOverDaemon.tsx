import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DaemonTakeover } from '../../lib/daemonAuth';
import { Button } from '@/ui/button';

/** Items the attached window cannot list, and what a takeover does for them. */
export function takeoverWaitingNotice(waiting: number): string {
  const noun = waiting === 1 ? 'item is' : 'items are';
  return `${waiting} ${noun} waiting on you (approvals, questions or agent sign-ins), and this window can't see them. Restarting Dispatch from this app shows them here.`;
}

/** Why the restart is held back: it would stop what the daemon is running.
 *  The sidecar refuses with the same words if this is stale. */
export function takeoverBusyReason(liveWork: readonly string[]): string {
  return `Dispatch for this project is busy with ${liveWork.join(', ')}. Restarting it from this app would stop that, so try again once it finishes.`;
}

/**
 * The way out of a read-only window: stop the daemon something else started
 * and run this app's own, which hands it the owner's token. Held back while
 * the daemon has work in flight, which the restart would end.
 */
export function TakeOverDaemon({
  takeover,
  onRestart,
}: {
  takeover: DaemonTakeover;
  onRestart: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = takeover.liveWork !== null && takeover.liveWork.length > 0;

  async function restart() {
    setRestarting(true);
    setError(null);
    try {
      await onRestart();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }

  return (
    <div className="flex flex-col items-start gap-1.5">
      {takeover.waiting > 0 && (
        <span className="text-foreground">
          {takeoverWaitingNotice(takeover.waiting)}
        </span>
      )}
      {busy ? (
        <span>{takeoverBusyReason(takeover.liveWork ?? [])}</span>
      ) : (
        <Button
          size="sm"
          variant="outline"
          data-testid="daemon-takeover"
          disabled={restarting}
          onClick={() => void restart()}
        >
          <RotateCw aria-hidden className="size-3" />
          {restarting ? 'Restarting…' : 'Restart Dispatch from this app'}
        </Button>
      )}
      {error !== null && (
        <span role="alert" className="text-state-failed">
          {error}
        </span>
      )}
    </div>
  );
}
