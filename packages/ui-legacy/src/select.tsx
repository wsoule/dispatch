'use client';

import { Select as SelectPrimitive } from '@base-ui/react/select';
import { CheckIcon, ChevronDownIcon, ChevronUpIcon } from 'lucide-react';
import * as React from 'react';

import { PILL_BUTTON_CLASS } from './ai/pill';
import { cn } from './lib/utils';

/**
 * The props this package's Select takes: a single string value, exactly what
 * every caller passes today. Two radix habits are absorbed here rather than
 * at each call site. First, `''` means "nothing selected" — Base UI wants
 * `null` for that, and hands `null` back when the selection clears, so the
 * value is mapped both ways. Second, `<SelectValue>` needs to know each
 * item's label to show it in the trigger; Base UI reads that from an `items`
 * map on the root, while callers only ever declare `<SelectItem>` children,
 * so the map is derived from those children (see `itemsFromChildren`).
 */
type SelectProps = Omit<
  SelectPrimitive.Root.Props<string, false>,
  'value' | 'defaultValue' | 'onValueChange' | 'multiple' | 'items'
> & {
  value?: string;
  defaultValue?: string;
  onValueChange?: (value: string) => void;
};

function Select({
  value,
  defaultValue,
  onValueChange,
  children,
  ...props
}: SelectProps) {
  const items = React.useMemo(() => itemsFromChildren(children), [children]);
  return (
    <SelectPrimitive.Root
      data-slot="select"
      items={items}
      value={value === '' ? null : value}
      defaultValue={defaultValue === '' ? null : defaultValue}
      onValueChange={(next) => onValueChange?.(next ?? '')}
      {...props}
    >
      {children}
    </SelectPrimitive.Root>
  );
}

// Walks the rendered tree for `<SelectItem value=…>label</SelectItem>`
// elements and returns the `{ value, label }` list Base UI's `Select.Value`
// resolves the trigger text from. Items rendered by a component of their own
// (rather than inline in the tree) are not found and fall back to showing
// their raw value.
function itemsFromChildren(
  children: React.ReactNode
): { value: string; label: React.ReactNode }[] {
  const found: { value: string; label: React.ReactNode }[] = [];
  const walk = (node: React.ReactNode): void => {
    React.Children.forEach(node, (child) => {
      if (!React.isValidElement(child)) return;
      const element = child as React.ReactElement<{
        value?: unknown;
        children?: React.ReactNode;
      }>;
      if (element.type === SelectItem) {
        if (typeof element.props.value === 'string') {
          found.push({
            value: element.props.value,
            label: element.props.children,
          });
        }
        return;
      }
      walk(element.props.children);
    });
  };
  walk(children);
  return found;
}

function SelectGroup({ className, ...props }: SelectPrimitive.Group.Props) {
  return (
    <SelectPrimitive.Group
      data-slot="select-group"
      className={cn('scroll-my-1', className)}
      {...props}
    />
  );
}

function SelectValue({ className, ...props }: SelectPrimitive.Value.Props) {
  return (
    <SelectPrimitive.Value
      data-slot="select-value"
      className={cn(
        'flex items-center gap-2 data-placeholder:text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

// The trigger is the `SelectPill`: a 28px pill on the control surface with a 12px
// chevron. `size="sm"` is the 24px chip-height version.
function SelectTrigger({
  className,
  size = 'default',
  children,
  ...props
}: SelectPrimitive.Trigger.Props & {
  size?: 'sm' | 'default';
}) {
  return (
    <SelectPrimitive.Trigger
      data-slot="select-trigger"
      data-size={size}
      className={cn(
        PILL_BUTTON_CLASS,
        'justify-between focus-visible:ring-2 focus-visible:ring-ring aria-invalid:ring-2 aria-invalid:ring-destructive data-placeholder:text-muted-foreground data-[size=sm]:h-6 data-[size=sm]:px-2 data-[size=sm]:text-[11px] *:data-[slot=select-value]:line-clamp-1 *:data-[slot=select-value]:flex *:data-[slot=select-value]:items-center *:data-[slot=select-value]:gap-2',
        className
      )}
      {...props}
    >
      {children}
      <SelectPrimitive.Icon
        render={<ChevronDownIcon className="text-muted-foreground size-3" />}
      />
    </SelectPrimitive.Trigger>
  );
}

// `alignItemWithTrigger` (on by default) is Base UI's version of radix's
// item-aligned menu: the open list lines its selected item up over the
// trigger, and the menu animates only when it cannot.
function SelectContent({
  className,
  children,
  side = 'bottom',
  sideOffset = 4,
  align = 'center',
  alignOffset = 0,
  alignItemWithTrigger = true,
  ...props
}: SelectPrimitive.Popup.Props &
  Pick<
    SelectPrimitive.Positioner.Props,
    'align' | 'alignOffset' | 'side' | 'sideOffset' | 'alignItemWithTrigger'
  >) {
  return (
    <SelectPrimitive.Portal>
      <SelectPrimitive.Positioner
        side={side}
        sideOffset={sideOffset}
        align={align}
        alignOffset={alignOffset}
        alignItemWithTrigger={alignItemWithTrigger}
        className="isolate z-50"
      >
        <SelectPrimitive.Popup
          data-slot="select-content"
          data-align-trigger={alignItemWithTrigger}
          className={cn(
            'relative z-50 max-h-(--available-height) min-w-[8rem] origin-(--transform-origin) overflow-x-hidden overflow-y-auto rounded-control bg-popover text-popover-foreground shadow-overlay transition-[opacity,scale] duration-100 outline-none data-[align-trigger=true]:transition-none data-ending-style:scale-95 data-ending-style:opacity-0 data-starting-style:scale-95 data-starting-style:opacity-0',
            className
          )}
          {...props}
        >
          <SelectScrollUpButton />
          <SelectPrimitive.List className="p-1">
            {children}
          </SelectPrimitive.List>
          <SelectScrollDownButton />
        </SelectPrimitive.Popup>
      </SelectPrimitive.Positioner>
    </SelectPrimitive.Portal>
  );
}

function SelectLabel({
  className,
  ...props
}: SelectPrimitive.GroupLabel.Props) {
  return (
    <SelectPrimitive.GroupLabel
      data-slot="select-label"
      className={cn(
        'px-2 py-1.5 text-[12px] font-medium text-muted-foreground',
        className
      )}
      {...props}
    />
  );
}

function SelectItem({
  className,
  children,
  ...props
}: SelectPrimitive.Item.Props) {
  return (
    <SelectPrimitive.Item
      data-slot="select-item"
      className={cn(
        "relative flex h-8 w-full cursor-default items-center gap-2 rounded-control pr-8 pl-2 text-[13px] outline-hidden select-none data-highlighted:bg-surface-hover data-highlighted:text-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className
      )}
      {...props}
    >
      <SelectPrimitive.ItemText className="flex items-center gap-2">
        {children}
      </SelectPrimitive.ItemText>
      <SelectPrimitive.ItemIndicator
        render={
          <span
            data-slot="select-item-indicator"
            className="absolute right-2 flex size-3.5 items-center justify-center"
          />
        }
      >
        <CheckIcon className="size-3.5" />
      </SelectPrimitive.ItemIndicator>
    </SelectPrimitive.Item>
  );
}

function SelectSeparator({
  className,
  ...props
}: SelectPrimitive.Separator.Props) {
  return (
    <SelectPrimitive.Separator
      data-slot="select-separator"
      className={cn(
        'pointer-events-none -mx-1 my-1 h-[0.5px] bg-border',
        className
      )}
      {...props}
    />
  );
}

function SelectScrollUpButton({
  className,
  ...props
}: SelectPrimitive.ScrollUpArrow.Props) {
  return (
    <SelectPrimitive.ScrollUpArrow
      data-slot="select-scroll-up-button"
      className={cn(
        'top-0 flex w-full cursor-default items-center justify-center bg-popover py-1',
        className
      )}
      {...props}
    >
      <ChevronUpIcon className="size-3.5" />
    </SelectPrimitive.ScrollUpArrow>
  );
}

function SelectScrollDownButton({
  className,
  ...props
}: SelectPrimitive.ScrollDownArrow.Props) {
  return (
    <SelectPrimitive.ScrollDownArrow
      data-slot="select-scroll-down-button"
      className={cn(
        'bottom-0 flex w-full cursor-default items-center justify-center bg-popover py-1',
        className
      )}
      {...props}
    >
      <ChevronDownIcon className="size-3.5" />
    </SelectPrimitive.ScrollDownArrow>
  );
}

export {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectSeparator,
  SelectTrigger,
  SelectValue,
};
