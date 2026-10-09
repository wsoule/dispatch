import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isContainerKind } from '@dispatch-foo/core/browser';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { isTypingTarget } from '../../hooks/useGlobalKeyboard';
import {
  type BoardLane,
  columnSuccessor,
  groupTasksByLane,
  visibleBoardColumns,
  visibleLaneTaskIds,
} from '../../lib/boardGrouping';
import {
  COLLAPSED_LANES_STORAGE_KEY,
  readCollapsedGroups,
  toggleCollapsedGroup,
  writeCollapsedGroups,
} from '../../lib/collapsedEpics';
import type { WorkEpicOptions } from '../../lib/epicSession';
import { resolveListKeyCommand } from '../../lib/keyboard';
import { landingStateByTaskId } from '../../lib/landingBadge';
import { sortTasks } from '../../lib/listGrouping';
import { useStatusModelOf } from '../../lib/statusModel';
import type { TasksDisplayPrefs } from '../../lib/tasksPrefs';
import { DispatchDialog } from './DispatchDialog';
import { TaskBoard } from './TaskBoard';
import { liveClaimsFrom } from '@/lib/dispatchPreview';

/** Session keys for the columns folded to a strip or hidden from a column's `···` menu —
 * the same "out of my way for now" lifetime as collapsed epic lanes. */
const COLLAPSED_COLUMNS_STORAGE_KEY = 'dispatch:board-collapsed-columns';
const HIDDEN_COLUMNS_STORAGE_KEY = 'dispatch:board-hidden-columns';

// Reads a session-scoped collapsed set without touching storage during SSR/tests that
// stub `window` away.
function readSessionSet(key: string): Set<string> {
  return typeof window === 'undefined' ? new Set() : readCollapsedGroups(key);
}

interface BoardPaneProps {
  data: DispatchProjectData;
  /** Columns are always status; lanes follow `subGrouping`, cards `ordering`. */
  display: TasksDisplayPrefs;
  /** The page's filter as one predicate; omitted passes everything. */
  taskFilter?: (doc: TaskListItem) => boolean;
  onSelectTask: (taskId: string) => void;
  /** `f` on the board: the page header opens its filter menu. */
  onRequestFilter?: () => void;
  /** `⇧V` on the board: the page header opens its Display popover. */
  onRequestDisplay?: () => void;
}

/**
 * The Kanban layout of the Tasks page:
 * status columns (fold to a strip, hide from a column's menu), swim lanes by Display ›
 * Sub-grouping that fold too, the fan-out dialog a lane's Send agents… opens, and j/k
 * roving focus that runs lane by lane, column-major inside a lane, over the cards on
 * screen. Collapsed lanes and columns are session-scoped.
 */
export function BoardPane({
  data,
  display,
  taskFilter,
  onSelectTask,
  onRequestFilter,
  onRequestDisplay,
}: BoardPaneProps) {
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  // Lifted here rather than kept inside `TaskBoard` because the j/k cursor has to skip the
  // cards a collapsed lane is hiding.
  const [collapsedLaneKeys, setCollapsedLaneKeys] = useState<
    ReadonlySet<string>
  >(() => readSessionSet(COLLAPSED_LANES_STORAGE_KEY));
  const [collapsedColumns, setCollapsedColumns] = useState<ReadonlySet<string>>(
    () => readSessionSet(COLLAPSED_COLUMNS_STORAGE_KEY)
  );
  const [hiddenColumns, setHiddenColumns] = useState<ReadonlySet<string>>(() =>
    readSessionSet(HIDDEN_COLUMNS_STORAGE_KEY)
  );
  // The fan-out dialog, open for one epic: `start` sends a fresh session from a lane
  // header's Send agents…, `raise` edits a paused one's ceilings.
  const [dispatchEpic, setDispatchEpic] = useState<{
    epicId: string;
    mode: 'start' | 'raise';
  } | null>(null);

  useEffect(() => {
    writeCollapsedGroups(COLLAPSED_LANES_STORAGE_KEY, collapsedLaneKeys);
  }, [collapsedLaneKeys]);

  useEffect(() => {
    writeCollapsedGroups(COLLAPSED_COLUMNS_STORAGE_KEY, collapsedColumns);
  }, [collapsedColumns]);

  useEffect(() => {
    writeCollapsedGroups(HIDDEN_COLUMNS_STORAGE_KEY, hiddenColumns);
  }, [hiddenColumns]);

  const laneBy = display.subGrouping;
  const model = useStatusModelOf(data.config);
  // With Display › Show archived on, archived tasks join the board so their (typically done)
  // column shows them dimmed — `data.tasks` stays untouched so every other consumer keeps its
  // archived-excluded meaning.
  const boardTasks = useMemo(
    () =>
      data.showArchived ? [...data.tasks, ...data.archivedTasks] : data.tasks,
    [data.tasks, data.archivedTasks, data.showArchived]
  );
  const archivedTaskIds = useMemo(
    () => new Set(data.archivedTasks.map((t) => t.meta.id)),
    [data.archivedTasks]
  );
  const landingByTaskId = useMemo(
    () => landingStateByTaskId(data.mergeQueue),
    [data.mergeQueue]
  );
  const epicIds = useMemo(
    () => new Set(data.epics.map((e) => e.meta.id)),
    [data.epics]
  );
  const epicTitleById = useMemo(
    () => new Map(data.epics.map((e) => [e.meta.id, e.meta.title])),
    [data.epics]
  );
  const filteredBoardTasks = useMemo(() => {
    const passing =
      taskFilter === undefined ? boardTasks : boardTasks.filter(taskFilter);
    // A sub-task is a task whose parent is another task (an epic's children are members);
    // Display › Show sub-tasks off hides those, as on the list.
    return display.showSubtasks
      ? passing
      : passing.filter(
          (doc) => doc.meta.parent === null || epicIds.has(doc.meta.parent)
        );
  }, [boardTasks, taskFilter, display.showSubtasks, epicIds]);
  // Sorted here, once, so the j/k cursor below and `TaskBoard` walk the same sequence.
  const orderedBoardTasks = useMemo(
    () => sortTasks(filteredBoardTasks, display, model),
    [filteredBoardTasks, display, model]
  );
  // Card counts per status from the *unfiltered* board set — empty-column visibility is
  // decided from these, so a filter narrows cards without making columns vanish.
  const countByStatus = useMemo(() => {
    const map = new Map<string, number>();
    for (const doc of boardTasks) {
      if (isContainerKind(doc.meta.kind)) continue;
      map.set(doc.meta.status, (map.get(doc.meta.status) ?? 0) + 1);
    }
    return map;
  }, [boardTasks]);
  // Keyed on its contents: every card takes this array, so a dispatch that moves a count
  // but no column must hand them the same one or they all redraw.
  const visibleStatusKey = useMemo(
    () =>
      data.config !== null
        ? visibleBoardColumns(
            data.config.statuses,
            countByStatus,
            display.showEmptyGroups,
            hiddenColumns
          ).join('\0')
        : '',
    [data.config, countByStatus, display.showEmptyGroups, hiddenColumns]
  );
  const visibleStatuses = useMemo(
    () => (visibleStatusKey === '' ? [] : visibleStatusKey.split('\0')),
    [visibleStatusKey]
  );
  // The same lanes `TaskBoard` renders, from the same pure functions over the same sorted
  // input — this copy exists only to give the j/k cursor an order that matches the screen.
  const lanes = useMemo<BoardLane[]>(
    () =>
      data.config === null
        ? []
        : groupTasksByLane(
            orderedBoardTasks,
            visibleStatuses,
            data.epics,
            display.subGrouping
          ),
    [
      orderedBoardTasks,
      data.config,
      visibleStatuses,
      data.epics,
      display.subGrouping,
    ]
  );
  const orderedTaskIds = useMemo(
    () =>
      visibleLaneTaskIds(
        lanes,
        laneBy !== 'none' ? collapsedLaneKeys : new Set()
      ),
    [lanes, collapsedLaneKeys, laneBy]
  );

  // A card's Dispatch and `d`: in place and optimistic, like the Cockpit's — the card moves
  // to the dispatched column at once.
  const handleDispatch = data.handleDispatch;
  const readyIds = data.readyIds;
  const dispatchInPlace = useCallback(
    (taskId: string) =>
      handleDispatch(taskId, undefined, undefined, { optimistic: true }),
    [handleDispatch]
  );
  // What a dispatch reads when it runs, so the card's Dispatch keeps one identity.
  const shown = useRef({ lanes, cursor: focusedTaskId });
  useLayoutEffect(() => {
    shown.current = { lanes, cursor: focusedTaskId };
  });
  // `d` and a card's Dispatch (clicking it focuses the card first): the card moves to
  // another column, and the cursor stays where it was, on the card that slides into its
  // place — in the same render, or the cursor follows the card and the board scrolls to it.
  const dispatchCard = useCallback(
    (taskId: string) => {
      const { lanes: onScreen, cursor } = shown.current;
      if (taskId === cursor) {
        const next = columnSuccessor(onScreen, taskId);
        if (next !== undefined) setFocusedTaskId(next);
      }
      return dispatchInPlace(taskId);
    },
    [dispatchInPlace]
  );

  function handleBoardKeyDown(e: React.KeyboardEvent) {
    // A keydown that lands on (or inside) one of the track's own interactive controls — an
    // epic lane header's buttons or pickers, a column's menu, a card's Dispatch button.
    // Task cards are role="button" divs (not real <button>s), so they fall through to the
    // roving-cursor logic as intended.
    const controlEl = (e.target as HTMLElement).closest(
      'button, a, select, input, textarea, [contenteditable="true"]'
    );
    const onControl = controlEl !== null && controlEl !== e.currentTarget;
    const command = resolveListKeyCommand(
      { key: e.key, metaKey: e.metaKey, ctrlKey: e.ctrlKey },
      { isTyping: isTypingTarget(e.target) }
    );
    if (command === null) return;
    if (command === 'list-open-filter') {
      if (onRequestFilter === undefined) return;
      e.preventDefault();
      onRequestFilter();
      return;
    }
    if (command === 'list-open-display') {
      if (onRequestDisplay === undefined) return;
      e.preventDefault();
      onRequestDisplay();
      return;
    }
    if (orderedTaskIds.length === 0) return;
    // Enter/Space belong to whatever control has focus — activating it, not opening the card the
    // cursor happens to be on. j/k are nobody's activation key, so they keep steering the board
    // from a control too.
    if (command === 'list-confirm' || command === 'list-open') {
      if (onControl) return;
      e.preventDefault();
      if (focusedTaskId !== null) onSelectTask(focusedTaskId);
      return;
    }
    if (command === 'list-dispatch') {
      if (focusedTaskId === null || !readyIds.has(focusedTaskId)) return;
      e.preventDefault();
      void dispatchCard(focusedTaskId);
      return;
    }
    if (command !== 'list-down' && command !== 'list-up') return;
    e.preventDefault();
    const currentIndex =
      focusedTaskId !== null ? orderedTaskIds.indexOf(focusedTaskId) : -1;
    const nextIndex =
      command === 'list-down'
        ? Math.min(currentIndex + 1, orderedTaskIds.length - 1)
        : Math.max(currentIndex - 1, 0);
    setFocusedTaskId(orderedTaskIds[Math.max(nextIndex, 0)] ?? null);
  }

  // Only a raise pre-fills from the session; a fresh fan-out starts from the defaults.
  const dialogSession =
    dispatchEpic?.mode === 'raise'
      ? (data.epicProgressById.get(dispatchEpic.epicId)?.session ?? null)
      : null;

  return (
    <>
      {/* `tabIndex={0}` puts the track itself in the natural tab order (so someone can
          Tab/click into the board and start using j/k immediately) — the individual cards
          remain the real roving-focus targets once `focusedTaskId` moves onto one of them. */}
      <div
        data-testid="board-pane"
        className="min-h-0 flex-1 px-4 py-3 outline-none"
        tabIndex={0}
        onKeyDown={handleBoardKeyDown}
      >
        <TaskBoard
          collapsedLaneKeys={collapsedLaneKeys}
          onToggleLane={(key) =>
            setCollapsedLaneKeys((prev) => toggleCollapsedGroup(prev, key))
          }
          collapsedColumns={collapsedColumns}
          onToggleColumnCollapsed={(status) =>
            setCollapsedColumns((prev) => toggleCollapsedGroup(prev, status))
          }
          onHideColumn={(status) =>
            setHiddenColumns((prev) => new Set([...prev, status]))
          }
          hiddenColumnCount={hiddenColumns.size}
          onShowHiddenColumns={() => setHiddenColumns(new Set())}
          onRequestWorkEpic={(epicId) =>
            setDispatchEpic({ epicId, mode: 'start' })
          }
          tasks={orderedBoardTasks}
          archivedTaskIds={archivedTaskIds}
          statusModel={model}
          statuses={visibleStatuses}
          display={display}
          readyIds={data.readyIds}
          blockedIds={data.blockedIds}
          liveRunStateByTaskId={data.liveRunStateByTaskId}
          latestRunByTaskId={data.latestRunByTaskId}
          readinessById={data.readinessById}
          attentionByTaskId={data.attentionByTaskId}
          landingByTaskId={landingByTaskId}
          epicProgressById={data.epicProgressById}
          epicConcurrencyDefault={
            data.config?.orchestrator.epicConcurrency ?? 3
          }
          epics={data.epics}
          onSelect={onSelectTask}
          onDispatch={dispatchCard}
          onWorkEpic={data.handleWorkEpic}
          onPauseEpic={data.handlePauseEpic}
          onResumeEpic={data.handleResumeEpic}
          onRaiseCeilingEpic={(epicId) =>
            setDispatchEpic({ epicId, mode: 'raise' })
          }
          onStopEpic={data.handleStopEpic}
          onLandEpic={data.handleLandEpic}
          onMoveStatus={data.moveTaskStatus}
          onEditTask={data.handleUpdate}
          focusedTaskId={focusedTaskId}
          onCardFocus={setFocusedTaskId}
        />
      </div>
      {dispatchEpic !== null && (
        <DispatchDialog
          title={`${dispatchEpic.mode === 'raise' ? 'Raise ceiling' : 'Send agents'} · ${epicTitleById.get(dispatchEpic.epicId) ?? dispatchEpic.epicId}`}
          tasks={data.tasks.filter(
            (t) => t.meta.parent === dispatchEpic.epicId
          )}
          readyIds={data.readyIds}
          runningNow={data.liveRunStateByTaskId.size}
          liveClaims={liveClaimsFrom(data.runs)}
          defaultConcurrency={data.config?.orchestrator.epicConcurrency ?? 3}
          maxConcurrency={data.config?.orchestrator.maxConcurrency}
          runCostEstimateUsd={data.config?.orchestrator.runCostEstimateUsd}
          fixLoopAuto={data.config?.fixLoop.auto}
          mode={dispatchEpic.mode}
          initial={
            dialogSession !== null
              ? {
                  concurrency: dialogSession.concurrency,
                  maxSpendUsd: dialogSession.maxSpendUsd,
                  maxRuns: dialogSession.maxRuns,
                }
              : undefined
          }
          onCancel={() => setDispatchEpic(null)}
          onConfirm={async (opts: WorkEpicOptions) => {
            if (dispatchEpic.mode === 'raise') {
              await data.handleResumeEpic(dispatchEpic.epicId, opts);
            } else {
              await data.handleWorkEpic(dispatchEpic.epicId, opts);
            }
            setDispatchEpic(null);
          }}
        />
      )}
    </>
  );
}
