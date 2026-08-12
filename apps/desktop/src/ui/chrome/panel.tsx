import type { ComponentPropsWithRef, KeyboardEvent, ReactNode } from 'react';

import { SectionLabel } from './SectionLabel';
import { cn } from '@/lib/utils';

/**
 * The app's single container shape — `shadow-card` + rounded, rows contained
 * rather than flush. Views must not spell one out; the chrome guard enforces that.
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
        'bg-card shadow-card rounded-card overflow-hidden',
        className
      )}
    >
      {children}
    </div>
  );
}

/**
 * A panel's title row: label left, optional count, optional actions right. Wraps
 * `SectionLabel` and forwards its `rule`/`trailing` rather than re-spelling them.
 */
export function PanelHeader({
  children,
  count,
  rule,
  trailing,
  actions,
  className,
  ...rest
}: {
  children: ReactNode;
  count?: number;
  rule?: boolean;
  trailing?: ReactNode;
  actions?: ReactNode;
} & Omit<ComponentPropsWithRef<'div'>, 'children'>) {
  return (
    <div
      className={cn(
        'shadow-hairline-bottom flex min-h-9 flex-wrap items-center gap-2 px-3 py-2',
        className
      )}
      {...rest}
    >
      <SectionLabel
        count={count}
        rule={rule}
        trailing={trailing}
        className={rule ? 'min-w-0 flex-1' : undefined}
      >
        {children}
      </SectionLabel>
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
  onKeyDown,
  className,
  ...rest
}: {
  children: ReactNode;
  urgent?: boolean;
  onClick?: () => void;
} & Omit<ComponentPropsWithRef<'div'>, 'children' | 'onClick'>) {
  const classes = cn(
    'flex w-full flex-wrap items-center gap-2 px-3 py-2 text-left',
    'shadow-hairline-bottom last:shadow-none',
    urgent && 'border-l-2 border-l-foreground',
    onClick &&
      'cursor-pointer hover:bg-muted/60 transition-colors duration-150',
    className
  );

  // A div with `role="button"`, not a `<button>`: these rows nest their own
  // action buttons (see components/overview/FeedRow.tsx), which a button wrapper
  // would make invalid HTML. tabIndex + Enter/Space restore what that costs.
  const activate = (event: KeyboardEvent<HTMLDivElement>) => {
    onKeyDown?.(event);
    if (!onClick || event.defaultPrevented) return;
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onClick();
    }
  };

  return (
    <div
      className={classes}
      {...(onClick
        ? { role: 'button', tabIndex: 0, onClick, onKeyDown: activate }
        : { onKeyDown })}
      {...rest}
    >
      {children}
    </div>
  );
}
