import type { MergeQueueEntryState } from '@dispatch/client';
import { Bot, Layers, Play } from 'lucide-react';
import { memo } from 'react';

import { useRunStep } from '../../hooks/useRunStep';
import {
  type CockpitItem,
  formatAge,
  type NeedsReason,
  type RosterHeader,
} from '../../lib/cockpit';
import { formatUsd } from '../../lib/epicSession';
import { landingStepLabel } from '../../lib/landingBadge';
import { runKindLabel } from '../../lib/liveRail';
import { formatShortDate } from '../../lib/taskDates';
import type { FlightPlan } from '../flightplan/flightPlan';
import { FlightPlanMini } from '../flightplan/FlightPlanMini';
import { RunStatePill } from '../runs/RunStatePill';
import { AssigneeAvatar } from '../tasks/AssigneeAvatar';
import { LandingBadge } from '../tasks/LandingBadge';
import { PriorityIcon } from '../tasks/PriorityIcon';
import { StatusIcon } from '../tasks/StatusIcon';
import type { FeedState } from '@/lib/feedState';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { ListRow } from '@/ui/ai/list-row';
import { Pill } from '@/ui/ai/pill';
import { useElapsed } from '@/ui/ai/use-elapsed';
import { MetaText } from '@/ui/chrome';
import { StateMark } from '@/ui/chrome/state-mark';

/** A Cockpit row's DOM id, for the grid's `aria-activedescendant`. */
export function cockpitRowId(key: string): string {
  return `cockpit-row-${key.replaceAll(':', '-')}`;
}

const NEEDS_LABEL: Record<NeedsReason, string> = {
  waiting: 'Your move',
  failed: 'Failed',
  review: 'Review',
  'in-review': 'In review',
  unclear: 'Unclear spec',
};

const NEEDS_MARK: Record<NeedsReason, FeedState> = {
  waiting: 'approve',
  failed: 'failed',
  review: 'review',
  'in-review': 'review',
  unclear: 'answer',
};

// A live clock for a running row. Its own component so only it re-renders each second.
function Elapsed({ since }: { since: number }) {
  return <MetaText>{useElapsed(since)}</MetaText>;
}

// The run's latest step, standing in for the agent's name (kept in the tooltip) so the
// title keeps its room; the name until the first step arrives. Its own component so a
// chatty run re-renders only this text.
function AgentStep({ runId, agent }: { runId: string; agent: string }) {
  const step = useRunStep(runId);
  if (step === null) {
    return <MetaText className="max-w-24 truncate">{agent}</MetaText>;
  }
  return (
    <span
      data-slot="run-step"
      title={`${agent} · ${step}`}
      className="font-book text-muted-foreground max-w-40 truncate text-[12px]"
    >
      {step}
    </span>
  );
}

interface CockpitRowProps {
  item: CockpitItem;
  focused: boolean;
  /** The fan-out's plan, for a fan-out row. */
  plan: FlightPlan | undefined;
  /** Where the row's task sits in the merge queue, while it is landing. */
  landing?: MergeQueueEntryState;
  onActivate: (key: string) => void;
  /** Present on Ready rows: the hover `Dispatch` button. */
  onDispatch?: (taskId: string) => void;
}

/**
 * One 36px Cockpit row, on the list row's anatomy. What fills the slots depends on the
 * item: a ready task (priority, id, status, title, cycle or due chip, assignee, age), a
 * live run (state mark, id, title, its latest step or else the agent, cost, a ticking
 * clock), a fan-out (its container and the mini Flight Plan), a run being landed (the
 * badge, its queue step, cost, time in that step), a teammate's started task (their
 * avatar, status, age) or something waiting on you (why, and since when).
 */
export const CockpitRow = memo(function CockpitRow({
  item,
  focused,
  plan,
  landing,
  onActivate,
  onDispatch,
}: CockpitRowProps) {
  const landingBadge =
    landing === undefined ? null : <LandingBadge state={landing} />;
  const common = {
    domId: cockpitRowId(item.key),
    'data-row-key': item.key,
    'data-kind': item.kind,
    focused,
    tabIndex: -1,
    onClick: () => onActivate(item.key),
  };

  switch (item.kind) {
    case 'ready': {
      const meta = item.task.meta;
      // One chip: the due date when there is one, else the cycle.
      const chip =
        meta.dueDate !== null ? (
          <Pill title="Due">{formatShortDate(meta.dueDate)}</Pill>
        ) : meta.cycle !== null ? (
          <Pill title={meta.cycle.name ?? `Cycle ${meta.cycle.number}`}>
            Cycle {meta.cycle.number}
          </Pill>
        ) : null;
      return (
        <ListRow
          {...common}
          leading={<PriorityIcon priority={meta.priority} />}
          id={meta.id}
          title={meta.title}
          trailing={
            <>
              {chip}
              {onDispatch !== undefined && (
                <span className="hidden group-hover/row:inline-flex group-data-[focused]/row:inline-flex">
                  <IconButton
                    label={`Dispatch ${meta.title}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onDispatch(meta.id);
                    }}
                  >
                    <Play aria-hidden />
                  </IconButton>
                </span>
              )}
              <AssigneeAvatar assignee={meta.assignee} size={16} />
            </>
          }
          date={formatAge(meta.created)}
        />
      );
    }
    case 'starting':
      return (
        <ListRow
          {...common}
          leading={<StateMark state="working" />}
          id={item.task.meta.id}
          title={item.task.meta.title}
          trailing={<MetaText>Starting…</MetaText>}
          date={<Elapsed since={item.startedAt} />}
        />
      );
    case 'run': {
      const { run } = item;
      const kind = runKindLabel(run);
      return (
        <ListRow
          {...common}
          indent={item.nested ? 1 : 0}
          leading={<RunStatePill meta={run} compact />}
          id={run.taskId}
          title={item.task?.meta.title ?? run.taskTitle}
          trailing={
            <>
              {landingBadge}
              <AgentStep
                runId={run.id}
                agent={kind === 'agent' ? run.executor : `${kind} run`}
              />
              {run.subagents !== undefined && run.subagents.total > 0 && (
                <MetaText className="flex items-center gap-0.5">
                  <Bot aria-hidden className="size-3" />
                  <span
                    aria-label={`${run.subagents.running} of ${run.subagents.total} sub-agents running`}
                  >
                    {run.subagents.running}/{run.subagents.total}
                  </span>
                </MetaText>
              )}
              {run.costUsd !== undefined && (
                <MetaText>{formatUsd(run.costUsd)}</MetaText>
              )}
            </>
          }
          date={<Elapsed since={Date.parse(run.createdAt)} />}
        />
      );
    }
    case 'fanout':
      // Two lines: the container, then its mini Flight Plan across the row's full width.
      return (
        <div
          id={common.domId}
          role="row"
          data-slot="list-row"
          data-row-key={item.key}
          data-kind="fanout"
          data-focused={focused || undefined}
          tabIndex={-1}
          onClick={common.onClick}
          onKeyDown={(e) => {
            if (
              e.target === e.currentTarget &&
              (e.key === 'Enter' || e.key === ' ')
            ) {
              e.preventDefault();
              common.onClick();
            }
          }}
          className={cn(
            'group/row rounded-control hover:bg-surface-hover flex h-[52px] cursor-pointer flex-col justify-center gap-1 px-3 text-[13px] transition-colors duration-100',
            focused && 'bg-surface-hover'
          )}
        >
          <span role="gridcell" className="flex min-w-0 items-center gap-2">
            <Layers
              aria-hidden
              className="text-muted-foreground size-3.5 shrink-0"
            />
            <span className="text-foreground min-w-0 flex-1 truncate font-medium">
              {item.container?.meta.title ?? item.progress.epicId}
            </span>
            <span className="font-book text-muted-foreground shrink-0 tracking-(--id-tracking)">
              {item.progress.epicId}
            </span>
          </span>
          {plan !== undefined && (
            <span role="gridcell" className="pl-[22px]">
              <FlightPlanMini plan={plan} />
            </span>
          )}
        </div>
      );
    case 'started': {
      const meta = item.task.meta;
      return (
        <ListRow
          {...common}
          leading={<AssigneeAvatar assignee={meta.assignee} size={16} />}
          id={meta.id}
          status={<StatusIcon status={meta.status} />}
          title={meta.title}
          trailing={landingBadge ?? undefined}
          date={formatAge(meta.updated)}
        />
      );
    }
    case 'landing':
      return (
        <ListRow
          {...common}
          leading={<StateMark state="landing" />}
          id={item.taskId}
          title={item.task?.meta.title ?? item.run?.taskTitle ?? item.taskId}
          trailing={
            <>
              {landingBadge}
              {landing !== undefined && (
                <MetaText>{landingStepLabel(landing)}</MetaText>
              )}
              {item.run?.costUsd !== undefined && (
                <MetaText>{formatUsd(item.run.costUsd)}</MetaText>
              )}
            </>
          }
          date={formatAge(item.since)}
        />
      );
    case 'needs':
      return (
        <ListRow
          {...common}
          leading={<StateMark state={NEEDS_MARK[item.reason]} />}
          id={item.taskId}
          title={item.task?.meta.title ?? item.run?.taskTitle ?? item.taskId}
          trailing={
            <>
              <Pill
                className={cn(
                  item.reason === 'failed' && 'text-state-failed',
                  item.reason === 'waiting' && 'text-state-waiting'
                )}
              >
                {NEEDS_LABEL[item.reason]}
              </Pill>
              {landingBadge}
              {item.owner !== null && (
                <AssigneeAvatar assignee={item.owner} size={16} />
              )}
            </>
          }
          date={item.since === '' ? undefined : formatAge(item.since)}
        />
      );
  }
});

/** A roster group's 28px header: the person's avatar, name and row count. */
export function RosterHeaderRow({ header }: { header: RosterHeader }) {
  return (
    <div
      role="row"
      data-slot="roster-header"
      className="text-muted-foreground flex h-7 items-end gap-2 px-3 pb-1 text-[12px] font-medium"
    >
      {header.owner === null ? (
        <AssigneeAvatar assignee="agent" size={16} />
      ) : (
        <AssigneeAvatar assignee={header.owner} name={header.name} size={16} />
      )}
      <span role="gridcell" className="truncate text-(--text-secondary)">
        {header.name}
      </span>
      <span className="font-book tabular-nums">{header.count}</span>
    </div>
  );
}
