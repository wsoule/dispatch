import type { TaskListItem } from '@dispatch-foo/core/browser';
import { isContainerKind } from '@dispatch-foo/core/browser';
import { Ellipsis, Layers, Star } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useSavedViewsContext } from '../components/shell/SavedViewsContext';
import { AppliedFilters } from '../components/tasks/AppliedFilters';
import { DispatchDialog } from '../components/tasks/DispatchDialog';
import { DisplayPopover } from '../components/tasks/DisplayPopover';
import { FilterMenu } from '../components/tasks/FilterMenu';
import { SaveViewDialog } from '../components/tasks/SaveViewDialog';
import { TaskBoard } from '../components/tasks/TaskBoard';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { isTypingTarget } from '../hooks/useGlobalKeyboard';
import type { TaskTab } from '../lib/appNav';
import {
  type BoardLane,
  columnSuccessor,
  groupTasksByLane,
  visibleBoardColumns,
  visibleLaneTaskIds,
} from '../lib/boardGrouping';
import {
  COLLAPSED_LANES_STORAGE_KEY,
  readCollapsedGroups,
  toggleCollapsedGroup,
  writeCollapsedGroups,
} from '../lib/collapsedEpics';
import type { WorkEpicOptions } from '../lib/epicSession';
import { resolveListKeyCommand } from '../lib/keyboard';
import { landingStateByTaskId } from '../lib/landingBadge';
import { sortTasks } from '../lib/listGrouping';
import { countMergeReady } from '../lib/mergeReady';
import { viewMatches } from '../lib/savedViews';
import { useStatusModelOf } from '../lib/statusModel';
import {
  applyTaskFilters,
  EMPTY_TASK_FILTER_SET,
  type FilterContext,
  hasActiveTaskFilters,
  matchesTaskFilterSet,
  parseTaskFilterSet,
  serializeTaskFilterSet,
  TASK_FILTERS_V2_STORAGE_KEY,
  type TaskFilterSet,
  taskFilterSetFromValue,
} from '../lib/taskFilters';
import {
  parseTasksDisplay,
  serializeTasksDisplay,
  TASK_FILTERS_STORAGE_KEY,
  TASKS_DISPLAY_STORAGE_KEY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import {
  TASKS_VIEW_TABS,
  type TasksViewMode,
  useTasksViewMode,
} from '../lib/tasksViewMode';
import { MilestoneBranchesView } from './MilestoneBranchesView';
import { type FocusEpicRequest, MilestonesView } from './MilestonesView';
import { TasksListView } from './TasksListView';
import { liveClaimsFrom } from '@/lib/dispatchPreview';
import { IconButton } from '@/ui/ai/icon-button';
import {
  HeaderIconTriad,
  PageHeader,
  SidePanelIconButton,
  type ViewTab,
  ViewTabs,
} from '@/ui/ai/page-header';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Skeleton } from '@/ui/skeleton';

/** Session keys for the columns folded to a strip or hidden from a column's `···` menu —
 * the same "out of my way for now" lifetime as collapsed epic lanes. */
const COLLAPSED_COLUMNS_STORAGE_KEY = 'dispatch:board-collapsed-columns';
const HIDDEN_COLUMNS_STORAGE_KEY = 'dispatch:board-hidden-columns';
/** Session key for the saved view this page last applied — see the apply effect below. */
const APPLIED_VIEW_STORAGE_KEY = 'dispatch:board-applied-view';

/** A saved view's tab id, so the tab list can tell it from a layout's. */
const VIEW_TAB_PREFIX = 'view:';

/** The name prompt the header opens: a new view (starred when the star opened it) or a
 * rename of the active one. */
type ViewDialog = { mode: 'create'; favorite: boolean } | { mode: 'rename' };

interface BoardViewProps {
  data: DispatchProjectData;
  /** The layout to open in when nothing is remembered yet; the header's view tabs own it from
   * there (and persist it), and a persisted choice wins over this on every later mount. */
  mode?: TasksViewMode;
  /** The active project's display name, the first crumb segment. */
  projectName?: string | null;
  /** A one-shot "go to this milestone" from another surface (Plans' confirm, the live
   * rail): switches to the milestones layout, which expands and scrolls to the epic and
   * opens the fan-out dialog when asked. */
  focusEpic?: FocusEpicRequest | null;
  /** Bare `taskId` is a row click (the peek); the milestones layout's phase drill also
   * names the tab (and the run) a child's phase points at, which needs the full view. */
  onSelectTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** Opens `CreateTaskModal`, optionally pre-set to a status — the empty state's `New task`. */
  onNewTask: (status?: string) => void;
  onPlanWork: () => void;
}

// Reads a session-scoped collapsed set without touching storage during SSR/tests that
// stub `window` away.
function readSessionSet(key: string): Set<string> {
  return typeof window === 'undefined' ? new Set() : readCollapsedGroups(key);
}

// The id of the view the page last applied, tolerating a missing or blocked session store
// (the worst case is one extra apply on a remount).
function readAppliedView(): string | null {
  try {
    return window.sessionStorage.getItem(APPLIED_VIEW_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeAppliedView(id: string | null): void {
  try {
    if (id === null) window.sessionStorage.removeItem(APPLIED_VIEW_STORAGE_KEY);
    else window.sessionStorage.setItem(APPLIED_VIEW_STORAGE_KEY, id);
  } catch {
    // A blocked store just means a remount re-applies the view.
  }
}

/** Skeleton placeholder for the board while tasks/config load: the column geometry the
 * real board renders (348px columns, 44px headers, 322px cards with 8px corners). */
function BoardSkeleton() {
  return (
    <div
      data-slot="board-skeleton"
      className="flex h-full min-h-0 overflow-hidden px-4 py-3"
    >
      {Array.from({ length: 4 }, (_, columnIndex) => (
        <div
          key={columnIndex}
          className="flex w-[348px] shrink-0 flex-col px-3"
        >
          <div className="flex h-11 items-center gap-2">
            <Skeleton className="size-3.5 rounded-full" />
            <Skeleton className="h-3 w-16" />
          </div>
          <div className="flex flex-col gap-2">
            {Array.from({ length: 3 }, (_, cardIndex) => (
              <Skeleton
                key={cardIndex}
                className="rounded-card h-[104px] w-[322px]"
              />
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}

// A thin line-art board for the empty state: three columns with a card or two each.
function BoardLineArt() {
  return (
    <svg viewBox="0 0 60 60" fill="none" stroke="currentColor" aria-hidden>
      <rect x="4" y="8" width="15" height="44" rx="2" />
      <rect x="22.5" y="8" width="15" height="44" rx="2" />
      <rect x="41" y="8" width="15" height="44" rx="2" />
      <rect x="7" y="13" width="9" height="6" rx="1" />
      <rect x="7" y="22" width="9" height="6" rx="1" />
      <rect x="25.5" y="13" width="9" height="6" rx="1" />
      <rect x="44" y="13" width="9" height="6" rx="1" />
      <rect x="44" y="22" width="9" height="6" rx="1" />
      <rect x="44" y="31" width="9" height="6" rx="1" />
    </svg>
  );
}

/**
 * The Tasks page: Linear's two-row panel header (`Project › Tasks`, the favourite star and
 * the ghost actions, then the Board | List | Milestones | Branches view tabs — plus one per
 * saved view — and the Filter / Display / side-panel triad) over one of four layouts.
 * `board` is the kanban — status columns on the bare panel, split into swim lanes by
 * Display › Sub-grouping (epic, assignee or priority; the side-panel toggle flips epic
 * lanes); `list` is the grouped list; `milestones` groups the same tasks by milestone;
 * `branches` draws each milestone's tasks as a git-log graph with the critical path on the
 * trunk. The Display popover writes the one `TasksDisplayPrefs` every layout reads, and the
 * Filter menu's clauses (typed, or asked of the daemon's AI filter) apply before grouping on
 * all four.
 *
 * Saved views (`useSavedViewsContext`, null outside App's provider): selecting one applies
 * its filters and display, `Save view…` / `Update view` snapshot the current ones, and the
 * star favorites the active view. Without the provider the header shows none of it.
 *
 * j/k/Enter roving focus: the Board's own traversal runs lane by lane and column-major
 * inside a lane over the cards actually on screen (a collapsed epic's cards are skipped) —
 * see `handleBoardKeyDown`; the List's is row-major (see `TasksListView`). `f` opens the
 * filter menu and `⇧V` the Display popover from either.
 */
export function BoardView({
  data,
  mode: initialMode,
  projectName,
  focusEpic = null,
  onSelectTask,
  onNewTask,
  onPlanWork,
}: BoardViewProps) {
  const [mode, setMode] = useTasksViewMode(initialMode);
  // The focus request the tabs have since left behind: the milestones layout serves a
  // request on mount, so one that is still held when the user comes back would replay
  // its expand/scroll/dialog without this.
  const [retiredFocusNonce, setRetiredFocusNonce] = useState<number | null>(
    null
  );
  const [focusedTaskId, setFocusedTaskId] = useState<string | null>(null);
  // Which lanes are folded up. Session-scoped (see `collapsedEpics.ts`) and lifted to the
  // view rather than kept inside `TaskBoard` because the j/k cursor below has to skip the cards a
  // collapsed lane is hiding.
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
  // The filter clauses and the display model, persisted across restarts — see
  // `taskFilters.ts` / `tasksPrefs.ts` for the parse/defaults and the v1 filter migration.
  const [filters, setFilters] = useState<TaskFilterSet>(() =>
    parseTaskFilterSet(
      window.localStorage.getItem(TASK_FILTERS_V2_STORAGE_KEY),
      window.localStorage.getItem(TASK_FILTERS_STORAGE_KEY)
    )
  );
  const [prefs, setPrefs] = useState<TasksDisplayPrefs>(() =>
    parseTasksDisplay(window.localStorage.getItem(TASKS_DISPLAY_STORAGE_KEY))
  );
  // The header menus' open state lives here so the list's `f` / `⇧V` can open them.
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  // "Merge all ready" action state — the Board's copy of the merge queue's control.
  const [mergeAllPending, setMergeAllPending] = useState(false);
  const [viewDialog, setViewDialog] = useState<ViewDialog | null>(null);
  const savedViews = useSavedViewsContext();
  const activeView = savedViews?.activeView ?? null;
  const activeViewId = savedViews?.activeViewId ?? null;

  useEffect(() => {
    window.localStorage.setItem(
      TASK_FILTERS_V2_STORAGE_KEY,
      serializeTaskFilterSet(filters)
    );
  }, [filters]);

  useEffect(() => {
    window.localStorage.setItem(
      TASKS_DISPLAY_STORAGE_KEY,
      serializeTasksDisplay(prefs)
    );
  }, [prefs]);

  useEffect(() => {
    writeCollapsedGroups(COLLAPSED_LANES_STORAGE_KEY, collapsedLaneKeys);
  }, [collapsedLaneKeys]);

  useEffect(() => {
    writeCollapsedGroups(COLLAPSED_COLUMNS_STORAGE_KEY, collapsedColumns);
  }, [collapsedColumns]);

  useEffect(() => {
    writeCollapsedGroups(HIDDEN_COLUMNS_STORAGE_KEY, hiddenColumns);
  }, [hiddenColumns]);

  // The layout switch keeps `prefs.layout` in step so a reader of the display model alone
  // agrees with the tabs. Leaving the milestones layout retires the focus request it was
  // showing.
  const changeMode = useCallback(
    (next: TasksViewMode) => {
      setMode(next);
      setPrefs((prev) =>
        prev.layout === next ? prev : { ...prev, layout: next }
      );
      if (next !== 'milestones' && focusEpic !== null) {
        setRetiredFocusNonce(focusEpic.nonce);
      }
    },
    [setMode, focusEpic]
  );

  // A new focus request lands on the milestones layout whichever tab is showing.
  useEffect(() => {
    if (focusEpic !== null && focusEpic.nonce !== retiredFocusNonce) {
      changeMode('milestones');
    }
  }, [focusEpic, retiredFocusNonce, changeMode]);
  const milestoneFocus =
    focusEpic !== null && focusEpic.nonce !== retiredFocusNonce
      ? focusEpic
      : null;

  // Applies the active saved view when a pick changes it — including a pick from the rail
  // or palette made while another page was up, which lands here when the view mounts. The
  // session store remembers the id last applied so a plain remount (back from a task page)
  // with the same view active keeps the edits made on top of it instead of resetting them
  // to the snapshot `Update view` exists to save; leaving the view clears the marker so
  // picking it again is a fresh apply. The api and `changeMode` are read through a ref: the
  // view object's identity changes on every store write, and that must not re-apply either.
  const applyViewRef = useRef<(id: string) => void>(() => {});
  applyViewRef.current = (id) => {
    const view = savedViews?.views.find((v) => v.id === id);
    if (view === undefined) return;
    setFilters(view.filters);
    setPrefs(view.display);
    changeMode(view.display.layout);
  };
  useEffect(() => {
    if (activeViewId === null) {
      writeAppliedView(null);
      return;
    }
    if (activeViewId === readAppliedView()) return;
    applyViewRef.current(activeViewId);
    writeAppliedView(activeViewId);
  }, [activeViewId]);

  // Board lanes follow Display › Sub-grouping (`groupTasksByLane`); the side-panel toggle
  // flips the epic lanes on and off.
  const laneBy = prefs.subGrouping;
  const toggleEpicLanes = () =>
    setPrefs((prev) => ({
      ...prev,
      subGrouping: prev.subGrouping === 'epic' ? 'none' : 'epic',
    }));

  // The project's statuses in the render its config lands: done sinks and lanes roll up by it.
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
  const filterContext = useMemo<FilterContext>(
    () => ({
      liveRunStateByTaskId: data.liveRunStateByTaskId,
      epicTitleById,
    }),
    [data.liveRunStateByTaskId, epicTitleById]
  );
  const filtersActive = hasActiveTaskFilters(filters);
  // The clauses as a predicate for the list/branches — `undefined` when nothing is active
  // so they skip a per-task closure call on the common unfiltered path.
  const taskFilterFn = useMemo(
    () =>
      filtersActive
        ? (doc: TaskListItem) =>
            matchesTaskFilterSet(doc, filters, filterContext)
        : undefined,
    [filtersActive, filters, filterContext]
  );
  const filteredBoardTasks = useMemo(() => {
    const passing = applyTaskFilters(boardTasks, filters, filterContext);
    // A sub-task is a task whose parent is another task (an epic's children are members);
    // Display › Show sub-tasks off hides those, as on the list.
    return prefs.showSubtasks
      ? passing
      : passing.filter(
          (doc) => doc.meta.parent === null || epicIds.has(doc.meta.parent)
        );
  }, [boardTasks, filters, filterContext, prefs.showSubtasks, epicIds]);
  // The cards in the order a column shows them (Display › Ordering, done sinking when asked).
  // Sorted here, once, so the j/k cursor below and `TaskBoard` walk the same sequence.
  const orderedBoardTasks = useMemo(
    () => sortTasks(filteredBoardTasks, prefs, model),
    [filteredBoardTasks, prefs, model]
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
            prefs.showEmptyGroups,
            hiddenColumns
          ).join('\0')
        : '',
    [data.config, countByStatus, prefs.showEmptyGroups, hiddenColumns]
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
            prefs.subGrouping
          ),
    [
      orderedBoardTasks,
      data.config,
      visibleStatuses,
      data.epics,
      prefs.subGrouping,
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
  // Everything the Filter menu can offer values for, from the project's own vocabulary.
  const filterMenuContext = useMemo(() => {
    const labels = new Set<string>();
    const milestones = new Set<string>();
    for (const doc of data.tasks) {
      for (const l of doc.meta.labels) labels.add(l);
      if (doc.meta.milestone !== null) milestones.add(doc.meta.milestone);
    }
    return {
      statuses: data.config?.statuses ?? [],
      epics: data.epics,
      labels: [...labels].sort(),
      milestones: [...milestones].sort(),
    };
  }, [data.tasks, data.config, data.epics]);
  const queuedRunIds = useMemo(
    () => new Set((data.mergeQueue?.entries ?? []).map((e) => e.runId)),
    [data.mergeQueue]
  );
  const mergeReadyCount = useMemo(
    () =>
      countMergeReady(
        data.runs,
        data.tasksIncludingArchived,
        queuedRunIds,
        model
      ),
    [data.runs, data.tasksIncludingArchived, queuedRunIds, model]
  );
  const handleMergeAll = async () => {
    setMergeAllPending(true);
    try {
      await data.handleMergeAllReady();
    } finally {
      setMergeAllPending(false);
    }
  };
  // The Filter menu's AI row: the daemon turns a sentence into clauses, parsed through the
  // same walk a stored filter set gets so a facet the daemon invented drops rather than
  // leaking into a `switch`. `undefined` without a client, which hides the row.
  const client = data.client;
  const aiFilter = useMemo(
    () =>
      client === null
        ? undefined
        : async (sentence: string) =>
            taskFilterSetFromValue(await client.aiFilterTasks(sentence)) ??
            EMPTY_TASK_FILTER_SET,
    [client]
  );

  // A card's Dispatch, `Dispatch all ready` and `d`: in place and optimistic, like the
  // Cockpit's — the card moves to the dispatched column at once.
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
      e.preventDefault();
      setFilterOpen(true);
      return;
    }
    if (command === 'list-open-display') {
      e.preventDefault();
      setDisplayOpen(true);
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

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  const loading = data.tasksLoading || data.config === null;
  // Only a raise pre-fills from the session; a fresh fan-out starts from the defaults.
  const dialogSession =
    dispatchEpic?.mode === 'raise'
      ? (data.epicProgressById.get(dispatchEpic.epicId)?.session ?? null)
      : null;
  const crumb = [
    ...(projectName !== undefined && projectName !== null ? [projectName] : []),
    'Tasks',
  ];
  // The saved-view header pieces, all absent without a provider.
  const activeFavorite =
    savedViews !== null && activeView !== null
      ? savedViews.isFavorite({ kind: 'view', id: activeView.id })
      : false;
  const dirty = activeView !== null && !viewMatches(activeView, filters, prefs);
  const tabs: ViewTab[] = [
    ...TASKS_VIEW_TABS.map((tab) => ({ ...tab })),
    ...(savedViews?.views ?? []).map((view) => ({
      id: VIEW_TAB_PREFIX + view.id,
      label: view.name,
      icon: <Layers aria-hidden />,
    })),
  ];
  const star =
    savedViews === null ? undefined : activeView !== null ? (
      <IconButton
        label={activeFavorite ? 'Unfavorite view' : 'Favorite view'}
        active={activeFavorite}
        onClick={() =>
          savedViews.toggleFavorite({ kind: 'view', id: activeView.id })
        }
      >
        <Star aria-hidden fill={activeFavorite ? 'currentColor' : 'none'} />
      </IconButton>
    ) : (
      // Nothing to star yet: the star saves the current filters as a favorite view,
      // and its name says so rather than reading as a toggle that does nothing.
      <IconButton
        label="Favorite this view"
        onClick={() => setViewDialog({ mode: 'create', favorite: true })}
      >
        <Star aria-hidden />
      </IconButton>
    );

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={crumb}
        star={star}
        actions={
          <>
            {savedViews !== null && activeView === null && filtersActive && (
              <Button
                variant="ghost"
                onClick={() =>
                  setViewDialog({ mode: 'create', favorite: false })
                }
              >
                Save view…
              </Button>
            )}
            {savedViews !== null && activeView !== null && dirty && (
              <Button
                variant="ghost"
                onClick={() =>
                  savedViews.updateView(activeView.id, {
                    filters,
                    display: prefs,
                  })
                }
              >
                Update view
              </Button>
            )}
            <Button variant="ghost" onClick={onPlanWork}>
              Plan work…
            </Button>
            <Button
              variant="ghost"
              disabled={mergeReadyCount === 0 || mergeAllPending}
              onClick={() => void handleMergeAll()}
            >
              Merge all ready ({mergeReadyCount})
            </Button>
            {savedViews !== null && activeView !== null && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<IconButton label="View options" />}
                >
                  <Ellipsis aria-hidden />
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="min-w-[160px]">
                  <DropdownMenuItem
                    onClick={() => setViewDialog({ mode: 'rename' })}
                  >
                    Rename…
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() =>
                      savedViews.toggleFavorite({
                        kind: 'view',
                        id: activeView.id,
                      })
                    }
                  >
                    {activeFavorite ? 'Unfavorite' : 'Favorite'}
                  </DropdownMenuItem>
                  <DropdownMenuItem
                    onClick={() => savedViews.deleteView(activeView.id)}
                  >
                    Delete view
                  </DropdownMenuItem>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        }
        tabs={
          <ViewTabs
            tabs={tabs}
            active={
              activeViewId !== null ? VIEW_TAB_PREFIX + activeViewId : mode
            }
            onChange={(id) => {
              if (id.startsWith(VIEW_TAB_PREFIX)) {
                savedViews?.selectView(id.slice(VIEW_TAB_PREFIX.length));
                return;
              }
              savedViews?.clearActiveView();
              changeMode(id as TasksViewMode);
            }}
          />
        }
        controls={
          <HeaderIconTriad
            filter={
              <FilterMenu
                filters={filters}
                onChange={setFilters}
                context={filterMenuContext}
                open={filterOpen}
                onOpenChange={setFilterOpen}
                onAiFilter={aiFilter}
              />
            }
            display={
              <DisplayPopover
                mode={mode}
                onModeChange={changeMode}
                prefs={prefs}
                onPrefsChange={setPrefs}
                showArchived={data.showArchived}
                archivedCount={data.archivedTasks.length}
                onShowArchivedChange={data.setShowArchived}
                open={displayOpen}
                onOpenChange={setDisplayOpen}
              />
            }
            sidePanel={
              // Milestones and Branches always group by milestone, so the lane toggle has
              // nothing to do on either.
              <SidePanelIconButton
                label={laneBy === 'epic' ? 'Ungroup epics' : 'Group by epic'}
                active={laneBy === 'epic'}
                disabled={mode === 'milestones' || mode === 'branches'}
                onClick={toggleEpicLanes}
              />
            }
          />
        }
      />
      <AppliedFilters
        filters={filters}
        onChange={setFilters}
        context={filterContext}
        className="shadow-hairline-bottom shrink-0 px-4 py-2"
      />

      {loading ? (
        <BoardSkeleton />
      ) : boardTasks.length === 0 ? (
        <EmptyState
          illustration={<BoardLineArt />}
          heading="No tasks yet"
          description="Create one, or let Plan work… draft a set from a goal."
          primary={{ label: 'New task', hint: 'C', onClick: () => onNewTask() }}
          secondary={{ label: 'Plan work…', onClick: onPlanWork }}
          className="flex-1"
        />
      ) : mode === 'milestones' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MilestonesView
            data={data}
            onOpenTask={onSelectTask}
            focusEpic={milestoneFocus}
            display={prefs}
            onRequestFilter={() => setFilterOpen(true)}
            onRequestDisplay={() => setDisplayOpen(true)}
          />
        </div>
      ) : mode === 'branches' ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          <MilestoneBranchesView
            data={data}
            onOpenTask={onSelectTask}
            display={prefs}
            taskFilter={taskFilterFn}
            onRequestFilter={() => setFilterOpen(true)}
            onRequestDisplay={() => setDisplayOpen(true)}
            onPlanWork={onPlanWork}
          />
        </div>
      ) : mode === 'board' ? (
        // `tabIndex={0}` puts the track itself in the natural tab order (so someone can
        // Tab/click into the board and start using j/k immediately) — the individual cards
        // remain the real roving-focus targets once `focusedTaskId` moves onto one of them.
        <div
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
            display={prefs}
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
      ) : (
        <div className="min-h-0 flex-1 overflow-hidden">
          <TasksListView
            data={data}
            onSelectTask={onSelectTask}
            taskFilter={taskFilterFn}
            display={prefs}
            onRequestFilter={() => setFilterOpen(true)}
            onRequestDisplay={() => setDisplayOpen(true)}
          />
        </div>
      )}

      {savedViews !== null && (
        <SaveViewDialog
          open={viewDialog !== null}
          onOpenChange={(open) => {
            if (!open) setViewDialog(null);
          }}
          mode={viewDialog?.mode ?? 'create'}
          initialName={
            viewDialog?.mode === 'rename' ? activeView?.name : undefined
          }
          defaultFavorite={
            viewDialog?.mode === 'create' ? viewDialog.favorite : false
          }
          onSubmit={({ name, favorite }) => {
            if (viewDialog?.mode === 'rename') {
              if (activeView !== null)
                savedViews.renameView(activeView.id, name);
              return;
            }
            const view = savedViews.saveView({
              name,
              filters,
              display: prefs,
              favorite,
            });
            savedViews.selectView(view.id);
          }}
        />
      )}

      {/* The milestones layout owns the dialog while it is serving a focus request. */}
      {dispatchEpic !== null &&
        !(mode === 'milestones' && milestoneFocus !== null) && (
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
    </div>
  );
}
