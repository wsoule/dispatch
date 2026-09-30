import type { ReactNode } from 'react';

import { cn } from '@/lib/utils';

// A titled block in the task page's main column (Acceptance criteria, Sessions, Memory,
// Fix loop…): Linear's sentence-case 12px/500 muted heading over its content, separated
// from its neighbours by whitespace rather than rules. `trailing` sits at the heading's
// right edge (a count, an icon button).
export function MainSection({
  title,
  trailing,
  children,
  className,
}: {
  title: ReactNode;
  trailing?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      data-slot="main-section"
      className={cn('flex flex-col gap-2', className)}
    >
      <div className="flex h-7 items-center gap-2">
        <h3 className="text-muted-foreground text-[12px] font-medium">
          {title}
        </h3>
        {trailing !== undefined && (
          <div className="ml-auto flex items-center gap-1">{trailing}</div>
        )}
      </div>
      {children}
    </section>
  );
}
