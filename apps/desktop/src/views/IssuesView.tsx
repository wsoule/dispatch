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
import { DisplayPanel } from '../components/issues/DisplayPanel';
import { FilterPicker } from '../components/issues/FilterPicker';
import { SavedViewsMenu } from '../components/issues/SavedViewsMenu';
import { useSavedViewsContext } from '../components/shell/SavedViewsContext';
import { BoardPane } from '../components/tasks/BoardPane';
import { NeedsYouBlock } from '../components/tasks/NeedsYouBlock';
import { TasksExtraGroups } from '../components/tasks/TasksExtraGroups';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { useTaskFilterMenu } from '../hooks/useTaskFilterMenu';
import type { TasksMode, TasksPage, TaskTab } from '../lib/appNav';
import type { DecisionItem } from '../lib/decisionFeed';
import {
  ISSUES_DISPLAY,
  readIssuesDisplay,
  readIssuesFilters,
  writeIssuesDisplay,
  writeIssuesFilters,
} from '../lib/issuesPrefs';
import type { NeedsYou } from '../lib/needsYou';
import { issuesHref } from '../lib/routes';
import { useStatusModelOf } from '../lib/statusModel';
import {
  containerMatcher,
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
import styles from './IssuesView.module.css';
import { assigneeChoices } from './IssuesViewMenus';
import { IssuesTable } from './IssuesViewTable';

// The Issues hub in Gr8r's layout (architecture §8.4 "Issues"): the view
// toolbar (search, the Filter menu, the Display popover, group by person,
// List | Board, the saved views, New task), the preset tabs with their counts,
// the applied filters as chips, my asks on the Needs you preset, then the list
// (IssuesViewTable on @dispatch/ui's TaskGroupTable) or the board, and the
// composer at the foot. A row click quick-looks its task in the shell's
// slide-over (App's peek slot, over this view); Enter, o and "Open" go to the
// full page, which replaces the list here. The preset and the filter clauses
// narrow both layouts; Display shapes them. The dependency graph is a sidebar
// destination of its own (views/GraphView), not a layout here.

const MODES: { id: TasksMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'board', label: 'Board' },
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
      prefs.grouping === 'assignee' ? ISSUES_DISPLAY.grouping : 'assignee',
  };
}

// Pages that lead their own header with the Tasks back chip; the rest get a bare one here.
const OWN_HEADER: ReadonlySet<TasksPage['kind']> = new Set([
  'task',
  'docs',
  'pr',
  'room',
  'view',
  'file',
]);

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
  /** Narrows the list and board to one question; All shows everything. */
  preset: TasksPreset;
  onPreset: (preset: TasksPreset) => void;
  /** The container the route narrows the list and board to
   * (`#/issues?project=<id>`, a Projects register row's Issues link): only
   * the tasks below it show, under a Project chip whose × (or Clear all)
   * calls `onClearProject`. Null or left out: no narrowing. */
  project?: string | null;
  onClearProject?: () => void;
  presetContext: PresetContext;
  /** A click on a row or card: the quick-look drawer; with a tab, the full page
   * on that tab (a phase drill). */
  onSelectTask: (taskId: string, tab?: TaskTab, runId?: string) => void;
  /** Enter, `o` and the row menu's Open: the full page. */
  onOpenTask: (taskId: string) => void;
  /** The task in the quick-look drawer, marked current in the list. */
  peekTaskId: string | null;
  onNewTask: () => void;
  onOpenRef: (action: RefAction) => void;
  onOpenDecision: (item: DecisionItem) => void;
  renderPage: (page: TasksSidePage) => ReactNode;
  /** Back to the list from a full page. */
  onClosePage: () => void;
  onOpenPr: (number: number) => void;
  onOpenDoc: (docId: string) => void;
  onOpenAllDocs: () => void;
  speechByTask: ReadonlyMap<string, { count: number; mention: boolean }>;
  composer: ReactNode;
}

/**
 * Issues: the toolbar, the preset tabs, the filter chips, every ask pinned on
 * top, the work by group, and its pages. The toolbar carries the board
 * controls: the Filter menu (AI filter included), the Display popover, group
 * by person, List | Board, the saved and starred views and New task.
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
  project = null,
  onClearProject,
  presetContext,
  onSelectTask,
  onOpenTask,
  peekTaskId,
  onNewTask,
  onOpenRef,
  onOpenDecision,
  renderPage,
  onClosePage,
  onOpenPr,
  onOpenDoc,
  onOpenAllDocs,
  speechByTask,
  composer,
}: IssuesViewProps) {
  const [filters, setFilters] = useState<TaskFilterSet>(readIssuesFilters);
  const [prefs, setPrefs] = useState<TasksDisplayPrefs>(readIssuesDisplay);
  const [search, setSearch] = useState('');
  const searchInput = useRef<HTMLInputElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  // Open state lives here so `f` and `⇧V` on the list or board can open the menus.
  const [filterOpen, setFilterOpen] = useState(false);
  const [displayOpen, setDisplayOpen] = useState(false);
  useEffect(() => writeIssuesFilters(filters), [filters]);
  useEffect(() => writeIssuesDisplay(prefs), [prefs]);
  // The model as a saved view stores it: the layout is the toggle's.
  const display = useMemo(() => ({ ...prefs, layout: mode }), [prefs, mode]);
  const full = page.kind !== 'list';
  // The task whose full page was open last. When Back or Escape returns to the list or
  // the board, its row or card takes the focus, not the list's first row (it is not marked
  // open: nothing is); a quick look opened from the list afterwards takes over (and
  // forgets it). Kept as state adjusted during render (React's "storing information from
  // previous renders"), so the list or board mounts with it in the same commit the page
  // closes.
  const pageTaskId = page.kind === 'task' ? page.taskId : null;
  const [returnTaskId, setReturnTaskId] = useState<string | null>(null);
  if (pageTaskId !== null && pageTaskId !== returnTaskId) {
    setReturnTaskId(pageTaskId);
  } else if (
    pageTaskId === null &&
    peekTaskId !== null &&
    returnTaskId !== null
  ) {
    setReturnTaskId(null);
  }

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
    onModeChange(view.display.layout);
    if (preset !== 'all') onPreset('all');
    if (project !== null) onClearProject?.();
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
  // The live and the archived tasks together, where the routed project is
  // looked up: an archived row's parent chain resolves through it, and an
  // archived project still names its chip.
  const allTasks = useMemo(
    () => (project === null ? [] : [...data.tasks, ...data.archivedTasks]),
    [project, data.tasks, data.archivedTasks]
  );
  const byProject = useMemo(
    () => (project === null ? undefined : containerMatcher(project, allTasks)),
    [project, allTasks]
  );
  // The preset, the routed project and the filter clauses as one predicate;
  // `undefined` when none narrows.
  const taskFilter = useMemo(() => {
    const tests: ((doc: TaskListItem) => boolean)[] = [];
    const byPreset = presetMatcher(preset, presetContext);
    if (byPreset !== undefined) tests.push(byPreset);
    if (byProject !== undefined) tests.push(byProject);
    if (filtersActive) {
      tests.push((doc) => matchesTaskFilterSet(doc, filters, filterContext));
    }
    if (tests.length < 2) return tests[0];
    return (doc: TaskListItem) => tests.every((test) => test(doc));
  }, [preset, presetContext, byProject, filtersActive, filters, filterContext]);
  const requestFilter = useCallback(() => setFilterOpen(true), []);
  const requestDisplay = useCallback(() => setDisplayOpen(true), []);
  const byPerson = groupedByPerson(prefs, mode);
  const model = useStatusModelOf(data.config);

  // ---- the preset tabs ----------------------------------------------------

  const mineCount = useMemo(() => {
    const mine = presetMatcher('mine', presetContext);
    return mine === undefined ? 0 : data.tasks.filter(mine).length;
  }, [data.tasks, presetContext]);
  // Each tab's href is the list's route on its preset, in the routed project
  // when there is one (a real link); a plain click narrows in place.
  const tabs = useMemo(
    () =>
      presetTabs(counts, {
        current: preset,
        mine: mineCount,
        starred: presetContext.starred.size,
        hrefFor: (id) => issuesHref(id, project),
      }).map((tab) => ({
        ...tab,
        onFollow: () => onPreset(tab.id as TasksPreset),
      })),
    [counts, preset, mineCount, presetContext.starred, onPreset, project]
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
        case 'milestone':
          return [
            { value: FILTER_NONE, label: label(FILTER_NONE) },
            ...menuContext.milestones.map((milestone) => ({
              value: milestone.meta.id,
              label: milestone.meta.title,
            })),
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
  // The routed project's chip, first in the row: its title (the id, tinted
  // as unknown, when no task, live or archived, has it), cleared by its ×
  // like any filter.
  const projectChip = useMemo<FilterChipData | null>(() => {
    if (project === null) return null;
    const title = allTasks.find((task) => task.meta.id === project)?.meta.title;
    return {
      id: 'routed-project',
      field: 'Project',
      summary: title ?? project,
      unknown: title === undefined,
      removeLabel: 'Remove project filter',
      onRemove: () => onClearProject?.(),
    };
  }, [project, allTasks, onClearProject]);
  const clauseChips = useMemo<FilterChipData[]>(
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
  // The toolbar's Filter button. The last chip takes the whole chips bar
  // with it (FilterChips leaves focus to the host then), so its × and Clear
  // all hand focus here first: it never falls to the body.
  const focusFilterButton = useCallback(() => {
    rootRef.current
      ?.querySelector<HTMLElement>('button[aria-haspopup][aria-label="Filter"]')
      ?.focus({ preventScroll: true });
  }, []);
  const chips = useMemo(() => {
    const all =
      projectChip === null ? clauseChips : [projectChip, ...clauseChips];
    const only = all.length === 1 ? all[0] : undefined;
    if (only === undefined) return all;
    return [
      {
        ...only,
        onRemove: () => {
          focusFilterButton();
          only.onRemove();
        },
      },
    ];
  }, [projectChip, clauseChips, focusFilterButton]);

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
    <div ref={rootRef} data-testid="tasks-view" className={styles.root}>
      {/* The list's own chrome: a page that replaces the list (a task, the
          Timeline, Threads, Docs) has its own header, so the search, filters
          and presets go with the list. */}
      {!full && (
        <>
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
                <FilterPicker
                  filters={filters}
                  onChange={setFilters}
                  context={menuContext}
                  open={filterOpen}
                  onOpenChange={setFilterOpen}
                  onAiFilter={aiFilter}
                />
                <DisplayPanel
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
                  title={
                    byPerson ? 'Stop grouping by person' : 'Group by person'
                  }
                  aria-pressed={byPerson}
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
                <SavedViewsMenu
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
                New issue
              </Button>
            }
          />
          <div className={styles.tabs}>
            <NavTabs label="Presets" size="sm" items={tabs} />
          </div>
          <FilterChips
            chips={chips}
            onClearAll={() => {
              focusFilterButton();
              setFilters(EMPTY_TASK_FILTER_SET);
              if (project !== null) onClearProject?.();
            }}
            clearDisabled={!filtersActive && project === null}
          />
        </>
      )}
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
            {/* The asks belong to the Needs you page; other presets leave them to its sidebar badge. */}
            {preset === 'needs-you' && (
              <div className={styles.needs}>
                <NeedsYouBlock
                  flush
                  data={data}
                  needs={needs}
                  decided={decided}
                  onOpenRef={onOpenRef}
                  onOpenDecision={onOpenDecision}
                />
              </div>
            )}
            <div className={styles.main}>
              {mode === 'board' ? (
                <BoardPane
                  data={data}
                  display={display}
                  taskFilter={taskFilter}
                  returnTaskId={returnTaskId ?? undefined}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  onRequestFilter={requestFilter}
                  onRequestDisplay={requestDisplay}
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
                  returnTaskId={returnTaskId ?? undefined}
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
