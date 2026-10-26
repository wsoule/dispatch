import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import * as React from 'react';

import { Kbd } from './kbd';
import { splitKeycaps } from './lib/keycaps';
import { cn } from './lib/utils';

// The root carries no surface of its own: the popover or dialog that holds it already
// draws the `#202022` panel, the 12px radius and the half-pixel ring.
function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'text-popover-foreground flex h-full w-full flex-col overflow-hidden',
        className
      )}
      {...props}
    />
  );
}

// The 40px input row: a quiet search glyph, the borderless input, and an optional
// trailing `hint` slot (Linear's `Ask Linear  Tab`) kept clear of the text. The hint is
// wired to the input through `aria-describedby`, so a screen reader hears it too.
function CommandInput({
  className,
  hint,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input> & {
  hint?: React.ReactNode;
}) {
  const hintId = React.useId();
  return (
    <div
      data-slot="command-input-wrapper"
      className="shadow-hairline-bottom flex h-10 shrink-0 items-center gap-2 px-3"
    >
      <SearchIcon
        aria-hidden
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        aria-describedby={hint !== undefined ? hintId : undefined}
        className={cn(
          'text-foreground placeholder:text-muted-foreground font-book flex h-10 min-w-0 flex-1 bg-transparent text-[13px] outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
      {hint !== undefined && (
        <div
          id={hintId}
          data-slot="command-input-hint"
          className="text-muted-foreground flex shrink-0 items-center gap-1.5 text-[12px]"
        >
          {hint}
        </div>
      )}
    </div>
  );
}

function CommandList({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      data-slot="command-list"
      className={cn(
        'flex max-h-[300px] scroll-py-1 flex-col overflow-x-hidden overflow-y-auto p-1',
        className
      )}
      {...props}
    />
  );
}

// A bare muted line by default; pass an `EmptyState` as children for the full
// heading + description treatment.
function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      className={cn(
        'text-muted-foreground font-book px-4 py-8 text-center text-[13px]',
        className
      )}
      {...props}
    />
  );
}

// A section: cmdk renders the heading in `[cmdk-group-heading]`, styled here as the
// 12px/500 muted sentence-case label with 8px 12px padding.
function CommandGroup({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      data-slot="command-group"
      className={cn(
        'text-foreground [&_[cmdk-group-heading]]:text-muted-foreground overflow-hidden [&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-2 [&_[cmdk-group-heading]]:text-[12px] [&_[cmdk-group-heading]]:font-medium',
        className
      )}
      {...props}
    />
  );
}

function CommandSeparator({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator
      data-slot="command-separator"
      className={cn('bg-border -mx-1 my-1 h-[0.5px]', className)}
      {...props}
    />
  );
}

// A 40px row: 14px icon, 13px/450 label, a lighter surface when cmdk marks it selected.
function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "rounded-control ease-out-expo font-book relative flex h-10 cursor-default items-center gap-2 px-3 text-[13px] outline-hidden transition-colors duration-100 select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-active [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

// The right-aligned keycaps of a row. A string is split on whitespace so `G A` prints as
// two caps and `⌘1` as one; pass elements to control the split yourself.
function CommandShortcut({
  className,
  children,
  ...props
}: React.ComponentProps<'span'>) {
  const caps =
    typeof children === 'string'
      ? splitKeycaps(children).map((cap, index) => (
          <Kbd key={`${cap}-${index}`}>{cap}</Kbd>
        ))
      : children;
  return (
    <span
      data-slot="command-shortcut"
      className={cn('ml-auto flex shrink-0 items-center gap-1 pl-4', className)}
      {...props}
    >
      {caps}
    </span>
  );
}

export {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
};
