import { cn } from './lib/utils';

function Kbd({ className, ...props }: React.ComponentProps<'kbd'>) {
  return (
    <kbd
      data-slot="kbd"
      className={cn(
        'pointer-events-none inline-flex h-auto w-fit min-w-0 items-center justify-center gap-1 rounded-chip border-[0.5px] border-border-chip bg-surface-quaternary px-1 font-sans text-[11px] leading-4 font-book text-muted-foreground select-none',
        "[&_svg:not([class*='size-'])]:size-3",
        '[[data-slot=tooltip-content]_&]:bg-background/20 [[data-slot=tooltip-content]_&]:text-background dark:[[data-slot=tooltip-content]_&]:bg-background/10',
        className
      )}
      {...props}
    />
  );
}

export { Kbd };
