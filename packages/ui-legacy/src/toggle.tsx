'use client';

import { Toggle as TogglePrimitive } from '@base-ui/react/toggle';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './lib/utils';

// The pressed state is `data-pressed` (radix's `data-state="on"`), on top of
// the `aria-pressed` both libraries set.
const toggleVariants = cva(
  "inline-flex items-center justify-center gap-1.5 rounded-control text-[12px] font-medium whitespace-nowrap text-muted-foreground transition-colors duration-100 outline-none hover:bg-surface-control hover:text-(--text-secondary) focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive data-pressed:bg-surface-active data-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline:
          'rounded-pill border-[0.5px] border-border-chip bg-surface-control',
      },
      size: {
        default: 'h-7 min-w-7 px-2',
        sm: 'h-6 min-w-6 px-1.5',
        lg: 'h-8 min-w-8 px-2.5',
      },
    },
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

function Toggle({
  className,
  variant,
  size,
  ...props
}: TogglePrimitive.Props & VariantProps<typeof toggleVariants>) {
  return (
    <TogglePrimitive
      data-slot="toggle"
      className={cn(toggleVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Toggle, toggleVariants };
