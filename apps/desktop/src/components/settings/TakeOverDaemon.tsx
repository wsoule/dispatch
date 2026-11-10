import { Button } from '@dispatch/ui';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DaemonTakeover } from '../../lib/daemonAuth';
import styles from './TakeOverDaemon.module.css';

/** Items the attached window cannot list, and what a takeover does for them. */
export function takeoverWaitingNotice(waiting: number): string {
  const noun = waiting === 1 ? 'item waits' : 'items wait';
  return `${waiting} ${noun} on you that this window can't show until Dispatch restarts from it.`;
}

/** Why the restart is held back: it would stop what the daemon is running.
 *  The sidecar refuses with the same words if this is stale. */
export function takeoverBusyReason(busy: readonly string[]): string {
  return `You can restart once ${busy.join(', ')} finishes; restarting now would stop it.`;
}

/** What the restart does to runs that only wait on a human, confirmed first. */
export function takeoverParkedConfirm(parked: number): string {
  const runs = parked === 1 ? '1 run is' : `${parked} runs are`;
  const pronoun = parked === 1 ? "it'll" : "they'll";
  return `${runs} waiting on you; ${pronoun} pick up again after the restart. Questions stay open; tool approvals will be asked again.`;
}

/**
 * The way out of a read-only window: stop the daemon something else started
 * and run this app's own, which hands it the owner's token. Held back while
 * the daemon is busy, which the restart would cut short; runs that only wait
 * on a human resume after it, so those ask for a confirm instead.
 */
export function TakeOverDaemon({
  takeover,
  onRestart,
}: {
  takeover: DaemonTakeover;
  onRestart: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = takeover.busy !== null && takeover.busy.length > 0;

  async function restart() {
    setConfirming(false);
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
    <div className={styles.takeover}>
      {takeover.waiting > 0 && (
        <span className={styles.strong}>
          {takeoverWaitingNotice(takeover.waiting)}
        </span>
      )}
      {busy ? (
        <span>{takeoverBusyReason(takeover.busy ?? [])}</span>
      ) : confirming ? (
        <>
          <span className={styles.strong}>
            {takeoverParkedConfirm(takeover.parked)}
          </span>
          <div className={styles.actions}>
            <Button
              size="sm"
              data-testid="daemon-takeover-confirm"
              onClick={() => void restart()}
            >
              Restart anyway
            </Button>
            <Button
              size="sm"
              variant="quiet"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </Button>
          </div>
        </>
      ) : (
        <Button
          size="sm"
          data-testid="daemon-takeover"
          icon={<RotateCw size={12} strokeWidth={1.8} />}
          disabled={restarting}
          onClick={() =>
            takeover.parked > 0 ? setConfirming(true) : void restart()
          }
        >
          {restarting ? 'Restarting…' : 'Restart Dispatch from this app'}
        </Button>
      )}
      {error !== null && (
        <span role="alert" className="toneText" data-tone="danger">
          {error}
        </span>
      )}
    </div>
  );
}
