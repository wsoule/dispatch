import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** A view's page header. Wraps rather than clipping at narrow widths. */
export function ViewHeader({
  title,
  subtitle,
  actions,
  className,
}: {
  title: string;
  subtitle?: string;
  actions?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn('flex flex-wrap items-baseline gap-x-3 gap-y-1', className)}
    >
      <h1 className="view-topbar-title">{title}</h1>
      {subtitle && (
        <span className="text-muted-foreground text-sm">{subtitle}</span>
      )}
      {actions && (
        <div className="ml-auto flex flex-wrap items-center gap-2">
          {actions}
        </div>
      )}
    </div>
  );
}
