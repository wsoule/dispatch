import type { RunMeta } from '@dispatch/client';
import {
  isCanceledStatus,
  isDoneStatus,
  statusLabel,
} from '@dispatch/core/browser';
import { ArrowUpRight, GitCommitHorizontal } from 'lucide-react';
import type { ReactNode } from 'react';
import { useMemo } from 'react';

import {
  useEpicLedger,
  useProjectLedger,
  useTaskVerification,
} from '../../../hooks/useOrchestration';
import type { ContainerRollup } from '../../../lib/containerRollup';
import {
  containerRollup,
  landingRun,
  rollupOutcome,
} from '../../../lib/containerRollup';
import { taskLedgerEntries } from '../../../lib/ledgerScope';
import { modelLabel } from '../../../lib/models';
import { formatShortDate } from '../../../lib/taskDates';
import { taskIndexOf } from '../../../lib/taskIndex';
import { taskTimeline } from '../../../lib/taskTimeline';
import { flightScope } from '../../flightplan/flightScope';
import { RunStatePill } from '../../runs/RunStatePill';
import { LedgerSection } from '../detail/LedgerSection';
import { VerificationSection } from '../detail/VerificationSection';
import { StatusIcon } from '../StatusIcon';
import { ActivityTimeline } from './ActivityTimeline';
import type { TaskPageModel } from './pageModel';
import { FilesTouched } from './RunStrip';
import { Pill } from '@/ui/ai/pill';
import { formatElapsed } from '@/ui/ai/use-elapsed';

function Figure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="text-foreground truncate text-[15px] font-semibold tabular-nums">
        {children}
      </span>
      <span className="text-muted-foreground font-book text-[12px]">
        {label}
      </span>
    </div>
  );
}

/** From the first dispatch to the last time a run moved, as `3d 4h` / `2h 10m` / `12:04`. */
function span(runs: readonly RunMeta[]): string | null {
  if (runs.length === 0) return null;
  let first = Infinity;
  let last = -Infinity;
  for (const r of runs) {
    first = Math.min(first, Date.parse(r.createdAt));
    last = Math.max(last, Date.parse(r.updatedAt));
  }
  const ms = last - first;
  if (!Number.isFinite(ms) || ms < 0) return null;
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d ${hours % 24}h`;
  if (hours >= 1) return `${hours}h ${Math.floor((ms % 3_600_000) / 60_000)}m`;
  return formatElapsed(ms);
}

/** Where a run's work landed: its merge commit (and whether it reached origin), its PR. */
function LandedAs({ run }: { run: RunMeta }) {
  return (
    <>
      {run.mergeCommit !== undefined && (
        <Pill className="font-mono font-normal" title={run.mergeCommit}>
          <GitCommitHorizontal />
          {run.mergeCommit.slice(0, 7)}
        </Pill>
      )}
      {run.pushedToOrigin === true && (
        <span className="text-muted-foreground">· pushed</span>
      )}
      {run.prUrl !== undefined && (
        <a href={run.prUrl} target="_blank" rel="noreferrer">
          <Pill className="hover:bg-surface-active">
            Pull request
            <ArrowUpRight className="text-muted-foreground" />
          </Pill>
        </a>
      )}
    </>
  );
}

/** A container's sub-issues, each with its status and where its work landed. */
function SubIssueOutcomes({
  rollup,
  onOpenTask,
}: {
  rollup: ContainerRollup;
  onOpenTask: (taskId: string) => void;
}) {
  if (rollup.subIssues.length === 0) return null;
  return (
    <section data-slot="sub-issue-outcomes" className="flex flex-col gap-1">
      <h3 className="text-muted-foreground flex h-6 items-center text-[12px] font-medium">
        Sub-issues
      </h3>
      <ul className="-mx-2 flex flex-col">
        {rollup.subIssues.map(({ task, landedBy }) => (
          <li key={task.meta.id} className="flex h-8 items-center gap-2 px-2">
            <StatusIcon status={task.meta.status} className="size-3.5" />
            <button
              type="button"
              onClick={() => onOpenTask(task.meta.id)}
              className="flex min-w-0 flex-1 items-center gap-2 text-left outline-none focus-visible:underline"
            >
              <span className="text-muted-foreground font-book shrink-0 text-[12px] tracking-(--id-tracking)">
                {task.meta.id}
              </span>
              <span className="font-book hover:text-foreground min-w-0 truncate text-[13px] text-(--text-secondary)">
                {task.meta.title}
              </span>
            </button>
            {landedBy !== undefined && (
              <span className="font-book flex shrink-0 items-center gap-2 text-[12px]">
                <LandedAs run={landedBy} />
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Summary mode — how the task ended: its outcome in one line (landed where, as which
 * commit, through which PR), the figures (runs, spend, turns, time from first dispatch),
 * the files the landing run touched, every run it took, and the full timeline. For a
 * canceled task it says so and keeps the history. A container has no runs of its own, so
 * its summary rolls up the work its plan draws: which sub-issues landed and how, and the
 * figures across their runs.
 */
export function SummaryMode({ page }: { page: TaskPageModel }) {
  const { item, project } = page;
  const meta = item.meta;
  const tasks = project.tasksIncludingArchived;
  const rollup = useMemo(
    () =>
      page.isContainer
        ? containerRollup(
            flightScope(item, taskIndexOf(tasks).childrenOf).nodes,
            project.runs,
            page.statusModel
          )
        : null,
    [page.isContainer, item, tasks, project.runs, page.statusModel]
  );
  const runs = rollup?.runs ?? page.runs;
  const landed = rollup === null ? landingRun(runs) : undefined;
  const totalCost = runs.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalTurns = runs.reduce((sum, r) => sum + (r.turns ?? 0), 0);
  const took = span(runs);
  const timeline = useMemo(() => taskTimeline(page.activity), [page.activity]);
  const canceled = isCanceledStatus(meta.status, page.statusModel);
  const done = isDoneStatus(meta.status, page.statusModel);
  const { result: verification, error: verificationError } =
    useTaskVerification(project.client, project.port, meta.id);
  const { entries: epicLedger } = useEpicLedger(
    project.client,
    project.port,
    page.isContainer ? meta.id : undefined
  );
  const { entries: projectLedger } = useProjectLedger(
    project.client,
    project.port,
    !page.isContainer
  );
  const ledger = page.isContainer
    ? epicLedger
    : taskLedgerEntries(projectLedger, meta.id);

  const outcome =
    rollup !== null
      ? rollupOutcome(rollup)
      : canceled
        ? 'No work landed.'
        : landed?.mergeCommit !== undefined
          ? `Merged into ${landed.baseBranch}`
          : landed?.prUrl !== undefined
            ? 'Landed through a pull request'
            : done
              ? 'Closed without an agent run here.'
              : 'Not finished yet.';

  return (
    <div data-slot="summary-mode" className="flex flex-col gap-6 px-4 pb-10">
      <section className="flex flex-col gap-3">
        <div className="flex items-center gap-2">
          <StatusIcon status={meta.status} className="size-4" />
          <h3 className="text-foreground text-[15px] font-semibold">
            {statusLabel(meta.status)}
          </h3>
          <span className="text-muted-foreground font-book text-[13px]">
            {formatShortDate(meta.updated)}
          </span>
        </div>
        <div className="font-book flex flex-wrap items-center gap-2 text-[13px] text-(--text-secondary)">
          <span>{outcome}</span>
          {landed !== undefined && <LandedAs run={landed} />}
        </div>
        {runs.length > 0 && (
          <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
            <Figure label={runs.length === 1 ? 'run' : 'runs'}>
              {runs.length}
            </Figure>
            <Figure label="spent">${totalCost.toFixed(2)}</Figure>
            <Figure label="turns">{totalTurns}</Figure>
            <Figure label="first dispatch to last run">{took ?? '—'}</Figure>
          </div>
        )}
        {landed !== undefined && <FilesTouched files={landed.claims ?? []} />}
      </section>

      {rollup !== null && (
        <SubIssueOutcomes rollup={rollup} onOpenTask={page.openTask} />
      )}

      {rollup === null && runs.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-muted-foreground flex h-6 items-center text-[12px] font-medium">
            Runs
          </h3>
          <ul className="-mx-2 flex flex-col">
            {runs.map((r) => (
              <li key={r.id}>
                <button
                  type="button"
                  onClick={() => {
                    page.selectRun(r.id);
                    page.selectMode('run');
                  }}
                  className="hover:bg-surface-hover rounded-control focus-visible:ring-ring flex h-8 w-full items-center gap-2 px-2 text-left outline-none focus-visible:ring-2"
                >
                  <RunStatePill meta={r} compact />
                  <span className="font-book text-[13px] tracking-(--id-tracking) text-(--text-secondary)">
                    {r.id}
                  </span>
                  <span className="text-muted-foreground font-book min-w-0 flex-1 truncate text-[12px]">
                    {r.executor}
                    {r.model !== undefined && ` · ${modelLabel(r.model)}`}
                  </span>
                  {r.costUsd !== undefined && (
                    <span className="text-muted-foreground font-book text-[12px] tabular-nums">
                      ${r.costUsd.toFixed(2)}
                    </span>
                  )}
                  <span className="text-muted-foreground font-book w-14 text-right text-[12px]">
                    {formatShortDate(r.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      <VerificationSection
        exercised={meta.exercised}
        result={verification}
        error={verificationError}
      />
      <LedgerSection entries={ledger} />

      <section className="flex flex-col gap-2">
        <h3 className="text-muted-foreground flex h-6 items-center text-[12px] font-medium">
          Timeline
        </h3>
        {page.bodyLoaded ? (
          <ActivityTimeline items={timeline} />
        ) : (
          <p className="text-muted-foreground font-book text-[12px]">
            Loading the history…
          </p>
        )}
      </section>
    </div>
  );
}
