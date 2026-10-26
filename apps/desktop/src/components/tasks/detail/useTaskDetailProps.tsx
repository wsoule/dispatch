import { canonicalKind, parseLinearExternal } from '@dispatch-foo/core/browser';
import type { MilestoneAssessment } from '@dispatch/planning';
import {
  AssigneePicker,
  Button,
  Checklist,
  DateField,
  EstimatePicker,
  InlineTextField,
  LabelPicker,
  MilestonePicker,
  type PersonChoice,
  type PickerOption,
  PickerPopover,
  PriorityPicker,
  ProgressRule,
  ProjectPicker,
  type PropertyListItem,
  Register,
  RegisterCell,
  RegisterRow,
  StatePicker,
  StatusMark,
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
  type UiTone,
} from '@dispatch/ui';
import { Bot, Ellipsis } from 'lucide-react';
import { type ReactNode, useMemo, useState } from 'react';

import { AGENTS_GROUP } from '../../../adapters/people';
import { dueLabel } from '../../../adapters/planningFormat';
import {
  assessmentMark,
  type StatusMarkModel,
} from '../../../adapters/planningStatus';
import { planningProjectMark } from '../../../adapters/shell';
import type {
  DetailComment,
  DetailFact,
  RelationModel,
} from '../../../adapters/taskDetail';
import {
  buildMilestoneSection,
  type MilestoneSection,
} from '../../../adapters/timeline';
import {
  milestoneDetailOf,
  type Planning,
  usePlanningContext,
} from '../../../hooks/usePlanning';
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
  /** The planning's reading of a container (the Milestone section of a
   * milestone, the Milestones section of a project), for TaskDetail's rail:
   * right after the properties in the drawer, above the description, where
   * a quick look reads it first. Null for an issue or outside a planning. */
  planning: ReactNode | null;
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

/** A quiet note under a planning fact: the warning tone when it asks for
 * action (a risk reason, a missing input), else the quiet grey. */
function PlanningNote({
  tone = 'default',
  children,
}: {
  tone?: UiTone;
  children: ReactNode;
}) {
  const toned = tone !== 'default' && tone !== 'muted';
  return (
    <p
      className={toned ? styles.planningToneNote : styles.planningNote}
      data-tone={toned ? tone : undefined}
    >
      {children}
    </p>
  );
}

/** One row of a planning register: a status mark, the row's name and a
 * quiet fact beside it; the whole row quick-looks the task. */
function PlanningRow({
  mark,
  name,
  fact,
  onOpen,
}: {
  mark: StatusMarkModel;
  name: string;
  fact: string;
  onOpen: () => void;
}) {
  return (
    <RegisterRow onActivate={onOpen} rowLabel={`${name}, ${mark.label}`}>
      <RegisterCell variant="name">
        <span className={styles.planningName}>
          <StatusMark status={mark.status} label={mark.label} />
          <span>{name}</span>
        </span>
      </RegisterCell>
      <RegisterCell variant="mono" align="end">
        {fact}
      </RegisterCell>
    </RegisterRow>
  );
}

/**
 * The Milestone section of a milestone container (the planner's drawer
 * order: status with its reasons, progress, the project's next milestone,
 * the rubric), then what it waits on and its open issues as their own
 * sections. The drawer's property sheet already shows the due date and the
 * project's lead as facts, so neither is repeated here.
 */
function MilestoneSections({
  section,
  peek,
}: {
  section: MilestoneSection;
  peek: (taskId: string) => void;
}) {
  const { status, progress, next, muted } = section;
  return (
    <>
      <TaskDetailSection title="Milestone">
        <div className={styles.planning}>
          <StatusMark
            status={status.status}
            label={status.label}
            showLabel
            muted={muted}
          />
          {status.lines.length > 0 && (
            <PlanningNote tone={muted ? 'default' : 'warning'}>
              {status.lines.join(' · ')}
            </PlanningNote>
          )}
          <ProgressRule
            done={progress.done}
            total={progress.total}
            tone={progress.tone}
            aria-label="Milestone progress"
          />
          {section.isNext ? (
            <PlanningNote>The project's next milestone.</PlanningNote>
          ) : next !== null ? (
            <p className={styles.planningNext}>
              <span className={styles.planningNote}>Next</span>
              <Button variant="quiet" size="sm" onClick={() => peek(next.id)}>
                {next.name}
              </Button>
            </p>
          ) : null}
          <Checklist label="Rubric" items={section.rubric} />
        </div>
      </TaskDetailSection>
      {section.waitsOn.length > 0 && (
        <TaskDetailSection title="Waits on" count={section.waitsOn.length}>
          <Register columns="minmax(0, 1fr) auto" label="Waits on">
            {section.waitsOn.map((other) => (
              <PlanningRow
                key={other.id}
                mark={other}
                name={other.name}
                fact={other.project}
                onOpen={() => peek(other.id)}
              />
            ))}
          </Register>
        </TaskDetailSection>
      )}
      {section.openIssues.length > 0 && (
        <TaskDetailSection
          title="Open issues"
          count={section.openIssues.length}
        >
          <Register columns="minmax(0, 1fr) auto" label="Open issues">
            {section.openIssues.map((issue) => (
              <PlanningRow
                key={issue.id}
                mark={issue}
                name={issue.title}
                fact={issue.label}
                onOpen={() => peek(issue.id)}
              />
            ))}
          </Register>
        </TaskDetailSection>
      )}
    </>
  );
}

/** What the Project section draws: the next milestone's mark, progress
 * across every milestone, and the milestones themselves. */
interface ProjectPlanning {
  mark: StatusMarkModel;
  next: { id: string; name: string } | null;
  done: number;
  total: number;
  rows: { id: string; name: string; mark: StatusMarkModel; due: string }[];
}

/** The project's milestones as the planning reads them; null for a project
 * with none (the Work section's sub-issues already say what is under it). */
function projectPlanning(
  planning: Planning,
  projectId: string
): ProjectPlanning | null {
  const mark = planningProjectMark(
    planning.snapshot,
    planning.assessments,
    projectId
  );
  if (mark === null) return null;
  const { today } = planning.ctx;
  let done = 0;
  let total = 0;
  let next: ProjectPlanning['next'] = null;
  const rows: ProjectPlanning['rows'] = [];
  for (const milestone of planning.snapshot.milestonesByProject.get(
    projectId
  ) ?? []) {
    const assessment: MilestoneAssessment | undefined =
      planning.assessments.get(milestone.id);
    if (assessment === undefined) continue;
    done += assessment.progress.completed;
    total += assessment.progress.scope;
    if (assessment.isNext) next = { id: milestone.id, name: milestone.name };
    rows.push({
      id: milestone.id,
      name: milestone.name,
      mark: assessmentMark(assessment),
      due: dueLabel(
        milestone.targetDate,
        assessment.daysLeft,
        today,
        assessment.status
      ),
    });
  }
  return { mark, next, done, total, rows };
}

/** The reduced Project section: where the project stands by its next
 * milestone, progress across its milestones, and each milestone as a row. */
function ProjectSection({
  project,
  peek,
}: {
  project: ProjectPlanning;
  peek: (taskId: string) => void;
}) {
  return (
    <TaskDetailSection title="Milestones" count={project.rows.length}>
      <div className={styles.planning}>
        <StatusMark
          status={project.mark.status}
          label={project.mark.label}
          showLabel
        />
        <ProgressRule
          done={project.done}
          total={project.total}
          aria-label="Progress across milestones"
        />
        {project.next !== null && (
          <PlanningNote>Next: {project.next.name}</PlanningNote>
        )}
        <Register columns="minmax(0, 1fr) auto" label="Milestones">
          {project.rows.map((row) => (
            <PlanningRow
              key={row.id}
              mark={row.mark}
              name={row.name}
              fact={row.due}
              onOpen={() => peek(row.id)}
            />
          ))}
        </Register>
      </div>
    </TaskDetailSection>
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
  const planning = usePlanningContext();
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

  // The planning's reading of a container: the Milestone section for a
  // milestone, the Milestones section for a project; nothing for an issue or
  // outside App (no planning). Handed back as `planning` for the rail slot
  // rather than put among `sections`, which TaskDetail draws after Comments
  // and Activity.
  const kind = canonicalKind(item.meta.kind);
  const milestoneSection = useMemo(() => {
    if (planning === null || kind !== 'milestone') return null;
    const detail = milestoneDetailOf(planning, taskId);
    if (detail === null) return null;
    return buildMilestoneSection(
      detail,
      detail.assessment,
      planning.ctx.today,
      { view: planning.timeline, assessments: planning.assessments }
    );
  }, [planning, kind, taskId]);
  const projectSection = useMemo(
    () =>
      planning === null || kind !== 'project'
        ? null
        : projectPlanning(planning, taskId),
    [planning, kind, taskId]
  );

  const related = state.relations.related;
  const duplicateOf = state.relations.duplicateOf;
  const planningSections =
    milestoneSection !== null ? (
      <MilestoneSections section={milestoneSection} peek={peek} />
    ) : projectSection !== null ? (
      <ProjectSection project={projectSection} peek={peek} />
    ) : null;
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
    planning: planningSections,
    menu,
    onMenu,
    run,
  };
}
