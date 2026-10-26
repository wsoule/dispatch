import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

/** Row metadata — ids, elapsed times, counts. 12px sans, tabular digits. */
export function MetaText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'text-[12px] font-book text-muted-foreground tabular-nums',
        className
      )}
    >
      {children}
    </span>
  );
}

/** Explanatory prose under a control — a sentence. */
export function HintText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span className={cn('text-muted-foreground text-[11px]', className)}>
      {children}
    </span>
  );
}
