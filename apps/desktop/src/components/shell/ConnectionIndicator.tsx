import type { EventStreamStatus } from '@dispatch/client';
import { Chip, type ChipTone, Tooltip } from '@dispatch/ui';

// Failures in a row before "Reconnecting…" becomes "Offline": one drop is a
// daemon restart or a blip, three mean the daemon or the network is gone.
const OFFLINE_AFTER = 3;

export interface IndicatorView {
  label: string;
  tone: ChipTone;
  detail: string;
}

/**
 * What the shell says about the daemon connection, or null to say nothing.
 * A healthy local daemon is the normal case and shows nothing; a remote one
 * always shows where it is, so it is never mistaken for this machine's.
 */
export function connectionIndicator(
  status: EventStreamStatus | null,
  remoteOrigin: string | null,
  now: number = Date.now()
): IndicatorView | null {
  if (status === null) return null;
  const where =
    remoteOrigin === null ? 'this machine' : new URL(remoteOrigin).host;
  if (status.state === 'open') {
    return remoteOrigin === null
      ? null
      : {
          label: where,
          tone: 'success',
          detail: `Connected to the dispatchd at ${remoteOrigin}.`,
        };
  }
  if (status.state === 'connecting') {
    return remoteOrigin === null
      ? null
      : {
          label: 'Connecting…',
          tone: 'info',
          detail: `Connecting to the dispatchd at ${remoteOrigin}.`,
        };
  }
  const retry =
    status.retryAt === null
      ? ''
      : ` Retrying in ${Math.max(1, Math.round((status.retryAt - now) / 1000))}s.`;
  const offline = status.failures >= OFFLINE_AFTER;
  return {
    label: offline ? 'Offline' : 'Reconnecting…',
    tone: offline ? 'danger' : 'warning',
    detail: offline
      ? `Can't reach the dispatchd on ${where} (${status.failures} tries). What you see may be out of date.${retry}`
      : `Lost the live connection to the dispatchd on ${where}.${retry}`,
  };
}

interface ConnectionIndicatorProps {
  status: EventStreamStatus | null;
  remoteOrigin: string | null;
}

/** The daemon connection's state beside the project switcher. */
export function ConnectionIndicator({
  status,
  remoteOrigin,
}: ConnectionIndicatorProps) {
  const view = connectionIndicator(status, remoteOrigin);
  if (view === null) return null;
  return (
    <Tooltip content={view.detail}>
      <span
        tabIndex={0}
        role="status"
        aria-label={view.detail}
        data-testid="connection-indicator"
      >
        <Chip tone={view.tone}>{view.label}</Chip>
      </span>
    </Tooltip>
  );
}
