import { Button as ButtonPrimitive } from '@base-ui/react/button';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from './lib/utils';

const buttonVariants = cva(
  "relative inline-flex shrink-0 items-center justify-center gap-1.5 rounded-control border border-transparent text-[13px] font-medium whitespace-nowrap transition-[background-color,color,box-shadow,scale] duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset disabled:pointer-events-none disabled:opacity-64 aria-invalid:ring-2 aria-invalid:ring-destructive [&:active:not([aria-haspopup])]:scale-[0.97] [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      // T3 Code's button family: indigo primary with a 1px inner highlight, outline is the
      // raised popover surface with a hairline edge, ghost has no fill until hover.
      variant: {
        default:
          'border-primary bg-primary text-primary-foreground shadow-xs shadow-primary/24 inset-shadow-control-highlight hover:bg-[var(--accent-hover)] active:inset-shadow-control-pressed',
        destructive:
          'border-input bg-popover text-red shadow-xs/5 hover:bg-red/8 focus-visible:ring-destructive dark:bg-input/32',
        outline:
          'border-input bg-popover text-foreground shadow-xs/5 hover:bg-surface-hover dark:bg-input/32 dark:hover:bg-input/48',
        secondary: 'bg-secondary text-foreground hover:bg-surface-active',
        ghost:
          'bg-transparent text-foreground/80 hover:bg-accent hover:text-foreground aria-pressed:bg-accent data-[popup-open]:bg-accent',
        link: 'text-primary underline-offset-4 hover:underline',
      },
      // Every control is 28px; `xs` is the 24px chip-height button, `lg` 32px. Icon
      // buttons are rounded squares, like the rest of the family.
      size: {
        default: 'h-7 px-2.5 has-[>svg]:px-2',
        xs: "h-6 gap-1 px-2 text-[12px] has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3.5",
        sm: 'h-7 px-2.5 has-[>svg]:px-2',
        lg: 'h-8 px-3 has-[>svg]:px-2.5',
        icon: 'size-7',
        'icon-xs': "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3.5",
        'icon-sm': 'size-7',
        'icon-lg': 'size-8',
      },
    },
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
