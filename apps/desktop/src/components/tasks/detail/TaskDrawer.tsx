import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  Button,
  PickerPopover,
  SlideOver,
  TaskDetailSection,
  TaskSlideOver,
} from '@dispatch/ui';
import { Ellipsis } from 'lucide-react';
import { useEffect } from 'react';

import { resolveExecuteModel } from '../../../lib/models';
import { isTerminalRunState } from '../../../lib/runState';
import { AttachmentsRow, useAttachmentUpload } from '../page/AttachmentsRow';
import { DispatchCard } from '../page/DispatchCard';
import { RunStrip } from '../page/RunStrip';
import { SubtasksBlock } from '../page/SubtasksBlock';
import { type TaskPageHost, useTaskPageHost } from '../page/TaskPageHost';
import styles from './TaskDrawer.module.css';
import { useTaskDetail } from './useTaskDetail';
import { ICON, useTaskDetailProps } from './useTaskDetailProps';

// The quick-look drawer (owner decision, Phase 3a): a row click, Space and
// "Quick look" open one task in @dispatch/ui's 620px TaskSlideOver over
// whichever main view is showing; Enter, o and the drawer's "Open" go to the
// full page (page/TaskPageView). The drawer's own markup is @dispatch/ui only,
// fed by adapters/taskDetail through useTaskDetail and useTaskDetailProps (the
// pieces the page shares); Dispatch's legacy Work pieces (the dispatch card,
// the run strip, the sub-issues, the attachments) sit inside it as children
// until Phase 7 restyles them. It mounts in the shell's peek slot while
// `twoViewsState.peek` is a task; Esc (SlideOver's) closes it.

export interface TaskDrawerProps {
  taskId: string;
  onClose: () => void;
}

/**
 * One task's quick look. Renders nothing outside App's TaskPageHost (a test
 * or the gallery); a task the window no longer knows draws a plain drawer
 * saying so, so the Close button and Esc still work.
 */
export function TaskDrawer({ taskId, onClose }: TaskDrawerProps) {
  const host = useTaskPageHost();
  if (host === null) return null;
  const item = host.project.tasksIncludingArchived.find(
    (t) => t.meta.id === taskId
  );
  if (item === undefined) {
    return (
      <SlideOver
        open
        onClose={onClose}
        title={host.project.tasksReady ? 'Task unavailable' : 'Loading…'}
        contentKey={taskId}
      >
        <p className={styles.gone}>
          {host.project.tasksReady
            ? 'That task is no longer available. It was archived or deleted while it was open.'
            : 'Loading the task…'}
        </p>
      </SlideOver>
    );
  }
  return (
    <TaskDrawerLoaded key={taskId} host={host} item={item} onClose={onClose} />
  );
}

function TaskDrawerLoaded({
  host,
  item,
  onClose,
}: {
  host: TaskPageHost;
  item: TaskListItem;
  onClose: () => void;
}) {
  const state = useTaskDetail(host, item);
  const { canEdit, container, runs, latestRun, readiness, openPage, peek } =
    state;
  const detail = useTaskDetailProps(host, state);
  const taskId = item.meta.id;
  const { project } = host;
  const upload = useAttachmentUpload(project.client, taskId);

  // ⌘/Ctrl+Enter grows the quick look into the full page, as the old peek did.
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        openPage();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [openPage]);

  const headerActions = (
    <>
      <Button variant="quiet" size="sm" onClick={() => openPage()}>
        Open
      </Button>
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
    </>
  );

  // The Work block: Dispatch's own pieces, right after the properties. A
  // read-only window with no run and nothing attached has none.
  const live = runs.some((r) => !isTerminalRunState(r.state));
  const config = project.config;
  const attachments = item.meta.attachments ?? [];
  const showAttachments =
    attachments.length > 0 || (canEdit && !state.archived);
  const hasWork =
    container || canEdit || latestRun !== undefined || showAttachments;
  const work = (
    <TaskDetailSection title="Work">
      <div className={styles.work}>
        {container ? (
          <div className={styles.subtasks}>
            <SubtasksBlock
              title="Sub-issues"
              parent={item}
              tasks={state.children}
              model={state.statusModel}
              latestRunByTaskId={project.latestRunByTaskId}
              onOpenTask={peek}
              createPreset={canEdit ? { epic: taskId } : undefined}
            />
          </div>
        ) : (
          canEdit && (
            <DispatchCard
              readiness={readiness}
              live={live}
              starting={state.dispatching}
              executors={project.executors ?? undefined}
              defaultModel={
                config === null ? undefined : resolveExecuteModel(config)
              }
              defaultEffort={config?.effort?.execute}
              onDispatch={() => detail.run('Dispatch failed', state.dispatch())}
              onOpenRun={() =>
                openPage(
                  'run',
                  latestRun === undefined ? undefined : latestRun.id
                )
              }
              onOpenTask={peek}
              enriching={false}
              onAddWrites={() => openPage('spec')}
            />
          )
        )}
        {latestRun !== undefined && (
          <RunStrip
            run={latestRun}
            runs={runs}
            onSelectRun={(runId) => openPage('run', runId)}
          />
        )}
        {showAttachments && (
          <AttachmentsRow
            taskId={taskId}
            attachments={attachments}
            client={project.client}
            port={project.port}
            editable={canEdit && !state.archived}
            upload={upload.upload}
            uploading={upload.uploading}
          />
        )}
      </div>
    </TaskDetailSection>
  );

  return (
    <TaskSlideOver
      open
      onClose={onClose}
      taskKey={detail.taskKey}
      title={detail.title}
      titleControl={detail.titleControl}
      href={detail.href}
      breadcrumb={detail.breadcrumb}
      headerActions={headerActions}
      status={detail.status}
      alerts={detail.alerts}
      properties={detail.properties}
      // The rail: a container's planning section first (where a milestone's
      // quick look reads its status), then Dispatch's Work block.
      rail={
        detail.planning !== null || hasWork ? (
          <>
            {detail.planning}
            {hasWork ? work : null}
          </>
        ) : undefined
      }
      description={detail.description}
      relations={detail.relations}
      sectionMeta={detail.sectionMeta}
      comments={detail.comments}
      activity={detail.activity}
      activityLimit={detail.activityLimit}
    >
      {detail.sections}
    </TaskSlideOver>
  );
}
