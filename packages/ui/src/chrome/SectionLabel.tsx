import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

interface SectionLabelProps {
  children: ReactNode;
  /** Shown in mono beside the label. Omit rather than passing 0 — see below. */
  count?: number;
  /** Extends a hairline from the label to the far edge, fading out as it goes. */
  rule?: boolean;
  /** Trailing content pinned to the right of the rule (a toggle, an action). */
  trailing?: ReactNode;
  className?: string;
}

/**
 * The uppercase micro-heading that titles every band in the app — "Merge queue", "Files
 * touched", "Needs triage".
 *
 * The optional rule is the part worth having in one place: it fades to transparent instead of
 * stopping at a hard edge, so a heading can span a full-width pane without drawing a line that
 * competes with the row hairlines beneath it. Repeating that gradient per view is how the
 * three existing spellings of it drifted apart.
 */
export function SectionLabel({
  children,
  count,
  rule = false,
  trailing,
  className,
}: SectionLabelProps) {
  return (
    <div className={cn('flex items-center gap-2', className)}>
      <span className="dense-label">{children}</span>
      {count !== undefined && <span className="dense-meta">{count}</span>}
      {rule && (
        <span
          aria-hidden
          className="h-px flex-1 bg-[linear-gradient(to_right,var(--border-default),transparent_70%)]"
        />
      )}
      {trailing}
    </div>
  );
}
