import { Button, cx, Panel, PanelRow, type UiTone } from '@dispatch/ui';
import { useCallback, useState } from 'react';

import { formatRelativeTimeFromIso } from '../../lib/format';
import type { NarratorLine } from '../../lib/narrator';
import { doorLabel, type OverseerDoor } from '../../lib/overseerThread';
import styles from './posts.module.css';

const SEEN_PREFIX = 'dispatch:narrator-seen:';

function readSeen(projectPath: string): string | null {
  try {
    return window.localStorage.getItem(SEEN_PREFIX + projectPath);
  } catch {
    return null;
  }
}

function writeSeen(projectPath: string, at: string): void {
  try {
    window.localStorage.setItem(SEEN_PREFIX + projectPath, at);
  } catch {
    // Blocked storage: the digest still clears for this session.
  }
}

/**
 * When this project's digest was last dismissed. A project never seen starts
 * now, so the first open says nothing rather than replaying all of history.
 */
export function useNarratorSince(projectPath: string | null): {
  since: string;
  dismiss: () => void;
} {
  const key = projectPath ?? '';
  const [state, setState] = useState(() => ({ key, since: initial(key) }));
  // A project switch re-reads that project's own mark.
  const current = state.key === key ? state : { key, since: initial(key) };
  if (current !== state) setState(current);
  const dismiss = useCallback(() => {
    const now = new Date().toISOString();
    writeSeen(key, now);
    setState({ key, since: now });
  }, [key]);
  return { since: current.since, dismiss };
}

function initial(key: string): string {
  const now = new Date().toISOString();
  // No project: nothing to remember.
  if (key === '') return now;
  const seen = readSeen(key);
  if (seen !== null) return seen;
  writeSeen(key, now);
  return now;
}

// The same tones as the top bar's counts: a failed run is red, a finished
// run waiting on review green (Q6), a landed one quiet grey. The line's own
// glyph (✕, ◇, ✓) still says which it is, so colour is never the only signal.
const TONE: Record<NarratorLine['tone'], UiTone> = {
  failed: 'danger',
  review: 'success',
  landed: 'muted',
};

/** The narrator's "While you were away", above the composer; dismissing marks it seen. */
export function AwayDigest({
  lines,
  since,
  onDismiss,
  onOpenDoor,
}: {
  lines: NarratorLine[];
  since: string;
  onDismiss: () => void;
  onOpenDoor: (door: OverseerDoor) => void;
}) {
  if (lines.length === 0) return null;
  return (
    // The section carries the region's name; Panel takes no aria-label.
    <section aria-label="While you were away" data-testid="away-digest">
      <Panel
        as="div"
        flush
        heading={`While you were away · since ${formatRelativeTimeFromIso(since)}`}
        actions={
          <Button variant="quiet" size="sm" onClick={onDismiss}>
            Got it
          </Button>
        }
      >
        {lines.map((line) => (
          <PanelRow key={line.key} className={styles.row}>
            <span
              className={cx('toneText', styles.rowText)}
              data-tone={TONE[line.tone]}
            >
              {line.text}
            </span>
            <Button
              variant="quiet"
              size="sm"
              className={styles.rowAction}
              onClick={() => onOpenDoor(line.door)}
            >
              {doorLabel(line.door)}
            </Button>
          </PanelRow>
        ))}
      </Panel>
    </section>
  );
}
