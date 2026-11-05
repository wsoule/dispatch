import { cx } from '@dispatch/ui';
import { useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecisionCard } from '../gates/DecisionCard';
import { DecideUnavailableNotice } from './DecideUnavailableNotice';
import { Markdown } from './Markdown';
import styles from './ScopeRequestCard.module.css';

interface ScopeRequestCardProps {
  paths: string[];
  reason: string;
  onDecide: (granted: boolean) => Promise<void>;
  /** Whether this window holds the app token deciding requires — see
   *  `decideAvailability`. Grant/Deny are inert without it. */
  availability: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
}

const DENY_ID = 'deny';
const GRANT_ID = 'grant';

/** An agent's scope gate: it waits on permission to edit outside its declared fence — grant
 *  or deny, no ruling text required (a grant is advisory and logged). Built on `DecisionCard`:
 *  the agent's reason is its Markdown detail, Deny and Grant (recommended) are its radio
 *  cards, and the affected paths, the daemon-unavailable notice and a failed answer's error
 *  sit under them. `data-slot="scope-request-card"` is on the card's root. */
export function ScopeRequestCard({
  paths,
  reason,
  onDecide,
  availability,
  onRestartDaemon,
}: ScopeRequestCardProps) {
  const [pending, setPending] = useState<'grant' | 'deny' | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  // The answer that went out, so the line says "Answered" only once it has.
  const [sentId, setSentId] = useState<string | undefined>();

  async function decide(granted: boolean) {
    setPending(granted ? 'grant' : 'deny');
    setError(null);
    try {
      await onDecide(granted);
      setSentId(granted ? GRANT_ID : DENY_ID);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      // A refused answer did not go out, so no choice is shown as made.
      setSelectedId(undefined);
    } finally {
      setPending(null);
    }
  }

  function handleSelect(id: string) {
    if (pending !== null || !availability.enabled) return;
    setSelectedId(id);
    void decide(id === GRANT_ID);
  }

  const options = [
    { id: DENY_ID, label: pending === 'deny' ? 'Denying…' : 'Deny' },
    {
      id: GRANT_ID,
      label: pending === 'grant' ? 'Granting…' : 'Grant',
      recommended: true,
    },
  ];

  return (
    <DecisionCard
      data-slot="scope-request-card"
      question="The agent wants to edit outside its scope"
      detail={<Markdown content={reason} />}
      options={options}
      onSelect={handleSelect}
      selectedId={selectedId}
      disabled={pending !== null || !availability.enabled}
      // Disabled while the answer is in flight, yet only "Answered" once it went out.
      answered={selectedId !== undefined && selectedId === sentId}
    >
      {/* Wrapped, never truncated: this is what the grant applies to, so a
          path the user cannot read in full is a permission they cannot judge. */}
      <ul className={styles.paths}>
        {paths.map((path) => (
          <li key={path} title={path} className={styles.path}>
            {path}
          </li>
        ))}
      </ul>
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.error)}
          data-tone="danger"
        >
          {error}
        </p>
      )}
    </DecisionCard>
  );
}
