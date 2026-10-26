'use client';

import { Progress as ProgressPrimitive } from '@base-ui/react/progress';

import { cn } from './lib/utils';

// Base UI sizes the indicator itself (its width is the completed percentage
// of `value` against `max`, 100 by default) and marks the root
// `data-indeterminate` when `value` is `null`.
function Progress({
  className,
  value,
  ...props
}: ProgressPrimitive.Root.Props) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      value={value}
      className={cn(
        'relative h-2 w-full overflow-hidden rounded-full bg-primary/20',
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Track
        data-slot="progress-track"
        className="relative flex h-full w-full items-center overflow-hidden"
      >
        <ProgressPrimitive.Indicator
          data-slot="progress-indicator"
          className="bg-primary h-full transition-all"
        />
      </ProgressPrimitive.Track>
    </ProgressPrimitive.Root>
  );
}

export { Progress };
