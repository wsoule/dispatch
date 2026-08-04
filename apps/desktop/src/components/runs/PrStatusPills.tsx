import type {
  PrCheckSummary,
  PrConversationItem,
  PrStatus,
} from '@dispatch/client';
import { Check, Clock, X } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

export type PillTone = 'green' | 'amber' | 'red' | 'purple' | 'muted';

// One PR status fact (state, review decision, mergeability, checks) as a pill.
// Shared so the review queue row and the PR panel cannot drift apart.
export function StatusPill({
  icon,
  children,
  tone = 'muted',
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: PillTone;
}) {
  const toneClass = {
    green: 'border-state-review-edge bg-state-review-surface text-state-review',
    amber:
      'border-state-waiting-edge bg-state-waiting-surface text-state-waiting',
    red: 'border-destructive/30 bg-destructive/10 text-destructive',
    purple: 'border-primary/30 bg-primary/10 text-primary',
    muted: 'border-border bg-muted/60 text-muted-foreground',
  }[tone];
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-medium',
        toneClass
      )}
    >
      {icon}
      {children}
    </span>
  );
}

export const STATE_TONE: Record<PrStatus['state'], 'green' | 'purple' | 'red'> =
  {
    OPEN: 'green',
    MERGED: 'purple',
    CLOSED: 'red',
  };

export const REVIEW_VERDICT: Record<
  NonNullable<PrConversationItem['state']>,
  { label: string; tone: PillTone }
> = {
  APPROVED: { label: 'approved', tone: 'green' },
  CHANGES_REQUESTED: { label: 'requested changes', tone: 'amber' },
  COMMENTED: { label: 'commented', tone: 'muted' },
  DISMISSED: { label: 'dismissed', tone: 'muted' },
};

// Checks rollup as one pill: red on any failure, amber while pending, green
// when all pass. Renders nothing at zero checks, so a repo without CI is bare.
export function PrChecksPill({ checks }: { checks?: PrCheckSummary }) {
  // Optional, and read through `?.`: a daemon older than the widened RepoPr
  // sends no rollup, and throwing here would drop the whole page's render.
  const total = checks?.total ?? 0;
  const failed = checks?.failed ?? 0;
  const pending = checks?.pending ?? 0;
  if (total === 0) return null;
  const tone = failed > 0 ? 'red' : pending > 0 ? 'amber' : 'green';
  const icon =
    failed > 0 ? (
      <X className="size-3" />
    ) : pending > 0 ? (
      <Clock className="size-3" />
    ) : (
      <Check className="size-3" />
    );
  return (
    <StatusPill tone={tone} icon={icon}>
      {checks?.passed ?? 0}/{total} checks
    </StatusPill>
  );
}
