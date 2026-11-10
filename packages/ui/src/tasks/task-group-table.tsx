'use client';

import { ArrowUpRight, ChevronRight, GripVertical, Plus } from 'lucide-react';
import {
  type CSSProperties,
  type DragEvent,
  type FocusEvent,
  type KeyboardEvent,
  memo,
  type MouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { avatarHue, InitialsAvatar } from '../components/initials-avatar';
import StatusMark from '../components/status-mark';
import { PickerMarkView } from '../edit/picker-mark';
import { useLatest } from '../edit/save-state';
import { Link } from '../lib/link';
import { isTypingTarget, useMediaQuery } from '../shell/dom';
import type { UiTone } from '../types';
import { Button } from './button';
import { Checkbox } from './checkbox';
import { Chip } from './chip';
import { cx } from './class-names';
import {
  parseCollapsed,
  readCollapsedRaw,
  subscribeCollapsed,
  writeCollapsed,
} from './collapsed-groups';
import { EmptyState } from './notice';
import { ProgressRule } from './progress-rule';
import { type RowSegment, sameSegments } from './row-window';
import { PriorityGlyph, StateGlyph } from './task-glyphs';
import styles from './task-group-table.module.css';
import { pruneSelection, rangeIds, setIds, toggleId } from './task-selection';
import type {
  TaskChipData,
  TaskColumnId,
  TaskDragProps,
  TaskGroupData,
  TaskGroupTableProps,
  TaskRowData,
  TaskSectionData,
  TaskSelectionProps,
} from './types';
import {
  focusTargetOf,
  type RowWindowGroup,
  type RowWindows,
  useRowWindows,
} from './use-row-windows';

/** Above this many rows (folded groups included) the table windows its
    rows: only the rows near the viewport are mounted. */
const DEFAULT_WINDOW_ABOVE = 150;

const DEFAULT_COLUMNS: TaskColumnId[] = ['project', 'state', 'priority', 'due'];

const DEFAULT_LABELS: Record<TaskColumnId | 'title', string> = {
  title: 'Issue',
  project: 'Project',
  state: 'State',
  priority: 'Priority',
  due: 'Due',
  assignee: 'Assignee',
  milestone: 'Milestone',
};

/** Each meta column's fixed width, in px. */
const COLUMN_WIDTHS: Record<TaskColumnId, number> = {
  project: 156,
  state: 136,
  priority: 128,
  due: 88,
  assignee: 140,
  milestone: 180,
};

/** The lead and trailing columns' widths, in px (the CSS's --task-grip-col
    on a fine pointer, --task-check-col and --task-actions-col). */
const GRIP_COL_PX = 18;
const CHECK_COL_PX = 30;
const ACTIONS_COL_PX = 40;
/** Before the title text: the indent under the group's mark (38), the key
    column (64) and the gap after it (8), as in the stylesheet. */
const TITLE_LEAD_PX = 110;
/** The narrowest title a step of `dropColumns` leaves. */
const TITLE_MIN_PX = 260;

/**
 * The narrow steps of `dropColumns`: below `below` px of table width (and
 * down to `from`, where the next step starts) the step's attribute names
 * the dropped columns and its custom property holds the grid without them.
 * The container queries in the stylesheet use the same numbers.
 */
const DROP_STEPS = [
  { step: 'lg', below: 1160, from: 1000 },
  { step: 'md', below: 1000, from: 860 },
  { step: 'sm', below: 860, from: 720 },
] as const;

/**
 * Which of `columns` a table `width` px wide keeps: the `dropOrder`
 * columns go one by one, first to last, until the title has
 * TITLE_MIN_PX beside the rest (`fixed` px of lead and trailing columns).
 */
function columnsAtWidth(
  width: number,
  columns: readonly TaskColumnId[],
  dropOrder: readonly TaskColumnId[],
  fixed: number
): TaskColumnId[] {
  let kept = [...columns];
  const fits = (cols: readonly TaskColumnId[]) =>
    width -
      fixed -
      cols.reduce((sum, column) => sum + COLUMN_WIDTHS[column], 0) -
      TITLE_LEAD_PX >=
    TITLE_MIN_PX;
  for (const column of dropOrder) {
    if (fits(kept)) break;
    kept = kept.filter((c) => c !== column);
  }
  return kept;
}

/** Where a row can be dragged from: a mouse or trackpad (touch selects
    with checkboxes and moves through menus instead). */
const FINE_POINTER_QUERY = '(hover: hover) and (pointer: fine)';

type HeadingTag = 'h2' | 'h3' | 'h4' | 'h5' | 'h6';

// Whether a due date's tone colours its text (the tone's --tone-ink via
// data-tone): every tone but default (the text colour) and muted (its own
// grey class).
function hasTextTone(tone: UiTone | undefined): boolean {
  return tone !== undefined && tone !== 'default' && tone !== 'muted';
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

// A plain primary-button click (no modifier, no middle button): the only
// click a row callback may take over; cmd/ctrl/shift-click and middle
// click keep the browser's open-in-new-tab behaviour.
function isPlainClick(event: MouseEvent): boolean {
  return (
    event.button === 0 &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.shiftKey &&
    !event.altKey
  );
}

/** One stop of the keyboard model, in reading order: a group's toggle, or
    a row (with its place in its group, for a row that is not mounted). */
type NavTarget =
  | { kind: 'group'; groupId: string }
  | { kind: 'row'; groupId: string; rowId: string; index: number };

/** What one render derives from the sections and the folds, in one pass. */
interface TableModel {
  groupById: Map<string, TaskGroupData>;
  /** The rows drawn, in reading order: the order of shift ranges,
      Shift+↑/↓ and ⌘A. Folded groups' rows are not drawn, so they are not
      in it. */
  shownOrder: string[];
  /** Every group toggle and shown row, in reading order: what ↑/↓, j/k,
      Home and End walk (never the DOM, whose rows may be unmounted). */
  navOrder: NavTarget[];
  /** `g:<id>` / `r:<id>` → index in navOrder. */
  navIndex: Map<string, number>;
  /** The unfolded groups with their row ids, for the row windows. */
  shownGroups: RowWindowGroup[];
  /** Every row, folded or not: what the windowing threshold counts. */
  totalRows: number;
}

function buildModel(
  sections: readonly TaskSectionData[],
  collapsed: ReadonlySet<string>
): TableModel {
  const groupById = new Map<string, TaskGroupData>();
  const shownOrder: string[] = [];
  const navOrder: NavTarget[] = [];
  const navIndex = new Map<string, number>();
  const shownGroups: RowWindowGroup[] = [];
  let totalRows = 0;
  for (const section of sections) {
    for (const group of section.groups) {
      groupById.set(group.id, group);
      totalRows += group.rows.length;
      navIndex.set(`g:${group.id}`, navOrder.length);
      navOrder.push({ kind: 'group', groupId: group.id });
      if (collapsed.has(group.id)) continue;
      const rowIds: string[] = [];
      group.rows.forEach((row, index) => {
        rowIds.push(row.id);
        shownOrder.push(row.id);
        navIndex.set(`r:${row.id}`, navOrder.length);
        navOrder.push({ kind: 'row', groupId: group.id, rowId: row.id, index });
      });
      shownGroups.push({ id: group.id, rowIds });
    }
  }
  return { groupById, shownOrder, navOrder, navIndex, shownGroups, totalRows };
}

// Events from a host control inside a row (a cell picker's search box, an
// open menu) are that control's: the list never treats them as its own
// navigation, selection or row commands.
function isHostControlEvent(target: HTMLElement): boolean {
  return (
    isTypingTarget(target) || target.closest('[data-picker-popup]') !== null
  );
}

/** What a drag is over: a group, and whether it would take the rows. */
interface DropState {
  groupId: string;
  verdict: true | string;
}

/** The selection model the rows and headers share. Its identity stays
    the same while the selection changes (the set itself goes to each
    group and, as a boolean, to each row), so a memoized row redraws
    only when its own checkbox does. */
interface SelectionModel {
  toggleOnClick: boolean;
  /** A row's checkbox or `x`; shift extends from the anchor. */
  toggleRow: (id: string, shift: boolean) => void;
  /** A group header's checkbox. */
  setGroup: (group: TaskGroupData, on: boolean) => void;
}

/** The drag model the rows and groups share, as stable as the selection
    model: what is dragged and where it would drop are passed beside it. */
interface DragModel {
  draggable: boolean;
  start: (event: DragEvent<HTMLElement>, row: TaskRowData) => void;
  end: () => void;
  over: (event: DragEvent<HTMLElement>, group: TaskGroupData) => void;
  leave: (event: DragEvent<HTMLElement>, group: TaskGroupData) => void;
  dropOn: (event: DragEvent<HTMLElement>, group: TaskGroupData) => void;
}

/** What a Row needs besides its data, passed down unchanged. */
interface RowSlots {
  renderCell: TaskGroupTableProps['renderCell'];
  rowActions: TaskGroupTableProps['rowActions'];
  onRowContextMenu: TaskGroupTableProps['onRowContextMenu'];
}

/* Gr8r's My Tasks grouped list, as one rounded panel. Structure: a column
   header, then sections (This week / Later / No milestone) as recessed
   bands, each holding collapsible groups (Gr8r's group header: chevron,
   status mark, Project / Milestone, count, then due, days left and
   completed/scope) of flat rows split by soft dividers.

   Semantics are plain on purpose: section and group titles are headings,
   each group's toggle is a disclosure button (aria-expanded/controls) and
   its rows are a list of links, so screen readers, cmd-click and the host
   router all work natively. The keyboard model (Gr8r/Dispatch) is layered
   on top: ↑/↓ (or j/k) move between group toggles and rows, Home/End jump,
   ← on a row goes to its group and on a group collapses it, → expands or
   enters it, ↵ opens; any other key on a row goes to onRowKeyDown, so a
   host can add its own single-key commands. Collapsed groups persist under
   storageKey. The column header is sticky at var(--task-sticky-top, 0):
   hosts with a sticky topbar set that custom property to its height.

   The issue list adds, each only when its prop is set (without them the
   markup is My week's, unchanged): `selection` (Gr8r's row and select-all
   checkboxes, shift ranges, x, Shift+↑/↓, ⌘A; a selected row takes the
   accent tint and a 2px accent bar at its left edge, and the row's
   checkbox carries the state, never aria-selected, which a list item does
   not support), `drag` (an HTML5 drag from an 18px grip onto any group,
   which answers with a faint accent wash in an accent edge), and the slots
   `renderCell`, `rowActions`,
   `groupActions` and `onRowContextMenu`.

   Groups and rows are memoized: a selection, a fold or a host render
   that changes nothing of theirs leaves them as they are, so a click on
   a 300-row list redraws the rows it touches, not all of them. A group
   is compared by identity (its header is one cheap draw); a row by value
   (rowPropsEqual: every field of its TaskRowData, chips and note
   included, and of its group only the id and eyebrow it draws), so a
   host that rebuilds its sections, groups and rows from scratch on every
   event redraws only the rows whose data changed. The callbacks a row
   calls on an event (onOpenRow, onOpenGroup, onRowContextMenu) are read
   at call time, get the current group object, and need not be stable;
   the render slots (renderCell, rowActions, groupActions) redraw every
   row or group when their identity changes, so a host with many rows
   keeps them stable (useCallback).

   Above `windowAbove` rows (default 150) the rows are windowed, per group
   (use-row-windows.ts): every group keeps its heading, header row and its
   own <ul>, and inside the <ul> only the rows near the scroll viewport
   are mounted, the rest standing as gaps of their measured (or estimated)
   height, so document order, roles, drop targets and the sticky column
   header are as in a small list. The keyboard model walks the model
   (navOrder), not the DOM: a key that lands on an unmounted row scrolls
   it into view and focuses it once it mounts. Below the threshold every
   row is drawn, exactly as before windowing existed. */
export function TaskGroupTable({
  sections,
  columns = DEFAULT_COLUMNS,
  columnLabels,
  label = 'Issues',
  headingLevel = 3,
  storageKey,
  storage = 'local',
  defaultCollapsed,
  emptyMessage = 'Nothing assigned to you',
  onOpenRow,
  onOpenGroup,
  onToggleGroup,
  activeRowId,
  onRowKeyDown,
  selection,
  renderCell,
  rowActions,
  onRowContextMenu,
  groupActions,
  drag,
  dropColumns,
  scrollParent,
  windowAbove = DEFAULT_WINDOW_ABOVE,
}: TaskGroupTableProps) {
  // Folds live in component state, mirrored to storage when storageKey is
  // set. The stored value is read through useSyncExternalStore: the server
  // and hydration renders see null (defaults), the client then switches to
  // the stored set without a mismatch, and other tabs stay in step.
  const [local, setLocal] = useState<ReadonlySet<string>>(
    () => new Set(defaultCollapsed)
  );
  const stored = useSyncExternalStore(
    subscribeCollapsed,
    () =>
      storageKey === undefined ? null : readCollapsedRaw(storageKey, storage),
    () => null
  );
  const collapsed = useMemo<ReadonlySet<string>>(
    () => (stored === null ? local : parseCollapsed(stored)),
    [stored, local]
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const headRef = useRef<HTMLDivElement>(null);
  const hintId = useId();
  const baseId = useId();
  const finePointer = useMediaQuery(FINE_POINTER_QUERY);

  const labels = useMemo(
    () => ({ ...DEFAULT_LABELS, ...columnLabels }),
    [columnLabels]
  );
  const templateOf = (cols: readonly TaskColumnId[]) =>
    [
      ...(drag !== undefined ? ['var(--task-grip-col)'] : []),
      ...(selection !== undefined ? ['var(--task-check-col)'] : []),
      'minmax(0, 1fr)',
      ...cols.map((c) => `${COLUMN_WIDTHS[c]}px`),
      ...(rowActions !== undefined ? ['var(--task-actions-col)'] : []),
    ].join(' ');
  const template = templateOf(columns);
  // dropColumns: per narrow step, the columns that give way and the grid
  // without them (data-drop-<step>, --task-cols-<step>).
  const rootStyle: CSSProperties & Record<string, string> = {
    '--task-cols': template,
  };
  const dropAttrs: Record<string, string> = {};
  if (dropColumns !== undefined && dropColumns.length > 0) {
    const fixed =
      (drag !== undefined ? GRIP_COL_PX : 0) +
      (selection !== undefined ? CHECK_COL_PX : 0) +
      (rowActions !== undefined ? ACTIONS_COL_PX : 0);
    const order = dropColumns.filter((c) => columns.includes(c));
    for (const { step, from } of DROP_STEPS) {
      const kept = columnsAtWidth(from, columns, order, fixed);
      if (kept.length === columns.length) continue;
      dropAttrs[`data-drop-${step}`] = columns
        .filter((c) => !kept.includes(c))
        .join(' ');
      rootStyle[`--task-cols-${step}`] = templateOf(kept);
    }
  }
  const SectionHeading = `h${headingLevel}` as HeadingTag;
  const GroupHeading = `h${headingLevel + 1}` as HeadingTag;

  function setGroupCollapsed(group: TaskGroupData, shut: boolean) {
    if (collapsed.has(group.id) === shut) return;
    // Focus must not vanish with the rows: if it sits in this group's rows,
    // hand it to the group's toggle before they unmount.
    if (shut) {
      const active = document.activeElement;
      const groupEl = rootRef.current?.querySelector(
        `[data-group-id="${CSS.escape(group.id)}"]`
      );
      const header = groupEl?.querySelector('[data-nav-item="group"]') ?? null;
      if (
        active !== null &&
        header !== null &&
        groupEl?.contains(active) === true &&
        !header.contains(active)
      ) {
        focusTargetOf(header)?.focus();
      }
    }
    const next = new Set(collapsed);
    if (shut) next.add(group.id);
    else next.delete(group.id);
    setLocal(next);
    if (storageKey !== undefined) writeCollapsed(storageKey, storage, next);
    onToggleGroup?.(group.id, shut);
  }

  const { groupById, shownOrder, navOrder, navIndex, shownGroups, totalRows } =
    useMemo(() => buildModel(sections, collapsed), [sections, collapsed]);

  // ---- selection --------------------------------------------------------

  // The anchor of shift ranges and Shift+↑/↓, and the selection as it was
  // when the anchor was set (a keyboard range grows and shrinks over it).
  const anchorRef = useRef<{ id: string; base: ReadonlySet<string> } | null>(
    null
  );

  // Rows that are no longer drawn (a folded group, a host refresh) leave
  // the selection, so an action never reaches a row nobody can see.
  const selected = selection?.selected;
  const onSelectionChange = selection?.onChange;
  const shownKey = shownOrder.join('\n');
  useEffect(() => {
    if (selected === undefined || onSelectionChange === undefined) return;
    const pruned = pruneSelection(selected, new Set(shownKey.split('\n')));
    if (pruned !== selected) onSelectionChange(pruned);
  }, [selected, onSelectionChange, shownKey]);

  function changeSelection(
    model: TaskSelectionProps,
    next: ReadonlySet<string>
  ) {
    if (next !== model.selected) model.onChange(next);
  }

  // ---- drag -------------------------------------------------------------

  const [dragging, setDragging] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [drop, setDrop] = useState<DropState | null>(null);
  // The ids being dragged (also in dataTransfer, which dragover cannot
  // read) and canDrop's answers for this drag, asked once per group.
  const dragRef = useRef<{
    ids: readonly string[];
    verdicts: Map<string, true | string>;
  } | null>(null);

  // ---- row windows ------------------------------------------------------

  // Above the threshold only the rows near the viewport are mounted; the
  // hook finds the scroller, measures and hands each group its window.
  const windowed = totalRows > windowAbove;
  const rowWindows = useRowWindows({
    rootRef,
    headRef,
    enabled: windowed,
    scrollParent,
    groups: shownGroups,
    dragging,
  });

  // What the stable models and event callbacks below read when they run:
  // this render's props and fold state, never a stale closure.
  const latest = useLatest({
    selection,
    drag,
    shownOrder,
    navOrder,
    navIndex,
    collapsed,
    groupById,
    setGroupCollapsed,
    onOpenRow,
    onOpenGroup,
    onRowContextMenu,
    rowWindows,
  });

  // Moves focus to a stop of the keyboard model. A group's toggle is always
  // mounted; a row may not be (windowed): then its place is scrolled into
  // view and it is focused once it mounts. In a windowed table the scroll
  // also keeps the target clear of the sticky column header, which a
  // browser's own focus scrolling does not know about.
  function focusNav(target: NavTarget | undefined) {
    const root = rootRef.current;
    if (target === undefined || root === null) return;
    if (target.kind === 'group') {
      const header = root.querySelector<HTMLElement>(
        `[data-group-id="${CSS.escape(target.groupId)}"] [data-nav-item="group"]`
      );
      if (header !== null) focusMounted(header);
      return;
    }
    const item = root.querySelector<HTMLElement>(
      `[data-nav-item="row"][data-row-id="${CSS.escape(target.rowId)}"]`
    );
    if (item !== null) focusMounted(item);
    else if (windowed) {
      rowWindows.focusUnmountedRow(target.groupId, target.index, target.rowId);
    }
  }

  function focusMounted(item: HTMLElement) {
    if (!windowed) {
      focusTargetOf(item)?.focus();
      return;
    }
    rowWindows.revealElement(item);
    focusTargetOf(item)?.focus({ preventScroll: true });
  }

  // The open row (a drawer, a detail pane) comes into view when it changes,
  // mounted or not; a small list leaves scrolling to the host as before.
  // rowWindows is read through `latest`, not listed as a dependency: its
  // identity changes with every scroll that moves a window, and the row
  // must be revealed once per change of activeRowId, never on a scroll
  // (that would pull the list back to the open row as the reader scrolls
  // away from it).
  useEffect(() => {
    if (!windowed || activeRowId === undefined) return;
    const {
      navOrder: order,
      navIndex: index,
      rowWindows: windows,
    } = latest.current;
    const target = order[index.get(`r:${activeRowId}`) ?? -1];
    if (target === undefined || target.kind !== 'row') return;
    const item = rootRef.current?.querySelector<HTMLElement>(
      `[data-nav-item="row"][data-row-id="${CSS.escape(activeRowId)}"]`
    );
    if (item !== null && item !== undefined) windows.revealElement(item);
    else windows.revealRow(target.groupId, target.index);
  }, [activeRowId, windowed, latest]);

  // Which row has focus, for the windows to keep mounted while the list
  // scrolls away from it (focus must never fall to the body).
  function onFocus(event: FocusEvent<HTMLDivElement>) {
    const item = (event.target as HTMLElement).closest<HTMLElement>(
      '[data-nav-item="row"]'
    );
    rowWindows.setFocusedRow(item?.dataset.rowId ?? null);
  }
  function onBlur(event: FocusEvent<HTMLDivElement>) {
    const into = event.relatedTarget;
    if (into instanceof Node && event.currentTarget.contains(into)) return;
    rowWindows.setFocusedRow(null);
  }

  const hasSelection = selection !== undefined;
  const toggleOnClick = selection?.toggleOnClick === true;
  const selectionModel = useMemo<SelectionModel | null>(
    () =>
      !hasSelection
        ? null
        : {
            toggleOnClick,
            toggleRow(id, shift) {
              const current = latest.current.selection;
              if (current === undefined) return;
              const anchor = anchorRef.current;
              let next: ReadonlySet<string>;
              if (shift && anchor !== null) {
                const on = !current.selected.has(id);
                next = setIds(
                  current.selected,
                  rangeIds(latest.current.shownOrder, anchor.id, id),
                  on
                );
              } else {
                next = toggleId(current.selected, id);
              }
              anchorRef.current = { id, base: next };
              changeSelection(current, next);
            },
            setGroup(group, on) {
              const current = latest.current.selection;
              if (current === undefined) return;
              if (on && latest.current.collapsed.has(group.id)) {
                latest.current.setGroupCollapsed(group, false);
              }
              anchorRef.current = null;
              changeSelection(
                current,
                setIds(
                  current.selected,
                  group.rows.map((r) => r.id),
                  on
                )
              );
            },
          },
    [hasSelection, toggleOnClick, latest]
  );

  // Shift+↑/↓ on a row: the range from the anchor to the next row grows
  // or shrinks over the selection the anchor started from; focus follows.
  function extendSelection(
    model: TaskSelectionProps,
    from: string,
    delta: 1 | -1
  ): boolean {
    const at = shownOrder.indexOf(from);
    const target = shownOrder[at + delta];
    if (at < 0 || target === undefined) return false;
    const anchor = anchorRef.current ?? { id: from, base: model.selected };
    anchorRef.current = anchor;
    changeSelection(
      model,
      setIds(anchor.base, rangeIds(shownOrder, anchor.id, target), true)
    );
    focusNav(navOrder[navIndex.get(`r:${target}`) ?? -1]);
    return true;
  }

  const hasDrag = drag !== undefined;
  const dragModel = useMemo<DragModel | null>(() => {
    if (!hasDrag) return null;
    const endDrag = () => {
      dragRef.current = null;
      setDragging(new Set());
      setDrop(null);
    };
    return {
      draggable: finePointer,
      start(event, row) {
        const {
          drag: host,
          selection: chosen,
          shownOrder: order,
        } = latest.current;
        if (host === undefined) return;
        const ids =
          chosen !== undefined && chosen.selected.has(row.id)
            ? order.filter((id) => chosen.selected.has(id))
            : [row.id];
        dragRef.current = { ids, verdicts: new Map() };
        const transfer = event.dataTransfer;
        transfer.effectAllowed = 'move';
        transfer.setData('text/plain', ids.join(','));
        setDragImage(event, rootRef.current, host, ids.length);
        setDragging(new Set(ids));
      },
      end: endDrag,
      over(event, group) {
        const current = dragRef.current;
        const host = latest.current.drag;
        if (current === null || host === undefined) return;
        if (group.droppable === false) {
          setDrop((was) => (was === null ? was : null));
          return;
        }
        let verdict = current.verdicts.get(group.id);
        if (verdict === undefined) {
          verdict = host.canDrop(current.ids, group.id);
          current.verdicts.set(group.id, verdict);
        }
        if (verdict === true) {
          event.preventDefault();
          event.dataTransfer.dropEffect = 'move';
        } else {
          event.dataTransfer.dropEffect = 'none';
        }
        const next = verdict;
        setDrop((was) =>
          was !== null && was.groupId === group.id && was.verdict === next
            ? was
            : { groupId: group.id, verdict: next }
        );
      },
      leave(event, group) {
        const into = event.relatedTarget;
        if (into instanceof Node && event.currentTarget.contains(into)) {
          return;
        }
        setDrop((was) =>
          was !== null && was.groupId === group.id ? null : was
        );
      },
      dropOn(event, group) {
        const current = dragRef.current;
        const host = latest.current.drag;
        if (current === null || host === undefined) return;
        event.preventDefault();
        const verdict =
          current.verdicts.get(group.id) ??
          (group.droppable === false
            ? ''
            : host.canDrop(current.ids, group.id));
        const ids = current.ids;
        endDrag();
        if (verdict === true) host.onDrop(ids, group.id);
      },
    };
  }, [hasDrag, finePointer, latest]);

  // The event callbacks rows and groups get: stable while the host's
  // handler is there (read at call time), undefined while it is not, as
  // the rows and groups draw differently without one. A row that skipped
  // a redraw (rowPropsEqual: its group object changed, its data did not)
  // still holds the group it last drew, so the host gets the group as it
  // is now, found by id.
  const stable = useMemo(
    () => ({
      toggleGroup: (group: TaskGroupData, shut: boolean) =>
        latest.current.setGroupCollapsed(group, shut),
      openRow: (row: TaskRowData, group: TaskGroupData) =>
        latest.current.onOpenRow?.(row, currentGroup(latest.current, group)),
      openGroup: (group: TaskGroupData) => latest.current.onOpenGroup?.(group),
      contextMenu: (
        event: MouseEvent<HTMLElement>,
        row: TaskRowData,
        group: TaskGroupData
      ) =>
        latest.current.onRowContextMenu?.(
          event,
          row,
          currentGroup(latest.current, group)
        ),
    }),
    [latest]
  );
  const openRow = onOpenRow === undefined ? undefined : stable.openRow;
  const openGroup = onOpenGroup === undefined ? undefined : stable.openGroup;
  const contextMenu =
    onRowContextMenu === undefined ? undefined : stable.contextMenu;
  const slots = useMemo<RowSlots>(
    () => ({ renderCell, rowActions, onRowContextMenu: contextMenu }),
    [renderCell, rowActions, contextMenu]
  );

  // ---- keys -------------------------------------------------------------

  // The table's own navigation over navOrder (the toggles and shown rows in
  // reading order; `index` is the focused item's place in it); returns
  // false for keys it leaves alone.
  function navigate(
    key: string,
    index: number,
    group: TaskGroupData | undefined,
    isGroup: boolean
  ): boolean {
    const focusAt = (i: number) => {
      focusNav(navOrder[Math.min(Math.max(i, 0), navOrder.length - 1)]);
    };
    switch (key) {
      case 'ArrowDown':
      case 'j':
        focusAt(index + 1);
        return true;
      case 'ArrowUp':
      case 'k':
        focusAt(index - 1);
        return true;
      case 'Home':
        focusAt(0);
        return true;
      case 'End':
        focusAt(navOrder.length - 1);
        return true;
      case 'ArrowRight': {
        if (!isGroup || group === undefined) return false;
        if (collapsed.has(group.id)) setGroupCollapsed(group, false);
        else if (group.rows.length > 0) focusAt(index + 1);
        return true;
      }
      case 'ArrowLeft': {
        if (group === undefined) return false;
        if (isGroup) setGroupCollapsed(group, true);
        else focusAt(navIndex.get(`g:${group.id}`) ?? index);
        return true;
      }
      default:
        return false;
    }
  }

  // Selection keys: x toggles the focused row, Shift+↑/↓ extend from the
  // anchor, ⌘/Ctrl+A selects every drawn row. Returns true when handled.
  function selectionKey(
    event: KeyboardEvent<HTMLDivElement>,
    rowId: string | undefined
  ): boolean {
    if (selection === undefined || selectionModel === null) return false;
    const plain = !event.altKey && !event.ctrlKey && !event.metaKey;
    const key = event.key;
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      if (key.toLowerCase() !== 'a' || event.shiftKey) return false;
      changeSelection(selection, setIds(selection.selected, shownOrder, true));
      return true;
    }
    if (!plain || rowId === undefined) return false;
    if ((key === 'x' || key === 'X') && !event.shiftKey) {
      selectionModel.toggleRow(rowId, false);
      return true;
    }
    if (event.shiftKey && (key === 'ArrowDown' || key === 'ArrowUp')) {
      extendSelection(selection, rowId, key === 'ArrowDown' ? 1 : -1);
      return true;
    }
    return false;
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const root = rootRef.current;
    const target = event.target as HTMLElement;
    if (event.defaultPrevented || isHostControlEvent(target)) return;
    const item = target.closest<HTMLElement>('[data-nav-item]');
    if (root === null || item === null || !root.contains(item)) return;
    const isGroup = item.dataset.navItem === 'group';
    const group = groupById.get(item.dataset.groupId ?? '');
    if (selectionKey(event, isGroup ? undefined : item.dataset.rowId)) {
      event.preventDefault();
      return;
    }
    // A held modifier means someone else's shortcut (the palette, the
    // browser): never navigation, but a host row command may want it.
    const modified = event.altKey || event.ctrlKey || event.metaKey;
    if (!modified) {
      // The item's place in the model (collapsed groups' rows are not in
      // it, so they are skipped for free); an item the model no longer
      // knows (a row gone in a refresh) navigates nowhere.
      const index = navIndex.get(
        isGroup ? `g:${item.dataset.groupId}` : `r:${item.dataset.rowId}`
      );
      if (index !== undefined && navigate(event.key, index, group, isGroup)) {
        event.preventDefault();
        return;
      }
    }
    if (isGroup || group === undefined || onRowKeyDown === undefined) return;
    const row = group.rows.find((r) => r.id === item.dataset.rowId);
    if (row !== undefined) onRowKeyDown(event, row, group);
  }

  const hasGroups = sections.some((s) => s.groups.length > 0);
  if (!hasGroups) {
    return <EmptyState>{emptyMessage}</EmptyState>;
  }

  const allOn =
    selection !== undefined &&
    shownOrder.length > 0 &&
    shownOrder.every((id) => selection.selected.has(id));
  const someOn =
    selection !== undefined &&
    !allOn &&
    shownOrder.some((id) => selection.selected.has(id));

  return (
    <div
      ref={rootRef}
      className={styles.root}
      style={rootStyle}
      {...dropAttrs}
      onKeyDown={onKeyDown}
      onFocus={onFocus}
      onBlur={onBlur}
      role="group"
      aria-label={label}
      aria-describedby={hintId}
      data-select={selection !== undefined ? '' : undefined}
      data-touch-select={selection?.hideOnTouch === true ? 'hidden' : undefined}
      data-drag={drag !== undefined ? '' : undefined}
      data-row-actions={rowActions !== undefined ? '' : undefined}
      data-dragging={dragging.size > 0 ? '' : undefined}
    >
      <p id={hintId} className="srOnly">
        Up and down arrows move between groups and issues. Left and right
        collapse and expand a group. Enter opens.
        {selection !== undefined
          ? ' X selects the focused issue; Shift with up or down extends the selection; Control or Command A selects every shown issue.'
          : null}
      </p>
      <div
        ref={headRef}
        className={styles.head}
        aria-hidden={selection === undefined ? 'true' : undefined}
      >
        {drag !== undefined ? (
          <span className={styles.leadCell} aria-hidden="true" />
        ) : null}
        {selection !== undefined ? (
          <span className={styles.checkCell}>
            <Checkbox
              label={`Select all ${plural(shownOrder.length, 'shown issue', 'shown issues')}`}
              hideLabel
              checked={allOn}
              indeterminate={someOn}
              disabled={shownOrder.length === 0}
              onChange={(on) => {
                anchorRef.current = null;
                changeSelection(
                  selection,
                  setIds(selection.selected, shownOrder, on)
                );
              }}
            />
          </span>
        ) : null}
        <span
          className={cx(styles.headCell, styles.headTitle)}
          aria-hidden={selection !== undefined ? 'true' : undefined}
        >
          {labels.title}
        </span>
        {columns.map((c) => (
          <span
            key={c}
            className={styles.headCell}
            data-column={dropColumns !== undefined ? c : undefined}
            aria-hidden={selection !== undefined ? 'true' : undefined}
          >
            {labels[c]}
          </span>
        ))}
        {rowActions !== undefined ? (
          <span className={styles.leadCell} aria-hidden="true" />
        ) : null}
      </div>
      {sections.map((section) => (
        <Section
          key={section.id}
          section={section}
          Heading={SectionHeading}
          GroupHeading={GroupHeading}
          baseId={baseId}
          columns={columns}
          labels={labels}
          collapsed={collapsed}
          onToggle={stable.toggleGroup}
          onOpenRow={openRow}
          onOpenGroup={openGroup}
          activeRowId={activeRowId}
          selection={selectionModel}
          selected={selection?.selected ?? null}
          drag={dragModel}
          dragging={dragging}
          drop={drop}
          slots={slots}
          groupActions={groupActions}
          rowWindows={rowWindows}
        />
      ))}
    </div>
  );
}

/** The group as the latest render has it, for a callback a row fires with
    the group object it last drew (the row itself when the group is gone,
    which a refresh between the draw and the click can do). */
function currentGroup(
  latest: { groupById: Map<string, TaskGroupData> },
  group: TaskGroupData
): TaskGroupData {
  return latest.groupById.get(group.id) ?? group;
}

/** Draws the drag image: a small inverted card naming how many rows move
    ("3 issues"), appended inside the table (so its styles apply in scoped
    mode) and removed once the browser has taken its picture. */
function setDragImage(
  event: DragEvent<HTMLElement>,
  root: HTMLElement | null,
  drag: TaskDragProps,
  count: number
): void {
  const transfer = event.dataTransfer;
  if (root === null || typeof transfer.setDragImage !== 'function') return;
  const ghost = document.createElement('div');
  ghost.className = styles.dragGhost ?? '';
  ghost.textContent = drag.label(count);
  root.appendChild(ghost);
  transfer.setDragImage(ghost, 14, 14);
  setTimeout(() => ghost.remove(), 0);
}

interface SectionProps {
  section: TaskSectionData;
  Heading: HeadingTag;
  GroupHeading: HeadingTag;
  baseId: string;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  collapsed: ReadonlySet<string>;
  onToggle: (group: TaskGroupData, shut: boolean) => void;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  onOpenGroup: TaskGroupTableProps['onOpenGroup'];
  activeRowId: string | undefined;
  selection: SelectionModel | null;
  /** The host's selected row ids (null without selection). */
  selected: ReadonlySet<string> | null;
  drag: DragModel | null;
  /** The rows being dragged (empty when no drag is on). */
  dragging: ReadonlySet<string>;
  /** The group a drag is over and its verdict. */
  drop: DropState | null;
  slots: RowSlots;
  groupActions: TaskGroupTableProps['groupActions'];
  rowWindows: RowWindows;
}

function Section({
  section,
  Heading,
  GroupHeading,
  baseId,
  columns,
  labels,
  collapsed,
  onToggle,
  onOpenRow,
  onOpenGroup,
  activeRowId,
  selection,
  selected,
  drag,
  dragging,
  drop,
  slots,
  groupActions,
  rowWindows,
}: SectionProps) {
  let count = 0;
  for (const group of section.groups) count += group.count ?? group.rows.length;
  const note = section.note ?? plural(count, 'issue', 'issues');
  return (
    <div className={styles.section} data-section-id={section.id}>
      {section.label !== undefined ? (
        <Heading className={styles.sectionRow}>
          <span className={styles.sectionLabel}>{section.label}</span>
          <span className={styles.sectionNote}>{note}</span>
        </Heading>
      ) : null}
      {section.groups.length === 0 ? (
        <p className={styles.emptyLine}>
          {section.emptyLabel ?? 'Nothing in this section'}
        </p>
      ) : null}
      {section.groups.map((group) => (
        <Group
          key={group.id}
          group={group}
          Heading={GroupHeading}
          listId={`${baseId}-${section.id}-${group.id}`}
          columns={columns}
          labels={labels}
          collapsed={collapsed.has(group.id)}
          onToggle={onToggle}
          onOpenRow={onOpenRow}
          onOpenGroup={onOpenGroup}
          activeRowId={activeRowId}
          selection={selection}
          selected={selected}
          drag={drag}
          dragging={dragging}
          drop={
            drop !== null && drop.groupId === group.id ? drop.verdict : null
          }
          slots={slots}
          groupActions={groupActions}
          rowWindow={rowWindows.segmentsOf(group.id)}
          registerList={rowWindows.registerList}
        />
      ))}
    </div>
  );
}

interface GroupProps {
  group: TaskGroupData;
  Heading: HeadingTag;
  listId: string;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  collapsed: boolean;
  onToggle: (group: TaskGroupData, shut: boolean) => void;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  onOpenGroup: TaskGroupTableProps['onOpenGroup'];
  activeRowId: string | undefined;
  selection: SelectionModel | null;
  selected: ReadonlySet<string> | null;
  drag: DragModel | null;
  dragging: ReadonlySet<string>;
  /** A drag over this group: whether it would take the rows (true) or
      why not; null when no drag is over it. */
  drop: true | string | null;
  slots: RowSlots;
  groupActions: TaskGroupTableProps['groupActions'];
  /** Which rows to mount and the gaps standing for the rest (windowed),
      or null to draw every row. */
  rowWindow: RowSegment[] | null;
  registerList: RowWindows['registerList'];
}

/** Whether the rows of `rows` are in `a` exactly when they are in `b`
    (the same set object, or both null, answers at once). */
function sameMembership(
  rows: readonly TaskRowData[],
  a: ReadonlySet<string> | null,
  b: ReadonlySet<string> | null
): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  return rows.every((row) => a.has(row.id) === b.has(row.id));
}

/**
 * React.memo's test for a group: every prop the same, except that the
 * selection, the dragged rows and the open row count only for this
 * group's own rows. A click that selects one row redraws its group's
 * header (its checkbox) and that row, not the other groups.
 */
function groupPropsEqual(prev: GroupProps, next: GroupProps): boolean {
  for (const key of Object.keys(next) as (keyof GroupProps)[]) {
    if (
      key === 'selected' ||
      key === 'dragging' ||
      key === 'activeRowId' ||
      key === 'rowWindow'
    ) {
      continue;
    }
    if (prev[key] !== next[key]) return false;
  }
  // A scroll that crosses no row edge hands the group an equal window.
  if (prev.rowWindow !== next.rowWindow) {
    if (prev.rowWindow === null || next.rowWindow === null) return false;
    if (!sameSegments(prev.rowWindow, next.rowWindow)) return false;
  }
  const rows = next.group.rows;
  const activeHere = (id: string | undefined) =>
    id !== undefined && rows.some((row) => row.id === id);
  return (
    sameMembership(rows, prev.selected, next.selected) &&
    sameMembership(rows, prev.dragging, next.dragging) &&
    (prev.activeRowId === next.activeRowId ||
      (!activeHere(prev.activeRowId) && !activeHere(next.activeRowId)))
  );
}

const Group = memo(function Group({
  group,
  Heading,
  listId,
  columns,
  labels,
  collapsed,
  onToggle,
  onOpenRow,
  onOpenGroup,
  activeRowId,
  selection,
  selected,
  drag,
  dragging,
  drop,
  slots,
  groupActions,
  rowWindow,
  registerList,
}: GroupProps) {
  const listRef = useCallback(
    (el: HTMLUListElement | null) => registerList(group.id, el),
    [registerList, group.id]
  );
  // The spoken name: a comma, not the visible "/", which screen readers
  // read out as punctuation ("slash").
  const name =
    group.eyebrow !== undefined && group.eyebrow !== ''
      ? `${group.eyebrow}, ${group.title}`
      : group.title;
  const countId = `${listId}-count`;
  // A muted group (an inactive project's milestone) is never loud: its
  // date carries no tone and its progress is the inactive grey.
  const muted = group.muted === true;
  const dueTone = muted ? 'default' : (group.dueTone ?? 'default');
  const dueToned = hasTextTone(dueTone);
  const count = group.count ?? group.rows.length;

  function onTitleClick(event: MouseEvent<HTMLAnchorElement>) {
    if (onOpenGroup === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onOpenGroup(group);
  }

  const title =
    group.href !== undefined ? (
      <Link
        href={group.href}
        className={styles.groupLink}
        onClick={onTitleClick}
      >
        {group.title}
      </Link>
    ) : onOpenGroup !== undefined ? (
      <button
        type="button"
        className={styles.groupLink}
        onClick={() => onOpenGroup(group)}
      >
        {group.title}
      </button>
    ) : (
      <span className={styles.groupTitle}>{group.title}</span>
    );

  let groupCheck: ReactNode = null;
  if (selection !== null) {
    const ids = group.rows.map((r) => r.id);
    const on = ids.filter((id) => selected?.has(id) === true).length;
    const all = ids.length > 0 && on === ids.length && !collapsed;
    groupCheck = (
      <span className={styles.groupLead}>
        <span className={styles.checkCell}>
          <Checkbox
            label={`Select the ${plural(ids.length, 'shown issue', 'shown issues')} in ${group.title}`}
            hideLabel
            checked={all}
            indeterminate={!all && on > 0}
            disabled={ids.length === 0}
            onChange={(next) => selection.setGroup(group, next)}
          />
        </span>
      </span>
    );
  } else if (drag !== null) {
    groupCheck = <span className={styles.groupLead} aria-hidden="true" />;
  }

  // A windowed row says its place among the group's rows (aria-posinset /
  // aria-setsize), since assistive tech cannot count rows that are not
  // mounted; a fully drawn list carries neither.
  const drawRow = (row: TaskRowData, position?: number, size?: number) => (
    <Row
      key={row.id}
      row={row}
      group={group}
      columns={columns}
      labels={labels}
      onOpenRow={onOpenRow}
      active={row.id === activeRowId}
      selection={selection}
      selected={selected?.has(row.id) === true}
      drag={drag}
      dragged={dragging.has(row.id)}
      slots={slots}
      position={position}
      size={size}
    />
  );

  return (
    <div
      className={cx(styles.group, collapsed ? styles.collapsed : undefined)}
      data-group-id={group.id}
      data-collapsed={collapsed}
      data-drop={drop === null ? undefined : drop === true ? 'ok' : 'no'}
      title={typeof drop === 'string' && drop !== '' ? drop : undefined}
      onDragOver={drag === null ? undefined : (e) => drag.over(e, group)}
      onDragLeave={drag === null ? undefined : (e) => drag.leave(e, group)}
      onDrop={drag === null ? undefined : (e) => drag.dropOn(e, group)}
    >
      <div
        className={styles.groupRow}
        data-nav-item="group"
        data-group-id={group.id}
      >
        {groupCheck}
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={!collapsed}
          aria-controls={listId}
          aria-label={name}
          aria-describedby={countId}
          data-nav-target=""
          onClick={() => onToggle(group, !collapsed)}
        >
          <ChevronRight
            className={styles.chevron}
            size={14}
            strokeWidth={1.8}
            aria-hidden="true"
          />
        </button>
        <Heading className={styles.groupHeading}>
          {group.status !== undefined ? (
            <StatusMark
              status={group.status}
              label={group.statusLabel ?? group.status}
              muted={muted}
            />
          ) : null}
          {group.mark !== undefined ? (
            <span className={styles.groupMark}>
              <PickerMarkView mark={group.mark} />
            </span>
          ) : null}
          {group.eyebrow !== undefined && group.eyebrow !== '' ? (
            <>
              <span className={styles.eyebrow}>{group.eyebrow}</span>
              <span className={styles.crumb} aria-hidden="true">
                /
              </span>
            </>
          ) : null}
          {title}
          {group.tags !== undefined && group.tags.length > 0 ? (
            <span className={styles.tags}>
              {group.tags.map((tag) => (
                <span key={tag} className={styles.tag}>
                  {tag}
                </span>
              ))}
            </span>
          ) : null}
          <span id={countId} className={styles.count}>
            {plural(count, 'issue', 'issues')}
          </span>
        </Heading>
        <div className={styles.groupMeta}>
          {typeof drop === 'string' && drop !== '' ? (
            <span className={styles.dropReason} role="status">
              {drop}
            </span>
          ) : null}
          {group.dueLabel !== undefined ? (
            <span
              className={cx(
                styles.groupDue,
                dueToned ? styles.toneText : undefined
              )}
              data-tone={dueTone}
            >
              <span className="srOnly">Due </span>
              {group.dueLabel}
              {group.daysLeftLabel !== undefined ? (
                <span className={styles.daysLeft}>{group.daysLeftLabel}</span>
              ) : null}
            </span>
          ) : null}
          {group.progress !== undefined ? (
            <span className={styles.groupProgress}>
              <ProgressRule
                done={group.progress.done}
                total={group.progress.total}
                tone={muted ? 'muted' : group.progress.tone}
                aria-label={`${group.title} progress`}
              />
            </span>
          ) : null}
        </div>
        {group.onAdd !== undefined && group.addLabel !== undefined ? (
          <span className={styles.groupAdd}>
            <Button
              variant="quiet"
              size="sm"
              icon={<Plus size={14} strokeWidth={1.8} />}
              aria-label={group.addLabel}
              title={group.addLabel}
              onClick={group.onAdd}
            />
          </span>
        ) : null}
        {groupActions !== undefined ? (
          <span className={styles.groupActions}>{groupActions(group)}</span>
        ) : null}
      </div>
      {group.missingLabel !== undefined && group.missingLabel !== '' ? (
        <p className={styles.missing}>{group.missingLabel}</p>
      ) : null}
      <ul
        ref={listRef}
        id={listId}
        className={styles.rows}
        hidden={collapsed}
        aria-label={name}
      >
        {collapsed
          ? null
          : rowWindow === null
            ? group.rows.map((row) => drawRow(row))
            : // One flat list keyed by row id (and a gap by its first row),
              // so a window that moves keeps every row it still draws.
              rowWindow.flatMap((segment) =>
                segment.kind === 'gap'
                  ? [
                      // The rows not mounted: their height, so the scroll
                      // range and every mounted row's place are as if they
                      // were.
                      <li
                        key={`gap-${segment.start}`}
                        className={styles.gap}
                        role="presentation"
                        aria-hidden="true"
                        data-row-gap={segment.end - segment.start}
                        style={{ height: segment.px }}
                      />,
                    ]
                  : group.rows
                      .slice(segment.start, segment.end)
                      .map((row, i) =>
                        drawRow(row, segment.start + i + 1, group.rows.length)
                      )
              )}
        {!collapsed && group.rows.length === 0 && group.footer === undefined ? (
          <li className={styles.emptyLine}>
            {group.emptyLabel ?? 'No open issues'}
          </li>
        ) : null}
        {!collapsed && group.footer !== undefined ? (
          <li className={styles.footer}>
            <span>{group.footer.text}</span>
            {group.footer.actions.map((action) => (
              <span key={action.label} className={styles.footerItem}>
                <span className={styles.footerDot} aria-hidden="true">
                  ·
                </span>
                <button
                  type="button"
                  className={styles.footerAction}
                  disabled={action.disabled}
                  onClick={action.onActivate}
                >
                  {action.label}
                </button>
              </span>
            ))}
          </li>
        ) : null}
      </ul>
    </div>
  );
}, groupPropsEqual);

interface RowProps {
  row: TaskRowData;
  group: TaskGroupData;
  columns: TaskColumnId[];
  labels: Record<TaskColumnId | 'title', string>;
  onOpenRow: TaskGroupTableProps['onOpenRow'];
  active: boolean;
  selection: SelectionModel | null;
  /** This row is in the host's selection. */
  selected: boolean;
  drag: DragModel | null;
  /** This row is being dragged. */
  dragged: boolean;
  slots: RowSlots;
  /** The row's 1-based place among its group's rows and their number, set
      only when the group is windowed (aria-posinset / aria-setsize). */
  position?: number;
  size?: number;
}

/** Whether two rows' chips say the same things (label, tone, filled), so a
    chips array an adapter rebuilds on every event counts as unchanged. */
function sameChips(
  a: readonly TaskChipData[] | undefined,
  b: readonly TaskChipData[] | undefined
): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.length !== b.length) return false;
  return a.every((chip, i) => {
    const other = b[i];
    return (
      other !== undefined &&
      chip.label === other.label &&
      chip.tone === other.tone &&
      chip.filled === other.filled
    );
  });
}

/** A row's field by name (TaskRowData is an interface, so it has no index
    signature of its own). */
function fieldOf(row: TaskRowData, key: string): unknown {
  return (row as unknown as Record<string, unknown>)[key];
}

/** Whether two TaskRowData say the same things: every field by identity
    except `chips` (sameChips) and `note` (text and tone), the two an
    adapter builds fresh each time. A field present on one side only is
    compared as undefined. About twenty comparisons per row, run only when
    the row's group redraws (its object changed). */
function sameRow(a: TaskRowData, b: TaskRowData): boolean {
  if (a === b) return true;
  const keys = new Set<string>([...Object.keys(a), ...Object.keys(b)]);
  for (const key of keys) {
    if (key === 'chips') {
      if (!sameChips(a.chips, b.chips)) return false;
    } else if (key === 'note') {
      if (
        a.note !== b.note &&
        (a.note === undefined ||
          b.note === undefined ||
          a.note.text !== b.note.text ||
          a.note.tone !== b.note.tone)
      ) {
        return false;
      }
    } else if (fieldOf(a, key) !== fieldOf(b, key)) {
      return false;
    }
  }
  return true;
}

/**
 * React.memo's test for a row: its data by value (sameRow), its group by
 * the two fields the row draws (id, and the eyebrow the project cell is
 * checked against), every other prop by identity. A host that rebuilds
 * its sections from scratch on each event (new groups, new row objects)
 * so redraws only the rows whose data changed; the callbacks it fires get
 * the current group through the table (currentGroup), never the one the
 * row last drew.
 */
function rowPropsEqual(prev: RowProps, next: RowProps): boolean {
  for (const key of Object.keys(next) as (keyof RowProps)[]) {
    if (key === 'row' || key === 'group') continue;
    if (prev[key] !== next[key]) return false;
  }
  return (
    prev.group.id === next.group.id &&
    prev.group.eyebrow === next.group.eyebrow &&
    sameRow(prev.row, next.row)
  );
}

/** One row; memoized, so it redraws only when its own props change
    (rowPropsEqual). */
const Row = memo(function Row({
  row,
  group,
  columns,
  labels,
  onOpenRow,
  active,
  selection,
  selected,
  drag,
  dragged,
  slots,
  position,
  size,
}: RowProps) {
  const external = row.external === true;
  // Under a Project / Milestone heading the project cell repeats the
  // heading; phones drop it so the meta fits one line.
  const projectRepeatsHeading =
    row.project !== undefined && row.project === group.eyebrow;
  const isSelected = selection !== null && selected;
  const tapToggles = selection !== null && selection.toggleOnClick;
  const title =
    row.externalHref === undefined ? row.title : gluedTitle(row.title);

  function onClick(event: MouseEvent<HTMLAnchorElement | HTMLButtonElement>) {
    if (onOpenRow === undefined || !isPlainClick(event)) return;
    event.preventDefault();
    onOpenRow(row, group);
  }

  // In touch Select mode a tap on the title toggles the row, so it is
  // drawn (and named to assistive tech) as what it does: a checkbox with
  // the title as its name and the selection as its state, not a link
  // that would not open. A native input, visually hidden inside the
  // title's label (the row-wide click target), so Space toggles it and
  // forms and assistive tech see a real checkbox; it stays the row's
  // focus target (focusTargetOf).
  const primary =
    tapToggles && selection !== null ? (
      <label className={styles.titleLink}>
        <input
          type="checkbox"
          className={styles.titleToggle}
          checked={isSelected}
          onChange={() => selection.toggleRow(row.id, false)}
        />
        {title}
      </label>
    ) : row.href !== undefined ? (
      <Link
        href={row.href}
        className={styles.titleLink}
        onClick={onClick}
        target={external ? '_blank' : undefined}
        rel={external ? 'noreferrer noopener' : undefined}
      >
        {title}
        {external ? (
          <>
            <ArrowUpRight
              className={styles.externalGlyph}
              size={12}
              strokeWidth={1.8}
              aria-hidden="true"
            />
            <span className="srOnly"> (opens in a new tab)</span>
          </>
        ) : null}
      </Link>
    ) : (
      <button
        type="button"
        className={styles.titleLink}
        onClick={() => {
          onOpenRow?.(row, group);
        }}
      >
        {title}
      </button>
    );

  const onContextMenu = slots.onRowContextMenu;
  const isDragged = drag !== null && dragged;

  return (
    <li
      className={styles.row}
      data-nav-item="row"
      data-group-id={group.id}
      data-row-id={row.id}
      aria-current={active ? 'true' : undefined}
      aria-posinset={position}
      aria-setsize={size}
      aria-busy={row.pending === true ? 'true' : undefined}
      data-selected={isSelected ? 'true' : undefined}
      data-pending={row.pending === true ? 'true' : undefined}
      data-done={row.done === true ? 'true' : undefined}
      data-dragged={isDragged ? 'true' : undefined}
      data-indent={
        row.indent !== undefined && row.indent > 0 ? row.indent : undefined
      }
      onContextMenu={
        onContextMenu === undefined
          ? undefined
          : (event) => {
              const target = event.target as HTMLElement;
              if (isHostControlEvent(target)) return;
              onContextMenu(event, row, group);
            }
      }
    >
      {drag !== null ? (
        <div className={styles.gripCell}>
          <span
            className={styles.grip}
            aria-hidden="true"
            draggable={drag.draggable ? true : undefined}
            data-draggable={drag.draggable ? 'true' : undefined}
            onDragStart={drag.draggable ? (e) => drag.start(e, row) : undefined}
            onDragEnd={drag.draggable ? () => drag.end() : undefined}
          >
            <GripVertical size={14} strokeWidth={1.8} aria-hidden="true" />
          </span>
        </div>
      ) : null}
      {selection !== null ? (
        <div className={styles.checkCell}>
          <ShiftAwareCheckbox
            label={`Select ${row.key}`}
            checked={isSelected}
            onToggle={(shift) => selection.toggleRow(row.id, shift)}
          />
        </div>
      ) : null}
      <div className={styles.titleCell}>
        <span className={styles.key}>{row.key}</span>
        <span className={styles.titleWrap}>
          {row.externalHref === undefined ? (
            <span className={styles.titleText} data-nav-target="">
              {primary}
            </span>
          ) : (
            // The title and its ↗ in one no-wrap run (the words before
            // the title's last one still wrap: gluedTitle): CSS always
            // lets a line break before an atomic inline such as the ↗'s
            // box, so a word joiner could not keep the ↗ from falling
            // alone onto a line of its own when the last word just fitted.
            <span className={styles.titleRun}>
              <span className={styles.titleText} data-nav-target="">
                {primary}
              </span>
              <Link
                href={row.externalHref}
                className={styles.linkOut}
                target="_blank"
                rel="noreferrer noopener"
                aria-label={row.externalLabel ?? `Open ${row.key} in a new tab`}
                title={row.externalLabel ?? `Open ${row.key} in a new tab`}
              >
                <ArrowUpRight size={13} strokeWidth={1.8} aria-hidden="true" />
              </Link>
            </span>
          )}
          {row.chips !== undefined && row.chips.length > 0 ? (
            <span className={styles.chips}>
              {row.chips.map((chip) => (
                <Chip
                  key={chip.label}
                  tone={chip.tone ?? 'default'}
                  filled={chip.filled}
                >
                  {chip.label}
                </Chip>
              ))}
            </span>
          ) : null}
          {row.note !== undefined && row.note.text !== '' ? (
            <span
              className={styles.note}
              data-tone={row.note.tone ?? 'default'}
            >
              {row.note.text}
            </span>
          ) : null}
        </span>
      </div>
      {columns.map((column) => {
        const custom = slots.renderCell?.(column, row, group);
        if (custom !== undefined) {
          return (
            <div
              key={column}
              className={styles.cell}
              data-column={column}
              data-control=""
              data-repeats-heading={
                column === 'project' && projectRepeatsHeading ? '' : undefined
              }
            >
              {custom}
            </div>
          );
        }
        return (
          <div
            key={column}
            className={styles.cell}
            data-column={column}
            data-repeats-heading={
              column === 'project' && projectRepeatsHeading ? '' : undefined
            }
          >
            <span className="srOnly">{labels[column]}: </span>
            <CellValue row={row} column={column} />
          </div>
        );
      })}
      {slots.rowActions !== undefined ? (
        <div className={styles.actionsCell}>{slots.rowActions(row, group)}</div>
      ) : null}
    </li>
  );
}, rowPropsEqual);

/** The longest last word a title glues to its ↗ (a longer one wraps
    on its own rather than overflow the row). */
const GLUE_MAX = 24;

/**
 * A title whose last word cannot be parted from the ↗ link after it. The
 * row's title run is no-wrap (so no break opens before the ↗'s box, which
 * CSS otherwise always allows before an atomic inline, whatever joiner
 * precedes it); the words before the last sit in a span that wraps again.
 */
function gluedTitle(text: string): ReactNode {
  const cut = text.lastIndexOf(' ');
  const tail = text.slice(cut + 1);
  if (tail === '' || tail.length > GLUE_MAX) {
    return <span className={styles.titleHead}>{text}</span>;
  }
  return (
    <>
      {cut < 0 ? null : (
        <span className={styles.titleHead}>{text.slice(0, cut + 1)}</span>
      )}
      <span className={styles.titleTail}>{tail}</span>
    </>
  );
}

/** A row's checkbox that knows whether shift was held: Checkbox reports
    only the new state, so the click's modifier is read on the way in
    (capture phase, before the input's change). */
function ShiftAwareCheckbox({
  label,
  checked,
  onToggle,
}: {
  label: string;
  checked: boolean;
  onToggle: (shift: boolean) => void;
}) {
  const shiftRef = useRef(false);
  return (
    <span
      className={styles.checkWrap}
      onClickCapture={(event) => {
        shiftRef.current = event.shiftKey;
      }}
    >
      <Checkbox
        label={label}
        hideLabel
        checked={checked}
        onChange={() => {
          const shift = shiftRef.current;
          shiftRef.current = false;
          onToggle(shift);
        }}
      />
    </span>
  );
}

function CellValue({
  row,
  column,
}: {
  row: TaskRowData;
  column: TaskColumnId;
}) {
  switch (column) {
    case 'project':
      // Gr8r's project chip: a dot in the name's decorative hue (the
      // avatars' hues, never a status hue), then the name.
      return row.project === undefined || row.project === '' ? (
        <span className={styles.project}>—</span>
      ) : (
        <span className={styles.project}>
          <span
            className={styles.projectDot}
            style={
              {
                '--project-hue': `var(--${avatarHue(row.project)})`,
              } as CSSProperties
            }
            aria-hidden="true"
          />
          <span className={styles.projectName}>{row.project}</span>
        </span>
      );
    case 'state':
      return (
        <span className={styles.glyphValue} data-state={row.stateKind}>
          <StateGlyph kind={row.stateKind} />
          <span className={styles.metaText}>{row.state}</span>
        </span>
      );
    case 'priority':
      return (
        <span
          className={cx(
            styles.glyphValue,
            row.priority === 1 ? styles.urgentText : undefined
          )}
          data-priority={row.priority}
        >
          <PriorityGlyph priority={row.priority} />
          <span className={styles.metaText}>{row.priorityLabel}</span>
        </span>
      );
    case 'due': {
      const dueClass = cx(
        styles.metaText,
        hasTextTone(row.dueTone) ? styles.toneText : undefined,
        row.dueTone === 'muted' ? styles.mutedText : undefined
      );
      const tone = row.dueTone ?? 'default';
      const date = (
        <span className={dueClass} data-tone={tone}>
          {row.due ?? '—'}
        </span>
      );
      // "Oct 21" over "Overdue": the word says what the hue says.
      return row.due === undefined || row.dueNote === undefined ? (
        date
      ) : (
        <span className={styles.dueValue}>
          {date}
          <span className={dueClass} data-tone={tone}>
            {row.dueNote}
          </span>
        </span>
      );
    }
    case 'assignee': {
      const name = row.assignee ?? '';
      // Gr8r's round avatar; nobody is the dashed empty one, beside
      // "Unassigned" (or the row's own words for it) in its tone.
      return name === '' ? (
        <span className={styles.person} data-tone={row.assigneeTone ?? 'muted'}>
          <InitialsAvatar name="" />
          <span className={styles.personName}>
            {row.unassignedLabel ?? 'Unassigned'}
          </span>
        </span>
      ) : (
        <span className={styles.person}>
          <InitialsAvatar name={name} />
          <span className={styles.personName}>{name}</span>
        </span>
      );
    }
    case 'milestone': {
      const milestone = row.milestone ?? '';
      const project = row.milestoneProject ?? '';
      if (milestone === '') {
        return (
          <span className={styles.milestone} data-tone="muted">
            No milestone
          </span>
        );
      }
      // The name keeps its room; the project after it is cut first.
      return (
        <span
          className={styles.milestone}
          title={project === '' ? milestone : `${project} › ${milestone}`}
        >
          <span className={styles.milestoneName}>{milestone}</span>
          {project !== '' ? (
            <span className={styles.milestoneProject}> · {project}</span>
          ) : null}
        </span>
      );
    }
  }
}
