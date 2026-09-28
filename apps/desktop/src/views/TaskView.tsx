import { useMemo } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { ErrorBoundary } from '../components/shell/ErrorBoundary';
import { useShellActions } from '../components/shell/ShellActionsContext';
import type { TaskDetailPanelProps } from '../components/tasks/detail';
import { TaskPage } from '../components/tasks/detail';
import { TaskChatTab } from '../components/tasks/TaskChatTab';
import { TaskDiffTab } from '../components/tasks/TaskDiffTab';
import { TaskPreviewTab } from '../components/tasks/TaskPreviewTab';
import { TaskThreadTab } from '../components/tasks/TaskThreadTab';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { ImpactSubjectRef, TaskTab } from '../lib/appNav';
import { formatShortDate } from '../lib/taskDates';
import { openRefWith } from '../lib/threadSources';
import { ViewTabs } from '@/ui/ai/page-header';
import { SelectPill } from '@/ui/ai/pill';
import { EmptyState } from '@/ui/chrome/empty-state';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

const TASK_TABS = [
  { id: 'details', label: 'Details' },
  { id: 'chat', label: 'Chat' },
  { id: 'thread', label: 'Thread' },
  { id: 'diff', label: 'Diff' },
  { id: 'preview', label: 'Preview' },
];

export interface TaskViewProps {
  data: DispatchProjectData;
  taskId: string;
  tab: TaskTab;
  activeRunId: string | null;
  onSetTab: (tab: TaskTab) => void;
  /** Dispatches `openTask` with the same task+tab and a new run selected. */
  onSelectRun: (runId: string) => void;
  onBack: () => void;
  /** The exact prop bundle `TaskPage` needs — shared with the peek dialog so both mounts
   * render identically. `undefined` when the caller's own lookup of `taskId` came up empty;
   * this component's `doc === null` branch below renders the same "gone" state first. */
  panelProps: TaskDetailPanelProps | undefined;
  /** Opens the run's pull request on the PR review page. */
  onViewPr: (runId: string) => void;
  /** Opens `ImpactView` with a subject preselected — reaches the Diff tab's review case
   * panel, which is where the retired Review page used to offer this. */
  onOpenImpact: (subject: ImpactSubjectRef) => void;
  /** Opens a doc a thread's `doc:` ref names, at its section when the ref has one. */
  onOpenDoc: (docId: string, anchor: string | null) => void;
  /** The active project's display name, the first crumb of the page header (`null` only
   * when no project is active). Required so a mount that forgets it fails `tsc` instead
   * of silently dropping the segment. */
  projectName: string | null;
}

/**
 * One task, full-window: `TaskPage` draws the crumb header with Details/Chat/Thread/Diff
 * view tabs; Details is the page's own body, Chat hosts `TaskChatTab`, Thread hosts
 * `TaskThreadTab`, Diff hosts `TaskDiffTab`.
 */
export function TaskView({
  data,
  taskId,
  tab,
  activeRunId,
  onSetTab,
  onSelectRun,
  onBack,
  panelProps,
  onViewPr,
  onOpenImpact,
  onOpenDoc,
  projectName,
}: TaskViewProps) {
  const doc =
    data.tasksIncludingArchived.find((t) => t.meta.id === taskId) ?? null;
  const taskRuns = useMemo(
    () =>
      data.runs
        .filter((r) => r.taskId === taskId)
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)),
    [data.runs, taskId]
  );
  const selectedRun = taskRuns.find((r) => r.id === activeRunId);
  const shell = useShellActions();
  // Where a thread's ref chips and sender names lead from inside the task page.
  const openRef = useMemo(
    () =>
      openRefWith({
        openTask: shell.openTask,
        openThread: shell.openThread,
        openImpact: onOpenImpact,
        openDoc: onOpenDoc,
      }),
    [shell.openTask, shell.openThread, onOpenImpact, onOpenDoc]
  );
  if (doc === null || panelProps === undefined)
    return (
      <EmptyState
        className="h-full"
        heading="That task is no longer available."
        description="It was archived or deleted while this page was open."
        secondary={{ label: 'Back', onClick: onBack }}
      />
    );

  // The session select: which run the Chat and Diff tabs read. Details and Thread have none.
  const sessionSelect =
    tab !== 'details' && tab !== 'thread' && taskRuns.length > 0 ? (
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<SelectPill aria-label="Session" className="max-w-72" />}
        >
          {selectedRun !== undefined ? (
            <span className="flex items-center gap-1.5">
              <RunStatePill meta={selectedRun} compact />
              <span className="font-book text-[13px] tracking-(--id-tracking)">
                {selectedRun.id}
              </span>
            </span>
          ) : (
            'Pick a session'
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-72">
          {taskRuns.map((r) => (
            <DropdownMenuItem key={r.id} onClick={() => onSelectRun(r.id)}>
              <RunStatePill meta={r} compact />
              <span className="font-book min-w-0 flex-1 truncate text-[13px] tracking-(--id-tracking)">
                {r.id}
              </span>
              <span className="text-muted-foreground font-book text-[12px]">
                {formatShortDate(r.updatedAt)}
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    ) : undefined;

  return (
    <TaskPage
      mode="page"
      projectName={projectName}
      {...panelProps}
      tabs={
        <ViewTabs
          tabs={TASK_TABS}
          active={tab}
          onChange={(id) => onSetTab(id as TaskTab)}
          label="Task views"
        />
      }
      controls={sessionSelect}
    >
      {tab === 'chat' ? (
        <ErrorBoundary label="this tab">
          <TaskChatTab
            data={data}
            doc={doc}
            selectedRun={selectedRun}
            onDispatch={() => void data.handleDispatch(doc.meta.id)}
          />
        </ErrorBoundary>
      ) : tab === 'thread' ? (
        <ErrorBoundary label="this tab">
          <TaskThreadTab
            data={data}
            taskId={doc.meta.id}
            onOpenRef={openRef}
            onOpenOverseer={() => shell.setGlobalView('overseer')}
          />
        </ErrorBoundary>
      ) : tab === 'diff' ? (
        <ErrorBoundary label="this tab">
          <TaskDiffTab
            data={data}
            selectedRun={selectedRun}
            onViewPr={onViewPr}
            onOpenImpact={onOpenImpact}
            onDispatch={
              data.readyIds.has(doc.meta.id)
                ? () => void data.handleDispatch(doc.meta.id)
                : undefined
            }
          />
        </ErrorBoundary>
      ) : tab === 'preview' ? (
        <ErrorBoundary label="this tab">
          <TaskPreviewTab data={data} selectedRun={selectedRun} />
        </ErrorBoundary>
      ) : undefined}
    </TaskPage>
  );
}
