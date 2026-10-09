import type { TaskListItem } from '@dispatch-foo/core/browser';
import { Ellipsis, Layers, Star } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useSavedViewsContext } from '../components/shell/SavedViewsContext';
import { AppliedFilters } from '../components/tasks/AppliedFilters';
import { BoardPane, BoardSkeleton } from '../components/tasks/BoardPane';
import { DisplayPopover } from '../components/tasks/DisplayPopover';
import { FilterMenu } from '../components/tasks/FilterMenu';
import { SaveViewDialog } from '../components/tasks/SaveViewDialog';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useTaskFilterMenu } from '../hooks/useTaskFilterMenu';
import type { TaskTab } from '../lib/appNav';
import { countMergeReady } from '../lib/mergeReady';
import { viewMatches } from '../lib/savedViews';
import { useStatusModelOf } from '../lib/statusModel';
import {
  hasActiveTaskFilters,
  matchesTaskFilterSet,
  parseTaskFilterSet,
  serializeTaskFilterSet,
  TASK_FILTERS_V2_STORAGE_KEY,
  type TaskFilterSet,
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
 * see `BoardPane`; the List's is row-major (see `TasksListView`). `f` opens the
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

  const model = useStatusModelOf(data.config);
  const {
    filterContext,
    menuContext: filterMenuContext,
    aiFilter,
  } = useTaskFilterMenu(data);
  const filtersActive = hasActiveTaskFilters(filters);
  // The clauses as a predicate for every layout — `undefined` when nothing is active so
  // they skip a per-task closure call on the common unfiltered path.
  const taskFilterFn = useMemo(
    () =>
      filtersActive
        ? (doc: TaskListItem) =>
            matchesTaskFilterSet(doc, filters, filterContext)
        : undefined,
    [filtersActive, filters, filterContext]
  );
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
  // Empty means nothing at all to show, archived tasks included when they are showing.
  const noTasks =
    data.tasks.length === 0 &&
    (!data.showArchived || data.archivedTasks.length === 0);
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
      ) : noTasks ? (
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
        <BoardPane
          data={data}
          display={prefs}
          taskFilter={taskFilterFn}
          onSelectTask={onSelectTask}
          onRequestFilter={() => setFilterOpen(true)}
          onRequestDisplay={() => setDisplayOpen(true)}
        />
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
    </div>
  );
}
