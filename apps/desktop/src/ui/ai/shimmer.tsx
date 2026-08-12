import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Shimmering gradient-text sweep for in-progress labels — the one shared treatment behind
 * task-rows, tool-chips, thinking, and loading-state. Reduced motion drops the sweep and
 * renders plain foreground text instead. `className` layers the caller's sizing/truncation
 * (e.g. `block truncate`, `text-[13px] font-medium`) over the shared base. */
export function ShimmerLabel({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'motion-reduce:text-foreground animate-[shimmer-text_1.4s_linear_infinite] [background-size:200%_100%] bg-clip-text text-transparent motion-reduce:animate-none',
        className
      )}
      style={{
        backgroundImage:
          'linear-gradient(90deg, var(--text-muted) 35%, var(--text-primary) 50%, var(--text-muted) 65%)',
      }}
    >
      {children}
    </span>
  );
}
