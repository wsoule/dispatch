import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { useEffect, useRef, useState } from 'react';

import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

export interface PickerItem {
  value: string;
  label: string;
  /** Muted trailing text (a task id); also searched. */
  hint?: string;
  glyph?: ReactNode;
  /** The current value — drawn with a trailing check. */
  selected?: boolean;
}

// The first `limit` items whose label or hint contains every word of `query`.
function firstMatches(
  items: PickerItem[],
  query: string,
  limit: number
): PickerItem[] {
  const words = query
    .toLowerCase()
    .split(/\s+/)
    .filter((w) => w !== '');
  const out: PickerItem[] = [];
  for (const item of items) {
    const hay = `${item.label} ${item.hint ?? ''}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(item);
    if (out.length === limit) break;
  }
  return out;
}

// The searchable picker the rail's free-form properties open (milestone, labels, blockers):
// a 12px-radius popover holding a Command list with a search input on top. Where a property
// accepts new values, typing a name nobody has used yet offers to create it, so assigning a
// task to a milestone reuses a name with one keystroke or coins a new one. Controlled
// `open` lets the page's `l`/`m` keys open it. A multi-select (labels) passes
// `closeOnSelect={false}`: a pick then keeps the popover open and only clears the query, so
// several values toggle in one visit. Clicks and pointer-downs on the trigger and clicks in
// the portaled popup are stopped from propagating, as in `PropertyDropdown`, so opening or
// using the picker never also activates the card or row it sits on.
export function PickerPopover({
  triggerLabel,
  triggerClassName,
  children,
  placeholder,
  items: itemsProp,
  limit,
  onSelect,
  onCreate,
  emptyLabel = 'No matches.',
  closeOnSelect = true,
  open,
  onOpenChange,
}: {
  /** Accessible name of the trigger button. */
  triggerLabel: string;
  triggerClassName?: string;
  /** The trigger's face — a glyph and the current value, or the `Add …` action. */
  children: ReactNode;
  placeholder: string;
  /** A function is only called once the picker opens — a task picker over a big project
   * then builds its thousands of rows on intent, not on every render. */
  items: PickerItem[] | (() => PickerItem[]);
  /** Caps the rows drawn: the picker then filters itself and shows the first `limit`
   * matches, so a 2000-task list opens as fast as a short one. */
  limit?: number;
  onSelect: (value: string) => void;
  /** Offered as `Create "<query>"` when the typed text matches no item. */
  onCreate?: (query: string) => void;
  emptyLabel?: string;
  /** `false` keeps the popover open after a pick or a create (default `true`). */
  closeOnSelect?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const [localOpen, setLocalOpen] = useState(false);
  const [query, setQuery] = useState('');
  const isOpen = open ?? localOpen;
  // A Base UI popover costs more to mount than the card or row it sits in, so the picker
  // starts as a plain trigger and swaps the popover in on hover, focus, click or `open`.
  const [live, setLive] = useState(false);
  const refocus = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!live || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus();
  }, [live]);
  function setOpen(next: boolean) {
    if (!next) setQuery('');
    setLocalOpen(next);
    onOpenChange?.(next);
  }
  // What a pick does afterwards: dismiss, or stay and reset the search for the next pick.
  function afterPick() {
    if (closeOnSelect) setOpen(false);
    else setQuery('');
  }
  const trimmed = query.trim();
  const items =
    typeof itemsProp === 'function' ? (isOpen ? itemsProp() : []) : itemsProp;
  const shown =
    limit === undefined ? items : firstMatches(items, trimmed, limit);
  const canCreate =
    onCreate !== undefined &&
    trimmed !== '' &&
    !items.some((item) => item.label.toLowerCase() === trimmed.toLowerCase());

  if (!live && !isOpen) {
    return (
      <button
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="dialog"
        aria-expanded={false}
        data-slot="picker-trigger"
        className={triggerClassName}
        onPointerEnter={() => setLive(true)}
        onFocus={() => {
          refocus.current = true;
          setLive(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          setLive(true);
          setOpen(true);
        }}
      >
        {children}
      </button>
    );
  }

  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger
        render={
          <button
            ref={triggerRef}
            type="button"
            aria-label={triggerLabel}
            data-slot="picker-trigger"
            className={triggerClassName}
            onClick={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
          />
        }
      >
        {children}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="w-64 p-0"
        onClick={(e) => e.stopPropagation()}
      >
        <Command shouldFilter={limit === undefined}>
          <CommandInput
            placeholder={placeholder}
            value={query}
            onValueChange={setQuery}
          />
          <CommandList className="max-h-64 p-1">
            {!canCreate && <CommandEmpty>{emptyLabel}</CommandEmpty>}
            <CommandGroup>
              {shown.map((item) => (
                <CommandItem
                  key={item.value}
                  value={`${item.label} ${item.hint ?? ''}`}
                  onSelect={() => {
                    onSelect(item.value);
                    afterPick();
                  }}
                  className="h-8"
                >
                  {item.glyph}
                  <span className="min-w-0 flex-1 truncate">{item.label}</span>
                  {item.hint !== undefined && (
                    <span className="text-muted-foreground ml-2 shrink-0 text-[12px]">
                      {item.hint}
                    </span>
                  )}
                  {item.selected === true && (
                    <Check className="ml-auto size-3 shrink-0" />
                  )}
                </CommandItem>
              ))}
              {canCreate && (
                <CommandItem
                  value={`create ${trimmed}`}
                  onSelect={() => {
                    onCreate(trimmed);
                    afterPick();
                  }}
                  className="h-8"
                >
                  <span className="min-w-0 flex-1 truncate">
                    Create &ldquo;{trimmed}&rdquo;
                  </span>
                </CommandItem>
              )}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
