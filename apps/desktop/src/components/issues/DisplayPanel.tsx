import {
  Button,
  type PickerOption,
  PickerPopover,
  Popover,
  SegmentedControl,
  Switch,
} from '@dispatch/ui';
import {
  ArrowDownNarrowWide,
  ArrowUpNarrowWide,
  SlidersHorizontal,
} from 'lucide-react';
import { type ReactNode, useId, useState } from 'react';

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
import styles from './DisplayPanel.module.css';

const GROUPINGS: { id: TasksGrouping; label: string }[] = [
  { id: 'status', label: 'Status' },
  { id: 'parent', label: 'Parent' },
  { id: 'milestone', label: 'Milestone' },
  { id: 'assignee', label: 'Assignee' },
  { id: 'priority', label: 'Priority' },
  { id: 'none', label: 'No grouping' },
];

const SUB_GROUPINGS: { id: TasksSubGrouping; label: string }[] = [
  { id: 'none', label: 'No grouping' },
  { id: 'parent', label: 'Parent' },
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
  milestone: 'Milestone',
  labels: 'Labels',
  links: 'Links',
  created: 'Created',
  updated: 'Updated',
  run: 'Run',
};

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** Turns one of the id/label tables above into picker options. */
function toOptions(
  table: readonly { id: string; label: string }[],
  disabled?: (id: string) => boolean
): PickerOption[] {
  return table.map((row) => ({
    value: row.id,
    label: row.label,
    disabled: disabled?.(row.id) === true ? true : undefined,
  }));
}

/** One `Label … [picker]` line of the panel: the setting's name on the
    left, its picker (and any extra control) on the right. */
function PickerRow({
  label,
  children,
}: {
  label: string;
  children: ReactNode;
}) {
  return (
    <div className={styles.row}>
      <span className={styles.rowLabel}>{label}</span>
      <span className={styles.rowControls}>{children}</span>
    </div>
  );
}

export interface DisplayPanelProps {
  /** Which layout is showing; the Layout control at the top switches it. */
  mode: TasksViewMode;
  /** Omitted hides the Layout control, for a toolbar that switches layouts
      itself. */
  onModeChange?: (mode: TasksViewMode) => void;
  prefs: TasksDisplayPrefs;
  onPrefsChange: (prefs: TasksDisplayPrefs) => void;
  /** `Show archived`: the project hook's own toggle, not part of the
      display prefs. */
  showArchived: boolean;
  archivedCount: number;
  onShowArchivedChange: (value: boolean) => void;
  /** Controlled open state, so `⇧V` on the list can open it. Omitted, the
      panel keeps its own. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * The Issues toolbar's Display panel: a Popover off a quiet sliders button
 * holding the Layout control (when the host lets it switch layouts), the
 * Grouping, Sub-grouping and Ordering pickers with a sort-direction
 * button, the switch rows (completed by recency, sub-tasks, then the list
 * options) and the display-property toggles. Every change writes straight
 * into `TasksDisplayPrefs`, the one model the list and board both read.
 * The pickers are layers of their own, so changing Grouping keeps the
 * panel open and Escape closes the inner picker first.
 */
export function DisplayPanel({
  mode,
  onModeChange,
  prefs,
  onPrefsChange,
  showArchived,
  archivedCount,
  onShowArchivedChange,
  open,
  onOpenChange,
}: DisplayPanelProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const isOpen = open ?? innerOpen;
  const listOptionsId = useId();
  const propertiesId = useId();

  function setOpen(next: boolean): void {
    if (open === undefined) setInnerOpen(next);
    onOpenChange?.(next);
  }

  function set<K extends keyof TasksDisplayPrefs>(
    key: K,
    value: TasksDisplayPrefs[K]
  ): void {
    onPrefsChange({ ...prefs, [key]: value });
  }

  const ascending = prefs.orderDir === 'asc';
  // The board's columns are always status and its lanes follow
  // Sub-grouping, so on the board Grouping is pinned to Status with every
  // other option listed but disabled: a Milestone chosen on the list never
  // reads as a column layout the board does not draw.
  const board = mode === 'board';
  const grouping = board ? 'status' : prefs.grouping;

  return (
    <Popover
      open={isOpen}
      onOpenChange={setOpen}
      label="Display"
      align="end"
      width={300}
      data-slot="display-popover"
      trigger={
        <Button
          variant="quiet"
          size="sm"
          aria-label="Display"
          icon={<SlidersHorizontal {...ICON} />}
        />
      }
    >
      <div className={styles.panel}>
        {onModeChange !== undefined ? (
          <div className={styles.section}>
            <SegmentedControl
              label="Layout"
              size="sm"
              fill
              value={mode}
              options={TASKS_VIEW_TABS.map((tab) => ({
                id: tab.id,
                label: tab.label,
              }))}
              onChange={(id) => {
                const tab = TASKS_VIEW_TABS.find((t) => t.id === id);
                if (tab !== undefined) onModeChange(tab.id);
              }}
            />
          </div>
        ) : null}
        <div className={styles.section}>
          <PickerRow label="Grouping">
            <PickerPopover
              label="Grouping"
              searchable={false}
              appearance="value"
              align="end"
              options={toOptions(GROUPINGS, (id) => board && id !== 'status')}
              value={grouping}
              onChange={(next) => {
                const picked = GROUPINGS.find((g) => g.id === next);
                if (picked !== undefined) set('grouping', picked.id);
              }}
            />
          </PickerRow>
          <PickerRow label="Sub-grouping">
            <PickerPopover
              label="Sub-grouping"
              searchable={false}
              appearance="value"
              align="end"
              options={toOptions(SUB_GROUPINGS)}
              value={prefs.subGrouping}
              onChange={(next) => {
                const picked = SUB_GROUPINGS.find((g) => g.id === next);
                if (picked !== undefined) set('subGrouping', picked.id);
              }}
            />
          </PickerRow>
          <PickerRow label="Ordering">
            <PickerPopover
              label="Ordering"
              searchable={false}
              appearance="value"
              align="end"
              options={toOptions(ORDERINGS)}
              value={prefs.ordering}
              onChange={(next) => {
                const picked = ORDERINGS.find((o) => o.id === next);
                if (picked !== undefined) set('ordering', picked.id);
              }}
            />
            {/* Action wording (what a press does), so no aria-pressed: a
                toggle would need one stable name instead. */}
            <Button
              variant="quiet"
              size="sm"
              aria-label={ascending ? 'Sort descending' : 'Sort ascending'}
              icon={
                ascending ? (
                  <ArrowDownNarrowWide {...ICON} />
                ) : (
                  <ArrowUpNarrowWide {...ICON} />
                )
              }
              onClick={() => set('orderDir', ascending ? 'desc' : 'asc')}
            />
          </PickerRow>
          <div className={styles.switchRow}>
            <Switch
              label="Order completed by recency"
              checked={prefs.completedByRecency}
              onChange={(checked) => set('completedByRecency', checked)}
            />
          </div>
        </div>
        <div className={styles.section}>
          <div className={styles.switchRow}>
            <Switch
              label="Show sub-tasks"
              checked={prefs.showSubtasks}
              onChange={(checked) => set('showSubtasks', checked)}
            />
          </div>
        </div>
        <div
          className={styles.section}
          role="group"
          aria-labelledby={listOptionsId}
        >
          <span id={listOptionsId} className={styles.heading}>
            List options
          </span>
          <div className={styles.switchRow}>
            <Switch
              label="Nested sub-tasks"
              checked={prefs.nestedSubtasks}
              onChange={(checked) => set('nestedSubtasks', checked)}
            />
          </div>
          <div className={styles.switchRow}>
            <Switch
              label="Show empty groups"
              checked={prefs.showEmptyGroups}
              onChange={(checked) => set('showEmptyGroups', checked)}
            />
          </div>
          {showArchiveToggle(showArchived, archivedCount) ? (
            <div className={styles.switchRow}>
              <Switch
                label={`Show archived (${archivedCount})`}
                aria-label="Show archived"
                checked={showArchived}
                onChange={onShowArchivedChange}
              />
            </div>
          ) : null}
        </div>
        <div className={styles.section}>
          <span id={propertiesId} className={styles.heading}>
            Display properties
          </span>
          <div
            className={styles.properties}
            role="group"
            aria-labelledby={propertiesId}
            data-slot="display-properties"
          >
            {TASK_PROPERTIES.map((property) => {
              const on = prefs.properties.has(property);
              return (
                <Button
                  key={property}
                  variant={on ? 'secondary' : 'quiet'}
                  size="sm"
                  aria-pressed={on}
                  onClick={() =>
                    onPrefsChange(toggleDisplayProperty(prefs, property))
                  }
                >
                  {PROPERTY_LABEL[property]}
                </Button>
              );
            })}
          </div>
        </div>
      </div>
    </Popover>
  );
}
