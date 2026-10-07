import { Plus } from 'lucide-react';
import { type ReactNode, useCallback, useMemo, useState } from 'react';

import { MilestoneMapView } from '../components/graph/MilestoneMap';
import { MilestoneStatusCells } from '../components/tasks/MilestoneStatusCells';
import { NeedsYouBlock } from '../components/tasks/NeedsYouBlock';
import { TasksExtraGroups } from '../components/tasks/TasksExtraGroups';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import { TasksStrip } from '../components/tasks/TasksStrip';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { TaskTab } from '../lib/appNav';
import { containerStatus } from '../lib/containerStatus';
import type { DecisionItem } from '../lib/decisionFeed';
import { groupTasks, type ListGroup } from '../lib/listGrouping';
import type { NeedsYou } from '../lib/needsYou';
import { useStatusModelOf } from '../lib/statusModel';
import {
  DEFAULT_TASKS_DISPLAY,
  type TasksDisplayPrefs,
} from '../lib/tasksPrefs';
import {
  type PresetContext,
  presetMatcher,
  TASKS_PRESETS,
  type TasksPreset,
} from '../lib/tasksPresets';
import type { TaskStatusCounts } from '../lib/taskStatus';
import type { RefAction } from '../lib/threadSources';
import type { TasksMode, TasksPage } from '../lib/twoViews';
import { TasksListView } from './TasksListView';
import { SelectPill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

// One list grouped by milestone, the No milestone group included.
const BY_MILESTONE: TasksDisplayPrefs = {
  ...DEFAULT_TASKS_DISPLAY,
  layout: 'list',
  grouping: 'milestone',
};

const MODES: { id: TasksMode; label: string }[] = [
  { id: 'list', label: 'List' },
  { id: 'graph', label: 'Graph' },
];

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

/** Tasks: the strip, every ask pinned on top, the work by milestone, and its pages. */
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
  const taskFilter = useMemo(
    () => presetMatcher(preset, presetContext),
    [preset, presetContext]
  );
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
            BY_MILESTONE,
            { statuses: data.config.statuses, epics: data.epics, model }
          ),
    [mode, data.config, data.tasks, data.epics, taskFilter, model]
  );
  const presetLabel =
    TASKS_PRESETS.find((p) => p.id === preset)?.label ?? 'All';
  const full = page.kind !== 'list' && !split;

  return (
    <div data-testid="tasks-view" className="flex h-full min-h-0 flex-col">
      <div className="border-border flex items-center gap-3 border-b-[0.5px] px-4 py-2">
        <span className="shrink-0 text-[13px] font-medium">All work</span>
        <TasksStrip counts={counts} preset={preset} onPreset={onPreset} />
        <span className="flex-1" />
        <ToggleGroup
          aria-label="Tasks layout"
          variant="outline"
          size="sm"
          value={[mode]}
          onValueChange={(next) => {
            const picked = MODES.find((m) => m.id === next[0]);
            if (picked !== undefined) onModeChange(picked.id);
          }}
          className="shrink-0"
        >
          {MODES.map((m) => (
            <ToggleGroupItem key={m.id} value={m.id}>
              {m.label}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
        <DropdownMenu>
          <DropdownMenuTrigger
            data-testid="tasks-preset"
            render={<SelectPill />}
          >
            view: {presetLabel}
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[160px]">
            <DropdownMenuRadioGroup
              value={preset}
              onValueChange={(value) => {
                const next = TASKS_PRESETS.find((p) => p.id === value);
                if (next !== undefined) onPreset(next.id);
              }}
            >
              {TASKS_PRESETS.map((p) => (
                <DropdownMenuRadioItem key={p.id} value={p.id}>
                  {p.label}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <Button size="sm" onClick={onNewTask} className="shrink-0">
          <Plus className="size-3.5" />
          New task
        </Button>
      </div>
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
              {mode === 'graph' ? (
                <MilestoneMapView
                  groups={graphGroups}
                  bucketOf={presetContext.bucketOf}
                  asksByTask={needs.byTask}
                  projectKey={projectKey}
                  dueDateOf={(id) => epicById.get(id)?.meta.dueDate ?? null}
                  onOpenTask={onSelectTask}
                />
              ) : (
                <TasksListView
                  data={data}
                  onSelectTask={(taskId) => onSelectTask(taskId)}
                  display={BY_MILESTONE}
                  taskFilter={taskFilter}
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
