import type { TaskListItem, UpdatePatch } from '@dispatch-foo/core/browser';
import type {
  EpicProgressChild,
  FixLoopState,
  MergeQueueEntryState,
  RunMeta,
} from '@dispatch/client';
import { Milestone, Play } from 'lucide-react';
import { type KeyboardEvent, memo } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { AssigneeAvatar } from '../components/tasks/AssigneeAvatar';
import { LandingBadge } from '../components/tasks/LandingBadge';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import {
  AssigneeControl,
  EpicControl,
  LabelsControl,
  PriorityControl,
  StatusControl,
} from '../components/tasks/PropertyControls';
import { StatusIcon } from '../components/tasks/StatusIcon';
import {
  formatUsd,
  PHASE_LABEL,
  phaseTint,
  showsPhasePill,
} from '../lib/epicSession';
import { fixLoopStatusLabel } from '../lib/fixLoopStatus';
import {
  isInteractiveControlTagName,
  type ListKeyCommand,
  resolveListKeyCommand,
} from '../lib/keyboard';
import { colorForLabel } from '../lib/labelColor';
import { formatShortDate } from '../lib/taskDates';
import type { TaskProperty, TasksDisplayPrefs } from '../lib/tasksPrefs';
import { cn } from '@/lib/utils';
import { ListRow, type ListRowProps } from '@/ui/ai/list-row';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { MetaText } from '@/ui/chrome';
import { CountChip } from '@/ui/chrome/CountChip';

// The task row and the single-key model the Tasks list and the Milestones page share, so a
// task reads and edits identically under a status header and under a milestone header.

/** Which picker the `s`/`p`/`a`/`l`/`e` keys have opened, and on which row. */
export type PickerKind = 'status' | 'priority' | 'assignee' | 'labels' | 'epic';

export interface OpenPicker {
  taskId: string;
  kind: PickerKind;
}

/** The row's escape hatch for consumer-owned DOM attributes (`data-*`, `aria-*`, a DOM id):
 * every `ListRow` prop the task row sets itself is carved out so a passthrough can never
 * override the row's own wiring. */
export type ListRowPassthrough = Omit<
  ListRowProps,
  | 'leading'
  | 'id'
  | 'status'
  | 'title'
  | 'crumb'
  | 'trailing'
  | 'date'
  | 'indent'
  | 'selected'
  | 'focused'
  | 'onClick'
  | 'onContextMenu'
  | 'onSelectToggle'
  | 'selectLabel'
  | 'className'
  | 'role'
  | 'tabIndex'
  | 'onKeyDown'
  | 'onFocus'
>;

export interface TaskListRowProps {
  doc: TaskListItem;
  prefs: TasksDisplayPrefs;
  /** This task's latest run, if any. */
  run: RunMeta | undefined;
  /** Whether `run` is still live — only then does the row show its run mark. */
  live: boolean;
  /** Whether the task's latest run needs a human (`attentionByTaskId`). */
  needsYou: boolean;
  /** Unread messages to me about this task; a mention adds a dot. Chatter never counts. */
  speech?: { count: number; mention: boolean };
  /** Where the task's run stands in the merge queue, while it is landing. */
  landing?: MergeQueueEntryState;
  /** This task's fix loop, for a capped phase pill's wording. */
  fixLoop?: FixLoopState;
  /** The project's configured statuses, for the status picker. */
  statuses: string[];
  /** Every epic, for the `e` picker. */
  epics: TaskListItem[];
  /** The label vocabulary — only passed while this row's labels picker is open. */
  labelCandidates?: string[];
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  onMoveStatus: (id: string, status: string) => Promise<void>;
  indent?: 0 | 1;
  /** Read-only: glyphs instead of pickers, no checkbox, dimmed. */
  archived?: boolean;
  /** The parent epic, resolved by the caller. */
  epic?: TaskListItem;
  /** How many tasks sit under this row's task (an epic's `▶ N` pill). */
  childCount?: number;
  /** Hide the ` › epic` chip — under an epic/milestone header it is redundant. */
  showEpicChip?: boolean;
  /** Where this task stands in its milestone's fan-out, when the milestone has a session:
   * a phase pill (only where the phase says more than the status glyph), the run's cost
   * and the open findings count. */
  phase?: EpicProgressChild;
  /** The open picker; callers pass it only to the row it belongs to, so opening one
   * re-renders that row alone. */
  picker: OpenPicker | null;
  onPickerChange: (picker: OpenPicker | null) => void;
  selected: boolean;
  focused: boolean;
  // Id-based so a list can hand every row the same stable callbacks.
  onOpen: (id: string) => void;
  onFocus: (id: string) => void;
  onContextMenu?: (id: string) => void;
  onSelectToggle?: (id: string) => void;
  /** Spread last onto the `ListRow` — see `ListRowPassthrough`. */
  rowProps?: ListRowPassthrough;
}

// A capped child reads its fix loop's own line (`Stopped at 3/3: rounds exhausted`) when
// the loop state is known; every other phase prints its label.
function phasePillLabel(
  phase: EpicProgressChild,
  loop: FixLoopState | undefined
): string {
  if (phase.phase === 'capped' && loop !== undefined) {
    return fixLoopStatusLabel(loop);
  }
  return PHASE_LABEL[phase.phase];
}

/** One 36px task row: priority picker, sans id, status picker, title, then the right-aligned
 * label pills, epic chip, sub-task count, `Needs you`, `Landing`, live run mark and assignee,
 * and the absolute date. Which of those show comes from `prefs.properties`. */
export const TaskListRow = memo(function TaskListRow({
  doc,
  prefs,
  run,
  live: liveRun,
  needsYou,
  speech,
  landing,
  fixLoop,
  statuses,
  epics,
  labelCandidates,
  onUpdate,
  onMoveStatus,
  indent = 0,
  archived = false,
  epic,
  childCount = 0,
  showEpicChip = true,
  phase,
  picker,
  onPickerChange,
  selected,
  focused,
  onOpen,
  onFocus,
  onContextMenu,
  onSelectToggle,
  rowProps,
}: TaskListRowProps) {
  const id = doc.meta.id;
  const live = run !== undefined && liveRun;
  const editable = !archived;
  const has = (p: TaskProperty) => prefs.properties.has(p);

  const pickerProps = (kind: PickerKind) => ({
    open: picker?.taskId === id && picker.kind === kind,
    onOpenChange: (open: boolean) =>
      onPickerChange(open ? { taskId: id, kind } : null),
  });

  const trailing = (
    <>
      {has('labels') &&
        doc.meta.labels.map((label) => (
          <LabelPill key={label} color={colorForLabel(label)}>
            {label}
          </LabelPill>
        ))}
      {/* The label picker only mounts while the `l` key has it open — the pills above are
          the row's resting face. The caller gathers the vocabulary once per open picker. */}
      {picker?.taskId === id && picker.kind === 'labels' && (
        <LabelsControl
          variant="inline"
          value={doc.meta.labels}
          candidates={labelCandidates ?? []}
          onChange={(labels) => void onUpdate(id, { labels })}
          {...pickerProps('labels')}
        />
      )}
      {has('epic') && showEpicChip && epic !== undefined && (
        <Pill title={epic.meta.title}>
          <Milestone className="text-muted-foreground" />
          <span className="max-w-40 truncate">{epic.meta.title}</span>
        </Pill>
      )}
      {/* The epic picker only mounts while the `e` key has it open — the chip above is the
          row's resting face for the same property. */}
      {picker?.taskId === id && picker.kind === 'epic' && (
        <EpicControl
          value={doc.meta.parent}
          epics={epics}
          variant="inline"
          onChange={(parent) => void onUpdate(id, { parent })}
          {...pickerProps('epic')}
        />
      )}
      {childCount > 0 && (
        <Pill title={`${childCount} sub-tasks`}>
          <Play className="size-2.5 fill-current" />
          {childCount}
        </Pill>
      )}
      {needsYou && !archived && (
        <LabelPill color="var(--state-waiting-fg)">Needs you</LabelPill>
      )}
      {speech !== undefined && speech.count > 0 && (
        <Pill
          data-slot="speech"
          title={`${speech.count} unread ${speech.count === 1 ? 'message' : 'messages'}${speech.mention ? ', one mentions you' : ''}`}
        >
          ◫ {speech.count}
          {speech.mention && (
            <span aria-hidden className="size-1.5 rounded-full bg-(--accent)" />
          )}
        </Pill>
      )}
      {has('run') && landing !== undefined && !archived && (
        <LandingBadge state={landing} />
      )}
      {has('run') && live && <RunStatePill meta={run} compact />}
      {phase !== undefined && showsPhasePill(phase.phase) && (
        <LabelPill
          data-slot="phase-pill"
          data-phase={phase.phase}
          color={phaseTint(phase.phase) ?? 'var(--text-muted)'}
          title={phase.reason}
        >
          {phasePillLabel(phase, fixLoop)}
        </LabelPill>
      )}
      {phase?.costUsd !== undefined && (
        <MetaText>{formatUsd(phase.costUsd)}</MetaText>
      )}
      {phase !== undefined && phase.openFindings > 0 && (
        <span title="open findings" className="flex items-center">
          <CountChip count={phase.openFindings} />
        </span>
      )}
      {has('assignee') &&
        (editable ? (
          <AssigneeControl
            value={doc.meta.assignee}
            onChange={(a) => void onUpdate(id, { assignee: a })}
            {...pickerProps('assignee')}
          />
        ) : (
          <AssigneeAvatar assignee={doc.meta.assignee} size={16} />
        ))}
    </>
  );

  return (
    <ListRow
      data-row-id={id}
      tabIndex={-1}
      indent={indent}
      leading={
        has('priority') ? (
          editable ? (
            <PriorityControl
              value={doc.meta.priority}
              onChange={(p) => void onUpdate(id, { priority: p })}
              {...pickerProps('priority')}
            />
          ) : (
            <PriorityIcon priority={doc.meta.priority} />
          )
        ) : undefined
      }
      id={has('id') ? id : undefined}
      status={
        has('status') ? (
          editable ? (
            <StatusControl
              value={doc.meta.status}
              statuses={statuses}
              onChange={(status) => void onMoveStatus(id, status)}
              {...pickerProps('status')}
            />
          ) : (
            <StatusIcon status={doc.meta.status} />
          )
        ) : undefined
      }
      title={doc.meta.title}
      trailing={trailing}
      date={
        has(prefs.dateField)
          ? formatShortDate(doc.meta[prefs.dateField])
          : undefined
      }
      selected={selected}
      focused={focused}
      onClick={() => onOpen(id)}
      onMouseEnter={() => onFocus(id)}
      onContextMenu={
        onContextMenu === undefined ? undefined : () => onContextMenu(id)
      }
      onKeyDown={(e: KeyboardEvent<HTMLDivElement>) => {
        // The list container owns Enter/Space (open/peek); the row's own activation must
        // not fire a second open.
        if (
          e.target === e.currentTarget &&
          (e.key === 'Enter' || e.key === ' ')
        ) {
          e.preventDefault();
        }
      }}
      onSelectToggle={
        editable && onSelectToggle !== undefined
          ? () => onSelectToggle(id)
          : undefined
      }
      selectLabel={`Select ${doc.meta.title}`}
      className={cn(archived && 'opacity-55')}
      {...rowProps}
    />
  );
}, sameRowProps);

// Shallow equality, except `rowProps`, which callers build inline on every render.
function sameRowProps(a: TaskListRowProps, b: TaskListRowProps): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys as Set<keyof TaskListRowProps>) {
    if (key === 'rowProps') {
      if (!shallowEqual(a.rowProps ?? {}, b.rowProps ?? {})) return false;
    } else if (!Object.is(a[key], b[key])) {
      return false;
    }
  }
  return true;
}

function shallowEqual(a: object, b: object): boolean {
  const aEntries = Object.entries(a);
  if (aEntries.length !== Object.keys(b).length) return false;
  return aEntries.every(([key, value]) =>
    Object.is(value, (b as Record<string, unknown>)[key])
  );
}

export interface TaskListKeyHandlers {
  /** Row ids in reading order, expanded groups only. */
  orderedIds: readonly string[];
  focusedTaskId: string | null;
  setFocusedTaskId: (id: string | null) => void;
  onOpen: (id: string) => void;
  onPeek: (id: string) => void;
  onSelectToggle?: (id: string) => void;
  onDispatch?: (id: string) => void;
  /** `⌘C` with nothing selected on the page copies the focused row's id. */
  onCopyId?: (id: string) => void;
  setPicker: (picker: OpenPicker | null) => void;
  /** Escape: clear whatever is selected. Return false when there was nothing to clear so
   * the key falls through to the shell. */
  onEscape: () => boolean;
  onRequestFilter?: () => void;
  onRequestDisplay?: () => void;
}

/** The keydown handler for a list container: `j/k`/arrows move the cursor, Enter/`o` open,
 * Space peeks, `x` selects, `s p a l e m` open the focused row's picker, `d` dispatches,
 * `⌘C` copies the id, `f` and `⇧V` ask the page for its filter/display menus, Escape
 * clears. A keystroke that landed on a real control inside a row (a picker trigger, the
 * checkbox) belongs to that control, and one from a portaled popup (an open picker menu or
 * its search input, a dialog) — which React still bubbles here — belongs to that popup. */
export function handleTaskListKeyDown(
  e: KeyboardEvent<HTMLDivElement>,
  h: TaskListKeyHandlers
): void {
  const target = e.target as HTMLElement;
  if (target !== e.currentTarget) {
    if (!e.currentTarget.contains(target)) return;
    const control = target.closest('button, a, input, textarea, select');
    if (
      control !== null &&
      isInteractiveControlTagName(control.tagName) &&
      (e.key === 'Enter' || e.key === ' ')
    ) {
      return;
    }
  }
  if ((e.metaKey || e.ctrlKey) && e.key === 'c') {
    // A text selection keeps the native copy; only a bare ⌘C takes the row's id.
    if (
      h.onCopyId !== undefined &&
      h.focusedTaskId !== null &&
      (window.getSelection()?.toString() ?? '') === ''
    ) {
      e.preventDefault();
      h.onCopyId(h.focusedTaskId);
    }
    return;
  }
  const command: ListKeyCommand | null = resolveListKeyCommand(
    { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
    { isTyping: false }
  );
  if (command === null) return;
  if (command === 'list-escape') {
    if (h.onEscape()) e.preventDefault();
    return;
  }
  if (command === 'list-open-filter') {
    e.preventDefault();
    h.onRequestFilter?.();
    return;
  }
  if (command === 'list-open-display') {
    e.preventDefault();
    h.onRequestDisplay?.();
    return;
  }
  if (h.orderedIds.length === 0) return;
  e.preventDefault();
  if (command === 'list-down' || command === 'list-up') {
    const currentIndex =
      h.focusedTaskId !== null ? h.orderedIds.indexOf(h.focusedTaskId) : -1;
    const nextIndex =
      command === 'list-down'
        ? Math.min(currentIndex + 1, h.orderedIds.length - 1)
        : Math.max(currentIndex - 1, 0);
    h.setFocusedTaskId(h.orderedIds[Math.max(nextIndex, 0)] ?? null);
    return;
  }
  const id = h.focusedTaskId;
  if (id === null) return;
  switch (command) {
    case 'list-confirm':
    case 'list-open':
      h.onOpen(id);
      return;
    case 'list-peek':
      h.onPeek(id);
      return;
    case 'list-select-toggle':
      h.onSelectToggle?.(id);
      return;
    case 'list-set-status':
      h.setPicker({ taskId: id, kind: 'status' });
      return;
    case 'list-set-priority':
      h.setPicker({ taskId: id, kind: 'priority' });
      return;
    case 'list-set-assignee':
      h.setPicker({ taskId: id, kind: 'assignee' });
      return;
    case 'list-set-labels':
      h.setPicker({ taskId: id, kind: 'labels' });
      return;
    case 'list-set-epic':
    case 'list-set-milestone':
      // Milestone = epic today (e-be4827), so both keys open the epic picker.
      h.setPicker({ taskId: id, kind: 'epic' });
      return;
    case 'list-dispatch':
      h.onDispatch?.(id);
      return;
  }
}
