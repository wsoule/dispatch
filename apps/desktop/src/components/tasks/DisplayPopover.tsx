import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  GitBranch,
  LayoutGrid,
  List,
  Target,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { showArchiveToggle } from '../../lib/archiveToggle';
import {
  TASK_PROPERTIES,
  type TaskProperty,
  type TasksDisplayPrefs,
  type TasksGrouping,
  type TasksOrdering,
  type TasksSubGrouping,
  toggleDisplayProperty,
} from '../../lib/tasksPrefs';
import { TASKS_VIEW_TABS, type TasksViewMode } from '../../lib/tasksViewMode';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { DisplayIconButton } from '@/ui/ai/page-header';
import { PillButton, SelectPill } from '@/ui/ai/pill';
import { SegmentedControl } from '@/ui/ai/segmented';
import { Switch } from '@/ui/ai/switch';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

const GROUPINGS: { id: TasksGrouping; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'epic', label: 'Epic' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
  { id: 'none', label: 'No grouping' },
];

const SUB_GROUPINGS: { id: TasksSubGrouping; label: string }[] = [
  { id: 'none', label: 'No grouping' },
  { id: 'epic', label: 'Epic' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
];

const ORDERINGS: { id: TasksOrdering; label: string }[] = [
  { id: 'priority', label: 'Priority' },
  { id: 'updated', label: 'Last updated' },
  { id: 'created', label: 'Created' },
  { id: 'title', label: 'Title' },
  { id: 'manual', label: 'Manual' },
];

const PROPERTY_LABEL: Record<TaskProperty, string> = {
  id: 'ID',
  status: 'Status',
  assignee: 'Assignee',
  priority: 'Priority',
  epic: 'Epic',
  milestone: 'Milestone',
  labels: 'Labels',
  links: 'Links',
  created: 'Created',
  updated: 'Updated',
  run: 'Run',
};

const LAYOUT_ICON: Record<TasksViewMode, ReactNode> = {
  list: <List aria-hidden />,
  board: <LayoutGrid aria-hidden />,
  milestones: <Target aria-hidden />,
  branches: <GitBranch aria-hidden />,
};

// One `Label … [control]` row of the popover: 13px/450 secondary text left, the control right.
function Row({
  label,
  children,
  className,
}: {
  label: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'font-book flex h-8 items-center justify-between gap-3 text-[13px] text-(--text-secondary)',
        className
      )}
    >
      <span className="min-w-0 truncate">{label}</span>
      <span className="flex shrink-0 items-center gap-1">{children}</span>
    </div>
  );
}

// A `Status ⌄` select pill opening a radio menu of the options; an option can be disabled
// on its own (greyed but listed) when the current layout has no use for it.
function SelectMenu<T extends string>({
  label,
  value,
  options,
  onChange,
  disabled = false,
}: {
  label: string;
  value: T;
  options: { id: T; label: string; disabled?: boolean }[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  const current = options.find((o) => o.id === value)?.label ?? value;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled}
        render={<SelectPill aria-label={label} />}
      >
        {current}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="min-w-[160px]">
        <DropdownMenuRadioGroup
          value={value}
          onValueChange={(next) => onChange(next as T)}
        >
          {options.map((option) => (
            <DropdownMenuRadioItem
              key={option.id}
              value={option.id}
              disabled={option.disabled}
            >
              {option.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

// The popover's sections stack with a hairline between each.
function Section({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        'shadow-hairline-bottom flex flex-col px-3 py-2 last:shadow-none',
        className
      )}
    >
      {children}
    </div>
  );
}

export interface DisplayPopoverProps {
  /** Which layout is showing; the segmented control at the top switches it. */
  mode: TasksViewMode;
  /** Omitted hides the segmented control, for a header that switches layouts itself. */
  onModeChange?: (mode: TasksViewMode) => void;
  prefs: TasksDisplayPrefs;
  onPrefsChange: (prefs: TasksDisplayPrefs) => void;
  /** `Show archived` — the project hook's own toggle, not part of the display prefs. */
  showArchived: boolean;
  archivedCount: number;
  onShowArchivedChange: (value: boolean) => void;
  /** Controlled open state, so `⇧V` on the list can open it. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * Linear's Display popover (§6): a 260px `#202022` card off the header's sliders button —
 * the Board | List | Milestones | Branches segmented control, then grouping / sub-grouping /
 * ordering select pills with a direction button and `Order completed by recency`, `Show
 * sub-tasks`, the list options (nested sub-tasks, empty groups, archived) and the
 * display-property toggle chips. Every change writes straight into `TasksDisplayPrefs`, the
 * one model the list, board, milestones and branches layouts all read.
 */
export function DisplayPopover({
  mode,
  onModeChange,
  prefs,
  onPrefsChange,
  showArchived,
  archivedCount,
  onShowArchivedChange,
  open,
  onOpenChange,
}: DisplayPopoverProps) {
  const set = <K extends keyof TasksDisplayPrefs>(
    key: K,
    value: TasksDisplayPrefs[K]
  ) => onPrefsChange({ ...prefs, [key]: value });
  const ascending = prefs.orderDir === 'asc';
  // Milestones and Branches both group by milestone and nothing else, so Grouping is greyed
  // out on either rather than offering a choice the layout cannot honour.
  const groupingFixed = mode === 'milestones' || mode === 'branches';
  // The board's columns are always status and its lanes follow Sub-grouping, so on the board
  // the Grouping pill is pinned to `Status` with every other option greyed out — a `Milestone`
  // chosen on the list never reads as a column layout the board does not draw. The fixed
  // layouts pin it to `Milestone` the same way, so the greyed pill shows what they draw.
  const grouping =
    mode === 'board' ? 'status' : groupingFixed ? 'milestone' : prefs.grouping;
  const groupings = GROUPINGS.map((option) => ({
    ...option,
    disabled: mode === 'board' && option.id !== 'status',
  }));

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger render={<DisplayIconButton />} />
      <PopoverContent
        align="end"
        data-slot="display-popover"
        className="w-[260px] p-0"
      >
        {onModeChange !== undefined && (
          <Section>
            {/* Four cells: at the control's own `px-2` their min-content widths (~241px in
                Inter 500) overrun the 260px card's content box, so the cells tighten to `px-1`. */}
            <SegmentedControl
              label="Layout"
              value={mode}
              className="[&_[role=radio]]:px-1"
              onChange={(id) => onModeChange(id as TasksViewMode)}
              options={TASKS_VIEW_TABS.map((tab) => ({
                id: tab.id,
                label: tab.label,
                icon: LAYOUT_ICON[tab.id],
              }))}
            />
          </Section>
        )}
        <Section>
          <Row label="Grouping">
            <SelectMenu
              label="Grouping"
              value={grouping}
              options={groupings}
              onChange={(next) => set('grouping', next)}
              disabled={groupingFixed}
            />
          </Row>
          <Row label="Sub-grouping">
            <SelectMenu
              label="Sub-grouping"
              value={prefs.subGrouping}
              options={SUB_GROUPINGS}
              onChange={(subGrouping) => set('subGrouping', subGrouping)}
            />
          </Row>
          <Row label="Ordering">
            <SelectMenu
              label="Ordering"
              value={prefs.ordering}
              options={ORDERINGS}
              onChange={(ordering) => set('ordering', ordering)}
            />
            {/* An action-style label (what a click does), so no `aria-pressed` — a toggle
                would need one stable name instead. */}
            <IconButton
              label={ascending ? 'Sort descending' : 'Sort ascending'}
              onClick={() => set('orderDir', ascending ? 'desc' : 'asc')}
            >
              {ascending ? (
                <ArrowDownNarrowWide aria-hidden />
              ) : (
                <ArrowUpNarrowWide aria-hidden />
              )}
            </IconButton>
          </Row>
          <Row label="Order completed by recency">
            <Switch
              aria-label="Order completed by recency"
              checked={prefs.completedByRecency}
              onCheckedChange={(checked) => set('completedByRecency', checked)}
            />
          </Row>
        </Section>
        <Section>
          <Row label="Show sub-tasks">
            <Switch
              aria-label="Show sub-tasks"
              checked={prefs.showSubtasks}
              onCheckedChange={(checked) => set('showSubtasks', checked)}
            />
          </Row>
        </Section>
        <Section>
          <span className="text-muted-foreground flex h-7 items-center text-[12px] font-medium">
            List options
          </span>
          <Row label="Nested sub-tasks">
            <Switch
              aria-label="Nested sub-tasks"
              checked={prefs.nestedSubtasks}
              onCheckedChange={(checked) => set('nestedSubtasks', checked)}
            />
          </Row>
          <Row label="Show empty groups">
            <Switch
              aria-label="Show empty groups"
              checked={prefs.showEmptyGroups}
              onCheckedChange={(checked) => set('showEmptyGroups', checked)}
            />
          </Row>
          {showArchiveToggle(showArchived, archivedCount) && (
            <Row label={`Show archived (${archivedCount})`}>
              <Switch
                aria-label="Show archived"
                checked={showArchived}
                onCheckedChange={onShowArchivedChange}
              />
            </Row>
          )}
          <span className="font-book flex h-8 items-center text-[13px] text-(--text-secondary)">
            Display properties
          </span>
          <div
            data-slot="display-properties"
            className="flex flex-wrap gap-1 pb-1"
          >
            {TASK_PROPERTIES.map((property) => {
              const on = prefs.properties.has(property);
              return (
                <PillButton
                  key={property}
                  aria-pressed={on}
                  data-active={on || undefined}
                  onClick={() =>
                    onPrefsChange(toggleDisplayProperty(prefs, property))
                  }
                  className={cn(
                    'h-6 px-2',
                    on
                      ? 'bg-surface-active text-foreground'
                      : 'text-muted-foreground border-transparent bg-transparent'
                  )}
                >
                  {PROPERTY_LABEL[property]}
                </PillButton>
              );
            })}
          </div>
        </Section>
      </PopoverContent>
    </Popover>
  );
}
