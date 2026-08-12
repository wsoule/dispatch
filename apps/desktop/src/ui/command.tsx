import { Command as CommandPrimitive } from 'cmdk';
import { SearchIcon } from 'lucide-react';
import * as React from 'react';

import { cn } from '@/lib/utils';

function Command({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      data-slot="command"
      className={cn(
        'flex h-full w-full flex-col overflow-hidden rounded-card bg-popover text-popover-foreground shadow-overlay',
        className
      )}
      {...props}
    />
  );
}

function CommandInput({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Input>) {
  return (
    <div
      data-slot="command-input-wrapper"
      // Same borderless input row as `SearchPanel`'s: a hairline shadow below rather than a
      // layout-affecting border, a quiet search glyph, no divider between icon and text.
      className="shadow-hairline-bottom flex h-10 shrink-0 items-center gap-2 px-3"
    >
      <SearchIcon
        aria-hidden
        className="text-muted-foreground size-3.5 shrink-0"
      />
      <CommandPrimitive.Input
        data-slot="command-input"
        className={cn(
          'text-foreground placeholder:text-muted-foreground flex h-10 w-full bg-transparent text-[13px] outline-hidden disabled:cursor-not-allowed disabled:opacity-50',
          className
        )}
        {...props}
      />
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
        'flex max-h-[300px] scroll-py-1 flex-col gap-0.5 overflow-x-hidden overflow-y-auto p-1',
        className
      )}
      {...props}
    />
  );
}

function CommandEmpty({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      data-slot="command-empty"
      // Same quiet centered-glyph frame `SearchPanel`'s empty state uses — a search icon
      // inset in a chip above the muted line, not a bare paragraph.
      className={cn(
        'text-muted-foreground flex flex-col items-center justify-center gap-1.5 px-4 py-10 text-center text-[12.5px]',
        className
      )}
      {...props}
    />
  );
}

function CommandItem({
  className,
  ...props
}: React.ComponentProps<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      data-slot="command-item"
      className={cn(
        "rounded-control ease-out-expo relative flex h-8 cursor-default items-center gap-2 px-2 text-[13px] outline-hidden transition-colors duration-100 select-none data-[disabled=true]:pointer-events-none data-[disabled=true]:opacity-50 data-[selected=true]:bg-surface-hover [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export { Command, CommandInput, CommandList, CommandEmpty, CommandItem };
