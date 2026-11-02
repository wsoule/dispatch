import type { MergeQueueEntryState } from '@dispatch/client';
import { Chip } from '@dispatch/ui';
import { PlaneLanding } from 'lucide-react';

import { landingBadgeTitle } from '../../lib/landingBadge';
import styles from './LandingBadge.module.css';

/** The compact `Landing` badge for a task whose run is in the merge queue, with the queue
 * step as its tooltip. `pill` is an info Chip among a row's or card's pills; `inline` fits
 * a Flight Plan node's 16px header line as the plane glyph and the word in the info ink. */
export function LandingBadge({
  state,
  variant = 'pill',
}: {
  state: MergeQueueEntryState;
  variant?: 'pill' | 'inline';
}) {
  const title = landingBadgeTitle(state);
  if (variant === 'inline') {
    return (
      <span
        data-slot="landing-badge"
        data-queue-state={state}
        data-tone="info"
        title={title}
        className={styles.inline}
      >
        <PlaneLanding size={14} strokeWidth={1.8} aria-hidden />
        Landing
      </span>
    );
  }
  return (
    <Chip
      tone="info"
      data-slot="landing-badge"
      data-queue-state={state}
      title={title}
    >
      Landing
    </Chip>
  );
}
