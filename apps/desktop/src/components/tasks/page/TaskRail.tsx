import type { TaskListItem } from '@dispatch-foo/core/browser';
import {
  isContainerKind,
  isDoneStatus,
  parseLinearExternal,
} from '@dispatch-foo/core/browser';
import { ArrowUpRight, CalendarArrowUp, Link2, Move, X } from 'lucide-react';
import { useMemo, useState } from 'react';

import type { TaskCommentsApi } from '../../../hooks/useTaskComments';
import { colorForLabel } from '../../../lib/labelColor';
import {
  isLinearConfigured,
  pushToLinearError,
  resolveLinearLink,
} from '../../../lib/linearSettings';
import { isTerminalRunState } from '../../../lib/runState';
import { formatShortDate } from '../../../lib/taskDates';
import { assigneeLabel, kindLabel } from '../../../lib/taskDisplay';
import { ancestorsOf, parentCandidates } from '../../../lib/taskHierarchy';
import { taskIndexOf } from '../../../lib/taskIndex';
import { taskTimeline } from '../../../lib/taskTimeline';
import { buildFlightPlan } from '../../flightplan/flightPlan';
import { FlightPlanMini } from '../../flightplan/FlightPlanMini';
import { usePeople } from '../../people/PeopleContext';
import { MergeLadderPill } from '../../runs/MergeLadderDot';
import { RunStatePill } from '../../runs/RunStatePill';
import { AssigneeAvatar } from '../AssigneeAvatar';
import { PickerPopover } from '../detail/PickerPopover';
import { railRowClass, RailSection } from '../detail/RailSection';
import { SelfReviewRow } from '../detail/SelfReviewRow';
import {
  AssigneeControl,
  CycleControl,
  DueDateControl,
  EstimateControl,
  LabelsControl,
  PriorityControl,
  StatusControl,
} from '../PropertyControls';
import { getStackByTaskId, StackRail } from '../StackRail';
import { StatusIcon } from '../StatusIcon';
import { ActivityTimeline } from './ActivityTimeline';
import { CommentsSection } from './CommentsSection';
import { ContainerIcon, kindIcon } from './ContainerIcon';
import type { TaskPageModel } from './pageModel';
import { RelationsEditor } from './RelationsEditor';
import { cn } from '@/lib/utils';
import { LabelPill, Pill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@/ui/popover';

/** Which rail picker the page's single-key shortcuts have opened. */
export type RailPicker =
  | 'status'
  | 'priority'
  | 'assignee'
  | 'labels'
  | 'parent';

const NO_PARENT = '__none__';
const SUB_ISSUES_SHOWN = 6;

/** A row in the hierarchy: the container's icon (in its colour when it has one), its
 * title, and its kind on hover. */
function HierarchyRow({
  task,
  onOpen,
}: {
  task: TaskListItem;
  onOpen: (taskId: string) => void;
}) {
  return (
    <button
      type="button"
      title={`${kindLabel(task.meta.kind)} · ${task.meta.id}`}
      onClick={() => onOpen(task.meta.id)}
      className={railRowClass()}
    >
      <ContainerIcon
        kind={task.meta.kind}
        icon={task.meta.icon}
        color={task.meta.color}
      />
      <span className="truncate">{task.meta.title}</span>
    </button>
  );
}

/** A container's own face: its icon in its colour, its kind, and a swatch of the colour. */
function ContainerRow({ meta }: { meta: TaskListItem['meta'] }) {
  const detail = [
    meta.icon === null ? null : `Icon ${meta.icon}`,
    meta.color === null ? null : `Color ${meta.color}`,
  ].filter((part) => part !== null);
  return (
    <div
      data-slot="container-row"
      title={detail.length === 0 ? undefined : detail.join(' · ')}
      className={railRowClass({ readOnly: true })}
    >
      <ContainerIcon kind={meta.kind} icon={meta.icon} color={meta.color} />
      <span className="truncate">{kindLabel(meta.kind)}</span>
      {meta.color !== null && (
        <span
          aria-hidden
          data-slot="container-color"
          className="ml-auto size-2.5 shrink-0 rounded-full"
          style={{ backgroundColor: meta.color }}
        />
      )}
    </div>
  );
}

// A `YYYY-MM-DD` day in local time, so the rail never shows the day before in the west.
function calendarDay(day: string): Date {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number);
  return new Date(y ?? 0, (m ?? 1) - 1, d ?? 1);
}

/** The start date: `Starts Sep 30` (or `Started` once it is past), opening a date field
 * and Clear. */
function StartDateRow({
  value,
  onChange,
}: {
  value: string | null;
  onChange: (startDate: string | null) => void;
}) {
  const [open, setOpen] = useState(false);
  function pick(next: string | null) {
    onChange(next);
    setOpen(false);
  }
  const started = value !== null && calendarDay(value).getTime() <= Date.now();
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger
        aria-label="Change start date"
        data-slot="start-date-control"
        data-unset={value === null || undefined}
        className={railRowClass({ unset: value === null })}
      >
        <CalendarArrowUp />
        <span className="truncate">
          {value === null
            ? 'Set start date'
            : `${started ? 'Started' : 'Starts'} ${formatShortDate(calendarDay(value))}`}
        </span>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className="flex w-56 flex-col gap-0.5 p-1"
        onKeyDown={(e) => e.stopPropagation()}
      >
        <input
          type="date"
          aria-label="Start date"
          className="bg-field rounded-control shadow-inset-field mx-1 my-1 h-8 px-2 text-[13px] text-(--text-secondary) outline-none"
          value={value ?? ''}
          onChange={(e) => {
            if (e.target.value !== '') pick(e.target.value);
          }}
        />
        {value !== null && (
          <button
            type="button"
            className={railRowClass({ unset: true })}
            onClick={() => pick(null)}
          >
            Clear start date
          </button>
        )}
      </PopoverContent>
    </Popover>
  );
}

/** Who created the task, and when — read-only. */
function CreatorRow({
  creator,
  created,
}: {
  creator: string;
  created: string;
}) {
  const name = usePeople().personFor(creator)?.name ?? assigneeLabel(creator);
  return (
    <div data-slot="creator-row" className={railRowClass({ readOnly: true })}>
      <AssigneeAvatar assignee={creator} size={16} />
      <span className="truncate">Created by {name}</span>
      <span className="font-book text-muted-foreground ml-auto shrink-0 text-[12px]">
        {formatShortDate(created)}
      </span>
    </div>
  );
}

export interface TaskRailProps {
  page: TaskPageModel;
  comments: TaskCommentsApi;
  picker: RailPicker | null;
  onPickerChange: (picker: RailPicker | null) => void;
  /** Spec mode shows relations in its own column, so the rail leaves them out. */
  showRelations: boolean;
  /** Summary mode shows the whole timeline, so the rail leaves its excerpt out. */
  showActivity: boolean;
  /** Plan mode draws every sub-issue and a container's spec lists them, so there the
   * rail leaves its excerpt out. */
  showSubIssues: boolean;
  className?: string;
}

/**
 * The task page's right rail, Linear's issue sidebar in Dispatch's grammar: a container's
 * icon and colour, every property on a 32px row you click to change (status, priority,
 * assignee, estimate, start date, due date, cycle, labels, self review), who created it,
 * where the task sits (initiative › project › milestone ›
 * parent, and Move to…), its Linear and PR links, relations, sub-issues with a mini
 * Flight Plan, the comment thread, and recent activity.
 */
export function TaskRail({
  page,
  comments,
  picker,
  onPickerChange,
  showRelations,
  showActivity,
  showSubIssues,
  className,
}: TaskRailProps) {
  const { item, project } = page;
  const meta = item.meta;
  const tasks = project.tasksIncludingArchived;
  const pickerProps = (kind: RailPicker) => ({
    open: picker === kind,
    onOpenChange: (open: boolean) => onPickerChange(open ? kind : null),
  });
  const ancestors = useMemo(
    () => ancestorsOf(item, page.tasksById),
    [item, page.tasksById]
  );
  const { labels: labelVocabulary, cycles, parentIds } = taskIndexOf(tasks);
  const timeline = useMemo(() => taskTimeline(page.activity), [page.activity]);
  const hasStack = getStackByTaskId(tasks).has(meta.id);

  const linearLink = resolveLinearLink(meta.external, project.linearLinks);
  // Any Linear record counts: an issue, or a project, milestone or initiative.
  const linearRef = parseLinearExternal(meta.external);
  const linearLinked = linearRef !== null;
  const canPush = isLinearConfigured(project.linearStatus);
  const [pushing, setPushing] = useState(false);
  const [pushed, setPushed] = useState(false);
  async function pushToLinear() {
    setPushing(true);
    try {
      const failure = pushToLinearError(
        await project.handleSyncLinear([meta.id])
      );
      if (failure !== null) page.fail('Push to Linear failed', failure);
      else setPushed(true);
    } finally {
      setPushing(false);
    }
  }
  const latestRun = page.runs[0];

  const plan = useMemo(() => {
    if (page.children.length === 0) return null;
    const liveTaskIds = new Set(
      project.runs
        .filter((r) => !isTerminalRunState(r.state))
        .map((r) => r.taskId)
    );
    return buildFlightPlan(page.children, {
      liveTaskIds,
      model: page.statusModel,
      concurrency:
        project.epicProgressById.get(meta.id)?.session?.concurrency ?? null,
    });
  }, [
    page.children,
    page.statusModel,
    project.runs,
    project.epicProgressById,
    meta.id,
  ]);

  return (
    <aside
      data-slot="task-rail"
      aria-label="Task details"
      className={cn(
        'flex shrink-0 flex-col gap-5 overflow-y-auto px-3 py-4',
        className
      )}
    >
      <RailSection title="Properties">
        {isContainerKind(meta.kind) && <ContainerRow meta={meta} />}
        <StatusControl
          value={meta.status}
          statuses={project.config?.statuses ?? [meta.status]}
          onChange={page.changeStatus}
          variant="row"
          {...pickerProps('status')}
        />
        <PriorityControl
          value={meta.priority}
          onChange={(priority) => void page.patch({ priority })}
          variant="row"
          {...pickerProps('priority')}
        />
        <AssigneeControl
          value={meta.assignee}
          onChange={(assignee) => void page.patch({ assignee })}
          variant="row"
          {...pickerProps('assignee')}
        />
        <EstimateControl
          value={meta.estimate}
          onChange={(estimate) => void page.patch({ estimate })}
        />
        {(isContainerKind(meta.kind) || meta.startDate !== null) && (
          <StartDateRow
            value={meta.startDate}
            onChange={(startDate) => void page.patch({ startDate })}
          />
        )}
        <DueDateControl
          value={meta.dueDate}
          done={isDoneStatus(meta.status, page.statusModel)}
          onChange={(dueDate) => void page.patch({ dueDate })}
        />
        <CycleControl
          value={meta.cycle}
          cycles={cycles}
          onChange={(cycle) => void page.patch({ cycle })}
        />
        <div data-slot="label-editor" className="flex flex-col gap-1">
          {meta.labels.length > 0 && (
            <div className="flex flex-wrap gap-1 px-2 py-1">
              {meta.labels.map((label) => (
                <LabelPill key={label} color={colorForLabel(label)}>
                  <span className="inline-flex items-center gap-1 align-middle">
                    {label}
                    <button
                      type="button"
                      aria-label={`Remove label ${label}`}
                      className="text-muted-foreground hover:text-foreground rounded-pill focus-visible:ring-ring -mr-1 flex size-4 items-center justify-center outline-none focus-visible:ring-2"
                      onClick={() =>
                        void page.patch({
                          labels: meta.labels.filter((l) => l !== label),
                        })
                      }
                    >
                      <X className="size-3" />
                    </button>
                  </span>
                </LabelPill>
              ))}
            </div>
          )}
          <LabelsControl
            variant="row"
            value={meta.labels}
            candidates={labelVocabulary}
            onChange={(labels) => void page.patch({ labels })}
            {...pickerProps('labels')}
          />
        </div>
        <SelfReviewRow
          value={meta.selfReview}
          onChange={(selfReview) => void page.patch({ selfReview })}
        />
        {meta.creator !== null && (
          <CreatorRow creator={meta.creator} created={meta.created} />
        )}
      </RailSection>

      <RailSection title="Hierarchy">
        {ancestors.map((a) => (
          <HierarchyRow key={a.meta.id} task={a} onOpen={page.openTask} />
        ))}
        {meta.initiatives.map((id) => {
          const initiative = page.tasksById.get(id);
          return initiative === undefined ||
            ancestors.includes(initiative) ? null : (
            <HierarchyRow key={id} task={initiative} onOpen={page.openTask} />
          );
        })}
        <PickerPopover
          triggerLabel="Move to"
          triggerClassName={railRowClass({ unset: true })}
          placeholder="Project, milestone or issue…"
          items={() => [
            ...(meta.parent === null
              ? []
              : [
                  {
                    value: NO_PARENT,
                    label: 'No parent',
                    glyph: <X className="size-3.5" />,
                  },
                ]),
            ...parentCandidates(item, tasks, parentIds).map((t) => {
              const Icon = kindIcon(t.meta.kind);
              return {
                value: t.meta.id,
                label: t.meta.title,
                hint: kindLabel(t.meta.kind),
                glyph: <Icon className="size-3.5" />,
                selected: t.meta.id === meta.parent,
              };
            }),
          ]}
          limit={60}
          onSelect={(value) =>
            void page.patch({ parent: value === NO_PARENT ? null : value })
          }
          {...pickerProps('parent')}
        >
          <Move />
          <span className="truncate">
            {ancestors.length === 0 ? 'Add to a project…' : 'Move to…'}
          </span>
        </PickerPopover>
      </RailSection>

      {(linearLinked || canPush || latestRun?.prUrl !== undefined) && (
        <RailSection title="Links">
          <div className="flex flex-wrap items-center gap-1 px-2 py-1">
            {linearLinked &&
              (linearLink !== null ? (
                <a href={linearLink.url} target="_blank" rel="noreferrer">
                  <Pill className="hover:bg-surface-active">
                    <Link2 className="text-muted-foreground" />
                    {linearLink.identifier}
                  </Pill>
                </a>
              ) : (
                <Pill
                  title={`Linked to a Linear ${linearRef?.entity ?? 'issue'}`}
                >
                  <Link2 className="text-muted-foreground" />
                  Linear
                </Pill>
              ))}
            {!linearLinked &&
              canPush &&
              (pushed ? (
                <Pill>
                  <Link2 className="text-status-green" />
                  Pushed
                </Pill>
              ) : (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={pushing}
                  className="-ml-2.5"
                  onClick={() => void pushToLinear()}
                >
                  <Link2 />
                  {pushing ? 'Pushing…' : 'Push to Linear'}
                </Button>
              ))}
            {latestRun?.prUrl !== undefined && (
              <a href={latestRun.prUrl} target="_blank" rel="noreferrer">
                <Pill className="hover:bg-surface-active">
                  Pull request
                  <ArrowUpRight className="text-muted-foreground" />
                </Pill>
              </a>
            )}
            <MergeLadderPill meta={latestRun} />
          </div>
        </RailSection>
      )}

      {showRelations && (
        <RailSection title="Relations">
          <RelationsEditor
            item={item}
            tasks={tasks}
            tasksById={page.tasksById}
            model={page.statusModel}
            onPatch={(patch) => void page.patch(patch)}
            onOpenTask={page.openTask}
          />
        </RailSection>
      )}

      {plan !== null && showSubIssues && (
        <RailSection title="Sub-issues">
          <div className="flex flex-col gap-1">
            <button
              type="button"
              onClick={() => page.selectMode('plan')}
              className={railRowClass()}
              title="Open the plan"
            >
              <FlightPlanMini plan={plan} />
            </button>
            <ul className="flex flex-col">
              {page.children.slice(0, SUB_ISSUES_SHOWN).map((child) => {
                const run = project.latestRunByTaskId.get(child.meta.id);
                return (
                  <li key={child.meta.id}>
                    <button
                      type="button"
                      onClick={() => page.openTask(child.meta.id)}
                      className={railRowClass()}
                    >
                      <StatusIcon status={child.meta.status} />
                      <span className="truncate">{child.meta.title}</span>
                      {run !== undefined && !isTerminalRunState(run.state) && (
                        <RunStatePill meta={run} compact className="ml-auto" />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
            {page.children.length > SUB_ISSUES_SHOWN && (
              <button
                type="button"
                onClick={() => page.selectMode('plan')}
                className="text-muted-foreground rounded-control focus-visible:ring-ring h-6 self-start px-2 text-[12px] font-medium outline-none hover:text-(--text-secondary) focus-visible:ring-2"
              >
                All {page.children.length} sub-issues
              </button>
            )}
          </div>
        </RailSection>
      )}

      {hasStack && (
        <RailSection title="Stack">
          <StackRail
            tasks={tasks}
            taskId={meta.id}
            latestRunByTaskId={project.latestRunByTaskId}
            onOpenTask={page.openTask}
          />
        </RailSection>
      )}

      <RailSection title="Comments">
        <div className="px-2">
          <CommentsSection api={comments} me={project.me} onError={page.fail} />
        </div>
      </RailSection>

      {showActivity && (
        <RailSection title="Activity">
          {page.bodyLoaded ? (
            <ActivityTimeline items={timeline} initial={5} />
          ) : (
            <p className="text-muted-foreground font-book px-2 text-[12px]">
              Loading…
            </p>
          )}
        </RailSection>
      )}
    </aside>
  );
}
