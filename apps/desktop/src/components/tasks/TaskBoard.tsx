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
import { Layers, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';

import {
  groupTasksByEpicLane,
  groupTasksByStatus,
} from '../../lib/boardGrouping';
import { EpicCardTile } from './EpicCardTile';
import { StatusIcon } from './StatusIcon';
import { TaskCardTile } from './TaskCardTile';
import { cn } from '@/lib/utils';

interface TaskBoardProps {
  tasks: TaskDoc[];
  statuses: string[];
  readyIds: Set<string>;
  blockedIds: Set<string>;
  /** Live (non-terminal) run state per task id. */
  liveRunStateByTaskId: Map<string, RunState>;
  /** Each task's latest run, if any — feeds the card's merge-ladder dot. */
  latestRunByTaskId: Map<string, RunMeta>;
  /** Epic dispatch progress per epic id, once fetched. */
  epicProgressById: Map<string, EpicProgress>;
  /** Default concurrency for a fresh epic dispatch session (config's `orchestrator.epicConcurrency`). */
  epicConcurrencyDefault: number;
  /** Every epic in the project — used only to resolve a plain task's `parent` id to that
   * epic's title for the card's `t-id › Epic title` breadcrumb (see `epicTitleById` below). */
  epics: TaskDoc[];
  /** Render as per-epic swim lanes instead of one flat set of status columns. */
  swimLanes?: boolean;
  /** Routes epic dispatch through a confirmation preview. See EpicCardTile. */
  onRequestWorkEpic?: (epicId: string) => void;
  onSelect: (id: string) => void;
  /** Dispatches a plain (non-epic) task directly from its card's inline ready-lane button.
   * Optional — omitting it (rather than requiring every caller to wire it up) simply hides
   * the inline action and leaves dispatching to the task detail view, the same as before this
   * card gained a ready-lane shortcut. */
  onDispatch?: (taskId: string) => Promise<void>;
  onWorkEpic: (epicId: string, concurrency: number) => Promise<void>;
  onStopEpic: (epicId: string) => Promise<void>;
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
   * `BoardView`'s column-major traversal. `undefined`/no match renders every card unfocused. */
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

// A card's draggable id doubles as its task id — plain `useDraggable`, not `useSortable`,
// since the board never persists intra-column order, only which column (status) a card sits
// in. This wrapper is the one place that calls the hook, so `TaskCardTile`/`EpicCardTile`
// stay ignorant of @dnd-kit beyond the small `CardDragProps` shape they already accept.
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

// One column's card stack, droppable by status id — a plain `useDroppable` zone (not wrapped
// in a `SortableContext`, matching `DraggableCard`'s plain-draggable choice above) so an empty
// column stays a valid drop target with no cards inside it to anchor to.
function DroppableColumn({
  status,
  children,
}: {
  status: string;
  children: React.ReactNode;
}) {
  const { setNodeRef, isOver } = useDroppable({ id: status });
  return (
    <div
      ref={setNodeRef}
      data-over={isOver}
      className={cn(
        'flex min-h-16 flex-1 flex-col gap-2 overflow-y-auto rounded-lg p-1 transition-colors duration-150',
        'data-[over=true]:bg-accent/40 data-[over=true]:ring-1 data-[over=true]:ring-ring/40'
      )}
    >
      {children}
    </div>
  );
}

/** One column per tracker status, in the order the project's `.dispatch/config.yml` lists
 * them — never a hardcoded status list, so a custom tracker config reshapes the board
 * automatically (grouping itself is `lib/boardGrouping.ts`'s pure, unit-tested
 * `groupTasksByStatus`, rather than a per-status filter inlined here).
 *
 * Drag-and-drop (the board's core interaction): a `PointerSensor` with a 6px activation
 * distance so an ordinary click still opens the peek panel and the inline Dispatch button
 * still works (only a real drag — pointer travel past the threshold — ever picks a card up),
 * plus a `KeyboardSensor` for accessible drag (Space lifts/drops the focused card; arrow keys
 * move it). Dropping onto a different column calls `onMoveStatus`, which `BoardView` wires to
 * the already-optimistic `moveTaskStatus`. `DragOverlay` renders a lifted copy of whichever
 * card is being dragged so the original can fade out in place instead of visibly jumping.
 *
 * Columns render as open lanes sitting directly on the page background (a header row, then a
 * card stack) rather than bordered/backgrounded boxes. */
export function TaskBoard({
  tasks,
  statuses,
  readyIds,
  blockedIds,
  liveRunStateByTaskId,
  latestRunByTaskId,
  epicProgressById,
  epicConcurrencyDefault,
  epics,
  swimLanes = false,
  onRequestWorkEpic,
  onSelect,
  onDispatch,
  onWorkEpic,
  onStopEpic,
  onMoveStatus,
  onEditTask,
  onAddTask,
  focusedTaskId = null,
  onCardFocus,
  archivedTaskIds = NO_ARCHIVED_IDS,
}: TaskBoardProps) {
  const columns = groupTasksByStatus(tasks, statuses);
  // Epic swim lanes: the same status columns, repeated per epic. Reads as a grid of epics
  // against statuses, which answers "which epic is stuck" rather than "what is in review".
  const lanes = groupTasksByEpicLane(tasks, statuses, epics);
  const [activeTaskId, setActiveTaskId] = useState<string | null>(null);

  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of epics) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [epics]);

  const taskById = useMemo(() => {
    const map = new Map<string, TaskDoc>();
    for (const doc of tasks) map.set(doc.meta.id, doc);
    return map;
  }, [tasks]);

  // Every epic's children, bucketed in one pass — feeds `EpicCardTile`'s dependency-graph
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
    const targetStatus = event.over?.id;
    if (targetStatus === undefined || onMoveStatus === undefined) return;
    const taskId = String(event.active.id);
    const doc = taskById.get(taskId);
    if (doc === undefined || doc.meta.status === targetStatus) return;
    void onMoveStatus(taskId, String(targetStatus));
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
      {swimLanes ? (
        <div className="flex h-full min-h-0 flex-col gap-5 overflow-auto pb-2">
          {lanes.length === 0 ? (
            <p className="text-muted-foreground px-0.5 text-[12.5px]">
              No tasks yet.
            </p>
          ) : (
            lanes.map((lane) => (
              <section key={lane.epicId ?? '__none__'}>
                <div className="mb-2 flex items-center gap-2 px-0.5">
                  <Layers className="text-primary size-3.5 shrink-0" />
                  <span className="truncate text-[13px] font-medium">
                    {lane.title}
                  </span>
                  <span className="dense-meta">{lane.total}</span>
                  <span
                    aria-hidden
                    className="h-px flex-1 bg-[linear-gradient(to_right,var(--border-default),transparent_70%)]"
                  />
                </div>
                <div className="flex gap-6">
                  {lane.columns.map(({ status, tasks: laneTasks }) => (
                    <div
                      key={status}
                      className="flex w-[248px] shrink-0 flex-col gap-2"
                    >
                      <div className="flex items-center gap-1.5 px-0.5">
                        <StatusIcon status={status} />
                        <span className="dense-label truncate">{status}</span>
                        <span className="dense-meta">{laneTasks.length}</span>
                      </div>
                      {/* Droppable per lane+status so dragging within a lane still changes
                          status, and an empty column keeps its shape rather than collapsing
                          and knocking the lanes out of alignment. */}
                      <DroppableColumn status={status}>
                        {laneTasks.length === 0 && (
                          <div className="text-muted-foreground/40 min-h-8 px-0.5 py-1 text-[11px]" />
                        )}
                        {laneTasks.map((doc) => (
                          <TaskCardTile
                            key={doc.meta.id}
                            doc={doc}
                            ready={readyIds.has(doc.meta.id)}
                            blocked={blockedIds.has(doc.meta.id)}
                            liveRunState={liveRunStateByTaskId.get(doc.meta.id)}
                            run={latestRunByTaskId.get(doc.meta.id)}
                            // No epic breadcrumb inside a lane: the lane heading already says
                            // which epic this is, so repeating it on every card is noise.
                            epicTitle={undefined}
                            statuses={statuses}
                            onStatusChange={(status) =>
                              void onMoveStatus?.(doc.meta.id, status)
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
                            archived={archivedTaskIds.has(doc.meta.id)}
                          />
                        ))}
                      </DroppableColumn>
                    </div>
                  ))}
                </div>
              </section>
            ))
          )}
        </div>
      ) : (
        <div className="flex h-full min-h-0 gap-6 overflow-x-auto pb-2">
          {columns.map(({ status, tasks: columnTasks }) => (
            <div
              key={status}
              className="flex w-[272px] shrink-0 flex-col gap-2"
            >
              <div className="group/header flex items-center gap-1.5 px-0.5">
                <StatusIcon status={status} />
                <span className="text-muted-foreground truncate text-[11px] font-medium">
                  {status}
                </span>
                <span className="text-muted-foreground/60 font-mono text-[11px]">
                  {columnTasks.length}
                </span>
                {onAddTask !== undefined && (
                  <button
                    type="button"
                    onClick={() => onAddTask(status)}
                    aria-label={`New task in ${status}`}
                    className="text-muted-foreground hover:bg-accent hover:text-foreground ml-auto rounded-md p-0.5 opacity-0 transition-opacity duration-150 group-hover/header:opacity-100 focus-visible:opacity-100"
                  >
                    <Plus className="size-3.5" />
                  </button>
                )}
              </div>
              <DroppableColumn status={status}>
                {columnTasks.length === 0 && (
                  <div className="text-muted-foreground/50 px-0.5 py-1 text-[11px]">
                    No tasks
                  </div>
                )}
                {columnTasks.map((doc) => (
                  <DraggableCard
                    key={doc.meta.id}
                    id={doc.meta.id}
                    disabled={archivedTaskIds.has(doc.meta.id)}
                  >
                    {(drag) =>
                      doc.meta.kind === 'epic' ? (
                        <EpicCardTile
                          doc={doc}
                          progress={epicProgressById.get(doc.meta.id)}
                          concurrencyDefault={epicConcurrencyDefault}
                          childTasks={childrenByEpicId.get(doc.meta.id) ?? []}
                          onSelect={() => onSelect(doc.meta.id)}
                          onWork={onWorkEpic}
                          onRequestWork={onRequestWorkEpic}
                          onStop={onStopEpic}
                          onOpenTask={onSelect}
                          focused={doc.meta.id === focusedTaskId}
                          onFocus={() => onCardFocus?.(doc.meta.id)}
                          drag={drag}
                        />
                      ) : (
                        <TaskCardTile
                          doc={doc}
                          ready={readyIds.has(doc.meta.id)}
                          blocked={blockedIds.has(doc.meta.id)}
                          liveRunState={liveRunStateByTaskId.get(doc.meta.id)}
                          run={latestRunByTaskId.get(doc.meta.id)}
                          epicTitle={
                            doc.meta.parent !== null
                              ? epicTitleById.get(doc.meta.parent)
                              : undefined
                          }
                          statuses={statuses}
                          onStatusChange={(status) =>
                            void onMoveStatus?.(doc.meta.id, status)
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
                          archived={archivedTaskIds.has(doc.meta.id)}
                        />
                      )
                    }
                  </DraggableCard>
                ))}
              </DroppableColumn>
            </div>
          ))}
        </div>
      )}
      <DragOverlay>
        {activeDoc !== undefined &&
          (activeDoc.meta.kind === 'epic' ? (
            <div className="w-[272px] scale-[1.02] cursor-grabbing shadow-lg">
              <EpicCardTile
                doc={activeDoc}
                progress={epicProgressById.get(activeDoc.meta.id)}
                concurrencyDefault={epicConcurrencyDefault}
                onSelect={() => {}}
                onWork={async () => {}}
                onStop={async () => {}}
              />
            </div>
          ) : (
            <div className="w-[272px] scale-[1.02] cursor-grabbing shadow-lg">
              <TaskCardTile
                doc={activeDoc}
                ready={readyIds.has(activeDoc.meta.id)}
                blocked={blockedIds.has(activeDoc.meta.id)}
                liveRunState={liveRunStateByTaskId.get(activeDoc.meta.id)}
                run={latestRunByTaskId.get(activeDoc.meta.id)}
                epicTitle={
                  activeDoc.meta.parent !== null
                    ? epicTitleById.get(activeDoc.meta.parent)
                    : undefined
                }
                statuses={statuses}
                onStatusChange={() => {}}
                onEditTask={() => {}}
                onClick={() => {}}
              />
            </div>
          ))}
      </DragOverlay>
    </DndContext>
  );
}
