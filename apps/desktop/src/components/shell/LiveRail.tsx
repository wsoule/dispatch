import type { TaskListItem } from '@dispatch-foo/core/browser';
import type { EpicProgress, RunMeta } from '@dispatch/client';
import { Bot } from 'lucide-react';
import { useMemo } from 'react';

import type { OverseerSession } from '../../hooks/useOverseerSession';
import type { TaskTab } from '../../lib/appNav';
import { spendPillLabel } from '../../lib/epicSession';
import { deriveFeedState } from '../../lib/feedState';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { buildLiveRail, type LiveRailRow } from '../../lib/liveRail';
import { cn } from '@/lib/utils';
import {
  SIDEBAR_ROW_CLASS,
  SIDEBAR_ROW_INACTIVE_CLASS,
} from '@/ui/ai/sidebar-nav';
import { StateMark } from '@/ui/chrome/state-mark';
import { MetaText } from '@/ui/chrome/text';

interface LiveRailProps {
  runs: RunMeta[];
  /** The App-mounted overseer session — a turn in flight earns a row here like any run. */
  overseer: OverseerSession;
  /** Opens the full task view on a run's chat tab — `openTaskView` in App.tsx. */
  onOpenTask: (taskId: string, tab: TaskTab, runId?: string) => void;
  /** Opens the Overseer page — where the overseer's own row leads. */
  onOpenOverseer: () => void;
  /** Milestones with a fan-out session (`data.liveEpicSessions`) — live runs on their
   * children group under a section row per milestone. Absent, every row is flat. */
  sessions?: EpicProgress[];
  /** The epic docs (`data.epics`) a section row takes its title from; a milestone with no
   * doc here is named by its id. */
  epics?: TaskListItem[];
  /** Opens the milestone view on that epic — where a section row leads. */
  onOpenMilestone?: (epicId: string) => void;
}

/**
 * The `Live agents ▾` section's body: one 28px rail row per agent at work — a 14px
 * `StateMark`, the task title, the sub-agent count when a run fanned out, and how long
 * ago it started. Runs on a milestone with a fan-out session sit under a 28px section
 * row naming the milestone with its live count and spend against the ceiling; the rest
 * follow flat. The overseer mid-turn (or parked on an approval) is an agent at work too
 * and sits first; its queued approvals are counted on the Overseer row, not here, and
 * everything waiting on a human is the Inbox row's count. `lib/liveRail.ts` owns the
 * model.
 */
export function LiveRail({
  runs,
  overseer,
  onOpenTask,
  onOpenOverseer,
  sessions,
  epics,
  onOpenMilestone,
}: LiveRailProps) {
  const live = useMemo(() => buildLiveRail(runs, sessions), [runs, sessions]);
  const epicTitleById = useMemo(() => {
    const map = new Map<string, string>();
    for (const epic of epics ?? []) map.set(epic.meta.id, epic.meta.title);
    return map;
  }, [epics]);

  // `recordError` only decides the no-record case: fetch never succeeded (stale id 404s,
  // retry: false) means a broken conversation, not a turn in flight. With a record cached,
  // react-query keeps it through *background* refetch errors, and a running record plus one
  // transient failure is still the overseer at work — dropping the row would flicker.
  const overseerTurnLive =
    overseer.conversationId !== null &&
    (overseer.record === undefined
      ? overseer.recordError === null
      : overseer.record.state === 'running');
  // A settled turn with a pending action is idle, not running — but the row must not go
  // quiet while an approval is stranded behind it.
  const firstParked = overseer.record?.pendingApprovals[0];
  const firstPendingAction =
    firstParked !== undefined
      ? { summary: firstParked.summary, createdAt: firstParked.requestedAt }
      : overseer.record?.pendingActions[0];
  const overseerRow = overseerTurnLive || firstPendingAction !== undefined;

  if (live.groups.length === 0 && live.rows.length === 0 && !overseerRow) {
    return (
      <p
        data-testid="live-rail"
        className="text-muted-foreground flex h-7 items-center px-2 text-[12px]"
      >
        No agents running.
      </p>
    );
  }

  return (
    <div
      data-testid="live-rail"
      className="flex max-h-56 flex-col gap-px overflow-y-auto"
    >
      {overseerRow && (
        <button
          type="button"
          onClick={onOpenOverseer}
          className={cn(SIDEBAR_ROW_CLASS, SIDEBAR_ROW_INACTIVE_CLASS)}
        >
          <StateMark state={firstPendingAction ? 'approve' : 'working'} />
          <span className="min-w-0 flex-1 truncate">
            {firstPendingAction?.summary ??
              overseer.record?.prompt ??
              'Assistant'}
          </span>
          {overseer.record !== undefined && (
            <Elapsed
              iso={firstPendingAction?.createdAt ?? overseer.record.createdAt}
            />
          )}
        </button>
      )}
      {live.groups.map(({ progress, rows }) => {
        const title = epicTitleById.get(progress.epicId) ?? progress.epicId;
        // Live count then spend against the ceiling, the milestone header's pill in one
        // line — `$41.20 / $60`, or the settled figure alone with no ceiling.
        const meta = `${rows.length} running · ${spendPillLabel(progress.spend)}`;
        return (
          <div
            key={progress.epicId}
            data-slot="live-rail-group"
            className="flex flex-col gap-px"
          >
            <button
              type="button"
              onClick={() => onOpenMilestone?.(progress.epicId)}
              aria-label={`${title} milestone · ${meta}`}
              className={cn(SIDEBAR_ROW_CLASS, SIDEBAR_ROW_INACTIVE_CLASS)}
            >
              {/* A budget-paused session still drains its last runs; the mark says held,
                  not working, so the rail agrees with the milestone header. */}
              <StateMark
                state={
                  progress.session?.state === 'paused' ? 'blocked' : 'working'
                }
              />
              <span className="min-w-0 flex-1 truncate">{title}</span>
              <MetaText className="shrink-0 text-[11px]">{meta}</MetaText>
            </button>
            {rows.map((row) => (
              <RunRow
                key={row.run.id}
                row={row}
                nested
                onOpenTask={onOpenTask}
              />
            ))}
          </div>
        );
      })}
      {live.rows.map((row) => (
        <RunRow key={row.run.id} row={row} onOpenTask={onOpenTask} />
      ))}
    </div>
  );
}

// One live run's 28px row. `nested` indents it under a milestone section row the way
// Linear nests sub-issues under their parent.
function RunRow({
  row: { run, kindLabel },
  nested = false,
  onOpenTask,
}: {
  row: LiveRailRow;
  nested?: boolean;
  onOpenTask: LiveRailProps['onOpenTask'];
}) {
  const state = deriveFeedState(run) ?? 'working';
  return (
    <button
      type="button"
      onClick={() => onOpenTask(run.taskId, 'run', run.id)}
      // The kind is in the name rather than on screen: "review" or "verify" matters
      // when there are two rows for one task, which the title alone can't tell apart.
      aria-label={
        kindLabel === 'agent'
          ? run.taskTitle
          : `${run.taskTitle} (${kindLabel})`
      }
      className={cn(
        SIDEBAR_ROW_CLASS,
        SIDEBAR_ROW_INACTIVE_CLASS,
        nested && 'pl-6'
      )}
    >
      <StateMark state={state} />
      <span className="min-w-0 flex-1 truncate">{run.taskTitle}</span>
      {/* The fleet under a run — live/total while any sub-agent is still going, the
          total once they have all stopped. */}
      {run.subagents !== undefined && run.subagents.total > 0 && (
        <span
          className="text-muted-foreground font-book flex shrink-0 items-center gap-0.5 text-[11px] tabular-nums"
          aria-label={
            run.subagents.running > 0
              ? `${run.subagents.running} of ${run.subagents.total} sub-agents running`
              : `${run.subagents.total} sub-agents`
          }
        >
          <Bot className="size-3" />
          {run.subagents.running > 0
            ? `${run.subagents.running}/${run.subagents.total}`
            : run.subagents.total}
        </span>
      )}
      <Elapsed iso={run.createdAt} />
    </button>
  );
}

function Elapsed({ iso }: { iso: string }) {
  return (
    <span className="text-muted-foreground font-book shrink-0 text-[11px] tabular-nums">
      {formatRelativeTimeFromIso(iso)}
    </span>
  );
}
