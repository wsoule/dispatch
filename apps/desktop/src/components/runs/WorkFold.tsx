import type { NormalizedEntry } from '@dispatch/client';
import { Button, cx, Disclosure } from '@dispatch/ui';
import { ChevronRight } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { formatElapsed } from '../../lib/draftTray';
import { ShimmerLabel } from '../transcript/ShimmerLabel';
import styles from './WorkFold.module.css';

// Below this many steps a fold costs more than it saves, so the rows show as they are.
const MIN_FOLDED_STEPS = 3;

// The span from a group's first entry to its last, from their log timestamps. Entries with
// an unparseable `ts` are skipped; one usable stamp or none reads as zero.
export function workSpanMs(entries: readonly NormalizedEntry[]): number {
  const stamps = entries
    .map((entry) => Date.parse(entry.ts))
    .filter((stamp) => Number.isFinite(stamp));
  if (stamps.length < 2) return 0;
  return Math.max(...stamps) - Math.min(...stamps);
}

/**
 * T3 Code's turn fold: a run of tool calls collapses behind one quiet "Worked for 12s ·
 * 5 steps" line, so a long session reads as its prose with the work tucked between. While
 * the group is still `live` it stays open and the header shimmers "Working…"; once settled
 * it starts closed. Short groups skip the fold entirely.
 */
export function WorkFold({
  entries,
  live,
  children,
}: {
  entries: readonly NormalizedEntry[];
  live: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(live);
  if (entries.length < MIN_FOLDED_STEPS) {
    return <div className={styles.rows}>{children}</div>;
  }
  const span = formatElapsed(workSpanMs(entries));
  const steps = `${entries.length} steps`;
  const label = live ? `Working for ${span}` : `Worked for ${span}`;
  return (
    <div className={styles.fold}>
      <Disclosure
        variant="plain"
        open={live || open}
        onOpenChange={setOpen}
        data-slot="work-fold"
        trigger={({ open: shown, props }) => (
          <Button
            {...props}
            variant="quiet"
            size="sm"
            className={cx(styles.trigger, 'num')}
            iconAfter={
              <ChevronRight
                className={cx(styles.chevron, shown ? styles.open : undefined)}
                size={14}
                strokeWidth={1.8}
                aria-hidden
              />
            }
          >
            {live ? <ShimmerLabel>{label}</ShimmerLabel> : label}
            <span className={styles.steps}> · {steps}</span>
          </Button>
        )}
      >
        <div className={cx(styles.rows, styles.opened)}>{children}</div>
      </Disclosure>
    </div>
  );
}
