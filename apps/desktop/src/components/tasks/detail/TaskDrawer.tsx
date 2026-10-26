import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  AssigneePicker,
  Button,
  DateField,
  EstimatePicker,
  InlineTextField,
  LabelPicker,
  MilestonePicker,
  type PersonChoice,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  ProjectPicker,
  type PropertyListItem,
  SlideOver,
  StatePicker,
  Switch,
  type TaskComment,
  type TaskDetailAlert,
  TaskDetailSection,
  TaskPropertyValue,
  type TaskRelation,
  TaskRelationList,
  TaskRelationPicker,
  TaskSlideOver,
  TextAreaEditor,
} from '@dispatch/ui';
import { Bot, Ellipsis } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';

import { AGENTS_GROUP } from '../../../adapters/people';
import type {
  DetailComment,
  DetailFact,
  RelationModel,
} from '../../../adapters/taskDetail';
import { describeError } from '../../../lib/actionFeedback';
import { resolveExecuteModel } from '../../../lib/models';
import { isTerminalRunState } from '../../../lib/runState';
import { Markdown } from '../../runs/Markdown';
import { useToasts } from '../../shell/Toasts';
import { AttachmentsRow, useAttachmentUpload } from '../page/AttachmentsRow';
import { DispatchCard } from '../page/DispatchCard';
import { RunStrip } from '../page/RunStrip';
import { SubtasksBlock } from '../page/SubtasksBlock';
import { type TaskPageHost, useTaskPageHost } from '../page/TaskPageHost';
import styles from './TaskDrawer.module.css';
import { type TaskDetailState, useTaskDetail } from './useTaskDetail';

// The quick-look drawer (owner decision, Phase 3a): a row click, Space and
// "Quick look" open one task in @dispatch/ui's 620px TaskSlideOver over
// whichever main view is showing; Enter, o and the drawer's "Open" go to the
// full page. The drawer's own markup is @dispatch/ui only, fed by
// adapters/taskDetail through useTaskDetail; Dispatch's legacy Work pieces
// (the dispatch card, the run strip, the sub-issues, the attachments) sit
// inside it as children until Phase 7 restyles them. It mounts in the shell's
// peek slot while `twoViewsState.peek` is a task; Esc (SlideOver's) closes it.

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** Activity items shown before "Show all". */
const ACTIVITY_LIMIT = 8;

/** The "⋯" menu's actions. */
type MenuAction =
  | 'copy-id'
  | 'copy-link'
  | 'dispatch'
  | 'archive'
  | 'unarchive'
  | 'drop';

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

/** Agents take the Bot glyph in place of the initials avatar, as the list's pickers do. */
function peopleWithMarks(people: readonly PersonChoice[]): PersonChoice[] {
  return people.map((choice) =>
    choice.group === AGENTS_GROUP
      ? { ...choice, mark: { kind: 'node', node: <Bot {...ICON} /> } }
      : choice
  );
}

/** A relation row for TaskRelationList: the adapter's model plus where it opens. */
function relationRow(
  relation: RelationModel,
  peek: (taskId: string) => void,
  onRemove?: () => void | Promise<unknown>
): TaskRelation {
  const row: TaskRelation = {
    id: relation.id,
    taskKey: relation.taskKey,
    title: relation.title,
    href: relation.href,
    onOpen: () => peek(relation.id),
    state: relation.state,
    resolved: relation.resolved,
  };
  if (relation.assignee !== undefined) row.assignee = relation.assignee;
  if (relation.context !== undefined) row.context = relation.context;
  if (relation.missing === true) row.external = true;
  if (onRemove !== undefined) row.onRemove = onRemove;
  return row;
}

/**
 * One property row: the fact's control when the window may write and the
 * property has one, else its value as text (toned and noted as the adapter
 * says). The status fact is left out here: the status line carries it.
 */
function propertyFor(
  fact: DetailFact,
  state: TaskDetailState
): PropertyListItem | null {
  const { choices, saveFact, me } = state;
  const value: ReactNode = (() => {
    if (!fact.editable) return null;
    switch (fact.kind) {
      case 'person':
        return (
          <AssigneePicker
            people={peopleWithMarks(choices.people)}
            meId={me ?? undefined}
            value={fact.raw}
            valueLabel={fact.value}
            placeholder={fact.value}
            placeholderTone={fact.tone ?? 'muted'}
            noneLabel="Nobody"
            onChange={(next) => saveFact('assignee', next)}
          />
        );
      case 'priority':
        return (
          <PriorityPicker
            value={fact.raw}
            priorityTones={{ 1: 'danger' }}
            onChange={(next) => saveFact('priority', next)}
          />
        );
      case 'labels':
        return (
          <LabelPicker
            labelOptions={choices.labels}
            value={fact.raw}
            placeholder="No labels"
            onChange={(next) => saveFact('labels', next)}
          />
        );
      case 'estimate':
        return (
          <EstimatePicker
            estimates={choices.estimates}
            value={fact.raw}
            placeholder="No estimate"
            noneLabel="No estimate"
            onChange={(next) => saveFact('estimate', next)}
          />
        );
      case 'date':
        return (
          <DateField
            label={fact.label}
            value={fact.raw}
            onChange={(next) =>
              saveFact(fact.id === 'start' ? 'start' : 'due', next)
            }
          />
        );
      case 'plan':
        // An issue files under a milestone (or a parent issue); a container
        // under a project or an initiative.
        return choices.plans.projects.length > 0 &&
          choices.plans.milestones.length === 0 &&
          choices.plans.issues.length === 0 ? (
          <ProjectPicker
            label={fact.label}
            projects={choices.plans.projects}
            value={fact.raw}
            valueLabel={fact.value}
            noneLabel="No parent"
            onChange={(next) => saveFact('parent', next)}
          />
        ) : (
          <MilestonePicker
            label={fact.label}
            milestones={[
              ...choices.plans.milestones,
              ...choices.plans.issues.map((issue) => ({
                ...issue,
                group: 'Issues',
              })),
              ...choices.plans.projects.map((project) => ({
                ...project,
                group: 'Projects',
              })),
            ]}
            value={fact.raw}
            valueLabel={fact.value}
            noneLabel="No parent"
            onChange={(next) => saveFact('parent', next)}
          />
        );
      case 'switch':
        return (
          <Switch
            label={fact.value}
            aria-label={`${fact.label}: ${fact.value}`}
            checked={fact.raw}
            onChange={(next) => void saveFact('selfReview', next)}
          />
        );
      default:
        return null;
    }
  })();
  if (fact.kind === 'state') return null;
  return {
    id: fact.id,
    label: fact.label,
    value:
      value !== null ? (
        fact.note === undefined ? (
          value
        ) : (
          <TaskPropertyValue note={fact.note}>{value}</TaskPropertyValue>
        )
      ) : (
        <TaskPropertyValue tone={fact.tone} note={fact.note}>
          {fact.kind === 'link' && fact.href !== undefined ? (
            <a
              className={styles.link}
              href={fact.href}
              target="_blank"
              rel="noreferrer"
            >
              {fact.value}
            </a>
          ) : (
            fact.value
          )}
        </TaskPropertyValue>
      ),
  };
}

/** What a comment's own "⋯" offers. */
const COMMENT_ACTIONS: PickerOption[] = [
  { value: 'reply', label: 'Reply' },
  { value: 'edit', label: 'Edit' },
  { value: 'delete', label: 'Delete' },
];

/** A comment box open under one comment: a reply to it, or an edit of it. */
type CommentBox = { id: string; kind: 'reply' | 'edit' } | null;

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
  const {
    header,
    canEdit,
    container,
    runs,
    latestRun,
    readiness,
    openPage,
    peek,
  } = state;
  const taskId = item.meta.id;
  const { project } = host;
  const toasts = useToasts();
  const [commentBox, setCommentBox] = useState<CommentBox>(null);
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

  // A menu action's failure is a toast: the menu has no row to print it beside.
  function run(title: string, action: Promise<unknown>) {
    action.catch((err: unknown) => {
      toasts.push({
        title,
        description: describeError(err),
        tone: 'error',
      });
    });
  }
  function onMenu(action: MenuAction) {
    switch (action) {
      case 'copy-id':
        state.copyId();
        return;
      case 'copy-link':
        state.copyLink?.();
        return;
      case 'dispatch':
        run('Dispatch failed', state.dispatch());
        return;
      case 'archive':
      case 'unarchive':
        run('Could not save the task', state.toggleArchive());
        return;
      case 'drop':
        run('Could not change the status', state.drop());
        return;
    }
  }
  const menu: PickerOption[] = [
    { value: 'copy-id', label: 'Copy id' },
    ...(state.copyLink === undefined
      ? []
      : [{ value: 'copy-link', label: 'Copy link' }]),
    ...(canEdit && !container
      ? [
          {
            value: 'dispatch',
            label: readiness.blocked ? 'Dispatch anyway' : 'Dispatch',
            disabled: !readiness.canDispatch || state.dispatching,
          },
        ]
      : []),
    ...(canEdit
      ? [
          state.archived
            ? { value: 'unarchive', label: 'Unarchive' }
            : { value: 'archive', label: 'Archive' },
          { value: 'drop', label: 'Drop', disabled: state.dropped },
        ]
      : []),
  ];

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
        options={menu}
        trigger={<Ellipsis {...ICON} />}
        triggerLabel="More actions"
        onChange={(value) => {
          if (value !== null) onMenu(value as MenuAction);
        }}
      />
    </>
  );

  // A failed run's alert leads to the run itself.
  const alerts: TaskDetailAlert[] = state.alerts.map((alert) =>
    alert.id === 'run-failed' && latestRun !== undefined
      ? {
          ...alert,
          action: {
            label: 'Open run',
            onClick: () => openPage('run', latestRun.id),
          },
        }
      : alert
  );

  const properties = state.facts
    .map((fact) => propertyFor(fact, state))
    .filter((row): row is PropertyListItem => row !== null);

  const linked = useMemo(
    () => [
      taskId,
      ...state.relations.blockedBy.map((r) => r.id),
      ...state.relations.blocks.map((r) => r.id),
    ],
    [taskId, state.relations]
  );
  const relations = {
    blockedBy: state.relations.blockedBy.map((relation) =>
      relationRow(
        relation,
        peek,
        canEdit ? () => state.removeBlocker(relation.id) : undefined
      )
    ),
    blocks: state.relations.blocks.map((relation) =>
      relationRow(
        relation,
        peek,
        canEdit ? () => state.removeBlocks(relation.id) : undefined
      )
    ),
  };

  const description = state.description;
  const descriptionData =
    description === null
      ? { text: null, loading: true }
      : canEdit
        ? {
            text: description.description,
            content: (
              <TextAreaEditor
                label="Description"
                value={description.description}
                emptyLabel="No description"
                placeholder="Add a description (markdown)…"
                view={(text) =>
                  text.trim() === '' ? undefined : (
                    <Markdown
                      className={styles.markdown}
                      variant="prose"
                      content={text}
                    />
                  )
                }
                onSave={state.saveDescription}
              />
            ),
          }
        : {
            text: description.description,
            content:
              description.description.trim() === '' ? undefined : (
                <Markdown
                  className={styles.markdown}
                  variant="prose"
                  content={description.description}
                />
              ),
            clampContent: true,
          };

  // Comments: the viewer's own carry a "⋯" (Reply, Edit, Delete); the box a
  // pick opens sits under the comment, the one new-comment box under the list.
  const commentItems: TaskComment[] = (state.comments ?? []).map(
    (comment: DetailComment) => {
      const editing =
        commentBox?.kind === 'edit' && commentBox.id === comment.id;
      const replying =
        commentBox?.kind === 'reply' && commentBox.id === comment.id;
      const row: TaskComment = {
        id: comment.id,
        author: comment.author,
        at: comment.at,
        body: comment.body,
        content: editing ? (
          <TextAreaEditor
            label="Edit comment"
            value={comment.body}
            editing
            onEditingChange={(open) => {
              if (!open) setCommentBox(null);
            }}
            onSave={(body) => state.editComment(comment.id, body)}
          />
        ) : (
          <Markdown content={comment.body} />
        ),
      };
      if (comment.dateTime !== undefined) row.dateTime = comment.dateTime;
      if (comment.tone !== undefined) row.tone = comment.tone;
      if (comment.reply === true) row.reply = true;
      if (comment.own && canEdit) {
        row.actions = (
          <PickerPopover
            label={`Actions for the comment by ${comment.author}`}
            searchable={false}
            action
            appearance="quiet"
            align="end"
            value={null}
            options={COMMENT_ACTIONS}
            trigger={<Ellipsis {...ICON} />}
            triggerLabel="Comment actions"
            onChange={(value) => {
              if (value === 'reply' || value === 'edit') {
                setCommentBox({ id: comment.id, kind: value });
              } else if (value === 'delete') {
                run(
                  'Could not delete the comment',
                  state.removeComment(comment.id)
                );
              }
            }}
          />
        );
      }
      if (replying) {
        row.footer = (
          <TextAreaEditor
            mode="compose"
            label={`Reply to ${comment.author}`}
            placeholder="Write a reply… (markdown)"
            saveLabel="Reply"
            onSave={async (body) => {
              // A reply threads under the root, one level deep.
              await state.addComment(body, comment.parentId ?? comment.id);
              setCommentBox(null);
            }}
          />
        );
      }
      return row;
    }
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
              onDispatch={() => run('Dispatch failed', state.dispatch())}
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

  const acceptance = state.description;
  const related = state.relations.related;
  const duplicateOf = state.relations.duplicateOf;

  return (
    <TaskSlideOver
      open
      onClose={onClose}
      taskKey={header.taskKey}
      title={header.title}
      titleControl={
        canEdit ? (
          <InlineTextField
            label="Title"
            value={item.meta.title}
            placeholder="Untitled task"
            maxLength={255}
            onSave={state.saveTitle}
          />
        ) : undefined
      }
      href={header.href}
      breadcrumb={header.breadcrumb}
      headerActions={headerActions}
      status={{
        kind: header.status.kind,
        label: header.status.label,
        control: canEdit ? (
          <StatePicker
            states={state.choices.states}
            value={item.meta.status}
            onChange={state.saveStatus}
          />
        ) : undefined,
      }}
      alerts={alerts}
      properties={properties}
      rail={hasWork ? work : undefined}
      description={descriptionData}
      relations={relations}
      sectionMeta={
        canEdit
          ? {
              blockedBy: (
                <TaskRelationPicker
                  label="Add blocker"
                  trigger="+ Add blocker"
                  search={(query) =>
                    Promise.resolve(state.searchRelations(query, linked))
                  }
                  exclude={linked}
                  onSelect={(task) => state.addBlocker(task.id)}
                />
              ),
            }
          : undefined
      }
      comments={{
        items: commentItems,
        loading: state.comments === null && state.commentsError === null,
        error: state.commentsError,
        composer: canEdit ? (
          <TextAreaEditor
            mode="compose"
            label="New comment"
            placeholder="Leave a comment… (markdown)"
            onSave={(body) => state.addComment(body)}
          />
        ) : undefined,
      }}
      activity={state.activity ?? undefined}
      activityLimit={ACTIVITY_LIMIT}
    >
      {acceptance !== null && (
        <TaskDetailSection
          title="Acceptance criteria"
          count={acceptance.criteria.length}
        >
          {canEdit ? (
            <TextAreaEditor
              label="Acceptance criteria"
              value={acceptance.acceptance}
              emptyLabel="No acceptance criteria"
              placeholder="One criterion per line…"
              view={(text) =>
                text.trim() === '' ? undefined : (
                  <Markdown
                    className={styles.markdown}
                    variant="prose"
                    content={text}
                  />
                )
              }
              onSave={state.saveAcceptance}
            />
          ) : acceptance.acceptance.trim() === '' ? (
            <p className="muted">No acceptance criteria</p>
          ) : (
            <Markdown
              className={styles.markdown}
              variant="prose"
              content={acceptance.acceptance}
            />
          )}
        </TaskDetailSection>
      )}
      {(related.length > 0 || duplicateOf !== null) && (
        <TaskDetailSection
          title="Related"
          count={related.length + (duplicateOf === null ? 0 : 1)}
        >
          <TaskRelationList
            label="Related"
            items={[
              ...(duplicateOf === null
                ? []
                : [
                    {
                      ...relationRow(duplicateOf, peek),
                      context: 'Duplicate of',
                    },
                  ]),
              ...related.map((relation) => relationRow(relation, peek)),
            ]}
          />
        </TaskDetailSection>
      )}
    </TaskSlideOver>
  );
}
