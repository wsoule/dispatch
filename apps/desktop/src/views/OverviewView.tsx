import type { RunMeta } from '@dispatch/client';
import type { TaskDoc } from '@dispatch/core';
import {
  ArrowRight,
  Bell,
  CircleCheck,
  GitPullRequest,
  Loader2,
  Play,
  Sparkles,
} from 'lucide-react';
import type { ReactNode } from 'react';

import { RunStatePill } from '../components/runs/RunStatePill';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import { cn } from '@/lib/utils';

interface OverviewViewProps {
  data: DispatchProjectData;
  projectName: string | null;
  onOpenRun: (runId: string) => void;
  onOpenTask: (taskId: string) => void;
  onOpenPr: (runId: string) => void;
  onDispatch: (taskId: string) => Promise<void>;
  onGoToBoard: () => void;
}

type Tone = 'amber' | 'blue' | 'violet' | 'emerald' | 'muted';

const TONE_TEXT: Record<Tone, string> = {
  amber: 'text-amber-600 dark:text-amber-400',
  blue: 'text-blue-600 dark:text-blue-400',
  violet: 'text-primary',
  emerald: 'text-emerald-600 dark:text-emerald-400',
  muted: 'text-muted-foreground',
};

// One big-number tile in the top strip — the glance-level count for a bucket.
function StatTile({
  label,
  count,
  icon,
  tone,
  onClick,
}: {
  label: string;
  count: number;
  icon: ReactNode;
  tone: Tone;
  onClick?: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={onClick === undefined}
      className={cn(
        'border-border bg-card flex flex-1 flex-col gap-1 rounded-lg border p-4 text-left transition-colors duration-150',
        onClick !== undefined && 'hover:border-border hover:bg-muted/40'
      )}
    >
      <div className="flex items-center gap-1.5">
        <span className={TONE_TEXT[tone]}>{icon}</span>
        <span className="text-muted-foreground text-[12px]">{label}</span>
      </div>
      <span className="text-foreground text-2xl font-semibold tabular-nums">
        {count}
      </span>
    </button>
  );
}

// A titled panel listing the items in one bucket, or a quiet "all clear" line
// when the bucket is empty — so an empty column still reads as reassuring
// rather than broken.
function SectionCard({
  title,
  icon,
  tone,
  count,
  emptyLabel,
  children,
}: {
  title: string;
  icon: ReactNode;
  tone: Tone;
  count: number;
  emptyLabel: string;
  children: ReactNode;
}) {
  return (
    <section className="border-border bg-card flex min-h-0 flex-col rounded-lg border">
      <div className="border-border/60 flex items-center gap-2 border-b px-4 py-2.5">
        <span className={TONE_TEXT[tone]}>{icon}</span>
        <h2 className="text-foreground text-[13px] font-medium">{title}</h2>
        {count > 0 && (
          <span className="text-muted-foreground bg-muted rounded-full px-1.5 text-[11px] tabular-nums">
            {count}
          </span>
        )}
      </div>
      {count === 0 ? (
        <div className="text-muted-foreground/70 flex items-center gap-1.5 px-4 py-3 text-[12px]">
          <CircleCheck className="size-3.5" />
          {emptyLabel}
        </div>
      ) : (
        <div className="flex flex-col gap-0.5 p-1.5">{children}</div>
      )}
    </section>
  );
}

// A clickable run row (used by every run-backed bucket): task title, its run's
// state, and when it last moved.
function RunRow({
  run,
  onClick,
  trailing,
}: {
  run: RunMeta;
  onClick: () => void;
  trailing?: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="hover:bg-muted/60 flex w-full items-center gap-2 rounded-md px-2.5 py-2 text-left transition-colors duration-150"
    >
      <RunStatePill state={run.state} className="shrink-0" />
      <span className="text-foreground min-w-0 flex-1 truncate text-[13px]">
        {run.taskTitle}
      </span>
      {trailing ?? (
        <span className="text-muted-foreground/60 shrink-0 text-[11px] whitespace-nowrap">
          {formatRelativeTimeFromIso(run.updatedAt)}
        </span>
      )}
    </button>
  );
}

/**
 * The command center — the app's landing view and answer to "what the hell is going on with my
 * agents." Built entirely from data the project hook already has, it buckets every run/task by
 * what the user cares about at a glance: what needs their attention (approvals, failures),
 * what's working right now, what's waiting to be reviewed or merged, and what's ready to start
 * next — each row one click from the surface that acts on it. No new data, just the one screen
 * that replaces staring at 50 terminal tabs.
 */
export function OverviewView({
  data,
  projectName,
  onOpenRun,
  onOpenTask,
  onOpenPr,
  onDispatch,
  onGoToBoard,
}: OverviewViewProps) {
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // A run "needs attention" if it's paused on an approval or has failed and not yet been dealt
  // with — those are the only two states where the user is the blocker.
  const needsAttention = data.runs.filter(
    (r) =>
      r.state === 'awaiting-approval' ||
      (r.state === 'failed' && r.reviewedAt === undefined)
  );
  const working = data.runs.filter(
    (r) => r.state === 'running' || r.state === 'provisioning'
  );
  // Finished, nothing claimed it yet (no PR, not merged/discarded) — waiting on a review.
  const inReview = data.runs.filter(
    (r) =>
      r.state === 'finished' &&
      r.reviewedAt === undefined &&
      r.prUrl === undefined
  );
  const openPrs = data.runs.filter(
    (r) => r.prUrl !== undefined && r.reviewedAt === undefined
  );
  // Ready-to-start tasks (deps met) that don't already have a live run going.
  const upNext: TaskDoc[] = data.tasks
    .filter(
      (t) =>
        data.readyIds.has(t.meta.id) &&
        !data.liveRunStateByTaskId.has(t.meta.id)
    )
    .slice(0, 8);

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto">
      <div className="flex items-baseline gap-2">
        <h1 className="view-topbar-title">Overview</h1>
        {projectName !== null && (
          <span className="text-muted-foreground text-[13px]">
            {projectName}
          </span>
        )}
      </div>

      <div className="flex flex-wrap gap-3">
        <StatTile
          label="Working now"
          count={working.length}
          tone="blue"
          icon={<Loader2 className="size-4" />}
        />
        <StatTile
          label="Needs you"
          count={needsAttention.length}
          tone="amber"
          icon={<Bell className="size-4" />}
        />
        <StatTile
          label="In review"
          count={inReview.length}
          tone="violet"
          icon={<Sparkles className="size-4" />}
        />
        <StatTile
          label="Open PRs"
          count={openPrs.length}
          tone="emerald"
          icon={<GitPullRequest className="size-4" />}
        />
      </div>

      <div className="grid flex-1 grid-cols-1 gap-3 lg:grid-cols-2">
        <SectionCard
          title="Needs your attention"
          icon={<Bell className="size-4" />}
          tone="amber"
          count={needsAttention.length}
          emptyLabel="Nothing waiting on you."
        >
          {needsAttention.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              onClick={() => onOpenRun(r.id)}
              trailing={
                <span className="shrink-0 text-[11px] text-amber-600 dark:text-amber-400">
                  {r.state === 'awaiting-approval'
                    ? 'Approve →'
                    : 'Review error →'}
                </span>
              }
            />
          ))}
        </SectionCard>

        <SectionCard
          title="Working now"
          icon={<Loader2 className="size-4" />}
          tone="blue"
          count={working.length}
          emptyLabel="No agents are running."
        >
          {working.map((r) => (
            <RunRow key={r.id} run={r} onClick={() => onOpenRun(r.id)} />
          ))}
        </SectionCard>

        <SectionCard
          title="In review"
          icon={<Sparkles className="size-4" />}
          tone="violet"
          count={inReview.length}
          emptyLabel="Nothing waiting to be reviewed."
        >
          {inReview.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              onClick={() => onOpenRun(r.id)}
              trailing={
                <span className="text-primary shrink-0 text-[11px]">
                  Review →
                </span>
              }
            />
          ))}
        </SectionCard>

        <SectionCard
          title="Pull requests"
          icon={<GitPullRequest className="size-4" />}
          tone="emerald"
          count={openPrs.length}
          emptyLabel="No open pull requests."
        >
          {openPrs.map((r) => (
            <RunRow
              key={r.id}
              run={r}
              onClick={() => onOpenPr(r.id)}
              trailing={
                <span className="shrink-0 text-[11px] text-emerald-600 dark:text-emerald-400">
                  Review PR →
                </span>
              }
            />
          ))}
        </SectionCard>
      </div>

      <SectionCard
        title="Up next"
        icon={<Play className="size-4" />}
        tone="muted"
        count={upNext.length}
        emptyLabel="No ready tasks — everything's blocked, running, or done."
      >
        {upNext.map((t) => (
          <div
            key={t.meta.id}
            className="group hover:bg-muted/60 flex items-center gap-2 rounded-md px-2.5 py-2 transition-colors duration-150"
          >
            <PriorityIcon priority={t.meta.priority} />
            <button
              type="button"
              onClick={() => onOpenTask(t.meta.id)}
              className="text-foreground min-w-0 flex-1 truncate text-left text-[13px]"
            >
              {t.meta.title}
            </button>
            <button
              type="button"
              onClick={() => void onDispatch(t.meta.id)}
              className="text-muted-foreground hover:bg-primary/10 hover:text-primary inline-flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-medium opacity-0 transition-opacity duration-150 group-hover:opacity-100"
            >
              Dispatch
              <ArrowRight className="size-3" />
            </button>
          </div>
        ))}
      </SectionCard>

      <div className="flex justify-center pb-2">
        <button
          type="button"
          onClick={onGoToBoard}
          className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1 text-[12px]"
        >
          Open the board
          <ArrowRight className="size-3.5" />
        </button>
      </div>
    </div>
  );
}
