import {
  isCanceledStatus,
  isCompletedStatus,
  isDoneStatus,
  statusLabel,
} from '@dispatch-foo/core/browser';
import type { RunMeta } from '@dispatch/client';
import {
  cx,
  Register,
  RegisterCell,
  RegisterRow,
  SkeletonText,
  type StatCell,
  StatsStrip,
} from '@dispatch/ui';
import { useMemo } from 'react';

import {
  useMilestoneLedger,
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
import { mergeLadderState } from '../../../lib/mergeLadder';
import { modelLabel } from '../../../lib/models';
import { formatShortDate } from '../../../lib/taskDates';
import { taskIndexOf } from '../../../lib/taskIndex';
import { taskOutcome } from '../../../lib/taskOutcome';
import { taskTimeline } from '../../../lib/taskTimeline';
import { flightScope } from '../../flightplan/flightScope';
import { LandedAs } from '../../runs/LandedAs';
import { RunStatePill } from '../../runs/RunStatePill';
import { MemoryReachSection } from '../detail/MemoryReachSection';
import { ReceiptsSection } from '../detail/ReceiptsSection';
import { TaskLessonsSection } from '../detail/TaskLessonsSection';
import { VerificationSection } from '../detail/VerificationSection';
import { StatusIcon } from '../StatusIcon';
import { ActivityTimeline } from './ActivityTimeline';
import { OutcomeCard } from './OutcomeCard';
import { type TaskPageModel, verificationTaskId } from './pageModel';
import { FilesTouched } from './RunStrip';
import styles from './SummaryMode.module.css';
import { formatElapsed } from '@/hooks/useElapsed';

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

/** A container's sub-issues, each with its status and where its work landed. */
function SubIssueOutcomes({
  rollup,
  onOpenTask,
  originWebUrl,
}: {
  rollup: ContainerRollup;
  onOpenTask: (taskId: string) => void;
  originWebUrl: string | undefined;
}) {
  if (rollup.subIssues.length === 0) return null;
  return (
    <section data-slot="sub-issue-outcomes" className={styles.section}>
      <h3 className={styles.heading}>Sub-issues</h3>
      <Register
        label="Sub-issues"
        columns="minmax(0, 1fr) auto"
        stackWithin={480}
        stackedColumns="minmax(0, 1fr)"
      >
        {rollup.subIssues.map(({ task, landedBy }) => (
          <RegisterRow
            key={task.meta.id}
            rowLabel={`${task.meta.id} ${task.meta.title}`}
            onActivate={() => onOpenTask(task.meta.id)}
          >
            <RegisterCell variant="name">
              <span className={styles.subject}>
                <StatusIcon status={task.meta.status} />
                <span className={cx(styles.id, 'mono')}>{task.meta.id}</span>
                <span className={styles.title}>{task.meta.title}</span>
              </span>
            </RegisterCell>
            <RegisterCell align="end">
              {landedBy !== undefined && (
                <LandedAs run={landedBy} originWebUrl={originWebUrl} />
              )}
            </RegisterCell>
          </RegisterRow>
        ))}
      </Register>
    </section>
  );
}

/** The run figures as stat cells: how many runs, what they cost, their turns, and the time
 * from the first dispatch to the last run that moved. */
function figureCells(
  runs: readonly RunMeta[],
  totalCost: number,
  totalTurns: number,
  took: string | null
): StatCell[] {
  return [
    {
      id: 'runs',
      label: runs.length === 1 ? 'Run' : 'Runs',
      value: runs.length,
    },
    { id: 'spent', label: 'Spent', value: `$${totalCost.toFixed(2)}` },
    { id: 'turns', label: 'Turns', value: totalTurns },
    {
      id: 'span',
      label: 'First dispatch to last run',
      value: took ?? '—',
    },
  ];
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
    useTaskVerification(project.client, project.port, verificationTaskId(page));
  const { entries: milestoneLedger } = useMilestoneLedger(
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
    ? milestoneLedger
    : taskLedgerEntries(projectLedger, meta.id);

  // A single task's ending, as the outcome card says it; containers keep
  // their rollup line instead.
  const ending =
    rollup === null
      ? taskOutcome({
          completed: isCompletedStatus(meta.status, page.statusModel),
          canceled,
          runs,
        })
      : null;
  const outcome =
    rollup !== null
      ? rollupOutcome(rollup)
      : canceled
        ? 'No work landed.'
        : // A landed run says where it went itself (LandedAs below).
          mergeLadderState(landed) !== 'unmerged'
          ? null
          : done
            ? 'Closed without an agent run here.'
            : 'Not finished yet.';

  return (
    <div data-slot="summary-mode" className={styles.root}>
      <section className={styles.outcome}>
        {ending !== null ? (
          <OutcomeCard
            outcome={ending}
            page={page}
            place="summary"
            updatedAt={meta.updated}
          />
        ) : (
          <>
            <div className={styles.statusLine}>
              <StatusIcon status={meta.status} size={16} />
              <h3 className={styles.status}>{statusLabel(meta.status)}</h3>
              <span className={cx(styles.date, 'num')}>
                {formatShortDate(meta.updated)}
              </span>
            </div>
            <div className={styles.outcomeLine}>
              {outcome !== null && <span>{outcome}</span>}
              {landed !== undefined && (
                <LandedAs
                  run={landed}
                  originWebUrl={project.health?.originWebUrl}
                  onPublish={project.handlePublishRun}
                />
              )}
            </div>
          </>
        )}
        {/* One run's figures are already in its line above; tiles add up several. */}
        {runs.length > 1 && (
          <StatsStrip
            label="Run figures"
            cells={figureCells(runs, totalCost, totalTurns, took)}
          />
        )}
        {landed !== undefined && <FilesTouched files={landed.claims ?? []} />}
      </section>

      {rollup !== null && (
        <SubIssueOutcomes
          rollup={rollup}
          onOpenTask={page.openTask}
          originWebUrl={project.health?.originWebUrl}
        />
      )}

      {rollup === null && runs.length > 1 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Runs</h3>
          <Register
            label="Runs"
            columns="auto minmax(0, 1fr) auto auto"
            stackWithin={480}
          >
            {runs.map((r) => (
              <RegisterRow
                key={r.id}
                rowLabel={`Open run ${r.id}`}
                onActivate={() => {
                  page.selectRun(r.id);
                  page.selectMode('run');
                }}
              >
                <RegisterCell variant="name">
                  <span className={styles.subject}>
                    <RunStatePill meta={r} compact />
                    <span className={cx(styles.id, 'mono')}>{r.id}</span>
                  </span>
                </RegisterCell>
                <RegisterCell>
                  <span className={styles.executor}>
                    {r.executor}
                    {r.model !== undefined && ` · ${modelLabel(r.model)}`}
                  </span>
                </RegisterCell>
                <RegisterCell variant="mono" align="end">
                  {r.costUsd !== undefined && `$${r.costUsd.toFixed(2)}`}
                </RegisterCell>
                <RegisterCell variant="mono" align="end">
                  {formatShortDate(r.updatedAt)}
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        </section>
      )}

      <VerificationSection
        exercised={meta.exercised}
        result={verification}
        error={verificationError}
      />
      {project.client !== null && (
        <MemoryReachSection
          client={project.client}
          port={project.port}
          taskId={meta.id}
        />
      )}
      {page.host.showLessons === true && project.client !== null && (
        <TaskLessonsSection
          client={project.client}
          port={project.port}
          runIds={page.runs.map((run) => run.id)}
        />
      )}
      <ReceiptsSection entries={ledger} />

      {/* A loaded, empty history is a heading over "Nothing has happened yet". */}
      {(!page.bodyLoaded || timeline.length > 0) && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Timeline</h3>
          {page.bodyLoaded ? (
            <ActivityTimeline items={timeline} />
          ) : (
            <SkeletonText lines={3} label="Loading the history" />
          )}
        </section>
      )}
    </div>
  );
}
