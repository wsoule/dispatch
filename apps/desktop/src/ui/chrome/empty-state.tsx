import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

/** The centred icon + one line + one action shown when a surface has nothing. */
export function EmptyState({
  icon: Icon,
  message,
  action,
  className,
}: {
  icon?: LucideIcon;
  message: string;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'text-muted-foreground flex flex-col items-center gap-2 px-4 py-8 text-center',
        className
      )}
    >
      {Icon && <Icon className="size-5" />}
      <p className="text-sm">{message}</p>
      {action}
    </div>
  );
}
