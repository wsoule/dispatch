import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** Row metadata — ids, elapsed times, counts. Mono and tabular. */
export function MetaText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <span className={cn('dense-meta', className)}>{children}</span>;
}
