import { mergeProps } from '@base-ui/react/merge-props';
import { useRender } from '@base-ui/react/use-render';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './lib/utils';

const badgeVariants = cva(
  'inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-sm border border-transparent px-1.5 text-[12px] font-medium whitespace-nowrap transition-[color,box-shadow] focus-visible:ring-2 focus-visible:ring-ring [&>svg]:pointer-events-none [&>svg]:size-3',
  {
    // T3 Code's badge: a small rounded-sm tag. Tones are a tint of their hue (8% light,
    // 16% dark) with the hue as text; `outline` is a hairline-edged neutral.
    variants: {
      variant: {
        default:
          'border-primary/40 bg-primary/10 text-primary [a&]:hover:bg-primary/16',
        secondary:
          'bg-secondary text-(--text-secondary) [a&]:hover:bg-surface-active',
        destructive: 'bg-red/8 text-red dark:bg-red/16 [a&]:hover:bg-red/16',
        outline:
          'border-input text-(--text-secondary) [a&]:hover:bg-surface-hover',
        ghost: 'text-muted-foreground [a&]:hover:bg-surface-hover',
        link: 'text-primary underline-offset-4 [a&]:hover:underline',
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
