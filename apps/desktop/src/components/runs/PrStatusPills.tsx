import type {
  PrCheckSummary,
  PrConversationItem,
  PrStatus,
} from '@dispatch/client';
import { Chip, cx } from '@dispatch/ui';
import { Check, Clock, X } from 'lucide-react';
import type { ReactNode } from 'react';

import styles from './PrStatusPills.module.css';

/** The tone of one PR fact. A status tone (success, warning, danger) is the
 * library Chip's status pill, the hue in a dot beside the words, or, when
 * the fact leads with a glyph, the neutral chip with the glyph in the
 * tone's ink; muted is plain quiet words; done is the filled neutral mark
 * a merged PR takes (closed-out work, never green and never the purple
 * accent). */
export type PillTone = 'success' | 'warning' | 'danger' | 'muted' | 'done';

// The 12px glyph a fact may lead with, sized for the chip.
const ICON = { size: 12, strokeWidth: 1.8, 'aria-hidden': true } as const;

/**
 * One PR status fact (state, review decision, mergeability, checks) as a
 * library Chip: an optional glyph before the words, the tone from `PillTone`.
 * Shared so the Landing row and the PR panel cannot drift apart.
 *
 * A glyph is the fact's status mark, so it replaces the status pill's dot
 * (the Chip's own rule for a leading mark): the chip stays neutral and the
 * glyph takes the tone's ink through `.toneText`, never a dot and a glyph
 * together. Without a glyph a status tone is the Chip's dot pill. A done
 * fact has no status tone: its chip carries `data-fill="neutral"` and the
 * module paints it as a filled neutral face (`--text-2` fill, `--surface-3`
 * words, the glyph in the words' colour).
 */
export function StatusPill({
  icon,
  children,
  tone = 'muted',
}: {
  icon?: ReactNode;
  children: ReactNode;
  tone?: PillTone;
}) {
  const glyphTone = tone === 'done' ? undefined : tone;
  const body = (
    <span className={styles.body}>
      {icon === undefined ? null : (
        <span
          className={cx(
            styles.icon,
            glyphTone === undefined ? undefined : 'toneText'
          )}
          data-tone={glyphTone}
          aria-hidden="true"
        >
          {icon}
        </span>
      )}
      <span className={styles.text}>{children}</span>
    </span>
  );
  if (tone === 'done') {
    return (
      <span className={styles.done}>
        <Chip data-fill="neutral">{body}</Chip>
      </span>
    );
  }
  if (icon !== undefined) return <Chip>{body}</Chip>;
  return <Chip tone={tone}>{body}</Chip>;
}

export const STATE_TONE: Record<
  PrStatus['state'],
  'success' | 'done' | 'danger'
> = {
  OPEN: 'success',
  MERGED: 'done',
  CLOSED: 'danger',
};

export const REVIEW_VERDICT: Record<
  NonNullable<PrConversationItem['state']>,
  { label: string; tone: PillTone }
> = {
  APPROVED: { label: 'Approved', tone: 'success' },
  CHANGES_REQUESTED: { label: 'Changes requested', tone: 'warning' },
  COMMENTED: { label: 'Commented', tone: 'muted' },
  DISMISSED: { label: 'Dismissed', tone: 'muted' },
};

// Checks rollup as one chip: danger on any failure, warning while pending,
// success when all pass. Renders nothing at zero checks, so a repo without CI
// is bare.
export function PrChecksPill({ checks }: { checks?: PrCheckSummary }) {
  // Optional, and read through `?.`: a daemon older than the widened RepoPr
  // sends no rollup, and throwing here would drop the whole page's render.
  const total = checks?.total ?? 0;
  const failed = checks?.failed ?? 0;
  const pending = checks?.pending ?? 0;
  if (total === 0) return null;
  const tone = failed > 0 ? 'danger' : pending > 0 ? 'warning' : 'success';
  const icon =
    failed > 0 ? (
      <X {...ICON} />
    ) : pending > 0 ? (
      <Clock {...ICON} />
    ) : (
      <Check {...ICON} />
    );
  return (
    <StatusPill tone={tone} icon={icon}>
      {checks?.passed ?? 0}/{total} checks
    </StatusPill>
  );
}
