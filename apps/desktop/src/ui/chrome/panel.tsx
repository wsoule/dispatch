import type { ReactNode } from 'react';

import { SectionLabel } from './SectionLabel';
import { cn } from '@/lib/utils';

/**
 * The app's single container shape — bordered, rounded, rows contained rather
 * than flush. Views must not spell one out; the chrome guard enforces that.
 */
export function Panel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'bg-card border-border overflow-hidden rounded-lg border',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A panel's title row: label left, optional count, optional actions right.
 * Composes `SectionLabel` for the label+count pairing rather than
 * re-implementing it — that markup already lives in one place.
 */
export function PanelHeader({
  children,
  count,
  actions,
  className,
}: {
  children: ReactNode;
  count?: number;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'border-border flex min-h-9 flex-wrap items-center gap-2 border-b px-3 py-2',
        className
      )}
    >
      <SectionLabel count={count}>{children}</SectionLabel>
      {actions && (
        <div className="ml-auto flex items-center gap-1">{actions}</div>
      )}
    </div>
  );
}

/**
 * A row inside a panel. `urgent` draws the left edge bar that replaces the old
 * red fill — @pierre/diffs' own changed-line device, reused so urgency stays
 * pre-attentive without spending colour.
 */
export function PanelRow({
  children,
  urgent,
  onClick,
  className,
}: {
  children: ReactNode;
  urgent?: boolean;
  onClick?: () => void;
  className?: string;
}) {
  const classes = cn(
    'border-border flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left',
    'border-b last:border-b-0',
    urgent && 'border-l-2 border-l-foreground',
    onClick && 'hover:bg-muted/60 transition-colors duration-150',
    className
  );

  // A clickable row must be a real button so the global :focus-visible ring in
  // global.css applies and j/k roving focus can move DOM focus onto it.
  if (onClick) {
    return (
      <button type="button" onClick={onClick} className={classes}>
        {children}
      </button>
    );
  }
  return <div className={classes}>{children}</div>;
}
