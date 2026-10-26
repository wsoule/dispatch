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
        'flex field-sizing-content min-h-16 w-full rounded-control bg-field px-2.5 py-1.5 text-[13px] font-book text-foreground shadow-inset-field transition-[color,box-shadow] outline-none placeholder:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive',
        variant === 'borderless' &&
          'rounded-none bg-transparent px-0 py-0 shadow-none focus-visible:ring-0',
        className
      )}
      {...props}
    />
  );
}

export { Textarea };
