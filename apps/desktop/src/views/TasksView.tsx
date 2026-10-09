import type { TaskListItem } from '@dispatch-foo/core/browser';
import { Plus, Users } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { MilestoneMapView } from '../components/graph/MilestoneMap';
import { useSavedViewsContext } from '../components/shell/SavedViewsContext';
import { AppliedFilters } from '../components/tasks/AppliedFilters';
import { BoardPane } from '../components/tasks/BoardPane';
import { DisplayPopover } from '../components/tasks/DisplayPopover';
import { FilterMenu } from '../components/tasks/FilterMenu';
import { MilestoneStatusCells } from '../components/tasks/MilestoneStatusCells';
import { NeedsYouBlock } from '../components/tasks/NeedsYouBlock';
import { TasksExtraGroups } from '../components/tasks/TasksExtraGroups';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import { TasksStrip } from '../components/tasks/TasksStrip';
import { TasksViewMenu } from '../components/tasks/TasksViewMenu';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useTaskFilterMenu } from '../hooks/useTaskFilterMenu';
import type { TaskTab } from '../lib/appNav';
import { containerStatus } from '../lib/containerStatus';
import type { DecisionItem } from '../lib/decisionFeed';
import { groupTasks, type ListGroup } from '../lib/listGrouping';
import type { NeedsYou } from '../lib/needsYou';
import { useStatusModelOf } from '../lib/statusModel';
import {
  hasActiveTaskFilters,
  matchesTaskFilterSet,
  type TaskFilterSet,
} from '../lib/taskFilters';
import type { TasksDisplayPrefs } from '../lib/tasksPrefs';
import {
  type PresetContext,
  presetMatcher,
  TASKS_PRESETS,
  type TasksPreset,
} from '../lib/tasksPresets';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { RefAction } from '../lib/threadSources';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import {
  layoutForMode,
  modeForLayout,
  readTwoViewsDisplay,
  readTwoViewsFilters,
  TWO_VIEWS_TASKS_DISPLAY,
  writeTwoViewsDisplay,
  writeTwoViewsFilters,
} from '../lib/twoViewsTasksPrefs';
import { LiveView } from './LiveView';
import { MilestoneBranchesView } from './MilestoneBranchesView';
import { ProjectsView } from './ProjectsView';
import { TasksListView } from './TasksListView';
import { IconButton } from '@/ui/ai/icon-button';
import { Button } from '@/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

const MODES: { id: TasksMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'board', label: 'Board' },
  { id: 'graph', label: 'Graph' },
];

/** Session key for the saved view this page last applied, so a remount keeps edits. */
const APPLIED_VIEW_STORAGE_KEY = 'dispatch:two-views-applied-view';

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

// Group by person, as the Cockpit's `g p` did: the list's groups or the board's lanes.
function groupedByPerson(prefs: TasksDisplayPrefs, mode: TasksMode): boolean {
  return mode === 'board'
    ? prefs.subGrouping === 'assignee'
    : prefs.grouping === 'assignee';
}

function toggleGroupByPerson(
  prefs: TasksDisplayPrefs,
  mode: TasksMode
): TasksDisplayPrefs {
  if (mode === 'board') {
    return {
      ...prefs,
      subGrouping: prefs.subGrouping === 'assignee' ? 'none' : 'assignee',
    };
  }
  return {
    ...prefs,
    grouping:
      prefs.grouping === 'assignee'
        ? TWO_VIEWS_TASKS_DISPLAY.grouping
        : 'assignee',
  };
}

// Pages that lead their own header with "‹ tasks"; the rest get a bare one here.
const OWN_HEADER: ReadonlySet<TasksPage['kind']> = new Set([
  'task',
  'docs',
  'pr',
  'room',
  'view',
  'impact',
]);

const GRAPH_NEEDS_FOLDED_KEY = 'dispatch:graph-needs-you-folded';

// Graph mode keeps Needs you to its header unless it was opened there before.
function storedGraphFold(): boolean {
  try {
    return localStorage.getItem(GRAPH_NEEDS_FOLDED_KEY) !== 'false';
  } catch {
    return true;
  }
}

function storeGraphFold(folded: boolean): void {
  try {
    localStorage.setItem(GRAPH_NEEDS_FOLDED_KEY, String(folded));
  } catch {
    // Kept for this session only.
  }
}

/** A page that is not the list: a task, a doc, a PR, a draft, a room or a hosted view. */
export type TasksSidePage = Exclude<TasksPage, { kind: 'list' }>;

export interface TasksViewProps {
  data: DispatchProjectData;
  needs: NeedsYou;
  /** Asks of mine decided elsewhere a moment ago. */
  decided: readonly DecisionItem[];
  counts: TaskStatusCounts;
  page: TasksPage;
  mode: TasksMode;
  onModeChange: (mode: TasksMode) => void;
  /** Narrows the list and graph to one question; All shows everything. */
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
  presetContext: PresetContext;
  onSelectTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  onNewTask: () => void;
  /** The creator, set to make a project (Graph mode's Projects layout). */
  onNewProject: () => void;
  /** Graph mode's Live layout dispatches in place, rejecting on failure. */
  onDispatchTask: (taskId: string) => Promise<void>;
  onDispatchFailed: (taskId: string, message: string) => void;
  onPeekTask: (taskId: string) => void;
  onOpenRef: (action: RefAction) => void;
  onOpenDecision: (item: DecisionItem) => void;
  renderPage: (page: TasksSidePage) => ReactNode;
  /** Back to the list from a full page. */
  onClosePage: () => void;
  onOpenPr: (number: number) => void;
  onOpenDoc: (docId: string) => void;
  onOpenAllDocs: () => void;
  onOpenNotes: () => void;
  /** Keys per-project choices such as the graph's Milestones | Tasks. */
  projectKey: string;
  speechByTask: ReadonlyMap<string, { count: number; mention: boolean }>;
  composer: ReactNode;
}

/**
 * Tasks: the strip, every ask pinned on top, the work by milestone, and its pages. The
 * header carries Classic's board controls: saved and starred views, the Filter menu (AI
 * filter included), the Display popover, group by person and List | Board | Graph. The
 * preset and the filter clauses narrow every layout; Display shapes the list and board.
 */
export function TasksView({
  data,
  needs,
  decided,
  counts,
  page,
  mode,
  onModeChange,
  preset,
  onPreset,
  presetContext,
  onSelectTask,
  onNewTask,
  onNewProject,
  onDispatchTask,
  onDispatchFailed,
  onPeekTask,
  onOpenRef,
  onOpenDecision,
  renderPage,
  onClosePage,
  onOpenPr,
  onOpenDoc,
  onOpenAllDocs,
  onOpenNotes,
  projectKey,
  speechByTask,
  composer,
}: TasksViewProps) {
  const split = page.kind === 'task' && !page.full;
  const [graphFolded, setGraphFolded] = useState(storedGraphFold);
  const onGraphFold = useCallback((folded: boolean) => {
    setGraphFolded(folded);
    storeGraphFold(folded);
  }, []);
  const [filters, setFilters] = useState<TaskFilterSet>(readTwoViewsFilters);
  const [prefs, setPrefs] = useState<TasksDisplayPrefs>(readTwoViewsDisplay);
  // Open state lives here so `f` and `⇧V` on the list or board can open the menus.
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  useEffect(() => writeTwoViewsFilters(filters), [filters]);
  useEffect(() => writeTwoViewsDisplay(prefs), [prefs]);
  // The model as a saved view stores it: the layout is the toggle's.
  const display = useMemo(
    () => ({ ...prefs, layout: layoutForMode(mode) }),
    [prefs, mode]
  );
  const full = page.kind !== 'list' && !split;

  // Applies the active saved view when a pick changes it — from the header's menu or the
  // palette's Open view, which may land before this mounts. The session marker keeps edits
  // made on top of a view across a remount; read through a ref so the view object's
  // changing identity never re-applies it.
  const savedViews = useSavedViewsContext();
  const activeViewId = savedViews?.activeViewId ?? null;
  const applyViewRef = useRef<(id: string) => void>(() => {});
  applyViewRef.current = (id) => {
    const view = savedViews?.views.find((v) => v.id === id);
    if (view === undefined) return;
    setFilters(view.filters);
    setPrefs(view.display);
    onModeChange(modeForLayout(view.display.layout));
    if (preset !== 'all') onPreset('all');
    if (full) onClosePage();
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

  const { filterContext, menuContext, aiFilter } = useTaskFilterMenu(data);
  const filtersActive = hasActiveTaskFilters(filters);
  // The preset and the filter clauses as one predicate; `undefined` when neither narrows.
  const taskFilter = useMemo(() => {
    const byPreset = presetMatcher(preset, presetContext);
    if (!filtersActive) return byPreset;
    const byClauses = (doc: TaskListItem) =>
      matchesTaskFilterSet(doc, filters, filterContext);
    return byPreset === undefined
      ? byClauses
      : (doc: TaskListItem) => byPreset(doc) && byClauses(doc);
  }, [preset, presetContext, filtersActive, filters, filterContext]);
  const requestFilter = useCallback(() => setFilterOpen(true), []);
  const requestDisplay = useCallback(() => setDisplayOpen(true), []);
  const byPerson = groupedByPerson(prefs, mode);
  const epicById = useMemo(
    () => new Map(data.epics.map((e) => [e.meta.id, e])),
    [data.epics]
  );
  // Every group's folded status, in the same units as the top bar.
  const groupAccessory = useCallback(
    (group: ListGroup) => (
      <MilestoneStatusCells
        status={containerStatus(
          group.rows.map((row) => row.doc),
          {
            bucketOf: presetContext.bucketOf,
            asksByTask: needs.byTask,
          }
        )}
        dueDate={
          group.epicId === null
            ? null
            : (epicById.get(group.epicId)?.meta.dueDate ?? null)
        }
      />
    ),
    [presetContext.bucketOf, needs.byTask, epicById]
  );
  const footer = (
    <TasksExtraGroups
      data={data}
      onOpenPr={onOpenPr}
      onOpenDoc={onOpenDoc}
      onOpenAllDocs={onOpenAllDocs}
      onOpenNotes={onOpenNotes}
    />
  );
  const model = useStatusModelOf(data.config);
  // The list's milestone groups, so the map and the list agree on membership.
  const graphGroups = useMemo(
    () =>
      mode !== 'graph' || data.config === null
        ? []
        : groupTasks(
            taskFilter === undefined
              ? data.tasks
              : data.tasks.filter(taskFilter),
            TWO_VIEWS_TASKS_DISPLAY,
            { statuses: data.config.statuses, epics: data.epics, model }
          ),
    [mode, data.config, data.tasks, data.epics, taskFilter, model]
  );
  const presetLabel =
    TASKS_PRESETS.find((p) => p.id === preset)?.label ?? 'All';

  return (
    <div data-testid="tasks-view" className="flex h-full min-h-0 flex-col">
      <div className="border-border flex items-center gap-3 border-b-[0.5px] px-4 py-2">
        <span className="shrink-0 text-[13px] font-medium">All work</span>
        <TasksStrip counts={counts} preset={preset} onPreset={onPreset} />
        <span className="flex-1" />
        <span className="flex shrink-0 items-center gap-0.5">
          <FilterMenu
            filters={filters}
            onChange={setFilters}
            context={menuContext}
            open={filterOpen}
            onOpenChange={setFilterOpen}
            onAiFilter={aiFilter}
          />
          <DisplayPopover
            mode={display.layout}
            prefs={display}
            onPrefsChange={setPrefs}
            showArchived={data.showArchived}
            archivedCount={data.archivedTasks.length}
            onShowArchivedChange={data.setShowArchived}
            open={displayOpen}
            onOpenChange={setDisplayOpen}
          />
          <IconButton
            data-testid="tasks-group-by-person"
            label={byPerson ? 'Stop grouping by person' : 'Group by person'}
            active={byPerson}
            disabled={mode === 'graph'}
            onClick={() => setPrefs((prev) => toggleGroupByPerson(prev, mode))}
          >
            <Users aria-hidden />
          </IconButton>
        </span>
        {/* On a full page (a task, docs, a PR) neither layout is showing, so
            nothing is selected, and picking one goes back to the list. */}
        <ToggleGroup
          aria-label="Tasks layout"
          variant="outline"
          size="sm"
          value={full ? [] : [mode]}
          onValueChange={(next) => {
            const picked = MODES.find((m) => m.id === next[0]);
            if (picked === undefined) return;
            onModeChange(picked.id);
            if (full) onClosePage();
          }}
          className="shrink-0"
        >
          {MODES.map((m) => (
            <ToggleGroupItem key={m.id} value={m.id}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <TasksViewMenu
          preset={preset}
          onPreset={onPreset}
          savedViews={savedViews}
          filters={filters}
          display={display}
        />
        <Button size="sm" onClick={onNewTask} className="shrink-0">
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>
      <AppliedFilters
        filters={filters}
        onChange={setFilters}
        context={filterContext}
        className="border-border shrink-0 border-b-[0.5px] px-4 py-1.5"
      />
      {full ? (
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          {!OWN_HEADER.has(page.kind) && (
            <div className="px-4 pt-2">
              <TasksBackButton onBack={onClosePage} />
            </div>
          )}
          <div className="min-h-0 flex-1 overflow-hidden">
            {renderPage(page as TasksSidePage)}
          </div>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1">
          <div
            className={
              split
                ? 'border-border flex w-[520px] shrink-0 flex-col border-r-[0.5px]'
                : 'flex min-w-0 flex-1 flex-col'
            }
          >
            <div className="max-h-[45%] shrink-0 overflow-y-auto px-2 pt-2">
              <NeedsYouBlock
                flush
                data={data}
                needs={needs}
                decided={decided}
                onOpenRef={onOpenRef}
                onOpenDecision={onOpenDecision}
                folded={mode === 'graph' ? graphFolded : undefined}
                onFoldedChange={mode === 'graph' ? onGraphFold : undefined}
              />
            </div>
            {preset !== 'all' && (
              <div
                data-testid="tasks-filter"
                className="text-muted-foreground flex items-center gap-2 px-4 pt-1 pb-1 text-[12px]"
              >
                <span>Showing {presetLabel} only</span>
                <Button
                  variant="link"
                  size="xs"
                  onClick={() => onPreset('all')}
                >
                  Clear
                </Button>
              </div>
            )}
            <div className="min-h-0 flex-1 overflow-hidden">
              {mode === 'board' ? (
                <div className="flex h-full min-h-0 flex-col">
                  <BoardPane
                    data={data}
                    display={display}
                    taskFilter={taskFilter}
                    onSelectTask={(taskId) => onSelectTask(taskId)}
                    onRequestFilter={requestFilter}
                    onRequestDisplay={requestDisplay}
                  />
                </div>
              ) : mode === 'graph' ? (
                <MilestoneMapView
                  groups={graphGroups}
                  bucketOf={presetContext.bucketOf}
                  asksByTask={needs.byTask}
                  projectKey={projectKey}
                  dueDateOf={(id) => epicById.get(id)?.meta.dueDate ?? null}
                  layouts={{
                    projects: {
                      body: (
                        <ProjectsView
                          showHeader={false}
                          projectName={null}
                          data={data}
                          onOpenTask={(id) => onSelectTask(id)}
                        />
                      ),
                      actions: (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={onNewProject}
                        >
                          <Plus className="size-3.5" />
                          New project
                        </Button>
                      ),
                    },
                    branches: {
                      body: (
                        <MilestoneBranchesView
                          data={data}
                          onOpenTask={onSelectTask}
                          display={TWO_VIEWS_TASKS_DISPLAY}
                          taskFilter={taskFilter}
                        />
                      ),
                    },
                    live: {
                      body: (
                        <LiveView
                          showHeader={false}
                          projectName={null}
                          data={data}
                          dispatchTask={onDispatchTask}
                          onDispatchFailed={onDispatchFailed}
                          onOpenTask={onSelectTask}
                          onPeekTask={onPeekTask}
                        />
                      ),
                    },
                  }}
                  onOpenTask={onSelectTask}
                />
              ) : (
                <TasksListView
                  data={data}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  display={display}
                  taskFilter={taskFilter}
                  onRequestFilter={requestFilter}
                  onRequestDisplay={requestDisplay}
                  needsYouIds={needs.taskIds}
                  groupAccessory={groupAccessory}
                  speechByTask={speechByTask}
                  footer={footer}
                />
              )}
            </div>
          </div>
          {split && (
            <section aria-label="Task" className="flex min-w-0 flex-1 flex-col">
              {renderPage(page)}
            </section>
          )}
        </div>
      )}
      {composer}
    </div>
  );
}
