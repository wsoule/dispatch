import * as React from 'react';

import { cn } from './lib/utils';

// `borderless` is the in-place description editor: no surface, no ring, flush left.
function Textarea({
  className,
  variant = 'default',
  ...props
}: React.ComponentProps<'textarea'> & { variant?: 'default' | 'borderless' }) {
  return (
    <textarea
      data-slot="textarea"
      data-variant={variant}
      className={cn(
        'flex field-sizing-content min-h-16 w-full rounded-control border border-input bg-background px-2.5 py-1.5 text-[13px] font-book text-foreground shadow-xs/5 transition-[color,box-shadow,border-color] outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 dark:bg-input/32 disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive',
        variant === 'borderless' &&
          'rounded-none border-0 bg-transparent px-0 py-0 shadow-none focus-visible:ring-0 dark:bg-transparent',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
