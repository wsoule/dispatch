import type { EpicProgress, RunMeta, RunState } from '@dispatch/client';
import type { TaskDoc, UpdatePatch } from '@dispatch/core/browser';
import {
  closestCenter,
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
import { Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  countLaneStatuses,
  dropZoneId,
  groupTasksByEpicLane,
  laneKey,
  statusFromDropZoneId,
} from '../../lib/boardGrouping';
import type { TaskAttention } from '../../lib/taskAttention';
import { statusLabel } from '../../lib/taskDisplay';
import { EpicLaneHeader } from './EpicLaneHeader';
import { StatusIcon } from './StatusIcon';
import { TaskCardTile } from './TaskCardTile';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';

interface TaskBoardProps {
  tasks: TaskDoc[];
  statuses: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  /** Live (non-terminal) run state per task id. */
  liveRunStateByTaskId: Map<string, RunState>;
  /** Each task's latest run, if any — feeds the card's merge-ladder dot. */
  latestRunByTaskId: Map<string, RunMeta>;
  /** Tasks whose latest run needs a human right now (see `deriveTaskAttentionById`) —
   * tints those cards amber. Optional so a board rendered without live run data (there
   * isn't one today) simply shows no highlights. */
  attentionByTaskId?: ReadonlyMap<string, TaskAttention>;
  /** Epic dispatch progress per epic id, once fetched. */
  epicProgressById: Map<string, EpicProgress>;
  /** Default concurrency for a fresh epic dispatch session (config's `orchestrator.epicConcurrency`). */
  epicConcurrencyDefault: number;
  /** Every epic in the project — one lane per epic that has children, in this order. */
  epics: TaskDoc[];
  /** Lane keys (see `laneKey`) whose epic is folded up right now. */
  collapsedLaneKeys: ReadonlySet<string>;
  /** Flips one lane between expanded and collapsed — owned by `BoardView`, which also needs the
   * collapsed set to keep j/k off hidden cards. */
  onToggleLane: (key: string) => void;
  /** Routes epic dispatch through a confirmation preview. See EpicLaneHeader. */
  onRequestWorkEpic?: (epicId: string) => void;
  onSelect: (id: string) => void;
  /** Dispatches a plain (non-epic) task directly from its card's inline ready-lane button.
   * Optional — omitting it (rather than requiring every caller to wire it up) simply hides
   * the inline action and leaves dispatching to the task detail view, the same as before this
   * card gained a ready-lane shortcut. */
  onDispatch?: (taskId: string) => Promise<void>;
  onWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  onStopEpic: (epicId: string) => Promise<void>;
  /** Lands a finished epic branch on the default base — see EpicLaneHeader's Land button.
   * Optional for the same reason as `onDispatch`: a board rendered without live land wiring
   * (tests, previews) simply never shows the button. */
  onLandEpic?: (epicId: string) => Promise<void>;
  /** Moves a task to a different status — wired to the drag-and-drop drop handler below (and
   * nowhere else); optional purely so a board rendered without a live project (there isn't
   * one today) doesn't need to supply a no-op. */
  onMoveStatus?: (taskId: string, status: string) => Promise<void>;
  /** Edits a task's priority/assignee inline from its card (the same handleUpdate the detail
   * modal uses). Optional for the same reason as `onMoveStatus` — a board with no live
   * project renders static cards. */
  onEditTask?: (taskId: string, patch: UpdatePatch) => Promise<void>;
  /** Opens `CreateTaskModal` pre-set to a given status — wired to each column header's
   * hover-revealed "+" button. */
  onAddTask?: (status: string) => void;
  /** Id of the card the Board's j/k roving-focus cursor is currently on, if any — see
   * `BoardView`'s lane-then-column traversal. `undefined`/no match renders every card
   * unfocused. */
  focusedTaskId?: string | null;
  /** Task 9: ids of tasks appended to `tasks` because the "Archived" toggle is on — these
   * cards render dimmed and can't be dragged (their `moveTaskStatus` calls are also gated
   * centrally in `useDispatchProject`, this just keeps the drag from starting in the first
   * place). Defaults to empty so a board rendered without the toggle never has to pass it. */
  archivedTaskIds?: ReadonlySet<string>;
  /** Called whenever real DOM focus lands on any card (click, Tab, or the roving-focus
   * effect) — lets `BoardView` sync `focusedTaskId` to wherever focus actually is, so a
   * mouse click (which the j/k cursor never hears about on its own) can't leave Enter
   * opening a stale card instead of the one that's visibly focused. */
  onCardFocus?: (taskId: string) => void;
}

// Stable empty-set default for `archivedTaskIds` — avoids allocating a fresh `Set` every
// render for the common case of a board rendered without the archived toggle at all.
const NO_ARCHIVED_IDS: ReadonlySet<string> = new Set();

// One column width, shared by the sticky status header and every lane's columns — they only
// line up as a grid because both read this constant.
const COLUMN_WIDTH_CLASS = 'w-[272px] shrink-0';

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
  /** Task 9: true for an archived card — `useDraggable`'s own `disabled` option, so an
   * archived card never lifts under the pointer/keyboard sensors at all rather than relying
   * solely on `onMoveStatus`'s own archived-task guard. */
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
  const style = transform
    ? { transform: CSS.Translate.toString(transform) }
    : undefined;
  return children({ setNodeRef, style, attributes, listeners, isDragging });
}

// One lane+status cell's card stack, droppable by the composite id `dropZoneId` builds (never
// the bare status — see that helper for why). A plain `useDroppable` zone, not wrapped in a
// `SortableContext`, matching `DraggableCard`'s plain-draggable choice above, so an empty cell
// stays a valid drop target with no cards inside it to anchor to.
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
      className={cn(
        'flex min-h-16 flex-1 flex-col gap-2 rounded-lg p-1 transition-colors duration-150',
        'data-[over=true]:bg-accent/40 data-[over=true]:ring-1 data-[over=true]:ring-ring/40'
      )}
    >
      {children}
    </div>
  );
}

/**
 * The unified kanban: one expandable row per epic, each holding the project's configured status
 * columns, with a shared sticky column header across the top.
 *
 * Epics are containers rather than cards — they head a lane instead of sitting in a status
 * column, so only plain tasks are ever dragged. Collapsing a lane hides its cards and moves their
 * count into the header's "+N hidden" badge, which keeps a folded-away epic visible as *something
 * still there* rather than silently shrinking the counts. Columns come from the project's own
 * `.dispatch/config.yml` order, never a hardcoded status list, so a custom tracker config
 * reshapes the board automatically (grouping itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByEpicLane`).
 *
 * Drag-and-drop (the board's core interaction): a `PointerSensor` with a 6px activation distance
 * so an ordinary click still opens the peek panel and the inline Dispatch button still works
 * (only a real drag — pointer travel past the threshold — ever picks a card up), plus a
 * `KeyboardSensor` for accessible drag (Space lifts/drops the focused card; arrow keys move it).
 * Dropping onto a different column calls `onMoveStatus`, which `BoardView` wires to the
 * already-optimistic `moveTaskStatus`. `DragOverlay` renders a lifted copy of the dragged card so
 * the original can fade out in place instead of visibly jumping.
 */
export function TaskBoard({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  latestRunByTaskId,
  attentionByTaskId,
  epicProgressById,
  epicConcurrencyDefault,
  epics,
  collapsedLaneKeys,
  onToggleLane,
  onRequestWorkEpic,
  onSelect,
  onDispatch,
  onWorkEpic,
  onStopEpic,
  onLandEpic,
  onMoveStatus,
  onEditTask,
  onAddTask,
  focusedTaskId = null,
  onCardFocus,
  archivedTaskIds = NO_ARCHIVED_IDS,
}: TaskBoardProps) {
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  // The same lanes `BoardView` derives for its j/k order, from the same pure function and the
  // same inputs — deliberately recomputed here rather than passed down, so the two never have to
  // be kept in sync as a pair of props that could disagree.
  const lanes = useMemo(
    () => groupTasksByEpicLane(tasks, statuses, epics),
    [tasks, statuses, epics]
  );
  const statusCounts = useMemo(
    () => countLaneStatuses(lanes, statuses, collapsedLaneKeys),
    [lanes, statuses, collapsedLaneKeys]
  );

  const epicById = useMemo(() => {
    const map = new Map<string, TaskDoc>();
    for (const epic of epics) map.set(epic.meta.id, epic);
    return map;
  }, [epics]);

  const taskById = useMemo(() => {
    const map = new Map<string, TaskDoc>();
    for (const doc of tasks) map.set(doc.meta.id, doc);
    return map;
  }, [tasks]);

  // Every epic's children, bucketed in one pass — feeds `EpicLaneHeader`'s dependency-graph
  // modal, which needs the epic's own children (not the whole project's tasks) to lay out.
  const childrenByEpicId = useMemo(() => {
    const map = new Map<string, TaskDoc[]>();
    for (const doc of tasks) {
      if (doc.meta.parent === null) continue;
      const bucket = map.get(doc.meta.parent);
      if (bucket !== undefined) bucket.push(doc);
      else map.set(doc.meta.parent, [doc]);
    }
    return map;
  }, [tasks]);

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
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

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
      onDragCancel={() => setActiveTaskId(null)}
    >
      <div className="flex h-full min-h-0 flex-col overflow-auto pb-2">
        {lanes.length === 0 ? (
          <p className="text-muted-foreground px-0.5 text-[12.5px]">
            No tasks yet.
          </p>
        ) : (
          <>
            {/* One column header row for the whole board rather than a set per lane: the lanes
                already repeat the same statuses in the same order, and a header that sticks to
                the top stays useful however far down the epics you scroll. */}
            <div className="bg-background sticky top-0 z-10 flex w-max gap-6 pb-2">
              {statuses.map((status) => {
                const count = statusCounts.get(status) ?? {
                  visible: 0,
                  hidden: 0,
                };
                return (
                  <div
                    key={status}
                    className={cn(
                      'group/header flex items-center gap-1.5 px-0.5',
                      COLUMN_WIDTH_CLASS
                    )}
                  >
                    <StatusIcon status={status} />
                    <span className="text-foreground/80 truncate text-[11px] font-medium">
                      {statusLabel(status)}
                    </span>
                    <span className="text-muted-foreground/60 font-mono text-[11px]">
                      {count.visible}
                    </span>
                    {count.hidden > 0 && (
                      <span
                        className="text-muted-foreground/70 bg-accent/60 rounded px-1 font-mono text-[10px] whitespace-nowrap"
                        title={`${count.hidden} hidden in collapsed epics`}
                      >
                        +{count.hidden} hidden
                      </span>
                    )}
                    {onAddTask !== undefined && (
                      <Button
                        type="button"
                        variant="ghost"
                        onClick={() => onAddTask(status)}
                        aria-label={`New task in ${status}`}
                        className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto size-auto rounded-md p-0.5 opacity-0 transition-opacity duration-150 group-hover/header:opacity-100 focus-visible:opacity-100 has-[>svg]:px-0.5"
                      >
                        <Plus className="size-3.5" />
                      </Button>
                    )}
                  </div>
                );
              })}
            </div>

            <div className="flex w-max flex-col gap-5">
              {lanes.map((lane, laneIndex) => {
                const key = laneKey(lane.epicId);
                const expanded = !collapsedLaneKeys.has(key);
                const epic =
                  lane.epicId !== null
                    ? (epicById.get(lane.epicId) ?? null)
                    : null;
                return (
                  <section key={key}>
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
                      onOpenTask={onSelect}
                      onWork={onWorkEpic}
                      onRequestWork={onRequestWorkEpic}
                      onStop={onStopEpic}
                      onLand={onLandEpic}
                    />
                    {expanded && (
                      <div className="flex gap-6">
                        {lane.columns.map(({ status, tasks: laneTasks }) => (
                          <div
                            key={status}
                            className={cn(
                              'flex flex-col gap-2',
                              COLUMN_WIDTH_CLASS
                            )}
                          >
                            <DroppableColumn id={dropZoneId(laneIndex, status)}>
                              {laneTasks.length === 0 && (
                                <div className="text-muted-foreground/40 min-h-8 px-0.5 py-1 text-[11px]" />
                              )}
                              {laneTasks.map((doc) => (
                                <DraggableCard
                                  key={doc.meta.id}
                                  id={doc.meta.id}
                                  disabled={archivedTaskIds.has(doc.meta.id)}
                                >
                                  {(drag) => (
                                    <TaskCardTile
                                      doc={doc}
                                      ready={readyIds.has(doc.meta.id)}
                                      blocked={blockedIds.has(doc.meta.id)}
                                      liveRunState={liveRunStateByTaskId.get(
                                        doc.meta.id
                                      )}
                                      run={latestRunByTaskId.get(doc.meta.id)}
                                      // No epic breadcrumb inside a lane: the lane heading
                                      // already says which epic this is, so repeating it on
                                      // every card is noise.
                                      epicTitle={undefined}
                                      statuses={statuses}
                                      onStatusChange={(next) =>
                                        void onMoveStatus?.(doc.meta.id, next)
                                      }
                                      onEditTask={(patch) =>
                                        void onEditTask?.(doc.meta.id, patch)
                                      }
                                      onClick={() => onSelect(doc.meta.id)}
                                      onDispatch={
                                        readyIds.has(doc.meta.id) &&
                                        onDispatch !== undefined
                                          ? () => onDispatch(doc.meta.id)
                                          : undefined
                                      }
                                      focused={doc.meta.id === focusedTaskId}
                                      onFocus={() => onCardFocus?.(doc.meta.id)}
                                      drag={drag}
                                      archived={archivedTaskIds.has(
                                        doc.meta.id
                                      )}
                                      needsAttention={
                                        attentionByTaskId?.has(doc.meta.id) ===
                                        true
                                      }
                                    />
                                  )}
                                </DraggableCard>
                              ))}
                            </DroppableColumn>
                          </div>
                        ))}
                      </div>
                    )}
                  </section>
                );
              })}
            </div>
          </>
        )}
      </div>
      <DragOverlay>
        {/* Only plain tasks are draggable now, so the lifted ghost is always a task card. */}
        {activeDoc !== undefined && (
          <div
            className={cn(
              'scale-[1.02] cursor-grabbing shadow-lg',
              COLUMN_WIDTH_CLASS
            )}
          >
            <TaskCardTile
              doc={activeDoc}
              ready={readyIds.has(activeDoc.meta.id)}
              blocked={blockedIds.has(activeDoc.meta.id)}
              liveRunState={liveRunStateByTaskId.get(activeDoc.meta.id)}
              run={latestRunByTaskId.get(activeDoc.meta.id)}
              statuses={statuses}
              onStatusChange={() => {}}
              onEditTask={() => {}}
              onClick={() => {}}
            />
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
