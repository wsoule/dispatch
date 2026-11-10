import {
  Chip,
  RegisterCell,
  type RegisterColumn,
  RegisterRow,
} from '@dispatch/ui';

import {
  formatRelativeTime,
  formatTokenCount,
  sessionDisplayName,
} from '../../lib/format';
import { modelDisplayName } from '../../lib/models';
import type { Session } from '../../lib/types';
import { ShimmerLabel } from '../transcript/ShimmerLabel';
import { sessionStatusTone } from './sessionDisplay';
import styles from './sessions.module.css';

/** The session list's grid template, shared by the `Register` that holds `SessionRow`s:
 * session, status, model, cost and last activity. The session (the row's subject, and a
 * stacked card's title) leads. Every track keeps a real minimum, so no column is squeezed to
 * nothing; with the gaps and padding they add up to 600px, the register's `stackWithin`
 * step, so the list stays a table at the default window size and stacks only below it. */
export const SESSION_COLUMNS =
  'minmax(132px, 2fr) 72px minmax(88px, 1fr) 128px 72px';

/** The session list's header row; its labels match each `SessionRow` cell's own label,
 * which stands in for the header once the rows stack into cards. */
export const SESSION_HEADER: RegisterColumn[] = [
  { id: 'session', label: 'Session' },
  { id: 'status', label: 'Status' },
  { id: 'model', label: 'Model' },
  { id: 'cost', label: 'Cost' },
  { id: 'activity', label: 'Last active', align: 'end' },
];

interface SessionRowProps {
  session: Session;
  projectName: string;
  onClick: () => void;
}

/**
 * Single-session summary row, a button row of @dispatch/ui's Register: the project name with
 * the session's own title or summary under it (shimmering while the session is active, as
 * the old row's live detail line did), the status (a dot in the session's tone beside the
 * word "Active" or "Ended", so the colour is never the only cue), the model as an agent
 * chip, cost and a compact prompt+completion token count, and the relative last-activity
 * time. The row's button is named by all of it, in that order. A Claude Code session has only
 * two states (`active`/`ended`), so the tone comes from `sessionStatusTone`. Used by the
 * Sessions hub's session list (`SessionsHubView`), optionally filtered to one project, so
 * this rendering logic lives in exactly one place; activating the row opens the full detail
 * in `SessionDetailModal`.
 */
export function SessionRow({ session, projectName, onClick }: SessionRowProps) {
  const displayName = sessionDisplayName(session.title, session.summary);
  const active = session.status === 'active';
  const status = active ? 'Active' : 'Ended';
  const model = modelDisplayName(session.model) ?? 'unknown model';
  const cost = `$${session.cost_usd.toFixed(2)} · ${formatTokenCount(
    session.prompt_tokens + session.completion_tokens
  )}`;
  const lastActive = formatRelativeTime(session.last_activity_at);
  return (
    <RegisterRow
      onActivate={onClick}
      rowLabel={`${projectName}: ${displayName}, ${status}, ${model}, ${cost}, ${lastActive}`}
    >
      <RegisterCell
        label="Session"
        variant="name"
        sub={
          <span className={styles.clip}>
            {active ? <ShimmerLabel>{displayName}</ShimmerLabel> : displayName}
          </span>
        }
      >
        <span className={styles.clip}>{projectName}</span>
      </RegisterCell>
      <RegisterCell label="Status">
        <span className={styles.status}>
          <span
            className={styles.statusDot}
            data-tone={sessionStatusTone(session.status)}
            aria-hidden="true"
          />
          {status}
        </span>
      </RegisterCell>
      <RegisterCell label="Model">
        {/* One line, ending in an ellipsis when the column is narrower than the name (a raw
            id such as claude-sonnet-4-5 is long); the chip's title holds the full id, and
            the row's own name carries the whole name. */}
        <Chip title={session.model ?? undefined}>
          <span className={styles.model}>{model}</span>
        </Chip>
      </RegisterCell>
      <RegisterCell label="Cost" variant="mono">
        {cost}
      </RegisterCell>
      <RegisterCell label="Last active" variant="mono" align="end">
        {lastActive}
      </RegisterCell>
    </RegisterRow>
  );
}
