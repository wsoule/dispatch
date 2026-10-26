import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './lib/utils';

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-1.5 text-[12px] font-medium whitespace-nowrap transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-invalid:ring-2 aria-invalid:ring-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  {
    variants: {
      // Indigo is only the primary; secondary/outline are the control-surface pill,
      // ghost has no fill at all (a header action), destructive is red text on that pill.
      variant: {
        default:
          'rounded-[6px] bg-primary text-primary-foreground hover:bg-[var(--accent-hover)]',
        destructive:
          'rounded-pill border-[0.5px] border-border-chip bg-surface-control text-red hover:bg-surface-active focus-visible:ring-destructive',
        outline:
          'rounded-pill border-[0.5px] border-border-chip bg-surface-control text-(--text-secondary) hover:bg-surface-active',
        secondary:
          'rounded-pill border-[0.5px] border-border-chip bg-surface-control text-(--text-secondary) hover:bg-surface-active',
        ghost:
          'rounded-control bg-transparent text-muted-foreground hover:text-(--text-secondary)',
        link: 'rounded-control text-primary underline-offset-4 hover:underline',
      },
      // Every control is 28px; `xs` is the 24px chip-height button, `lg` 32px. The icon
      // sizes are round; only the ghost ones take the control fill on hover (below), so
      // a filled variant keeps its own hover colour.
      size: {
        default: 'h-7 px-3 has-[>svg]:px-2.5',
        xs: "h-6 gap-1 px-2 text-[11px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: 'h-7 px-2.5 has-[>svg]:px-2',
        lg: 'h-8 px-4 has-[>svg]:px-3',
        icon: 'size-7 rounded-pill',
        'icon-xs': "size-6 rounded-pill [&_svg:not([class*='size-'])]:size-3",
        'icon-sm': 'size-7 rounded-pill',
        'icon-lg': 'size-8 rounded-pill',
      },
    },
    compoundVariants: [
      {
        variant: 'ghost',
        size: ['icon', 'icon-xs', 'icon-sm', 'icon-lg'],
        class: 'hover:bg-surface-control',
      },
    ],
    defaultVariants: {
      variant: 'default',
      size: 'default',
    },
  }
);

// Base UI's Button: a real `<button>` by default, or whatever `render` names
// (`render={<a href … />}`) — the Base UI counterpart of radix's `asChild`,
// which composes the other way round: the Button is what a trigger renders
// *as* (`<DialogTrigger render={<Button />} />`), not what wraps it.
function Button({
  className,
  variant = 'default',
  size = 'default',
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  );
}

export { Button, buttonVariants };
