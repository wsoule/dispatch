import type {
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch-foo/core/browser';
import type {
  MergeQueueEntryState,
  MilestoneProgress,
  ReadinessReading,
  RunMeta,
  RunState,
} from '@dispatch/client';
import {
  Button,
  cx,
  Menu,
  type MenuEntry,
  type RowSegment,
  type RowWindowGroup,
  type RowWindows,
  useElementWidth,
  useRowWindows,
} from '@dispatch/ui';
import {
  DndContext,
  type DragEndEvent,
  DragOverlay,
  type DragStartEvent,
  KeyboardSensor,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { CSS } from '@dnd-kit/utilities';
import {
  ChevronsLeftRight,
  ChevronsRightLeft,
  Ellipsis,
  EyeOff,
  Play,
  Plus,
} from 'lucide-react';
import {
  type ComponentProps,
  memo,
  type ReactNode,
  startTransition,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { boardCollision } from '../../lib/boardCollision';
import {
  type FlingTracker,
  NEVER_FLINGING,
  trackFling,
} from '../../lib/boardFling';
import {
  type BoardLane,
  countLaneStatuses,
  dropZoneId,
  groupTasksByLane,
  statusFromDropZoneId,
} from '../../lib/boardGrouping';
import type { WorkMilestoneOptions } from '../../lib/milestoneSession';
import { useActiveStatusModel } from '../../lib/statusModel';
import type { TaskAttention } from '../../lib/taskAttention';
import { statusLabel } from '../../lib/taskDisplay';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../../lib/tasksPrefs';
import { useShellActions } from '../shell/ShellActionsContext';
import { nearColumnIndexes, sameColumnIndexes } from './boardWindow';
import { LaneHeader } from './LaneHeader';
import { MilestoneLaneHeader } from './MilestoneLaneHeader';
import { StatusIcon } from './StatusIcon';
import styles from './TaskBoard.module.css';
import { TaskCardTile } from './TaskCardTile';

interface TaskBoardProps {
  /** The cards, already in the order a column shows them (`BoardPane` sorts once with
   * `sortTasks` so its j/k cursor and these columns walk the same sequence). */
  tasks: TaskListItem[];
  /** The status columns to render, in config order — already narrowed by the Display
   * popover's `Show empty groups` and any session-hidden columns (see `visibleBoardColumns`). */
  statuses: string[];
  /** Every status a card's status menu offers: the project's whole configured list, so a
   * card can move to a status whose column is hidden (empty with `Show empty groups` off,
   * or hidden this session). Defaults to `statuses`. */
  cardStatuses?: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  /** Live (non-terminal) run state per task id. */
  liveRunStateByTaskId: Map<string, RunState>;
  /** Each task's latest run, if any — feeds the card's run mark and merge-ladder pill. */
  latestRunByTaskId: Map<string, RunMeta>;
  /** Tasks whose latest run needs a human right now (see `deriveTaskAttentionById`) —
   * those cards carry a `Needs you` pill. Optional so a board rendered without live run
   * data simply shows none. */
  attentionByTaskId?: ReadonlyMap<string, TaskAttention>;
  /** Tasks whose run is in the merge queue, with the entry's state — a `Landing` pill. */
  landingByTaskId?: ReadonlyMap<string, MergeQueueEntryState>;
  /** Milestone dispatch progress per milestone id, once fetched. */
  /** Readiness readings per task id (see `useDispatchProject`); a card with none shows no pill. */
  readinessById?: ReadonlyMap<string, ReadinessReading>;
  milestoneProgressById: Map<string, MilestoneProgress>;
  /** Default concurrency for a fresh milestone dispatch session (config's `orchestrator.milestoneConcurrency`). */
  milestoneConcurrencyDefault: number;
  /** Every milestone in the project — one lane per milestone that has children, in this order. */
  milestones: TaskListItem[];
  /** The project's statuses, which roll each milestone lane up; defaults to the open project's.
   * A caller holding config passes its model, which is right in the render config lands. */
  statusModel?: StatusModel;
  /** The Display popover's model — the card properties, and `subGrouping` for the swim
   * lanes (`none` is the flat board with a milestone crumb on each card). Defaults to
   * `DEFAULT_TASKS_DISPLAY`; the ordering is applied by the caller (see `tasks`). */
  display?: TasksDisplayPrefs;
  /** Lane keys (`BoardLane.key`) folded up right now. */
  collapsedLaneKeys: ReadonlySet<string>;
  /** Flips one lane between expanded and collapsed — owned by `BoardPane`, which also needs the
   * collapsed set to keep j/k off hidden cards. */
  onToggleLane: (key: string) => void;
  /** Statuses whose column is folded to a narrow strip (a column's `···` › Collapse). */
  collapsedColumns?: ReadonlySet<string>;
  onToggleColumnCollapsed?: (status: string) => void;
  /** A column's `···` › Hide column. */
  onHideColumn?: (status: string) => void;
  /** How many columns are hidden this session, and the way back: a ghost pill at the end
   * of the header row. */
  hiddenColumnCount?: number;
  onShowHiddenColumns?: () => void;
  /** Routes milestone dispatch through a confirmation preview. See MilestoneLaneHeader. */
  onRequestWorkMilestone?: (milestoneId: string) => void;
  onSelect: (id: string) => void;
  /** Dispatches a plain (non-milestone) task from its card's Dispatch action, and every ready
   * task in a column from the column's `···` › Dispatch all ready. Optional — omitting it
   * hides both. */
  onDispatch?: (taskId: string) => Promise<void>;
  /** The lane header's direct dispatch path — a session at the picker's concurrency. */
  onWorkMilestone: (
    milestoneId: string,
    opts: WorkMilestoneOptions
  ) => Promise<void>;
  /** Pause/Resume/Raise ceiling… on a lane with a session; a header without them shows
   * only Stop. See MilestoneLaneHeader. */
  onPauseMilestone?: (milestoneId: string) => Promise<void>;
  onResumeMilestone?: (milestoneId: string) => Promise<void>;
  onRaiseCeilingMilestone?: (milestoneId: string) => void;
  onStopMilestone: (milestoneId: string) => Promise<void>;
  /** Lands a finished milestone branch on the default base — see MilestoneLaneHeader's Land button.
   * Optional for the same reason as `onDispatch`. */
  onLandMilestone?: (milestoneId: string) => Promise<void>;
  /** Moves a task to a different status — wired to the drag-and-drop drop handler below (and
   * the card's status picker); optional so a board rendered without a live project doesn't
   * need to supply a no-op. */
  onMoveStatus?: (taskId: string, status: string) => Promise<void>;
  /** Edits a task's priority/assignee inline from its card. Optional for the same reason
   * as `onMoveStatus`. */
  onEditTask?: (taskId: string, patch: UpdatePatch) => Promise<void>;
  /** Id of the card the Board's j/k roving-focus cursor is currently on, if any. */
  focusedTaskId?: string | null;
  /** Ids of tasks appended to `tasks` because Display › Show archived is on — these cards
   * render dimmed and can't be dragged. Defaults to empty. */
  archivedTaskIds?: ReadonlySet<string>;
  /** Called whenever real DOM focus lands on any card (click, Tab, or the roving-focus
   * effect) — lets `BoardPane` sync `focusedTaskId` to wherever focus actually is. */
  onCardFocus?: (taskId: string) => void;
}

// Stable empty-set defaults — no fresh `Set` per render for the common case.
const NO_IDS: ReadonlySet<string> = new Set();
const noop = () => {};
// One object for every render: fresh options make new sensors, and new sensors hand every
// card new drag listeners, so each board render (a cursor move, a dispatch) redrew them all.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };

// The column geometry (348px columns with 12px of padding either side so the 322px card sits
// on the 324px inner width, the 44px collapsed strip, the sticky lane headers) lives in
// TaskBoard.module.css.
const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

// A card before it is measured — the skeleton's 104px tile.
const CARD_ESTIMATE = 104;
// The space under each card: padding inside its `<li>`, so the height `useRowWindows`
// measures (the li's border box) includes it.
const CARD_GAP = 8;
// What one card's row takes before any is measured: the card plus the space under it.
const ROW_ESTIMATE = CARD_ESTIMATE + CARD_GAP;
// Cards kept mounted past each edge of the board's viewport. The library default (8) is
// sized for 55px list rows and would keep about 1,100px of ~138px cards on each side of
// every column. Two is enough (the old react-virtual board kept three): a scroll renders
// its new cards inside the scroll event (`flushOnScroll`), so the overscan is not what
// keeps a column from painting blank, and the 2,000-task board stays under the old
// board's DOM size.
const CARD_OVERSCAN = 2;

// How far past each side of the board's visible width a column still counts as near, as a
// share of that width: a column's cards mount this far before it scrolls into view.
const NEAR_COLUMN_MARGIN = 0.5;

/**
 * The board's columns near its horizontal viewport, by index (`nearColumnIndexes`). A column
 * off to the side is an `offscreen` row-window group: it keeps its height and its pinned
 * cards but mounts no others, so a vertical scroll mounts cards only in the columns in and
 * beside the window (five of seven on a 1440px window). A column comes near in a
 * transition, so a sideways scroll mounts its cards without holding up a frame.
 */
function useNearColumns(
  board: HTMLDivElement | null,
  stack: HTMLDivElement | null,
  columnSignature: string
): ReadonlySet<number> | null {
  const [near, setNear] = useState<ReadonlySet<number> | null>(null);
  useLayoutEffect(() => {
    if (board === null || stack === null) return;
    // Each column's span in the board's scrolled content; every lane shares them.
    let spans: (readonly [number, number])[] = [];
    let width = 0;
    let current: ReadonlySet<number> | null = null;
    const measure = () => {
      width = board.clientWidth;
      const row = stack.querySelector<HTMLElement>('[data-lane-columns]');
      const origin = board.getBoundingClientRect().left - board.scrollLeft;
      spans =
        row === null
          ? []
          : Array.from(row.children, (column) => {
              const rect = column.getBoundingClientRect();
              return [rect.left - origin, rect.right - origin] as const;
            });
    };
    const update = (urgent: boolean) => {
      const next = nearColumnIndexes(
        spans,
        board.scrollLeft,
        width,
        NEAR_COLUMN_MARGIN
      );
      if (sameColumnIndexes(current, next)) return;
      current = next;
      if (urgent) setNear(next);
      else startTransition(() => setNear(next));
    };
    measure();
    update(true);
    const onScroll = () => update(false);
    board.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(() => {
      measure();
      update(false);
    });
    observer.observe(board);
    observer.observe(stack);
    return () => {
      board.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [board, stack, columnSignature]);
  return near;
}

/** The board's fling tracker: placeholders while its scroller flings (see `boardFling`). */
function useBoardFling(board: HTMLDivElement | null): FlingTracker {
  const [tracker, setTracker] = useState<FlingTracker>(NEVER_FLINGING);
  useEffect(() => {
    if (board === null) return;
    const { tracker: next, dispose } = trackFling(board);
    setTracker(next);
    return () => {
      dispose();
      setTracker(NEVER_FLINGING);
    };
  }, [board]);
  return tracker;
}

// A fling's stand-in for a card: the tile's surface at the card's last measured height.
function CardPlaceholder({ height }: { height: number }) {
  return (
    <div
      aria-hidden
      data-slot="task-card-placeholder"
      className={styles.placeholder}
      style={{ height }}
    />
  );
}

/**
 * A card that mounts as a placeholder while the board flings and turns real once the fling
 * settles, in a transition so a new fling can interrupt it. A card that mounted real stays
 * real, and the cursor's or the dragged card (`eager`) never waits. A real card records its
 * height (`DraggableCard`, on its own node: no wrapper element per card) so a placeholder
 * for one seen before keeps its size.
 */
function LazyCard({
  id,
  fling,
  eager,
  heights,
  children,
}: {
  id: string;
  fling: FlingTracker;
  eager: boolean;
  heights: Map<string, number>;
  children: ReactNode;
}) {
  const [real, setReal] = useState(() => eager || !fling.isFlinging());
  const show = real || eager;
  useEffect(() => {
    if (show) return;
    const fill = () => startTransition(() => setReal(true));
    if (!fling.isFlinging()) {
      fill();
      return;
    }
    return fling.onSettle(fill);
  }, [show, fling]);
  if (!show) {
    return <CardPlaceholder height={heights.get(id) ?? CARD_ESTIMATE} />;
  }
  return children;
}

// A card's draggable id doubles as its task id — plain `useDraggable`, not `useSortable`,
// since the board never persists intra-column order, only which column (status) a card sits
// in. This wrapper is the one place that calls the hook, so `TaskCardTile` stays ignorant of
// @dnd-kit beyond the small `CardDragProps` shape it already accepts.
function DraggableCard({
  id,
  disabled = false,
  heights,
  children,
}: {
  id: string;
  /** True for an archived card — `useDraggable`'s own `disabled`, so it never lifts. */
  disabled?: boolean;
  /** Each card's last measured height by task id: this card's goes in when it mounts. */
  heights: Map<string, number>;
  children: (drag: {
    setNodeRef: (node: HTMLElement | null) => void;
    style: React.CSSProperties | undefined;
    attributes: ReturnType<typeof useDraggable>['attributes'];
    listeners: ReturnType<typeof useDraggable>['listeners'];
    isDragging: boolean;
  }) => React.ReactNode;
}) {
  const { attributes, listeners, setNodeRef, transform, isDragging } =
    useDraggable({ id, disabled });
  // The card's node goes to dnd-kit and its height to the fling placeholders.
  const setCardNode = useCallback(
    (node: HTMLElement | null) => {
      setNodeRef(node);
      if (node !== null) heights.set(id, node.offsetHeight);
    },
    [setNodeRef, heights, id]
  );
  // Memoized so an idle card's `drag` prop keeps its identity and the memo'd tile skips.
  const drag = useMemo(
    () => ({
      setNodeRef: setCardNode,
      style: transform
        ? { transform: CSS.Translate.toString(transform) }
        : undefined,
      attributes,
      listeners,
      isDragging,
    }),
    [setCardNode, transform, attributes, listeners, isDragging]
  );
  return children(drag);
}

// A draggable card as one memoized unit, so a scroll that re-renders the board skips every
// card whose props did not change (the tile alone is memoized, not its drag wrapper).
const BoardCard = memo(function BoardCard({
  disabled,
  heights,
  ...tile
}: Omit<ComponentProps<typeof TaskCardTile>, 'drag'> & {
  disabled: boolean;
  heights: Map<string, number>;
}) {
  return (
    <DraggableCard id={tile.doc.meta.id} disabled={disabled} heights={heights}>
      {(drag) => <TaskCardTile {...tile} drag={drag} />}
    </DraggableCard>
  );
});

/**
 * One lane+status cell's card list, droppable by the composite id `dropZoneId` builds (never
 * the bare status — see that helper for why) and registered with the board's one
 * `useRowWindows` under the same id. Only the cards its window holds mount, each in an
 * `<li data-row-id>` whose padding is the space under the card (so the measured height
 * includes it); the cards it skips stand as spacer items of their height. No background and
 * no ring: the only drag-over cue is the hover wash.
 */
const BoardCell = memo(function BoardCell({
  id,
  tasks,
  segments,
  registerList,
  parentLane,
  renderCard,
}: {
  id: string;
  tasks: readonly TaskListItem[];
  /** The cell's window; `null` mounts every card (windowing off). The same array while the
   * window stands, so a scroll redraws only the cells it moved (the cell is memoized). */
  segments: RowSegment[] | null;
  registerList: RowWindows['registerList'];
  /** True in a milestone lane, whose heading already names the milestone (no crumb). */
  parentLane: boolean;
  renderCard: (doc: TaskListItem, parentLane: boolean) => ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  const ref = useCallback(
    (el: HTMLUListElement | null) => {
      setNodeRef(el);
      registerList(id, el);
    },
    [setNodeRef, registerList, id]
  );
  const drawCard = (doc: TaskListItem) => (
    <li key={doc.meta.id} data-row-id={doc.meta.id} className={styles.cardItem}>
      {renderCard(doc, parentLane)}
    </li>
  );
  return (
    <ul
      ref={ref}
      data-over={isOver}
      data-slot="board-column"
      className={styles.cell}
    >
      {segments === null
        ? tasks.map(drawCard)
        : segments.flatMap((segment) =>
            segment.kind === 'gap'
              ? [
                  // The cards not mounted: their height, so the scroll range and every
                  // mounted card's place are as if they were.
                  <li
                    key={`gap-${segment.start}`}
                    role="presentation"
                    aria-hidden="true"
                    className={styles.gap}
                    style={{ height: segment.px }}
                  />,
                ]
              : tasks.slice(segment.start, segment.end).map(drawCard)
          )}
    </ul>
  );
});

// A column's 44px header: 14px glyph, the name in the secondary ink, plain count, then the
// options menu and `+`.
function ColumnHeader({
  status,
  count,
  readyCount,
  collapsed,
  onToggleCollapsed,
  onHide,
  onDispatchAll,
  onAdd,
}: {
  status: string;
  count: number;
  readyCount: number;
  collapsed: boolean;
  onToggleCollapsed?: () => void;
  onHide?: () => void;
  onDispatchAll?: () => void;
  onAdd: () => void;
}) {
  const label = statusLabel(status);
  if (collapsed) {
    return (
      <div
        data-slot="board-column-header"
        data-collapsed="true"
        className={cx(styles.columnHeader, styles.collapsedColumn)}
      >
        <Button
          variant="quiet"
          size="sm"
          aria-label={`Expand ${label} column`}
          onClick={onToggleCollapsed}
          icon={<StatusIcon status={status} />}
        />
        <span className={styles.stripName}>{label}</span>
        <span className={styles.count}>{count}</span>
      </div>
    );
  }
  const items: MenuEntry[] = [
    {
      id: 'collapse',
      label: 'Collapse column',
      icon: <ChevronsRightLeft {...ICON} />,
      disabled: onToggleCollapsed === undefined,
      onSelect: () => onToggleCollapsed?.(),
    },
    {
      id: 'hide',
      label: 'Hide column',
      icon: <EyeOff {...ICON} />,
      disabled: onHide === undefined,
      onSelect: () => onHide?.(),
    },
    {
      id: 'dispatch-all',
      label: `Dispatch all ready${readyCount > 0 ? ` (${readyCount})` : ''}`,
      icon: <Play {...ICON} />,
      disabled: onDispatchAll === undefined || readyCount === 0,
      onSelect: () => onDispatchAll?.(),
    },
  ];
  return (
    <div
      data-slot="board-column-header"
      className={cx(styles.columnHeader, styles.column)}
    >
      <StatusIcon status={status} />
      <span className={styles.columnName}>{label}</span>
      <span className={styles.count}>{count}</span>
      <span className={styles.spacer} />
      <Menu
        label={`${label} column`}
        items={items}
        align="end"
        trigger={(props) => (
          <Button
            {...props}
            variant="quiet"
            size="sm"
            aria-label={`${label} column options`}
            icon={<Ellipsis {...ICON} />}
          />
        )}
      />
      <Button
        variant="quiet"
        size="sm"
        aria-label={`New task in ${status}`}
        onClick={onAdd}
        icon={<Plus {...ICON} />}
      />
    </div>
  );
}

/**
 * The board (§5): status columns 348px wide sitting directly on the panel, a shared 44px
 * header row that sticks to the top, and — under Display › Sub-grouping — one swim lane
 * per milestone (`MilestoneLaneHeader`), assignee or priority (`LaneHeader`) over its own set of
 * columns. Columns come from the project's own `.dispatch/config.yml` order, never a
 * hardcoded status list (the lane split itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByLane`).
 *
 * Milestones are containers rather than cards — they head a lane instead of sitting in a status
 * column, so only plain tasks are ever dragged. A `PointerSensor` with a 6px activation
 * distance keeps an ordinary click opening the peek (only real pointer travel lifts a
 * card), plus a `KeyboardSensor` for accessible drag. Dropping onto a different column
 * calls `onMoveStatus`; `DragOverlay` renders a lifted copy so the original fades in place.
 */
export function TaskBoard({
  tasks,
  statuses,
  cardStatuses = statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  latestRunByTaskId,
  attentionByTaskId,
  landingByTaskId,
  milestoneProgressById,
  readinessById,
  milestoneConcurrencyDefault,
  milestones,
  statusModel,
  display = DEFAULT_TASKS_DISPLAY,
  collapsedLaneKeys,
  onToggleLane,
  collapsedColumns = NO_IDS,
  onToggleColumnCollapsed,
  onHideColumn,
  hiddenColumnCount = 0,
  onShowHiddenColumns,
  onRequestWorkMilestone,
  onSelect,
  onDispatch,
  onWorkMilestone,
  onPauseMilestone,
  onResumeMilestone,
  onRaiseCeilingMilestone,
  onStopMilestone,
  onLandMilestone,
  onMoveStatus,
  onEditTask,
  focusedTaskId = null,
  onCardFocus,
  archivedTaskIds = NO_IDS,
}: TaskBoardProps) {
  const shell = useShellActions();
  const activeModel = useActiveStatusModel();
  const model = statusModel ?? activeModel;
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);
  // The scroller as a ref (the row windows read it from their first layout effect) and as
  // state (the width, fling and near-column hooks subscribe once it exists); the lanes'
  // stack as state, for the near-column spans.
  const boardRef = useRef<HTMLDivElement | null>(null);
  const [board, setBoard] = useState<HTMLDivElement | null>(null);
  const attachBoard = useCallback((node: HTMLDivElement | null) => {
    boardRef.current = node;
    setBoard(node);
  }, []);
  const columnHeadRef = useRef<HTMLDivElement | null>(null);
  const [laneStack, setLaneStack] = useState<HTMLDivElement | null>(null);
  // The board's visible width (its `clientWidth`, less its own scrollbar), which the sticky
  // lane headers take. `null` until the observer's first callback, so a render that never
  // lays out (tests) sets no inline width and each header simply spans its lane.
  const viewportWidth = useElementWidth(board);
  const fling = useBoardFling(board);
  // Each card's last measured height, by task id — what its fling placeholder takes.
  const [cardHeights] = useState(() => new Map<string, number>());

  // The same lanes `BoardPane` derives for its j/k order, from the same pure function and the
  // same (pre-sorted) input — deliberately recomputed here rather than passed down, so the two
  // never have to be kept in sync as a pair of props that could disagree.
  const lanes = useMemo<BoardLane[]>(
    () => groupTasksByLane(tasks, statuses, milestones, display.subGrouping),
    [tasks, statuses, milestones, display.subGrouping]
  );
  const statusCounts = useMemo(
    () => countLaneStatuses(lanes, statuses),
    [lanes, statuses]
  );
  const nearColumns = useNearColumns(
    board,
    laneStack,
    `${statuses.join('\0')}|${[...collapsedColumns].join('\0')}`
  );
  // Ready task ids per status, for `Dispatch all ready` and its count.
  const readyByStatus = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const lane of lanes) {
      for (const column of lane.columns) {
        const ids = map.get(column.status) ?? [];
        for (const doc of column.tasks) {
          if (readyIds.has(doc.meta.id) && !archivedTaskIds.has(doc.meta.id)) {
            ids.push(doc.meta.id);
          }
        }
        map.set(column.status, ids);
      }
    }
    return map;
  }, [lanes, readyIds, archivedTaskIds]);

  const milestoneById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const milestone of milestones) map.set(milestone.meta.id, milestone);
    return map;
  }, [milestones]);

  const taskById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const doc of tasks) map.set(doc.meta.id, doc);
    return map;
  }, [tasks]);

  // Every label the board's tasks use — the vocabulary a card's label picker offers. Keyed
  // on its contents, so an edit that adds no label keeps the array (and the cards) as is.
  const labelKey = useMemo(
    () => [...new Set(tasks.flatMap((t) => t.meta.labels))].sort().join('\0'),
    [tasks]
  );
  const labelCatalogue = useMemo(
    () => (labelKey === '' ? [] : labelKey.split('\0')),
    [labelKey]
  );

  // Stable, id-based card callbacks so the memo'd tiles skip unrelated renders.
  const moveCardStatus = useCallback(
    (id: string, next: string) => void onMoveStatus?.(id, next),
    [onMoveStatus]
  );
  const editCard = useCallback(
    (id: string, patch: UpdatePatch) => void onEditTask?.(id, patch),
    [onEditTask]
  );

  // Every milestone's children, bucketed in one pass — feeds `MilestoneLaneHeader`'s rolled-up status
  // and dependency-graph modal, which need the milestone's own children, not the whole project.
  const childrenByMilestoneId = useMemo(() => {
    const map = new Map<string, TaskListItem[]>();
    for (const doc of tasks) {
      if (doc.meta.parent === null) continue;
      const bucket = map.get(doc.meta.parent);
      if (bucket !== undefined) bucket.push(doc);
      else map.set(doc.meta.parent, [doc]);
    }
    return map;
  }, [tasks]);

  // ---- row windows ------------------------------------------------------
  // One `useRowWindows` for the whole board: every shown lane+status cell is a group (its
  // droppable id, its cards' ids), so one measurement pass on the board's one scroller
  // windows every column at once. A column scrolled away sideways is `offscreen`.
  const windowGroups = useMemo<RowWindowGroup[]>(() => {
    const groups: RowWindowGroup[] = [];
    lanes.forEach((lane, laneIndex) => {
      if (lane.kind !== 'none' && collapsedLaneKeys.has(lane.key)) return;
      lane.columns.forEach(({ status, tasks: laneTasks }, index) => {
        if (collapsedColumns.has(status)) return;
        groups.push({
          id: dropZoneId(laneIndex, status),
          rowIds: laneTasks.map((doc) => doc.meta.id),
          offscreen: nearColumns !== null && !nearColumns.has(index),
        });
      });
    });
    return groups;
  }, [lanes, collapsedLaneKeys, collapsedColumns, nearColumns]);
  // Each shown card's cell and place in it, for revealing the cursor's card.
  const cellOfTask = useMemo(() => {
    const map = new Map<string, { groupId: string; index: number }>();
    for (const group of windowGroups) {
      group.rowIds.forEach((id, index) => {
        map.set(id, { groupId: group.id, index });
      });
    }
    return map;
  }, [windowGroups]);
  // The card in hand stays mounted however far the board scrolls: dnd-kit drops a drag
  // whose source node goes away.
  const dragging = useMemo<ReadonlySet<string>>(
    () => (activeTaskId === null ? NO_IDS : new Set([activeTaskId])),
    [activeTaskId]
  );
  const scrollParent = useCallback(() => boardRef.current, []);
  const rowWindows = useRowWindows({
    rootRef: boardRef,
    headRef: columnHeadRef,
    enabled: true,
    scrollParent,
    groups: windowGroups,
    dragging,
    estimate: ROW_ESTIMATE,
    overscan: CARD_OVERSCAN,
    // The old react-virtual board's guarantee: a scroll renders every column's new cards in
    // one commit inside the scroll event, so the frame it paints never shows a column short
    // of cards.
    flushOnScroll: true,
  });

  // The j/k cursor's card: kept mounted while the board scrolls away from it, and brought
  // into view (under the sticky column header) when the cursor moves, mounting it first if
  // its window does not hold it. A mounted `TaskCardTile` takes DOM focus itself from its
  // `focused` prop. Only a cursor move reveals: the cells and the windows (whose identity
  // changes on every scroll) are read from a ref, so a scroll or a refresh never drags the
  // board back to the cursor.
  const revealing = useRef({ cellOfTask, rowWindows });
  useLayoutEffect(() => {
    revealing.current = { cellOfTask, rowWindows };
  });
  useLayoutEffect(() => {
    const { cellOfTask: cells, rowWindows: windows } = revealing.current;
    windows.setFocusedRow(focusedTaskId);
    if (focusedTaskId === null) return;
    const cell = cells.get(focusedTaskId);
    if (cell === undefined) return;
    const mounted = boardRef.current?.querySelector<HTMLElement>(
      `li[data-row-id="${escapeAttribute(focusedTaskId)}"]`
    );
    if (mounted !== null && mounted !== undefined) {
      windows.revealElement(mounted);
    } else {
      windows.revealRow(cell.groupId, cell.index);
    }
  }, [focusedTaskId]);

  const sensors = useSensors(
    useSensor(PointerSensor, POINTER_SENSOR_OPTIONS),
    useSensor(KeyboardSensor)
  );

  function handleDragStart(event: DragStartEvent) {
    setActiveTaskId(String(event.active.id));
  }

  function handleDragEnd(event: DragEndEvent) {
    setActiveTaskId(null);
    const overId = event.over?.id;
    if (overId === undefined || onMoveStatus === undefined) return;
    const targetStatus = statusFromDropZoneId(String(overId));
    if (targetStatus === null) return;
    const taskId = String(event.active.id);
    const doc = taskById.get(taskId);
    if (doc === undefined || doc.meta.status === targetStatus) return;
    void onMoveStatus(taskId, targetStatus);
  }

  const activeDoc =
    activeTaskId !== null ? taskById.get(activeTaskId) : undefined;
  const laneHeaderStyle = useMemo(
    () => (viewportWidth !== null ? { width: viewportWidth } : undefined),
    [viewportWidth]
  );

  // The header row and the lane headers as memoized elements: a scroll that moves a window
  // re-renders the board, and an unchanged element is skipped outright, so neither the
  // column menus nor a milestone lane's fan-out controls redraw on a scroll.
  const columnHeaderRow = useMemo(
    () => (
      // One column header row for the whole board rather than a set per lane: the lanes
      // already repeat the same statuses in the same order, and a header that sticks to the
      // top stays useful however far down the milestones you scroll.
      <div ref={columnHeadRef} className={styles.columnHeaderRow}>
        {statuses.map((status) => (
          <ColumnHeader
            key={status}
            status={status}
            count={statusCounts.get(status) ?? 0}
            readyCount={readyByStatus.get(status)?.length ?? 0}
            collapsed={collapsedColumns.has(status)}
            onToggleCollapsed={
              onToggleColumnCollapsed !== undefined
                ? () => onToggleColumnCollapsed(status)
                : undefined
            }
            onHide={
              onHideColumn !== undefined
                ? () => onHideColumn(status)
                : undefined
            }
            onDispatchAll={
              onDispatch !== undefined
                ? () => {
                    for (const id of readyByStatus.get(status) ?? []) {
                      void onDispatch(id);
                    }
                  }
                : undefined
            }
            onAdd={() => shell.openCreateTask({ status })}
          />
        ))}
        {hiddenColumnCount > 0 && onShowHiddenColumns !== undefined && (
          <div className={styles.hiddenColumns}>
            <Button
              variant="quiet"
              size="sm"
              title="Show hidden columns"
              onClick={onShowHiddenColumns}
              icon={<ChevronsLeftRight {...ICON} />}
            >
              {hiddenColumnCount} hidden{' '}
              {hiddenColumnCount === 1 ? 'column' : 'columns'}
            </Button>
          </div>
        )}
      </div>
    ),
    [
      statuses,
      statusCounts,
      readyByStatus,
      collapsedColumns,
      onToggleColumnCollapsed,
      onHideColumn,
      onDispatch,
      shell,
      hiddenColumnCount,
      onShowHiddenColumns,
    ]
  );

  const laneHeaders = useMemo(() => {
    const map = new Map<string, ReactNode>();
    for (const lane of lanes) {
      const key = lane.key;
      const expanded = lane.kind === 'none' || !collapsedLaneKeys.has(key);
      if (lane.kind === 'parent') {
        const milestone =
          lane.milestoneId !== null
            ? (milestoneById.get(lane.milestoneId) ?? null)
            : null;
        map.set(
          key,
          <div
            data-slot="board-lane-header"
            className={styles.laneHeader}
            style={laneHeaderStyle}
          >
            <MilestoneLaneHeader
              milestone={milestone}
              title={lane.title}
              total={lane.total}
              expanded={expanded}
              onToggle={() => onToggleLane(key)}
              progress={
                milestone !== null
                  ? milestoneProgressById.get(milestone.meta.id)
                  : undefined
              }
              concurrencyDefault={milestoneConcurrencyDefault}
              childTasks={
                milestone !== null
                  ? (childrenByMilestoneId.get(milestone.meta.id) ?? [])
                  : []
              }
              model={model}
              onOpenTask={onSelect}
              onWork={onWorkMilestone}
              onRequestWork={onRequestWorkMilestone}
              onPause={onPauseMilestone}
              onResume={onResumeMilestone}
              onRaiseCeiling={onRaiseCeilingMilestone}
              onStop={onStopMilestone}
              onLand={onLandMilestone}
              onAdd={() =>
                shell.openCreateTask(
                  milestone !== null
                    ? { milestone: milestone.meta.id }
                    : undefined
                )
              }
            />
          </div>
        );
      } else if (lane.kind === 'assignee' || lane.kind === 'priority') {
        map.set(
          key,
          <div
            data-slot="board-lane-header"
            className={styles.laneHeader}
            style={laneHeaderStyle}
          >
            <LaneHeader
              lane={lane}
              expanded={expanded}
              onToggle={() => onToggleLane(key)}
            />
          </div>
        );
      }
    }
    return map;
  }, [
    lanes,
    collapsedLaneKeys,
    milestoneById,
    laneHeaderStyle,
    onToggleLane,
    milestoneProgressById,
    milestoneConcurrencyDefault,
    childrenByMilestoneId,
    model,
    onSelect,
    onWorkMilestone,
    onRequestWorkMilestone,
    onPauseMilestone,
    onResumeMilestone,
    onRaiseCeilingMilestone,
    onStopMilestone,
    onLandMilestone,
    shell,
  ]);

  // One card of a cell, as a stable function: it changes only with the data a card shows
  // (never on a scroll), so the memoized cells a scroll did not move skip their render.
  const renderCard = useCallback(
    (doc: TaskListItem, parentLane: boolean) => (
      <LazyCard
        id={doc.meta.id}
        fling={fling}
        eager={doc.meta.id === activeTaskId || doc.meta.id === focusedTaskId}
        heights={cardHeights}
      >
        <BoardCard
          doc={doc}
          heights={cardHeights}
          disabled={archivedTaskIds.has(doc.meta.id)}
          ready={readyIds.has(doc.meta.id)}
          blocked={blockedIds.has(doc.meta.id)}
          liveRunState={liveRunStateByTaskId.get(doc.meta.id)}
          run={latestRunByTaskId.get(doc.meta.id)}
          readiness={readinessById?.get(doc.meta.id)}
          // Milestone lanes: the lane heading already names the milestone, so the card
          // skips the crumb. Every other board: the crumb is how a card keeps its milestone.
          milestoneTitle={
            parentLane || doc.meta.parent === null
              ? undefined
              : (milestoneById.get(doc.meta.parent)?.meta.title ??
                doc.meta.parent)
          }
          statuses={cardStatuses}
          properties={display.properties}
          labelCatalogue={labelCatalogue}
          onStatusChange={moveCardStatus}
          onEditTask={editCard}
          onClick={onSelect}
          onDispatch={readyIds.has(doc.meta.id) ? onDispatch : undefined}
          focused={doc.meta.id === focusedTaskId}
          onFocus={onCardFocus}
          archived={archivedTaskIds.has(doc.meta.id)}
          needsAttention={attentionByTaskId?.has(doc.meta.id) === true}
          landing={landingByTaskId?.get(doc.meta.id)}
        />
      </LazyCard>
    ),
    [
      fling,
      activeTaskId,
      focusedTaskId,
      cardHeights,
      archivedTaskIds,
      readyIds,
      blockedIds,
      liveRunStateByTaskId,
      latestRunByTaskId,
      readinessById,
      milestoneById,
      cardStatuses,
      display.properties,
      labelCatalogue,
      moveCardStatus,
      editCard,
      onSelect,
      onDispatch,
      onCardFocus,
      attentionByTaskId,
      landingByTaskId,
    ]
  );

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTaskId(null)}
    >
      <div ref={attachBoard} data-slot="task-board" className={styles.board}>
        {columnHeaderRow}

        <div ref={setLaneStack} className={styles.laneStack}>
          {lanes.map((lane, laneIndex) => {
            const key = lane.key;
            // The flat board's single lane has no header to collapse from — always open.
            const expanded =
              lane.kind === 'none' || !collapsedLaneKeys.has(key);
            return (
              <section key={key} data-lane-key={key}>
                {laneHeaders.get(key)}
                {expanded && (
                  <div data-lane-columns={key} className={styles.laneColumns}>
                    {lane.columns.map(({ status, tasks: laneTasks }) => {
                      const collapsed = collapsedColumns.has(status);
                      const cellId = dropZoneId(laneIndex, status);
                      return (
                        <div
                          key={status}
                          className={
                            collapsed ? styles.collapsedColumn : styles.column
                          }
                        >
                          {collapsed ? (
                            <div className={styles.collapsedCell} />
                          ) : (
                            <BoardCell
                              id={cellId}
                              tasks={laneTasks}
                              segments={rowWindows.segmentsOf(cellId)}
                              registerList={rowWindows.registerList}
                              parentLane={lane.kind === 'parent'}
                              renderCard={renderCard}
                            />
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            );
          })}
        </div>
      </div>
      <DragOverlay>
        {/* Only plain tasks are draggable, so the lifted ghost is always a task card. */}
        {activeDoc !== undefined && (
          <div className={styles.dragOverlay}>
            <TaskCardTile
              doc={activeDoc}
              ready={readyIds.has(activeDoc.meta.id)}
              blocked={blockedIds.has(activeDoc.meta.id)}
              liveRunState={liveRunStateByTaskId.get(activeDoc.meta.id)}
              run={latestRunByTaskId.get(activeDoc.meta.id)}
              readiness={readinessById?.get(activeDoc.meta.id)}
              statuses={cardStatuses}
              properties={display.properties}
              onStatusChange={noop}
              onEditTask={noop}
              onClick={noop}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}

// `CSS.escape` where the DOM has it (the global, which dnd-kit's `CSS` import shadows here);
// a task id is a plain slug, so it is already safe in a quoted attribute selector without.
function escapeAttribute(value: string): string {
  return typeof globalThis.CSS?.escape === 'function'
    ? globalThis.CSS.escape(value)
    : value;
}
