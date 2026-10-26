import * as React from 'react';

import { cn } from './lib/utils';

// `borderless` is the in-place title/description field: no surface, no ring, flush left.
function Input({
  className,
  type,
  variant = 'default',
  ...props
}: React.ComponentProps<'input'> & { variant?: 'default' | 'borderless' }) {
  return (
    <input
      type={type}
      data-slot="input"
      data-variant={variant}
      className={cn(
        'h-7 w-full min-w-0 rounded-control bg-field px-2.5 text-[13px] font-book text-foreground shadow-inset-field transition-[color,box-shadow] outline-none file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-[13px] file:font-medium file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
        'focus-visible:ring-2 focus-visible:ring-ring',
        'aria-invalid:ring-2 aria-invalid:ring-destructive',
        variant === 'borderless' &&
          'h-auto rounded-none bg-transparent px-0 shadow-none focus-visible:ring-0',
        className
      )}
      {...props}
    />
  );
}

export { Input };
