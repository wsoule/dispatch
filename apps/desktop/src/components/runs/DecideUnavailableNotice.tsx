import { Button, cx, Notice } from '@dispatch/ui';
import { RotateCw } from 'lucide-react';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import styles from './DecideUnavailableNotice.module.css';

/** Why a decide card is inert in this window (it attached to a daemon it did
 *  not start, so it lacks the app token), with a restart when one is safe.
 *  A muted note: the lead-in is the lib's notice ("Restart daemon to enable
 *  approvals"), the body explains why, and the restart is a secondary Button
 *  whose words swap to "Restarting…" while it runs (never a spinner). When a
 *  restart is not safe, the reason it is blocked shows as quiet text. */
export function DecideUnavailableNotice({
  availability,
  onRestartDaemon,
}: {
  availability: DecideAvailability;
  onRestartDaemon?: () => Promise<void>;
}) {
  const [restarting, setRestarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (availability.enabled) return null;

  async function restart(run: () => Promise<void>) {
    setRestarting(true);
    setError(null);
    try {
      await run();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }

  // The restart is offered only when it is safe and this host can run it.
  const runRestart =
    availability.restart?.safe === true ? onRestartDaemon : undefined;
  const canRestart = runRestart !== undefined;
  const blockedReason = availability.restart?.blockedReason ?? null;

  return (
    <Notice
      tone="muted"
      role="note"
      label={availability.notice ?? undefined}
      action={
        runRestart === undefined ? undefined : (
          <Button
            variant="secondary"
            size="sm"
            icon={<RotateCw size={14} strokeWidth={1.8} aria-hidden />}
            busy={restarting}
            busyLabel="Restarting…"
            onClick={() => void restart(runRestart)}
          >
            Restart daemon
          </Button>
        )
      }
    >
      <div className={styles.body}>
        {availability.explanation === null ? null : (
          <p className={styles.line}>{availability.explanation}</p>
        )}
        {!canRestart && blockedReason !== null ? (
          <p className={styles.quiet}>{blockedReason}</p>
        ) : null}
        {error === null ? null : (
          <p
            role="alert"
            className={cx('toneText', styles.line)}
            data-tone="danger"
          >
            {error}
          </p>
        )}
      </div>
    </Notice>
  );
}
