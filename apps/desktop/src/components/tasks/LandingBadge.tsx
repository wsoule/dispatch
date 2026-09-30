import type { MergeQueueEntryState } from '@dispatch/client';
import { PlaneLanding } from 'lucide-react';

import { landingBadgeTitle } from '../../lib/landingBadge';
import { LabelPill } from '@/ui/ai/pill';

/** The compact `Landing` badge for a task whose run is in the merge queue, with the queue
 * step as its tooltip. `pill` sits among a row's or card's pills; `inline` fits a Flight
 * Plan node's 16px header line. */
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
        title={title}
        className="text-state-landing inline-flex shrink-0 items-center gap-1 text-[12px] font-medium"
      >
        <PlaneLanding aria-hidden className="size-3" />
        Landing
      </span>
    );
  }
  return (
    <LabelPill
      color="var(--state-landing-fg)"
      data-slot="landing-badge"
      data-queue-state={state}
      title={title}
    >
      Landing
    </LabelPill>
  );
}
