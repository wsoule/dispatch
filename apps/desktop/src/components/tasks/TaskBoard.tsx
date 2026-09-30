import type {
  EpicProgress,
  MergeQueueEntryState,
  ReadinessReading,
  RunMeta,
  RunState,
} from '@dispatch/client';
import type {
  StatusModel,
  TaskListItem,
  UpdatePatch,
} from '@dispatch/core/browser';
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
import type { WorkEpicOptions } from '../../lib/epicSession';
import { useActiveStatusModel } from '../../lib/statusModel';
import type { TaskAttention } from '../../lib/taskAttention';
import { statusLabel } from '../../lib/taskDisplay';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../../lib/tasksPrefs';
import { nearColumnIndexes, sameColumnIndexes } from '../../lib/virtualRows';
import { useShellActions } from '../shell/ShellActionsContext';
import { VirtualRows, type VirtualRowsHandle } from '../virtual/VirtualRows';
import { EpicLaneHeader } from './EpicLaneHeader';
import { LaneHeader } from './LaneHeader';
import { StatusIcon } from './StatusIcon';
import { TaskCardTile } from './TaskCardTile';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { PillButton } from '@/ui/ai/pill';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

interface TaskBoardProps {
  /** The cards, already in the order a column shows them (`BoardView` sorts once with
   * `sortTasks` so its j/k cursor and these columns walk the same sequence). */
  tasks: TaskListItem[];
  /** The status columns to render, in config order — already narrowed by the Display
   * popover's `Show empty groups` and any session-hidden columns (see `visibleBoardColumns`). */
  statuses: string[];
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
  /** Epic dispatch progress per epic id, once fetched. */
  /** Readiness readings per task id (see `useDispatchProject`); a card with none shows no pill. */
  readinessById?: ReadonlyMap<string, ReadinessReading>;
  epicProgressById: Map<string, EpicProgress>;
  /** Default concurrency for a fresh epic dispatch session (config's `orchestrator.epicConcurrency`). */
  epicConcurrencyDefault: number;
  /** Every epic in the project — one lane per epic that has children, in this order. */
  epics: TaskListItem[];
  /** The project's statuses, which roll each epic lane up; defaults to the open project's.
   * A caller holding config passes its model, which is right in the render config lands. */
  statusModel?: StatusModel;
  /** The Display popover's model — the card properties, and `subGrouping` for the swim
   * lanes (`none` is the flat board with an epic crumb on each card). Defaults to
   * `DEFAULT_TASKS_DISPLAY`; the ordering is applied by the caller (see `tasks`). */
  display?: TasksDisplayPrefs;
  /** Lane keys (`BoardLane.key`) folded up right now. */
  collapsedLaneKeys: ReadonlySet<string>;
  /** Flips one lane between expanded and collapsed — owned by `BoardView`, which also needs the
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
  /** Routes epic dispatch through a confirmation preview. See EpicLaneHeader. */
  onRequestWorkEpic?: (epicId: string) => void;
  onSelect: (id: string) => void;
  /** Dispatches a plain (non-epic) task from its card's Dispatch action, and every ready
   * task in a column from the column's `···` › Dispatch all ready. Optional — omitting it
   * hides both. */
  onDispatch?: (taskId: string) => Promise<void>;
  /** The lane header's direct dispatch path — a session at the picker's concurrency. */
  onWorkEpic: (epicId: string, opts: WorkEpicOptions) => Promise<void>;
  /** Pause/Resume/Raise ceiling… on a lane with a session; a header without them shows
   * only Stop. See EpicLaneHeader. */
  onPauseEpic?: (epicId: string) => Promise<void>;
  onResumeEpic?: (epicId: string) => Promise<void>;
  onRaiseCeilingEpic?: (epicId: string) => void;
  onStopEpic: (epicId: string) => Promise<void>;
  /** Lands a finished epic branch on the default base — see EpicLaneHeader's Land button.
   * Optional for the same reason as `onDispatch`. */
  onLandEpic?: (epicId: string) => Promise<void>;
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
   * effect) — lets `BoardView` sync `focusedTaskId` to wherever focus actually is. */
  onCardFocus?: (taskId: string) => void;
}

// Stable empty-set defaults — no fresh `Set` per render for the common case.
const NO_IDS: ReadonlySet<string> = new Set();
const noop = () => {};
// One object for every render: fresh options make new sensors, and new sensors hand every
// card new drag listeners, so each board render (a cursor move, a dispatch) redrew them all.
const POINTER_SENSOR_OPTIONS = { activationConstraint: { distance: 6 } };

// Linear's column: 348px including 12px of padding either side, so the 322px card sits on
// the 324px inner width. Shared by the sticky header row and every lane's columns.
const COLUMN_CLASS = 'w-[348px] shrink-0 px-3';
// A collapsed column folds to a 44px strip carrying the glyph, a rotated name and the count.
const COLLAPSED_COLUMN_CLASS = 'w-11 shrink-0 px-1';
// A lane header pins to the scroll container's left edge and is sized to its visible width
// (see `useBoardViewportWidth`), so the title on the left and the actions on the right both
// stay on-screen however far the column strip below scrolls sideways.
const LANE_HEADER_CLASS = 'sticky left-0 px-3';

// The board's visible width — the scroll container's `clientWidth`, which excludes its own
// scrollbar — kept current by one `ResizeObserver`. `null` until the observer's first
// callback (browsers fire one on `observe`), so a render that never measures (tests, SSR)
// sets no inline width and the header simply spans its lane.
function useBoardViewportWidth(board: HTMLDivElement | null) {
  const [viewportWidth, setViewportWidth] = useState<number | null>(null);
  useEffect(() => {
    if (board === null) return;
    const observer = new ResizeObserver(() => {
      setViewportWidth(board.clientWidth);
    });
    observer.observe(board);
    return () => observer.disconnect();
  }, [board]);
  return viewportWidth;
}

// The sticky column-header row's height (`h-11`): what a scrolled-to card must clear.
const COLUMN_HEADER_HEIGHT = 44;
// A card before it is measured — the skeleton's 104px tile.
const CARD_ESTIMATE = 104;
// `gap-2` between stacked cards.
const CARD_GAP = 8;
// Cards past the viewport kept mounted per side — a card is three list rows tall, so a
// few cover a flick without mounting a second screenful per column.
const CARD_OVERSCAN = 3;

const cardHeight = () => CARD_ESTIMATE;
const cardKey = (doc: TaskListItem) => doc.meta.id;

/**
 * Where each lane's columns start inside the board's scrolled content, by lane key — the
 * `scrollMargin` its virtual columns window against, since every column shares the board's
 * one vertical scroller. Re-measured whenever the lanes' stack changes height (a lane
 * folding, a card measuring taller than its estimate), which is the only thing that moves
 * a lane below it.
 */
function useLaneOffsets(
  board: HTMLDivElement | null,
  stack: HTMLDivElement | null,
  laneSignature: string
): ReadonlyMap<string, number> {
  const [offsets, setOffsets] = useState<ReadonlyMap<string, number>>(
    () => new Map()
  );
  useLayoutEffect(() => {
    if (board === null || stack === null) return;
    const measure = () => {
      const contentTop = board.getBoundingClientRect().top - board.scrollTop;
      const next = new Map<string, number>();
      for (const row of Array.from(
        stack.querySelectorAll<HTMLElement>('[data-lane-columns]')
      )) {
        next.set(
          row.dataset.laneColumns ?? '',
          Math.round(row.getBoundingClientRect().top - contentTop)
        );
      }
      setOffsets((prev) => (sameOffsets(prev, next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stack);
    return () => observer.disconnect();
  }, [board, stack, laneSignature]);
  return offsets;
}

function sameOffsets(
  a: ReadonlyMap<string, number>,
  b: ReadonlyMap<string, number>
): boolean {
  if (a.size !== b.size) return false;
  for (const [key, value] of a) if (b.get(key) !== value) return false;
  return true;
}

// How far past each side of the board's visible width a column still counts as near, as a
// share of that width: a column's cards mount this far before it scrolls into view.
const NEAR_COLUMN_MARGIN = 0.5;

/**
 * The board's columns near its horizontal viewport, by index (`nearColumnIndexes`). A column
 * off to the side keeps its virtual track (its height, its pinned cards) but mounts no cards,
 * so a vertical scroll mounts cards only in the columns in and beside the window (five of
 * seven on a 1440px window). A column comes near in a transition, so a sideways scroll
 * mounts its cards without holding up a frame.
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
      className="bg-surface-quaternary rounded-card shadow-card w-[322px] max-w-full opacity-60"
      style={{ height }}
    />
  );
}

/**
 * A card that mounts as a placeholder while the board flings and turns real once the fling
 * settles, in a transition so a new fling can interrupt it. A card that mounted real stays
 * real, and the cursor's or the dragged card (`eager`) never waits. Real cards record their
 * height so a placeholder for one seen before keeps its size.
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
  const record = useCallback(
    (node: HTMLDivElement | null) => {
      if (node !== null) heights.set(id, node.offsetHeight);
    },
    [heights, id]
  );
  if (!show) {
    return <CardPlaceholder height={heights.get(id) ?? CARD_ESTIMATE} />;
  }
  return <div ref={record}>{children}</div>;
}

/**
 * One lane+status cell's cards, virtualized against the board's shared scroller: only the
 * cards near the viewport mount, each measured for its real height. The dragged card and
 * the j/k cursor's card are pinned so they never unmount — dnd-kit drops a drag whose
 * source node goes away — and a keyboard move scrolls the focused card into view here,
 * where its index is known, so it mounts and takes DOM focus. Cards entering during a
 * fling mount as placeholders (`LazyCard`).
 */
function VirtualColumn({
  id,
  tasks,
  scrollElement,
  scrollMargin,
  offscreen,
  activeTaskId,
  focusedTaskId,
  fling,
  heights,
  renderCard,
}: {
  id: string;
  tasks: readonly TaskListItem[];
  scrollElement: HTMLDivElement | null;
  scrollMargin: number;
  /** Scrolled off to the side: no cards mount but the pinned ones. */
  offscreen: boolean;
  activeTaskId: string | null;
  focusedTaskId: string | null;
  fling: FlingTracker;
  heights: Map<string, number>;
  renderCard: (doc: TaskListItem) => ReactNode;
}) {
  const handle = useRef<VirtualRowsHandle>(null);
  const pinnedKeys = useMemo(
    () =>
      [activeTaskId, focusedTaskId].filter(
        (key): key is string => key !== null
      ),
    [activeTaskId, focusedTaskId]
  );
  // A key this column does not hold is a no-op in `scrollToKey`.
  useEffect(() => {
    if (focusedTaskId !== null) handle.current?.scrollToKey(focusedTaskId);
  }, [focusedTaskId]);
  const renderLazyCard = (doc: TaskListItem) => (
    <LazyCard
      id={doc.meta.id}
      fling={fling}
      eager={pinnedKeys.includes(doc.meta.id)}
      heights={heights}
    >
      {renderCard(doc)}
    </LazyCard>
  );
  return (
    <DroppableColumn id={id}>
      <VirtualRows
        rows={tasks}
        rowKey={cardKey}
        estimateSize={cardHeight}
        measure
        gap={CARD_GAP}
        overscan={CARD_OVERSCAN}
        scrollElement={scrollElement}
        scrollMargin={scrollMargin}
        scrollPaddingStart={COLUMN_HEADER_HEIGHT}
        pinnedKeys={pinnedKeys}
        // Every column rides the board's one scroller: one commit per scroll, not one each.
        sharedScroller
        offscreen={offscreen}
        handleRef={handle}
        renderRow={renderLazyCard}
      />
    </DroppableColumn>
  );
}

// A card's draggable id doubles as its task id — plain `useDraggable`, not `useSortable`,
// since the board never persists intra-column order, only which column (status) a card sits
// in. This wrapper is the one place that calls the hook, so `TaskCardTile` stays ignorant of
// @dnd-kit beyond the small `CardDragProps` shape it already accepts.
function DraggableCard({
  id,
  disabled = false,
  children,
}: {
  id: string;
  /** True for an archived card — `useDraggable`'s own `disabled`, so it never lifts. */
  disabled?: boolean;
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
  // Memoized so an idle card's `drag` prop keeps its identity and the memo'd tile skips.
  const drag = useMemo(
    () => ({
      setNodeRef,
      style: transform
        ? { transform: CSS.Translate.toString(transform) }
        : undefined,
      attributes,
      listeners,
      isDragging,
    }),
    [setNodeRef, transform, attributes, listeners, isDragging]
  );
  return children(drag);
}

// A draggable card as one memoized unit, so a scroll that re-renders its column skips every
// card whose props did not change (the tile alone is memoized, not its drag wrapper).
const BoardCard = memo(function BoardCard({
  disabled,
  ...tile
}: Omit<ComponentProps<typeof TaskCardTile>, 'drag'> & { disabled: boolean }) {
  return (
    <DraggableCard id={tile.doc.meta.id} disabled={disabled}>
      {(drag) => <TaskCardTile {...tile} drag={drag} />}
    </DraggableCard>
  );
});

// One lane+status cell's card stack, droppable by the composite id `dropZoneId` builds (never
// the bare status — see that helper for why). No background and no ring: the only drag-over
// cue is the panel's hover wash.
function DroppableColumn({
  id,
  children,
}: {
  id: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id });
  return (
    <div
      ref={setNodeRef}
      data-over={isOver}
      data-slot="board-column"
      className="rounded-card data-[over=true]:bg-surface-hover flex min-h-16 flex-1 flex-col gap-2 transition-colors duration-100"
    >
      {children}
    </div>
  );
}

// A column's 44px header: 14px glyph, 12px muted name, plain count, then `···` and `+`.
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
        data-collapsed
        className={cn(
          'flex flex-col items-center gap-2 pt-2',
          COLLAPSED_COLUMN_CLASS
        )}
      >
        <IconButton
          label={`Expand ${label} column`}
          onClick={onToggleCollapsed}
        >
          <StatusIcon status={status} />
        </IconButton>
        <span className="text-muted-foreground text-[12px] font-medium whitespace-nowrap [writing-mode:vertical-rl]">
          {label}
        </span>
        <span className="font-book text-muted-foreground text-[13px] tabular-nums">
          {count}
        </span>
      </div>
    );
  }
  return (
    <div
      data-slot="board-column-header"
      className={cn('flex h-11 items-center gap-2', COLUMN_CLASS)}
    >
      <StatusIcon status={status} />
      <span className="text-muted-foreground min-w-0 truncate text-[12px] font-medium">
        {label}
      </span>
      <span className="font-book text-muted-foreground text-[13px] tabular-nums">
        {count}
      </span>
      <span className="flex-1" />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton label={`${label} column options`} />}
        >
          <Ellipsis aria-hidden />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="min-w-[180px]">
          <DropdownMenuItem
            disabled={onToggleCollapsed === undefined}
            onClick={onToggleCollapsed}
          >
            <ChevronsRightLeft />
            Collapse column
          </DropdownMenuItem>
          <DropdownMenuItem disabled={onHide === undefined} onClick={onHide}>
            <EyeOff />
            Hide column
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={onDispatchAll === undefined || readyCount === 0}
            onClick={onDispatchAll}
          >
            <Play />
            Dispatch all ready{readyCount > 0 ? ` (${readyCount})` : ''}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <IconButton label={`New task in ${status}`} onClick={onAdd}>
        <Plus aria-hidden />
      </IconButton>
    </div>
  );
}

/**
 * The board (§5): status columns 348px wide sitting directly on the panel, a shared 44px
 * header row that sticks to the top, and — under Display › Sub-grouping — one swim lane
 * per epic (`EpicLaneHeader`), assignee or priority (`LaneHeader`) over its own set of
 * columns. Columns come from the project's own `.dispatch/config.yml` order, never a
 * hardcoded status list (the lane split itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByLane`).
 *
 * Epics are containers rather than cards — they head a lane instead of sitting in a status
 * column, so only plain tasks are ever dragged. A `PointerSensor` with a 6px activation
 * distance keeps an ordinary click opening the peek (only real pointer travel lifts a
 * card), plus a `KeyboardSensor` for accessible drag. Dropping onto a different column
 * calls `onMoveStatus`; `DragOverlay` renders a lifted copy so the original fades in place.
 */
export function TaskBoard({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  latestRunByTaskId,
  attentionByTaskId,
  landingByTaskId,
  epicProgressById,
  readinessById,
  epicConcurrencyDefault,
  epics,
  statusModel,
  display = DEFAULT_TASKS_DISPLAY,
  collapsedLaneKeys,
  onToggleLane,
  collapsedColumns = NO_IDS,
  onToggleColumnCollapsed,
  onHideColumn,
  hiddenColumnCount = 0,
  onShowHiddenColumns,
  onRequestWorkEpic,
  onSelect,
  onDispatch,
  onWorkEpic,
  onPauseEpic,
  onResumeEpic,
  onRaiseCeilingEpic,
  onStopEpic,
  onLandEpic,
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
  // The scroller and the lanes' stack as state: the virtual columns need the scroller
  // once it exists, and the lane offsets are measured off both.
  const [board, setBoard] = useState<HTMLDivElement | null>(null);
  const [laneStack, setLaneStack] = useState<HTMLDivElement | null>(null);
  const viewportWidth = useBoardViewportWidth(board);
  const fling = useBoardFling(board);
  // Each card's last measured height, by task id — what its fling placeholder takes.
  const [cardHeights] = useState(() => new Map<string, number>());

  // The same lanes `BoardView` derives for its j/k order, from the same pure function and the
  // same (pre-sorted) input — deliberately recomputed here rather than passed down, so the two
  // never have to be kept in sync as a pair of props that could disagree.
  const lanes = useMemo<BoardLane[]>(
    () => groupTasksByLane(tasks, statuses, epics, display.subGrouping),
    [tasks, statuses, epics, display.subGrouping]
  );
  const statusCounts = useMemo(
    () => countLaneStatuses(lanes, statuses),
    [lanes, statuses]
  );
  const laneOffsets = useLaneOffsets(
    board,
    laneStack,
    lanes.map((lane) => lane.key).join('\0')
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

  const epicById = useMemo(() => {
    const map = new Map<string, TaskListItem>();
    for (const epic of epics) map.set(epic.meta.id, epic);
    return map;
  }, [epics]);

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

  // Every epic's children, bucketed in one pass — feeds `EpicLaneHeader`'s rolled-up status
  // and dependency-graph modal, which need the epic's own children, not the whole project.
  const childrenByEpicId = useMemo(() => {
    const map = new Map<string, TaskListItem[]>();
    for (const doc of tasks) {
      if (doc.meta.parent === null) continue;
      const bucket = map.get(doc.meta.parent);
      if (bucket !== undefined) bucket.push(doc);
      else map.set(doc.meta.parent, [doc]);
    }
    return map;
  }, [tasks]);

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

  function dispatchAll(status: string) {
    if (onDispatch === undefined) return;
    for (const id of readyByStatus.get(status) ?? []) void onDispatch(id);
  }

  const activeDoc =
    activeTaskId !== null ? taskById.get(activeTaskId) : undefined;
  const columnClass = (status: string) =>
    collapsedColumns.has(status) ? COLLAPSED_COLUMN_CLASS : COLUMN_CLASS;
  const laneHeaderStyle =
    viewportWidth !== null ? { width: viewportWidth } : undefined;

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={boardCollision}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTaskId(null)}
    >
      <div
        ref={setBoard}
        data-slot="task-board"
        className="flex h-full min-h-0 flex-col overflow-auto pb-2"
      >
        {/* One column header row for the whole board rather than a set per lane: the lanes
            already repeat the same statuses in the same order, and a header that sticks to
            the top stays useful however far down the epics you scroll. */}
        <div className="bg-background sticky top-0 z-10 flex w-max items-start">
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
                onDispatch !== undefined ? () => dispatchAll(status) : undefined
              }
              onAdd={() => shell.openCreateTask({ status })}
            />
          ))}
          {hiddenColumnCount > 0 && onShowHiddenColumns !== undefined && (
            <div className="flex h-11 items-center px-3">
              <PillButton onClick={onShowHiddenColumns}>
                <ChevronsLeftRight />
                {hiddenColumnCount} hidden{' '}
                {hiddenColumnCount === 1 ? 'column' : 'columns'}
              </PillButton>
            </div>
          )}
        </div>

        <div ref={setLaneStack} className="flex w-max flex-col gap-4">
          {lanes.map((lane, laneIndex) => {
            const key = lane.key;
            // The flat board's single lane has no header to collapse from — always open.
            const expanded =
              lane.kind === 'none' || !collapsedLaneKeys.has(key);
            const epic =
              lane.epicId !== null ? (epicById.get(lane.epicId) ?? null) : null;
            return (
              <section key={key} data-lane-key={key}>
                {lane.kind === 'epic' && (
                  <div
                    data-slot="board-lane-header"
                    className={LANE_HEADER_CLASS}
                    style={laneHeaderStyle}
                  >
                    <EpicLaneHeader
                      epic={epic}
                      title={lane.title}
                      total={lane.total}
                      expanded={expanded}
                      onToggle={() => onToggleLane(key)}
                      progress={
                        epic !== null
                          ? epicProgressById.get(epic.meta.id)
                          : undefined
                      }
                      concurrencyDefault={epicConcurrencyDefault}
                      childTasks={
                        epic !== null
                          ? (childrenByEpicId.get(epic.meta.id) ?? [])
                          : []
                      }
                      model={model}
                      onOpenTask={onSelect}
                      onWork={onWorkEpic}
                      onRequestWork={onRequestWorkEpic}
                      onPause={onPauseEpic}
                      onResume={onResumeEpic}
                      onRaiseCeiling={onRaiseCeilingEpic}
                      onStop={onStopEpic}
                      onLand={onLandEpic}
                      onAdd={() =>
                        shell.openCreateTask(
                          epic !== null ? { epic: epic.meta.id } : undefined
                        )
                      }
                    />
                  </div>
                )}
                {(lane.kind === 'assignee' || lane.kind === 'priority') && (
                  <div
                    data-slot="board-lane-header"
                    className={LANE_HEADER_CLASS}
                    style={laneHeaderStyle}
                  >
                    <LaneHeader
                      lane={lane}
                      expanded={expanded}
                      onToggle={() => onToggleLane(key)}
                    />
                  </div>
                )}
                {expanded && (
                  <div data-lane-columns={key} className="flex items-start">
                    {lane.columns.map(({ status, tasks: laneTasks }, index) => (
                      <div
                        key={status}
                        className={cn('flex flex-col', columnClass(status))}
                      >
                        {collapsedColumns.has(status) ? (
                          <div className="min-h-16" />
                        ) : (
                          <VirtualColumn
                            id={dropZoneId(laneIndex, status)}
                            tasks={laneTasks}
                            scrollElement={board}
                            scrollMargin={laneOffsets.get(key) ?? 0}
                            offscreen={
                              nearColumns !== null && !nearColumns.has(index)
                            }
                            activeTaskId={activeTaskId}
                            focusedTaskId={focusedTaskId}
                            fling={fling}
                            heights={cardHeights}
                            renderCard={(doc) => (
                              <BoardCard
                                doc={doc}
                                disabled={archivedTaskIds.has(doc.meta.id)}
                                ready={readyIds.has(doc.meta.id)}
                                blocked={blockedIds.has(doc.meta.id)}
                                liveRunState={liveRunStateByTaskId.get(
                                  doc.meta.id
                                )}
                                run={latestRunByTaskId.get(doc.meta.id)}
                                readiness={readinessById?.get(doc.meta.id)}
                                // Epic lanes: the lane heading already names the
                                // epic, so the card skips the crumb. Every other
                                // board: the crumb is how a card keeps its epic.
                                epicTitle={
                                  lane.kind === 'epic' ||
                                  doc.meta.parent === null
                                    ? undefined
                                    : (epicById.get(doc.meta.parent)?.meta
                                        .title ?? doc.meta.parent)
                                }
                                statuses={statuses}
                                properties={display.properties}
                                labelCatalogue={labelCatalogue}
                                onStatusChange={moveCardStatus}
                                onEditTask={editCard}
                                onClick={onSelect}
                                onDispatch={
                                  readyIds.has(doc.meta.id)
                                    ? onDispatch
                                    : undefined
                                }
                                focused={doc.meta.id === focusedTaskId}
                                onFocus={onCardFocus}
                                archived={archivedTaskIds.has(doc.meta.id)}
                                needsAttention={
                                  attentionByTaskId?.has(doc.meta.id) === true
                                }
                                landing={landingByTaskId?.get(doc.meta.id)}
                              />
                            )}
                          />
                        )}
                      </div>
                    ))}
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
          <div className="rounded-card shadow-raised w-[322px] cursor-grabbing">
            <TaskCardTile
              doc={activeDoc}
              ready={readyIds.has(activeDoc.meta.id)}
              blocked={blockedIds.has(activeDoc.meta.id)}
              liveRunState={liveRunStateByTaskId.get(activeDoc.meta.id)}
              run={latestRunByTaskId.get(activeDoc.meta.id)}
              readiness={readinessById?.get(activeDoc.meta.id)}
              statuses={statuses}
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
