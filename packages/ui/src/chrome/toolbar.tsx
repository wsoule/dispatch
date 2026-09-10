import type { ReactNode } from 'react';

import { cn } from '../lib/utils';

/**
 * The filter/segmented/actions row under a view header. `flex-wrap` is
 * load-bearing: without it these rows clip trailing controls at ordinary widths.
 */
export function Toolbar({
  children,
  actions,
  className,
}: {
  children: ReactNode;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      {children}
      {actions && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
