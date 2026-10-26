import { parseLinearExternal } from '@dispatch-foo/core/browser';
import {
  AssigneePicker,
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
  StatePicker,
  Switch,
  type TaskActivityItem,
  type TaskComment,
  type TaskCommentsData,
  type TaskDescriptionData,
  type TaskDetailAlert,
  type TaskDetailProps,
  TaskDetailSection,
  type TaskDetailSectionMeta,
  TaskPropertyValue,
  type TaskRelation,
  TaskRelationList,
  TaskRelationPicker,
  type TaskRelations,
  TextAreaEditor,
} from '@dispatch/ui';
import { Bot, Ellipsis } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { AGENTS_GROUP } from '../../../adapters/people';
import type {
  DetailComment,
  DetailFact,
  RelationModel,
} from '../../../adapters/taskDetail';
import { describeError } from '../../../lib/actionFeedback';
import {
  isLinearConfigured,
  pushToLinearError,
} from '../../../lib/linearSettings';
import { Markdown } from '../../runs/Markdown';
import { useToasts } from '../../shell/Toasts';
import type { TaskPageHost } from '../page/TaskPageHost';
import styles from './taskDetailProps.module.css';
import type { TaskDetailState } from './useTaskDetail';

// What the quick-look drawer (TaskDrawer) and the task page (page/TaskPageView) both
// hand @dispatch/ui's TaskDetail for one task, built from useTaskDetail's state: the
// header (an editable title and status when the window may write), the alerts, the
// property sheet with its pickers, the description, the relations with their "+ Add
// blocker", the comments with their menus and boxes, the activity, the extra sections
// (acceptance criteria, related) and the "⋯" menu. One place, so the two surfaces never
// drift apart.

export const ICON = {
  size: 14,
  strokeWidth: 1.8,
  'aria-hidden': true,
} as const;

/** Activity items shown before "Show all". */
const ACTIVITY_LIMIT = 8;

/** The "⋯" menu's actions. */
type MenuAction =
  | 'copy-id'
  | 'copy-link'
  | 'dispatch'
  | 'push-linear'
  | 'archive'
  | 'unarchive'
  | 'drop';

/** A property picker a single-key shortcut can hold open (the page's s, p, a, l, m). */
export type DetailPicker =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'parent';

export interface TaskDetailPropsOptions {
  /** Replaces the state's dispatch with the surface's own (the page's keeps its pending
   * state in the model its modes share). */
  dispatch?: () => Promise<void>;
  dispatching?: boolean;
  /** Where a failed run's alert leads; by default the full page's Run mode. */
  openRun?: (runId: string) => void;
  /** The picker a shortcut holds open, and the change when it closes or another opens. */
  picker?: DetailPicker | null;
  onPickerChange?: (picker: DetailPicker | null) => void;
}

/** TaskDetail's props for one task, less the layout and the slots a surface adds
 * (header actions, the rail, the tabs). */
export interface TaskDetailViewProps extends Pick<
  TaskDetailProps,
  'taskKey' | 'title' | 'titleControl' | 'href' | 'breadcrumb' | 'status'
> {
  alerts: TaskDetailAlert[];
  properties: PropertyListItem[];
  description: TaskDescriptionData;
  relations: TaskRelations;
  sectionMeta: TaskDetailSectionMeta | undefined;
  comments: TaskCommentsData;
  activity: TaskActivityItem[] | undefined;
  activityLimit: number;
  /** The acceptance criteria and the related tasks, as sections at the sections' level. */
  sections: ReactNode;
  /** The "⋯" menu's entries and what a pick does. */
  menu: PickerOption[];
  onMenu: (value: string) => void;
  /** Runs an action whose failure is a toast (a menu pick has no row to print it beside). */
  run: (title: string, action: Promise<unknown>) => void;
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

/** The controlled-open props of the picker a shortcut names, none for the others. */
function pickerOpen(
  kind: DetailPicker,
  options: TaskDetailPropsOptions
): { open?: boolean; onOpenChange?: (open: boolean) => void } {
  const { picker, onPickerChange } = options;
  if (picker === undefined || onPickerChange === undefined) return {};
  return {
    open: picker === kind,
    onOpenChange: (open) => onPickerChange(open ? kind : null),
  };
}

/**
 * One property row: the fact's control when the window may write and the
 * property has one, else its value as text (toned and noted as the adapter
 * says). The status fact is left out here: the status line carries it.
 */
function propertyFor(
  fact: DetailFact,
  state: TaskDetailState,
  options: TaskDetailPropsOptions
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
            {...pickerOpen('assignee', options)}
          />
        );
      case 'priority':
        return (
          <PriorityPicker
            value={fact.raw}
            priorityTones={{ 1: 'danger' }}
            onChange={(next) => saveFact('priority', next)}
            {...pickerOpen('priority', options)}
          />
        );
      case 'labels':
        return (
          <LabelPicker
            labelOptions={choices.labels}
            value={fact.raw}
            placeholder="No labels"
            onChange={(next) => saveFact('labels', next)}
            {...pickerOpen('labels', options)}
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
            {...pickerOpen('parent', options)}
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
            {...pickerOpen('parent', options)}
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

/** A read-only body (the description, the criteria) as markdown; nothing when blank. */
function markdownView(text: string): ReactNode {
  return text.trim() === '' ? undefined : (
    <Markdown className={styles.markdown} variant="prose" content={text} />
  );
}

/**
 * Builds TaskDetail's props for `state` (useTaskDetail's), with every control wired to
 * the state's writes. The comment boxes (a reply, an edit) are this hook's state, so the
 * surface that calls it needs none of its own.
 */
export function useTaskDetailProps(
  host: TaskPageHost,
  state: TaskDetailState,
  options: TaskDetailPropsOptions = {}
): TaskDetailViewProps {
  const { header, canEdit, container, latestRun, readiness, openPage, peek } =
    state;
  const { item } = state;
  const taskId = item.meta.id;
  const { project } = host;
  const toasts = useToasts();
  const [commentBox, setCommentBox] = useState<CommentBox>(null);
  const dispatch = options.dispatch ?? state.dispatch;
  const dispatching = options.dispatching ?? state.dispatching;
  const openRun =
    options.openRun ?? ((runId: string) => openPage('run', runId));

  // A menu action's failure is a toast: the menu has no row to print it beside.
  function run(title: string, action: Promise<unknown>) {
    action.catch((err: unknown) => {
      toasts.push({ title, description: describeError(err), tone: 'error' });
    });
  }
  // Any Linear record counts: an issue, or a project, milestone or initiative.
  const linked = parseLinearExternal(item.meta.external) !== null;
  const canPush =
    canEdit && !linked && isLinearConfigured(project.linearStatus);
  async function pushToLinear() {
    const failure = pushToLinearError(await project.handleSyncLinear([taskId]));
    if (failure !== null) throw failure;
  }
  function onMenu(value: string) {
    switch (value as MenuAction) {
      case 'copy-id':
        state.copyId();
        return;
      case 'copy-link':
        state.copyLink?.();
        return;
      case 'dispatch':
        run('Dispatch failed', dispatch());
        return;
      case 'push-linear':
        run('Push to Linear failed', pushToLinear());
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
            disabled: !readiness.canDispatch || dispatching,
          },
        ]
      : []),
    ...(canPush ? [{ value: 'push-linear', label: 'Push to Linear' }] : []),
    ...(canEdit
      ? [
          state.archived
            ? { value: 'unarchive', label: 'Unarchive' }
            : { value: 'archive', label: 'Archive' },
          { value: 'drop', label: 'Drop', disabled: state.dropped },
        ]
      : []),
  ];

  // A failed run's alert leads to the run itself.
  const alerts: TaskDetailAlert[] = state.alerts.map((alert) =>
    alert.id === 'run-failed' && latestRun !== undefined
      ? {
          ...alert,
          action: { label: 'Open run', onClick: () => openRun(latestRun.id) },
        }
      : alert
  );

  const properties = state.facts
    .map((fact) => propertyFor(fact, state, options))
    .filter((row): row is PropertyListItem => row !== null);

  const linkedIds = useMemo(
    () => [
      taskId,
      ...state.relations.blockedBy.map((r) => r.id),
      ...state.relations.blocks.map((r) => r.id),
    ],
    [taskId, state.relations]
  );
  const relations: TaskRelations = {
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
  const sectionMeta: TaskDetailSectionMeta | undefined = canEdit
    ? {
        blockedBy: (
          <TaskRelationPicker
            label="Add blocker"
            trigger="+ Add blocker"
            search={(query) =>
              Promise.resolve(state.searchRelations(query, linkedIds))
            }
            exclude={linkedIds}
            onSelect={(task) => state.addBlocker(task.id)}
          />
        ),
      }
    : undefined;

  const body = state.description;
  const description: TaskDescriptionData =
    body === null
      ? { text: null, loading: true }
      : canEdit
        ? {
            text: body.description,
            content: (
              <TextAreaEditor
                label="Description"
                value={body.description}
                emptyLabel="No description"
                placeholder="Add a description (markdown)…"
                view={markdownView}
                onSave={state.saveDescription}
              />
            ),
          }
        : {
            text: body.description,
            content: markdownView(body.description),
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
            onSave={(text) => state.editComment(comment.id, text)}
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
            onSave={async (text) => {
              // A reply threads under the root, one level deep.
              await state.addComment(text, comment.parentId ?? comment.id);
              setCommentBox(null);
            }}
          />
        );
      }
      return row;
    }
  );
  const comments: TaskCommentsData = {
    items: commentItems,
    loading: state.comments === null && state.commentsError === null,
    error: state.commentsError,
    composer: canEdit ? (
      <TextAreaEditor
        mode="compose"
        label="New comment"
        placeholder="Leave a comment… (markdown)"
        onSave={(text) => state.addComment(text)}
      />
    ) : undefined,
  };

  const related = state.relations.related;
  const duplicateOf = state.relations.duplicateOf;
  const sections = (
    <>
      {body !== null && (
        <TaskDetailSection
          title="Acceptance criteria"
          count={body.criteria.length}
        >
          {canEdit ? (
            <TextAreaEditor
              label="Acceptance criteria"
              value={body.acceptance}
              emptyLabel="No acceptance criteria"
              placeholder="One criterion per line…"
              view={markdownView}
              onSave={state.saveAcceptance}
            />
          ) : (
            (markdownView(body.acceptance) ?? (
              <p className="muted">No acceptance criteria</p>
            ))
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
    </>
  );

  return {
    taskKey: header.taskKey,
    title: header.title,
    titleControl: canEdit ? (
      <InlineTextField
        label="Title"
        value={item.meta.title}
        placeholder="Untitled task"
        maxLength={255}
        onSave={state.saveTitle}
      />
    ) : undefined,
    href: header.href,
    breadcrumb: header.breadcrumb,
    status: {
      kind: header.status.kind,
      label: header.status.label,
      control: canEdit ? (
        <StatePicker
          states={state.choices.states}
          value={item.meta.status}
          onChange={state.saveStatus}
          {...pickerOpen('status', options)}
        />
      ) : undefined,
    },
    alerts,
    properties,
    description,
    relations,
    sectionMeta,
    comments,
    activity: state.activity ?? undefined,
    activityLimit: ACTIVITY_LIMIT,
    sections,
    menu,
    onMenu,
    run,
  };
}
