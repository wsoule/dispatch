import type { Assignee, Priority, TaskDoc } from '@dispatch/core';
import { Check, Milestone } from 'lucide-react';
import type { ReactNode } from 'react';

import { AssigneeAvatar } from './AssigneeAvatar';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

// Shared inline editors for a task's properties, so status/priority/assignee/epic edit
// identically everywhere they appear — a bare glyph you click on a dense board card or list
// row (`variant: 'icon'`), or a full labeled row in the detail modal's properties rail
// (`variant: 'row'`). Every surface that shows a property should edit it through one of these
// rather than re-deriving the picker, matching Linear's "click the thing to change the thing"
// interaction across the whole app.

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const ASSIGNEES: Assignee[] = ['agent', 'human', 'none'];
// Radix menu/select values can't be the empty string, so this sentinel stands in for the
// "no epic" choice and is mapped back to `null` at the onChange boundary.
const NO_EPIC = '__none__';

function capitalize(word: string): string {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export type ControlVariant = 'icon' | 'row';

interface Option {
  value: string;
  label: string;
  glyph: ReactNode;
}

// The trigger + menu shared by every control. On a card/row the trigger is the selected
// option's glyph alone; in the rail it's the glyph plus its label. Clicks and pointer-downs
// are stopped from propagating so opening/using the picker never also selects the card it sits
// on (the board card and list row are themselves clickable, and the menu is portaled — its
// clicks would otherwise bubble through React back to that parent).
function PropertyDropdown({
  value,
  options,
  onChange,
  variant,
  ariaLabel,
  muted = false,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  variant: ControlVariant;
  ariaLabel: string;
  /** Dims the row-variant label for an "unset" value (no priority, unassigned, no epic). */
  muted?: boolean;
}) {
  const selected = options.find((o) => o.value === value);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label={ariaLabel}
          onClick={(e) => e.stopPropagation()}
          onPointerDown={(e) => e.stopPropagation()}
          className={cn(
            'focus-visible:ring-ring/40 focus-visible:outline-none',
            variant === 'icon'
              ? 'hover:bg-muted/70 inline-flex size-5 items-center justify-center rounded focus-visible:ring-2'
              : 'hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-[13px] focus-visible:ring-1'
          )}
        >
          {variant === 'icon' ? (
            (selected?.glyph ?? null)
          ) : (
            <>
              {selected?.glyph}
              <span
                className={cn('truncate', muted && 'text-muted-foreground')}
              >
                {selected?.label}
              </span>
            </>
          )}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72"
        onClick={(e) => e.stopPropagation()}
      >
        {options.map((o) => (
          <DropdownMenuItem
            key={o.value}
            onSelect={() => onChange(o.value)}
            className="gap-2 pr-8 text-[13px]"
          >
            {o.glyph}
            <span className="truncate">{o.label}</span>
            {o.value === value && <Check className="ml-auto size-3.5" />}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusControl({
  value,
  statuses,
  onChange,
  variant = 'icon',
}: {
  value: string;
  statuses: string[];
  onChange: (status: string) => void;
  variant?: ControlVariant;
}) {
  const options = statuses.map((s) => ({
    value: s,
    label: s,
    glyph: <StatusIcon status={s} />,
  }));
  return (
    <PropertyDropdown
      value={value}
      options={options}
      onChange={onChange}
      variant={variant}
      ariaLabel="Change status"
    />
  );
}

export function PriorityControl({
  value,
  onChange,
  variant = 'icon',
}: {
  value: Priority;
  onChange: (priority: Priority) => void;
  variant?: ControlVariant;
}) {
  const options = PRIORITIES.map((p) => ({
    value: p,
    label: p,
    glyph: <PriorityIcon priority={p} />,
  }));
  return (
    <PropertyDropdown
      value={value}
      options={options}
      onChange={(v) => onChange(v as Priority)}
      variant={variant}
      ariaLabel="Change priority"
      muted={value === 'none'}
    />
  );
}

export function AssigneeControl({
  value,
  onChange,
  variant = 'icon',
}: {
  value: Assignee;
  onChange: (assignee: Assignee) => void;
  variant?: ControlVariant;
}) {
  const options = ASSIGNEES.map((a) => ({
    value: a,
    label: capitalize(a),
    glyph: <AssigneeAvatar assignee={a} />,
  }));
  return (
    <PropertyDropdown
      value={value}
      options={options}
      onChange={(v) => onChange(v as Assignee)}
      variant={variant}
      ariaLabel="Change assignee"
      muted={value === 'none'}
    />
  );
}

export function EpicControl({
  value,
  epics,
  onChange,
  variant = 'row',
}: {
  value: string | null;
  epics: TaskDoc[];
  onChange: (parent: string | null) => void;
  variant?: ControlVariant;
}) {
  const options: Option[] = [
    {
      value: NO_EPIC,
      label: 'No epic',
      glyph: <Milestone className="size-3.5" />,
    },
    ...epics.map((epic) => ({
      value: epic.meta.id,
      label: epic.meta.title,
      glyph: <Milestone className="size-3.5" />,
    })),
  ];
  return (
    <PropertyDropdown
      value={value ?? NO_EPIC}
      options={options}
      onChange={(v) => onChange(v === NO_EPIC ? null : v)}
      variant={variant}
      ariaLabel="Change epic"
      muted={value === null}
    />
  );
}
