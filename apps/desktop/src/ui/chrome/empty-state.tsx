import type { LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';
import { Empty, EmptyContent, EmptyDescription, EmptyMedia } from '@/ui/empty';

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
    // Empty's generated base classes (flex-1, rounded-lg border-dashed, text-balance,
    // p-6/md:p-12) fight this bar's current layout, so every one is overridden back.
    <Empty
      className={cn(
        'flex-initial min-w-[auto] justify-start flex-col items-center gap-2 rounded-none border-none p-0 px-4 py-8 text-center text-wrap text-muted-foreground md:p-0',
        className
      )}
    >
      {Icon && (
        <EmptyMedia className="mb-0 bg-transparent p-0">
          <Icon className="size-5" />
        </EmptyMedia>
      )}
      <EmptyDescription className="text-muted-foreground text-sm">
        {message}
      </EmptyDescription>
      {action && (
        <EmptyContent className="w-auto max-w-none min-w-[auto] gap-0 text-[length:inherit] text-wrap">
          {action}
        </EmptyContent>
      )}
    </Empty>
  );
}
