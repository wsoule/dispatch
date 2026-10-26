import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { ApiClient } from '@dispatch/client';
import {
  Button,
  EmptyState,
  type NavTabItem,
  NavTabs,
  PickerPopover,
  SkeletonText,
  TaskDetail,
  TaskDetailSection,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import {
  Ellipsis,
  FileDiff,
  FileText,
  Flag,
  FolderTree,
  type LucideIcon,
  Maximize2,
  MessagesSquare,
  MonitorPlay,
  SquareTerminal,
  Star,
  Waypoints,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { useTeamOn } from '../../../hooks/useTeamOn';
import type { TaskTab } from '../../../lib/appNav';
import {
  isTypingTagName,
  type ListKeyCommand,
  resolveListKeyCommand,
} from '../../../lib/keyboard';
import { presenceLine } from '../../../lib/remotePresence';
import { taskHref } from '../../../lib/shellRoutes';
import type { TaskPageMode } from '../../../lib/taskPageMode';
import { ErrorBoundary } from '../../shell/ErrorBoundary';
import { AlsoViewing } from '../../shell/PresenceStack';
import { useSavedViewsContext } from '../../shell/SavedViewsContext';
import { useTaskDetail } from '../detail/useTaskDetail';
import {
  type DetailPicker,
  ICON,
  useTaskDetailProps,
} from '../detail/useTaskDetailProps';
import { TaskPreviewTab } from '../TaskPreviewTab';
import { PlanMode } from './PlanMode';
import { ReviewMode } from './ReviewMode';
import { RunMode } from './RunMode';
import { SummaryMode } from './SummaryMode';
import { type TaskPageHost, useTaskPageHost } from './TaskPageHost';
import { TaskPageRail } from './TaskPageRail';
import styles from './TaskPageView.module.css';
import {
  isStage,
  type TaskPageView as PageView,
  useTaskPageModel,
} from './useTaskPageModel';
import { WritesEditor } from './WritesEditor';

// The full task page (owner decision, Phase 3b): Enter, o and the drawer's Open land
// here, on @dispatch/ui's TaskDetail in its page layout: the header bar (crumbs, the
// actions), the title, the status line, the alerts, the property sheet in a rail beside
// the content from 760px (the Work, Sub-issues, Links, Docs and Stack sections under
// it), and Dispatch's lifecycle modes as a NavTabs row under the lead: Spec is
// TaskDetail's own body (description, acceptance criteria, relations, comments,
// activity, exactly the quick-look drawer's sections, shared through
// useTaskDetailProps), Run, Review, Summary and a container's Plan render their existing
// mode components as the body instead. The page has no <main> of its own: it scrolls
// inside AppShell's main like every view, and the Overseer's focus column embeds the
// same component at heading level 2.

const MODE_ICON: Record<TaskPageMode, LucideIcon> = {
  spec: FileText,
  run: SquareTerminal,
  review: FileDiff,
  summary: Flag,
  plan: Waypoints,
};

// Which property picker each single-key command opens (Linear's keys).
const PICKER_FOR_KEY: Partial<Record<ListKeyCommand, DetailPicker>> = {
  'list-set-status': 'status',
  'list-set-priority': 'priority',
  'list-set-assignee': 'assignee',
  'list-set-labels': 'labels',
  'list-set-epic': 'parent',
  'list-set-milestone': 'parent',
};

export interface TaskPageViewProps {
  taskId: string;
  /** The mode, when the caller keeps it (the Tasks page keeps it in history); omitted,
   * the page holds it and starts on `auto`. */
  mode?: TaskTab;
  onModeChange?: (mode: TaskTab) => void;
  /** The run the Run and Review modes show, when the caller keeps it. */
  runId?: string | null;
  onSelectRun?: (runId: string) => void;
  /** Closes the page: back to the list, or out of the Overseer's column. */
  onBack?: () => void;
  /** An embedded page's way to the Tasks page. */
  onExpand?: () => void;
  /** Unread messages to you about this task, on the Conversation toggle. */
  conversationCount?: number;
  /** The title's heading level: 1 as the Tasks page (default), 2 embedded in another
   * view, whose own heading is the h1. */
  headingLevel?: 1 | 2;
  /** Mounted inside another view (the Overseer's focus column): a dispatch stays in
   * place, the plan does not take focus, and there is no room for the run's preview. */
  embedded?: boolean;
}

/**
 * One task as a page. Renders nothing outside App's TaskPageHost (a test or the
 * gallery); a task the window no longer knows says so, with the way back.
 */
export function TaskPageView(props: TaskPageViewProps) {
  const host = useTaskPageHost();
  if (host === null) return null;
  return <TaskPageResolver host={host} {...props} />;
}

function TaskPageResolver({
  host,
  ...props
}: TaskPageViewProps & { host: TaskPageHost }) {
  const tasks = host.project.tasksIncludingArchived;
  const item = useMemo(
    () => tasks.find((t) => t.meta.id === props.taskId),
    [tasks, props.taskId]
  );
  if (item === undefined) {
    if (!host.project.tasksReady) {
      return (
        <div className={styles.loading}>
          <SkeletonText lines={3} label="Loading the task" />
        </div>
      );
    }
    return (
      <div className={styles.gone}>
        <EmptyState
          label="That task is no longer available."
          action={
            props.onBack === undefined ? undefined : (
              <Button size="sm" onClick={props.onBack}>
                {props.embedded === true ? 'Close' : 'Back'}
              </Button>
            )
          }
        >
          It was archived or deleted while it was open.
        </EmptyState>
      </div>
    );
  }
  return (
    <ErrorBoundary label="this task">
      <TaskPageLoaded key={props.taskId} host={host} item={item} {...props} />
    </ErrorBoundary>
  );
}

// Where the task's run is live on the team and whom it waits on, in the status line;
// nothing when board sync is off or the task has no live run.
function TeamPresenceLine({
  client,
  port,
  taskId,
}: {
  client: ApiClient | null;
  port: number | undefined;
  taskId: string;
}) {
  // Presence only exists on a team; without one the route answers 409.
  const teamOn = useTeamOn(client);
  const query = useQuery({
    queryKey: ['task-presence', port, taskId],
    queryFn: () => {
      if (client === null) throw new Error('no client');
      return client.getTaskPresence(taskId);
    },
    enabled: client !== null && teamOn,
    retry: false,
  });
  const line =
    query.data === undefined
      ? null
      : presenceLine(query.data.presence, query.data.waitingOn);
  if (line === null) return null;
  return <span data-slot="team-presence">{line}</span>;
}

function TaskPageLoaded({
  host,
  item,
  taskId,
  mode,
  onModeChange,
  runId,
  onSelectRun,
  onBack,
  onExpand,
  conversationCount = 0,
  headingLevel = 1,
  embedded = false,
}: TaskPageViewProps & { host: TaskPageHost; item: TaskListItem }) {
  const { project } = host;
  const meta = item.meta;
  const rootRef = useRef<HTMLDivElement>(null);
  const [picker, setPicker] = useState<DetailPicker | null>(null);
  const savedViews = useSavedViewsContext();

  const state = useTaskDetail(host, item);
  const { page, view, autoMode, stages, selectView, sideViews, keyDispatches } =
    useTaskPageModel(host, item, {
      mode,
      onModeChange,
      runId,
      onSelectRun,
      embedded,
    });
  const detail = useTaskDetailProps(host, state, {
    // The page's dispatch keeps its pending state in the model its modes share, and
    // toasts its own failure.
    dispatch: () => page.dispatch(),
    dispatching: page.dispatching,
    openRun: (id) => {
      page.selectRun(id);
      selectView('run');
    },
    picker,
    onPickerChange: setPicker,
  });
  const { canEdit } = state;

  // Linear's single-key property shortcuts and `d` to dispatch, for a key that lands on
  // this page or on nothing at all. A key typed into a field, a picker, a menu or a
  // dialog, or already handled (the Flight Plan's own h/j/k/l and `d`), is left alone.
  const { dispatching, dispatch } = page;
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof HTMLElement)) return;
      if (event.defaultPrevented) return;
      if (target !== document.body && !root.contains(target)) return;
      if (isTypingTagName(target.tagName, target.isContentEditable)) return;
      if (
        target.closest(
          '[role="menu"], [role="listbox"], [role="dialog"], [data-slot="popover-content"]'
        ) !== null
      ) {
        return;
      }
      const command = resolveListKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        { isTyping: false }
      );
      const next = command === null ? undefined : PICKER_FOR_KEY[command];
      if (next !== undefined && canEdit) {
        event.preventDefault();
        setPicker(next);
        return;
      }
      if (command === 'list-dispatch' && keyDispatches && !dispatching) {
        event.preventDefault();
        void dispatch();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [canEdit, keyDispatches, dispatching, dispatch]);

  // The card's "Add writes": the editor sits in the spec's Writes section.
  function focusWrites() {
    if (view !== 'spec') selectView('spec');
    requestAnimationFrame(() => {
      const input = rootRef.current?.querySelector<HTMLInputElement>(
        'input[aria-label="Add a write path"]'
      );
      input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      input?.focus();
    });
  }

  // A side view's toggle: on when showing, off back to the state's own mode.
  const toggle = (next: PageView) =>
    selectView(view === next ? autoMode : next);
  const favoriteRef = { kind: 'task' as const, id: taskId };
  const favorite = savedViews?.isFavorite(favoriteRef) ?? false;
  const headerActions = (
    <>
      <AlsoViewing
        viewers={project.presence.filter(
          (p) => p.viewing === taskId && p.ref !== project.me
        )}
      />
      {sideViews.thread && (
        <Button
          variant="quiet"
          size="sm"
          icon={<MessagesSquare {...ICON} />}
          aria-pressed={view === 'thread'}
          onClick={() => toggle('thread')}
        >
          Conversation
          {conversationCount > 0 && (
            <span className={styles.count}>· {conversationCount}</span>
          )}
        </Button>
      )}
      {sideViews.files && (
        <Button
          variant="quiet"
          size="sm"
          icon={<FolderTree {...ICON} />}
          aria-label="The run's files"
          title="The run's files"
          aria-pressed={view === 'files'}
          onClick={() => toggle('files')}
        />
      )}
      {sideViews.terminal && (
        <Button
          variant="quiet"
          size="sm"
          icon={<SquareTerminal {...ICON} />}
          aria-label="A terminal in the run's worktree"
          title="A terminal in the run's worktree"
          aria-pressed={view === 'terminal'}
          onClick={() => toggle('terminal')}
        />
      )}
      {sideViews.preview && (
        <Button
          variant="quiet"
          size="sm"
          icon={<MonitorPlay {...ICON} />}
          aria-label="Preview the run's app"
          title="Preview the run's app"
          aria-pressed={view === 'preview'}
          onClick={() => toggle('preview')}
        />
      )}
      {savedViews !== null && (
        <Button
          variant="quiet"
          size="sm"
          icon={<Star {...ICON} />}
          aria-label={favorite ? 'Unfavorite' : 'Favorite'}
          title={favorite ? 'Unfavorite' : 'Favorite'}
          aria-pressed={favorite}
          onClick={() => savedViews.toggleFavorite(favoriteRef)}
        />
      )}
      <PickerPopover
        label="More actions"
        searchable={false}
        action
        appearance="quiet"
        align="end"
        value={null}
        options={detail.menu}
        trigger={<Ellipsis {...ICON} />}
        triggerLabel="More actions"
        onChange={(value) => {
          if (value !== null) detail.onMenu(value);
        }}
      />
      {embedded && onExpand !== undefined && (
        <Button
          variant="quiet"
          size="sm"
          icon={<Maximize2 {...ICON} />}
          aria-label="Open the full page"
          title="Open the full page"
          onClick={onExpand}
        />
      )}
      {onBack !== undefined && (
        <Button
          variant="quiet"
          size="sm"
          icon={<X {...ICON} />}
          aria-label="Close"
          title="Close (Esc)"
          onClick={onBack}
        />
      )}
    </>
  );

  // The lifecycle tabs: each stage the task offers, captioned by where it has got.
  // A side view (the conversation, a run's files) leaves no stage current.
  const tabs: NavTabItem[] = stages.map((stage) => {
    const Icon = MODE_ICON[stage.mode];
    const tab: NavTabItem = {
      id: stage.mode,
      label: stage.label,
      icon: <Icon size={14} strokeWidth={1.8} />,
      href: taskHref(taskId),
      current: isStage(view) && view === stage.mode,
      onFollow: () => selectView(stage.mode),
    };
    if (stage.caption !== '' && stage.caption !== '—') tab.note = stage.caption;
    return tab;
  });

  // Spec and Summary read as a column the page scrolls; Run, Review, Plan and the side
  // views fill the pane and scroll inside (the transcript, the diff, the canvas).
  const fills = view !== 'spec' && view !== 'summary';
  let body: ReactNode;
  switch (view) {
    case 'spec':
      body = (
        <>
          {detail.sections}
          {(canEdit || meta.writes.length > 0) && (
            <TaskDetailSection title="Writes" count={meta.writes.length}>
              {canEdit ? (
                <WritesEditor
                  writes={meta.writes}
                  onChange={(writes) => void page.patch({ writes })}
                />
              ) : (
                <ul className={styles.writes}>
                  {meta.writes.map((glob) => (
                    <li key={glob}>{glob}</li>
                  ))}
                </ul>
              )}
            </TaskDetailSection>
          )}
          {page.amendments !== '' && (
            <TaskDetailSection title="Amendments">
              <p className={styles.amendments}>{page.amendments}</p>
            </TaskDetailSection>
          )}
        </>
      );
      break;
    case 'run':
      body = <RunMode page={page} />;
      break;
    case 'review':
      body = <ReviewMode page={page} />;
      break;
    case 'summary':
      body = <SummaryMode page={page} />;
      break;
    case 'plan':
      body = <PlanMode page={page} />;
      break;
    case 'thread':
      body = host.threadView?.(taskId);
      break;
    case 'preview':
      body = <TaskPreviewTab data={project} selectedRun={page.selectedRun} />;
      break;
    case 'files':
      body =
        page.selectedRun === undefined
          ? null
          : host.filesView?.(page.selectedRun.id);
      break;
    case 'terminal':
      body =
        page.selectedRun === undefined
          ? null
          : host.terminalView?.(page.selectedRun.id);
      break;
  }
  const spec = view === 'spec';

  return (
    <div
      ref={rootRef}
      data-slot="task-page"
      data-mode={view}
      className={fills ? `${styles.root} ${styles.fill}` : styles.root}
    >
      <div className={styles.pane}>
        <TaskDetail
          layout="page"
          header
          headingLevel={headingLevel}
          className={styles.detail}
          taskKey={detail.taskKey}
          title={detail.title}
          titleControl={detail.titleControl}
          href={detail.href}
          breadcrumb={detail.breadcrumb}
          headerActions={headerActions}
          status={detail.status}
          statusMeta={
            <TeamPresenceLine
              client={project.client}
              port={project.port}
              taskId={taskId}
            />
          }
          alerts={detail.alerts}
          tabs={<NavTabs label="Lifecycle" size="sm" items={tabs} />}
          properties={detail.properties}
          rail={
            <TaskPageRail
              page={page}
              state={state}
              view={view}
              onAddWrites={focusWrites}
            />
          }
          description={spec ? detail.description : undefined}
          relations={spec ? detail.relations : undefined}
          sectionMeta={spec ? detail.sectionMeta : undefined}
          comments={spec ? detail.comments : undefined}
          activity={spec ? detail.activity : undefined}
          activityLimit={detail.activityLimit}
        >
          {spec ? (
            body
          ) : (
            // Its own boundary, so a crashing mode never strands the header and the rail.
            <div className={styles.mode}>
              <ErrorBoundary label="this view">{body}</ErrorBoundary>
            </div>
          )}
        </TaskDetail>
      </div>
    </div>
  );
}
