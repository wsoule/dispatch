import type { Priority, TaskListItem } from '@dispatch-foo/core/browser';
import { PRIORITY_ORDER, statusType } from '@dispatch-foo/core/browser';
import type { RunState } from '@dispatch/client';
import {
  Button,
  type FilterChipData,
  FilterChips,
  NavTabs,
  type PickerOption,
  PickerPopover,
  SegmentedControl,
  ViewToolbar,
} from '@dispatch/ui';
import { Plus, Users } from 'lucide-react';
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import {
  type FilterChipModel,
  filterChips,
  presetTabs,
  toTaskPriority,
} from '../adapters/rows';
import { MilestoneMapView } from '../components/graph/MilestoneMap';
import { useSavedViewsContext } from '../components/shell/SavedViewsContext';
import { BoardPane } from '../components/tasks/BoardPane';
import { DisplayPopover } from '../components/tasks/DisplayPopover';
import { FilterMenu } from '../components/tasks/FilterMenu';
import { NeedsYouBlock } from '../components/tasks/NeedsYouBlock';
import { TasksExtraGroups } from '../components/tasks/TasksExtraGroups';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import { TasksViewMenu } from '../components/tasks/TasksViewMenu';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useTaskFilterMenu } from '../hooks/useTaskFilterMenu';
import type { TaskTab } from '../lib/appNav';
import type { DecisionItem } from '../lib/decisionFeed';
import { groupTasks } from '../lib/listGrouping';
import type { NeedsYou } from '../lib/needsYou';
import { hrefFor } from '../lib/shellRoutes';
import { useStatusModelOf } from '../lib/statusModel';
import {
  EMPTY_TASK_FILTER_SET,
  FILTER_NONE,
  type FilterFacet,
  filterValueLabel,
  hasActiveTaskFilters,
  matchesTaskFilterSet,
  removeFilterClause,
  type TaskFilterSet,
  toggleFilterValue,
} from '../lib/taskFilters';
import type { TasksDisplayPrefs } from '../lib/tasksPrefs';
import {
  type PresetContext,
  presetMatcher,
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
import styles from './IssuesView.module.css';
import { assigneeChoices } from './IssuesViewMenus';
import { IssuesTable } from './IssuesViewTable';
import { LiveView } from './LiveView';
import { ProjectsView } from './ProjectsView';

// The Issues hub in Gr8r's layout (architecture §8.4 "Issues"): the view
// toolbar (search, the Filter menu, the Display popover, group by person,
// List | Board | Graph, the saved views, New task), the preset tabs with their
// counts, the applied filters as chips, every ask of mine pinned on top, then
// the list (IssuesViewTable on @dispatch/ui's TaskGroupTable), the board or the
// graph, and the composer at the foot. A row click quick-looks its task in the
// shell's slide-over (App's peek slot, over this view); Enter, o and "Open" go
// to the full page, which replaces the list here. The preset and the filter
// clauses narrow every layout; Display shapes the list and board.

const MODES: { id: TasksMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'board', label: 'Board' },
  { id: 'graph', label: 'Graph' },
];

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

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
  'file',
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

/** The live run states the Run state facet's chip offers. */
const RUN_STATES: readonly RunState[] = [
  'provisioning',
  'running',
  'awaiting-approval',
  'finished',
  'failed',
  'cancelled',
  'interrupted-dirty',
];

const PRIORITIES = Object.keys(PRIORITY_ORDER) as Priority[];

/** The one value a multi-picker's new list differs from the old one by: what
 * was added, else what was removed (a toggle changes one value at a time). */
function toggledValue(
  before: readonly string[],
  after: readonly string[]
): string | undefined {
  return (
    after.find((value) => !before.includes(value)) ??
    before.find((value) => !after.includes(value))
  );
}

/** A page that is not the list: a task, a doc, a PR, a draft, a room or a hosted view. */
export type TasksSidePage = Exclude<TasksPage, { kind: 'list' }>;

export interface IssuesViewProps {
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
  /** A click on a row or card: the quick-look drawer; with a tab, the full page
   * on that tab (a phase drill). */
  onSelectTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** Enter, `o` and the row menu's Open: the full page. */
  onOpenTask: (taskId: string) => void;
  /** The task in the quick-look drawer, marked current in the list. */
  peekTaskId: string | null;
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
  /** Keys per-project choices such as the graph's Milestones | Tasks. */
  projectKey: string;
  speechByTask: ReadonlyMap<string, { count: number; mention: boolean }>;
  composer: ReactNode;
}

/**
 * Issues: the toolbar, the preset tabs, the filter chips, every ask pinned on
 * top, the work by group, and its pages. The toolbar carries the board
 * controls: the Filter menu (AI filter included), the Display popover, group
 * by person, List | Board | Graph, the saved and starred views and New task.
 */
export function IssuesView({
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
  onOpenTask,
  peekTaskId,
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
  projectKey,
  speechByTask,
  composer,
}: IssuesViewProps) {
  const [graphFolded, setGraphFolded] = useState(storedGraphFold);
  const onGraphFold = useCallback((folded: boolean) => {
    setGraphFolded(folded);
    storeGraphFold(folded);
  }, []);
  const [filters, setFilters] = useState<TaskFilterSet>(readTwoViewsFilters);
  const [prefs, setPrefs] = useState<TasksDisplayPrefs>(readTwoViewsDisplay);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
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
  const full = page.kind !== 'list';

  // Applies the active saved view when a pick changes it — from the toolbar's menu or
  // the palette's Open view, which may land before this mounts. The session marker keeps
  // edits made on top of a view across a remount; read through a ref so the view object's
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

  // ---- the preset tabs ----------------------------------------------------

  const mineCount = useMemo(() => {
    const mine = presetMatcher('mine', presetContext);
    return mine === undefined ? 0 : data.tasks.filter(mine).length;
  }, [data.tasks, presetContext]);
  const issuesHref = hrefFor('issues');
  const tabs = useMemo(
    () =>
      presetTabs(counts, {
        current: preset,
        mine: mineCount,
        starred: presetContext.starred.size,
        hrefFor: () => issuesHref,
      }).map((tab) => ({
        ...tab,
        onFollow: () => onPreset(tab.id as TasksPreset),
      })),
    [counts, preset, mineCount, presetContext.starred, issuesHref, onPreset]
  );

  // ---- the filter chips ---------------------------------------------------

  // The values a facet's chip offers when clicked: the project's own
  // vocabulary (as the Filter menu lists it), in the clause's reading labels.
  const facetOptions = useCallback(
    (facet: FilterFacet): PickerOption[] | undefined => {
      const label = (value: string) =>
        filterValueLabel(facet, value, filterContext);
      switch (facet) {
        case 'status':
          return menuContext.statuses.map((status) => ({
            value: status,
            label: label(status),
            mark: { kind: 'state', state: statusType(status, model) },
          }));
        case 'priority':
          return PRIORITIES.map((priority) => ({
            value: priority,
            label: label(priority),
            mark: { kind: 'priority', priority: toTaskPriority(priority) },
          }));
        case 'assignee':
          return [
            { value: 'none', label: 'Unassigned' },
            ...assigneeChoices({
              people: data.people,
              executors: data.executors?.executors ?? [],
              me: data.me,
            }).map((choice) => ({
              value: choice.id,
              label: choice.name,
              hint: choice.hint,
              keywords: choice.keywords,
              group: choice.group,
              mark: choice.mark,
            })),
          ];
        case 'labels':
          return menuContext.labels.map((value) => ({ value, label: value }));
        case 'epic':
          return [
            { value: FILTER_NONE, label: label(FILTER_NONE) },
            ...menuContext.epics.map((epic) => ({
              value: epic.meta.id,
              label: epic.meta.title,
            })),
          ];
        case 'milestone':
          return [
            { value: FILTER_NONE, label: label(FILTER_NONE) },
            ...menuContext.milestones.map((value) => ({ value, label: value })),
          ];
        case 'run':
          return [FILTER_NONE, ...RUN_STATES].map((value) => ({
            value,
            label: label(value),
          }));
        case 'created':
        case 'updated':
          return undefined;
      }
    },
    [filterContext, menuContext, model, data.people, data.executors, data.me]
  );
  const chips = useMemo<FilterChipData[]>(
    () =>
      filterChips(filters, filterContext).map((chip: FilterChipModel) => {
        const clause = filters.clauses[chip.index];
        const options = facetOptions(chip.facet);
        const item: FilterChipData = {
          id: chip.id,
          field: chip.field,
          summary: chip.summary,
          unknown: chip.unknown,
          removeLabel: chip.removeLabel,
          onRemove: () =>
            setFilters((prev) => removeFilterClause(prev, chip.index)),
        };
        if (options !== undefined && clause !== undefined) {
          item.renderEditor = (face) => (
            <PickerPopover
              multiple
              label={`${chip.field} filter`}
              appearance="quiet"
              value={clause.values}
              options={options}
              trigger={face}
              triggerLabel={`Edit ${chip.field.toLowerCase()} filter`}
              onChange={(values) => {
                const toggled = toggledValue(clause.values, values);
                if (toggled !== undefined) {
                  setFilters((prev) =>
                    toggleFilterValue(prev, chip.facet, toggled)
                  );
                }
              }}
            />
          );
        }
        return item;
      }),
    [filters, filterContext, facetOptions]
  );

  // ---- render -------------------------------------------------------------

  const footer = (
    <TasksExtraGroups
      data={data}
      onOpenPr={onOpenPr}
      onOpenDoc={onOpenDoc}
      onOpenAllDocs={onOpenAllDocs}
    />
  );

  return (
    <div data-testid="tasks-view" className={styles.root}>
      <ViewToolbar
        label="Issue view options"
        search={{
          value: search,
          onChange: setSearch,
          placeholder: 'Search issues',
          label: 'Search issues',
          inputRef: searchInput,
        }}
        controls={
          <span className={styles.toolbarGroup}>
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
            <Button
              variant="quiet"
              size="sm"
              icon={<Users {...ICON} />}
              aria-label={
                byPerson ? 'Stop grouping by person' : 'Group by person'
              }
              title={byPerson ? 'Stop grouping by person' : 'Group by person'}
              aria-pressed={byPerson}
              disabled={mode === 'graph'}
              onClick={() =>
                setPrefs((prev) => toggleGroupByPerson(prev, mode))
              }
            />
            {/* On a full page (a task, docs, a PR) neither layout is showing, so
                nothing is selected, and picking one goes back to the list. */}
            <SegmentedControl
              label="Tasks layout"
              size="sm"
              options={MODES}
              value={full ? '' : mode}
              onChange={(next) => {
                const picked = MODES.find((m) => m.id === next);
                if (picked === undefined) return;
                onModeChange(picked.id);
                if (full) onClosePage();
              }}
            />
            <TasksViewMenu
              preset={preset}
              onPreset={onPreset}
              savedViews={savedViews}
              filters={filters}
              display={display}
            />
          </span>
        }
        end={
          <Button
            variant="primary"
            size="sm"
            icon={<Plus {...ICON} />}
            onClick={onNewTask}
          >
            New task
          </Button>
        }
      />
      <div className={styles.tabs}>
        <NavTabs label="Presets" size="sm" items={tabs} />
      </div>
      <FilterChips
        chips={chips}
        onClearAll={() => setFilters(EMPTY_TASK_FILTER_SET)}
        clearDisabled={!filtersActive}
      />
      {full ? (
        <div className={styles.full}>
          {!OWN_HEADER.has(page.kind) && (
            <div className={styles.back}>
              <TasksBackButton onBack={onClosePage} />
            </div>
          )}
          <div className={styles.page}>{renderPage(page as TasksSidePage)}</div>
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.column}>
            <div className={styles.needs}>
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
            <div className={styles.main}>
              {mode === 'board' ? (
                <BoardPane
                  data={data}
                  display={display}
                  taskFilter={taskFilter}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  onRequestFilter={requestFilter}
                  onRequestDisplay={requestDisplay}
                />
              ) : mode === 'graph' ? (
                <MilestoneMapView
                  // A project switch remounts the chart, so its selection, view, display
                  // toggles and framing come from the new project, not the last one.
                  key={projectKey}
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
                          variant="secondary"
                          size="sm"
                          icon={<Plus {...ICON} />}
                          onClick={onNewProject}
                        >
                          New project
                        </Button>
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
                          onOpenTask={(id, tab, runId) =>
                            tab === undefined
                              ? onOpenTask(id)
                              : onSelectTask(id, tab, runId)
                          }
                          onPeekTask={onPeekTask}
                        />
                      ),
                    },
                  }}
                  onOpenTask={onSelectTask}
                />
              ) : (
                <IssuesTable
                  data={data}
                  taskFilter={taskFilter}
                  search={search}
                  prefs={display}
                  needs={needs}
                  bucketOf={presetContext.bucketOf}
                  speechByTask={speechByTask}
                  activeTaskId={peekTaskId ?? undefined}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  onOpenTask={onOpenTask}
                  onRequestFilter={requestFilter}
                  onRequestDisplay={requestDisplay}
                  footer={footer}
                />
              )}
            </div>
          </div>
        </div>
      )}
      {composer}
    </div>
  );
}
