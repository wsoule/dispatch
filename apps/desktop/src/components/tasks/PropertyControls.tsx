import type {
  Assignee,
  Priority,
  TaskCycle,
  TaskListItem,
} from '@dispatch/core/browser';
import {
  CalendarDays,
  Check,
  IterationCw,
  Milestone,
  Plus,
  Tag,
  Triangle,
} from 'lucide-react';
import { type ReactNode, useEffect, useId, useRef, useState } from 'react';

import { colorForLabel } from '../../lib/labelColor';
import { dayFromNow, dueDateInfo } from '../../lib/taskDates';
import {
  assigneeLabel,
  priorityLabel,
  statusLabel,
} from '../../lib/taskDisplay';
import { usePeople } from '../people/PeopleContext';
import { AssigneeAvatar } from './AssigneeAvatar';
import { PickerPopover } from './detail/PickerPopover';
import { railRowClass } from './detail/RailSection';
import { PriorityIcon } from './PriorityIcon';
import { StatusIcon } from './StatusIcon';
import { cn } from '@/lib/utils';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Kbd } from '@/ui/kbd';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

// Shared inline editors for a task's properties, so status/priority/assignee/epic/labels edit
// identically everywhere they appear — a bare 14px glyph you click on a board card or list
// row (`variant: 'inline'`), or Linear's 32px ghost row in the properties rail
// (`variant: 'row'`). Every surface that shows a property should edit it through one of
// these rather than re-deriving the picker, matching Linear's "click the thing to change the
// thing" interaction across the whole app.

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];
const ASSIGNEES: Assignee[] = ['agent', 'human', 'none'];
// Menu values can't be the empty string, so this sentinel stands in for the "no epic"
// choice and is mapped back to `null` at the onChange boundary.
const NO_EPIC = '__none__';

export type ControlVariant = 'inline' | 'row';

/** Open state a list row or the task page can drive from the `s`/`p`/`a`/`e`/`l` keys.
 * Leave both out and the picker manages itself. */
export interface ControlledOpen {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

interface Option {
  value: string;
  label: string;
  glyph: ReactNode;
}

// The trigger + menu shared by every control. Inline, the trigger is the selected option's
// glyph in a 20px hit area; in the rail it is the glyph plus its label on a 32px ghost row,
// and an unset value reads as the action that fills it (`Set priority`, `Assign`). The
// trigger's accessible name stays the action (`Change status`) and its current value rides
// along as the accessible description, so a screen reader hears both. The menu opens with a header naming the picker and its single-key shortcut, then one 32px
// item per option with a 12px check on the current one. Clicks and pointer-downs are
// stopped from propagating so opening/using the picker never also selects the card or row
// it sits on (both are themselves clickable, and the menu is portaled — its clicks would
// otherwise bubble through React back to that parent).
function PropertyDropdown({
  value,
  options,
  onChange,
  variant,
  ariaLabel,
  menuTitle,
  shortcut,
  unset = false,
  unsetLabel,
  open,
  onOpenChange,
}: {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  variant: ControlVariant;
  ariaLabel: string;
  /** The menu's header, `Change status`. */
  menuTitle: string;
  /** The single key that opens this picker from a focused row, shown as a keycap. */
  shortcut?: string;
  /** The value is the "nothing chosen" option — the row dims and reads `unsetLabel`. */
  unset?: boolean;
  unsetLabel?: string;
} & ControlledOpen) {
  const selected = options.find((o) => o.value === value);
  const rowLabel =
    unset && unsetLabel !== undefined ? unsetLabel : selected?.label;
  const valueId = useId();
  // A Base UI menu costs more to mount than the whole row around it, and a scrolling list
  // mounts rows every frame. So the picker starts as a look-alike button and swaps the real
  // menu in on the first sign of intent: hover, focus, a click, or an `open` request.
  const [live, setLive] = useState(false);
  const [openOnMount, setOpenOnMount] = useState(false);
  const refocus = useRef(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!live || !refocus.current) return;
    refocus.current = false;
    triggerRef.current?.focus();
  }, [live]);
  const triggerProps = {
    'aria-label': ariaLabel,
    'aria-describedby': valueId,
    'data-slot': 'property-control',
    'data-variant': variant,
    'data-unset': unset || undefined,
    className: cn(
      'shrink-0 items-center rounded-control transition-colors duration-100 outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring data-popup-open:bg-surface-hover',
      variant === 'inline'
        ? 'inline-flex size-5 justify-center'
        : 'flex h-8 w-full min-w-0 gap-2 px-2 text-[13px] font-medium text-(--text-secondary)',
      variant === 'row' && unset && 'text-muted-foreground'
    ),
  };
  const face = (
    <>
      {selected?.glyph}
      <span id={valueId} className={variant === 'row' ? 'truncate' : 'sr-only'}>
        {rowLabel}
      </span>
    </>
  );
  if (!live && open !== true) {
    return (
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={false}
        {...triggerProps}
        onPointerEnter={() => setLive(true)}
        onFocus={() => {
          refocus.current = true;
          setLive(true);
        }}
        onPointerDown={(e) => e.stopPropagation()}
        onClick={(e) => {
          e.stopPropagation();
          // Controlled pickers open through their owner; the rest open as they mount.
          if (onOpenChange !== undefined) onOpenChange(true);
          else setOpenOnMount(true);
          setLive(true);
        }}
      >
        {face}
      </button>
    );
  }
  return (
    <DropdownMenu
      open={open}
      defaultOpen={openOnMount}
      onOpenChange={
        onOpenChange === undefined ? undefined : (next) => onOpenChange(next)
      }
    >
      <DropdownMenuTrigger
        ref={triggerRef}
        {...triggerProps}
        onClick={(e) => e.stopPropagation()}
        onPointerDown={(e) => e.stopPropagation()}
      >
        {face}
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 min-w-[184px]"
        onClick={(e) => e.stopPropagation()}
        // Base UI portals the menu, but React still bubbles its keydowns up to the row or
        // card the trigger sits in, whose roving j/k and single-key handlers must not react.
        onKeyDown={(e) => e.stopPropagation()}
      >
        <DropdownMenuGroup>
          <DropdownMenuLabel className="flex items-center gap-2">
            {menuTitle}
            {shortcut !== undefined && (
              <Kbd className="ml-auto">{shortcut}</Kbd>
            )}
          </DropdownMenuLabel>
          {options.map((o) => (
            <DropdownMenuItem
              key={o.value}
              onClick={() => onChange(o.value)}
              data-selected={o.value === value || undefined}
            >
              {o.glyph}
              <span className="truncate">{o.label}</span>
              {o.value === value && (
                <Check className="ml-auto size-3" aria-label="Selected" />
              )}
            </DropdownMenuItem>
          ))}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function StatusControl({
  value,
  statuses,
  onChange,
  variant = 'inline',
  open,
  onOpenChange,
}: {
  value: string;
  statuses: string[];
  onChange: (status: string) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
  const options = statuses.map((s) => ({
    value: s,
    label: statusLabel(s),
    glyph: <StatusIcon status={s} />,
  }));
  return (
    <PropertyDropdown
      value={value}
      options={options}
      onChange={onChange}
      variant={variant}
      ariaLabel="Change status"
      menuTitle="Change status"
      shortcut="S"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

export function PriorityControl({
  value,
  onChange,
  variant = 'inline',
  open,
  onOpenChange,
}: {
  value: Priority;
  onChange: (priority: Priority) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
  const options = PRIORITIES.map((p) => ({
    value: p,
    label: priorityLabel(p),
    glyph: <PriorityIcon priority={p} />,
  }));
  return (
    <PropertyDropdown
      value={value}
      options={options}
      onChange={(v) => onChange(v as Priority)}
      variant={variant}
      ariaLabel="Change priority"
      menuTitle="Change priority"
      shortcut="P"
      unset={value === 'none'}
      unsetLabel="Set priority"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

export function AssigneeControl({
  value,
  onChange,
  variant = 'inline',
  open,
  onOpenChange,
}: {
  value: Assignee;
  onChange: (assignee: Assignee) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
  const directory = usePeople();
  // With a people registry the choices are everyone in it (you first), the agent pool and
  // nobody; without one, the three fixed kinds. A value in neither list (a ref from before
  // the roster had them) is listed on top rather than silently rendering as unassigned.
  const choices =
    directory.assignable.length === 0
      ? ASSIGNEES
      : [
          ...directory.assignable
            .map((p) => p.ref)
            .sort((a, b) =>
              a === directory.me ? -1 : b === directory.me ? 1 : 0
            ),
          'agent',
          'none',
        ];
  const current =
    directory.personFor(value)?.ref ??
    (value === 'human' && directory.me !== null ? directory.me : value);
  const values = choices.includes(current) ? choices : [current, ...choices];
  const options = values.map((a) => ({
    value: a,
    label: directory.personFor(a)?.name ?? assigneeLabel(a),
    glyph: <AssigneeAvatar assignee={a} size={16} />,
  }));
  return (
    <PropertyDropdown
      value={current}
      options={options}
      onChange={onChange}
      variant={variant}
      ariaLabel="Change assignee"
      menuTitle="Assign to"
      shortcut="A"
      unset={value === 'none'}
      unsetLabel="Assign"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

export function EpicControl({
  value,
  epics,
  onChange,
  variant = 'row',
  open,
  onOpenChange,
}: {
  value: string | null;
  epics: TaskListItem[];
  onChange: (parent: string | null) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
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
      menuTitle="Add to epic"
      shortcut="E"
      unset={value === null}
      unsetLabel="Add to epic"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

// Linear's default estimate scale; a value outside it (synced from elsewhere) is listed too.
const ESTIMATES = [1, 2, 3, 5, 8, 13];
const NO_VALUE = '__none__';

/** `3 points` — a task's estimate on a row, or `Estimate` when unset. */
export function estimateLabel(estimate: number | null): string {
  if (estimate === null) return 'Estimate';
  return `${estimate} point${estimate === 1 ? '' : 's'}`;
}

export function EstimateControl({
  value,
  onChange,
  variant = 'row',
  open,
  onOpenChange,
}: {
  value: number | null;
  onChange: (estimate: number | null) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
  const values =
    value !== null && !ESTIMATES.includes(value)
      ? [value, ...ESTIMATES]
      : ESTIMATES;
  const glyph = <Triangle className="size-3.5" />;
  const options: Option[] = [
    { value: NO_VALUE, label: 'No estimate', glyph },
    ...values.map((n) => ({
      value: String(n),
      label: estimateLabel(n),
      glyph,
    })),
  ];
  return (
    <PropertyDropdown
      value={value === null ? NO_VALUE : String(value)}
      options={options}
      onChange={(v) => onChange(v === NO_VALUE ? null : Number(v))}
      variant={variant}
      ariaLabel="Change estimate"
      menuTitle="Estimate"
      unset={value === null}
      unsetLabel="Estimate"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

/** `Cycle 42`, or the cycle's own name when it has one. */
export function cycleLabel(cycle: TaskCycle): string {
  return cycle.name ?? `Cycle ${cycle.number}`;
}

export function CycleControl({
  value,
  cycles,
  onChange,
  variant = 'row',
  open,
  onOpenChange,
}: {
  value: TaskCycle | null;
  /** Every cycle the project's tasks name, oldest first. */
  cycles: readonly TaskCycle[];
  onChange: (cycle: TaskCycle | null) => void;
  variant?: ControlVariant;
} & ControlledOpen) {
  const list =
    value !== null && !cycles.some((c) => c.id === value.id)
      ? [value, ...cycles]
      : cycles;
  const glyph = <IterationCw className="size-3.5" />;
  const options: Option[] = [
    { value: NO_VALUE, label: 'No cycle', glyph },
    ...list.map((c) => ({ value: c.id, label: cycleLabel(c), glyph })),
  ];
  return (
    <PropertyDropdown
      value={value?.id ?? NO_VALUE}
      options={options}
      onChange={(v) =>
        onChange(v === NO_VALUE ? null : (list.find((c) => c.id === v) ?? null))
      }
      variant={variant}
      ariaLabel="Change cycle"
      menuTitle="Cycle"
      unset={value === null}
      unsetLabel="Add to cycle"
      open={open}
      onOpenChange={onOpenChange}
    />
  );
}

// The due-date shortcuts Linear offers, as days from today.
const DUE_PICKS: { label: string; days: number }[] = [
  { label: 'Today', days: 0 },
  { label: 'Tomorrow', days: 1 },
  { label: 'In a week', days: 7 },
  { label: 'In two weeks', days: 14 },
];

/** The due date: a calendar row reading `Sep 30 · in 5d` (red once overdue), opening a
 * popover of quick picks, a date field and Clear. `done` tasks are never overdue. */
export function DueDateControl({
  value,
  done = false,
  onChange,
  open,
  onOpenChange,
}: {
  value: string | null;
  done?: boolean;
  onChange: (dueDate: string | null) => void;
} & ControlledOpen) {
  const [localOpen, setLocalOpen] = useState(false);
  const isOpen = open ?? localOpen;
  function setOpen(next: boolean) {
    setLocalOpen(next);
    onOpenChange?.(next);
  }
  function pick(next: string | null) {
    onChange(next);
    setOpen(false);
  }
  const info = value === null ? null : dueDateInfo(value, new Date(), done);
  return (
    <Popover open={isOpen} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Change due date"
        data-slot="property-control"
        data-unset={value === null || undefined}
        className={cn(
          railRowClass({ unset: value === null }),
          info?.overdue === true && 'text-red'
        )}
      >
        <CalendarDays />
        {info === null ? (
          <span className="truncate">Set due date</span>
        ) : (
          <span className="flex min-w-0 items-center gap-1.5 truncate">
            {info.date}
            <span
              className={cn(
                'font-book',
                info.overdue ? 'text-red' : 'text-muted-foreground'
              )}
            >
              {info.relative}
            </span>
          </span>
        )}
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-56 flex-col gap-0.5 p-1"
        onKeyDown={(e) => e.stopPropagation()}
      >
        {DUE_PICKS.map((p) => (
          <button
            key={p.label}
            type="button"
            className={railRowClass()}
            onClick={() => pick(dayFromNow(p.days))}
          >
            {p.label}
          </button>
        ))}
        <input
          type="date"
          aria-label="Due date"
          className="bg-field rounded-control shadow-inset-field mx-1 my-1 h-8 px-2 text-[13px] text-(--text-secondary) outline-none"
          value={value ?? ''}
          onChange={(e) => {
            if (e.target.value !== '') pick(e.target.value);
          }}
        />
        {value !== null && (
          <button
            type="button"
            className={railRowClass({ unset: true })}
            onClick={() => pick(null)}
          >
            Clear due date
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

// Case-insensitive membership: `UI` and `ui` are one label, so neither a pick nor a create
// can add the second spelling.
function hasLabel(labels: readonly string[], label: string): boolean {
  const folded = label.toLowerCase();
  return labels.some((l) => l.toLowerCase() === folded);
}

/** The labels multi-select: one searchable picker over the project's vocabulary plus the
 * task's own labels, each with its colour dot and a check when applied. A pick toggles
 * membership and leaves the popover open (several labels in one visit); typing a name nobody
 * uses yet offers `Create "…"`. Every `onChange` carries the whole deduped list. Faces: the
 * rail's `Add label` ghost row, or inline a 20px `Tag` glyph — a card hands in its label
 * pills as `children` so clicking a pill opens the picker. */
export function LabelsControl({
  value,
  candidates,
  onChange,
  variant = 'row',
  children,
  open,
  onOpenChange,
}: {
  value: string[];
  /** Every label used anywhere in the project. */
  candidates: readonly string[];
  onChange: (next: string[]) => void;
  variant?: ControlVariant;
  /** Inline face override — a card passes its label pills. */
  children?: ReactNode;
} & ControlledOpen) {
  const items = [...new Set([...candidates, ...value])].sort().map((label) => ({
    value: label,
    label,
    glyph: (
      <span
        aria-hidden
        data-slot="label-dot"
        className="size-2 shrink-0 rounded-full"
        style={{ backgroundColor: colorForLabel(label) }}
      />
    ),
    selected: value.includes(label),
  }));
  const current = [...new Set(value)];
  function toggle(label: string) {
    onChange(
      current.includes(label)
        ? current.filter((l) => l !== label)
        : [...current, label]
    );
  }
  function create(text: string) {
    const label = text.trim();
    if (label === '' || hasLabel(current, label)) return;
    onChange([...current, label]);
  }
  const inline = variant === 'inline';
  return (
    <PickerPopover
      triggerLabel={inline ? 'Change labels' : 'Add label'}
      triggerClassName={
        inline
          ? cn(
              'rounded-control transition-colors duration-100 outline-none focus-visible:ring-2 focus-visible:ring-ring',
              children === undefined
                ? 'inline-flex size-5 shrink-0 items-center justify-center hover:bg-surface-hover data-popup-open:bg-surface-hover'
                : 'inline-flex min-w-0 flex-wrap items-center gap-1.5'
            )
          : railRowClass({ unset: true })
      }
      placeholder="Label…"
      items={items}
      onSelect={toggle}
      onCreate={create}
      emptyLabel="Type a new label."
      closeOnSelect={false}
      open={open}
      onOpenChange={onOpenChange}
    >
      {inline ? (
        (children ?? <Tag className="text-muted-foreground size-3.5" />)
      ) : (
        <>
          <Plus />
          <span className="truncate">Add label</span>
        </>
      )}
    </PickerPopover>
  );
}
