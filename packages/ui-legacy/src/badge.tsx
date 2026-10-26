import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './lib/utils';

const badgeVariants = cva(
  'inline-flex h-6 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-pill border-[0.5px] border-border-chip px-2 text-[12px] font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    // A badge is the 24px pill: quaternary surface, chip ring, secondary text. Only
    // `default` keeps the indigo fill, for the rare filled case.
    variants: {
      variant: {
        default:
          'border-transparent bg-primary text-primary-foreground [a&]:hover:bg-[var(--accent-hover)]',
        secondary:
          'bg-surface-quaternary text-(--text-secondary) [a&]:hover:bg-surface-active',
        destructive:
          'bg-surface-quaternary text-red [a&]:hover:bg-surface-active',
        outline:
          'bg-surface-quaternary text-(--text-secondary) [a&]:hover:bg-surface-active',
        ghost:
          'border-transparent text-muted-foreground [a&]:hover:bg-surface-hover',
        link: 'border-transparent text-primary underline-offset-4 [a&]:hover:underline',
      },
    },
    defaultVariants: {
      variant: 'default',
    },
  }
);

// A `<span>` unless `render` names another element (`render={<a href … />}`)
// — Base UI's `useRender` is the composition seam radix's `Slot` used to be.
function Badge({
  className,
  variant = 'default',
  render,
  ...props
}: useRender.ComponentProps<'span'> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: 'span',
    props: mergeProps<'span'>(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: 'badge',
      variant,
    },
  });
}

export { Badge, badgeVariants };
