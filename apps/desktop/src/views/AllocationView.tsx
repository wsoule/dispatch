import type { AllocationRun } from '@dispatch/client';
import {
  BlockBar,
  Button,
  Chip,
  ConfirmDialog,
  Dialog,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
  Skeleton,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { useMemo, useState } from 'react';

import {
  type AllocationPreviewProject,
  buildAllocationPreview,
  runRow,
} from '../adapters/allocation';
import { plural } from '../adapters/planningFormat';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useToasts } from '../components/shell/Toasts';
import { TasksBackButton } from '../components/tasks/TasksPageHeader';
import { useAllocationRuns } from '../hooks/useAllocationRuns';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { type Planning, usePlanningContext } from '../hooks/usePlanning';
import { describeError } from '../lib/actionFeedback';
import { formatRelativeTimeFromIso } from '../lib/format';
import { taskHref } from '../lib/routes';
import styles from './AllocationView.module.css';

// The Allocation page (Better Tracker's /runs, with its preview and "Run
// now"): what the planning's allocation would do right now (each unassigned
// issue in a project's next milestone goes to the project's lead and leaves
// Backlog), the projects it skips and why, and the log of runs. "Record dry
// run" logs the preview and changes nothing; "Apply" makes the changes, one
// issue at a time, and logs what happened. A request-tier window only
// previews. The plan is App's planning (PlanningContext); the log is the
// daemon's.

const ITEM_COLUMNS = 'minmax(0, 1fr) minmax(120px, 0.5fr) minmax(140px, 0.5fr)';
const ITEM_HEADER = [
  { id: 'issue', label: 'Issue' },
  { id: 'assignee', label: 'Assign to' },
  { id: 'status', label: 'Status' },
];
const RUN_COLUMNS = '150px 96px minmax(0, 1fr) minmax(100px, 0.4fr) 90px';
const RUN_HEADER = [
  { id: 'at', label: 'When' },
  { id: 'mode', label: 'Mode' },
  { id: 'summary', label: 'Result' },
  { id: 'by', label: 'By' },
  { id: 'blocked', label: 'Blocked', align: 'end' as const },
];

export interface AllocationViewProps {
  data: DispatchProjectData;
  onBack?: () => void;
}

export function AllocationView({ data, onBack }: AllocationViewProps) {
  const planning = usePlanningContext();
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }
  if (planning === null) {
    return (
      <div className={styles.root} data-testid="allocation-view">
        <EmptyState>Allocation is not available here.</EmptyState>
      </div>
    );
  }
  return <AllocationLoaded data={data} planning={planning} onBack={onBack} />;
}

function AllocationLoaded({
  data,
  planning,
  onBack,
}: AllocationViewProps & { planning: Planning }) {
  const toasts = useToasts();
  const { allocation, snapshot } = planning;
  const preview = useMemo(
    () => buildAllocationPreview(allocation, snapshot),
    [allocation, snapshot]
  );
  const runs = useAllocationRuns(data.client, data.port, allocation, snapshot);
  const [confirming, setConfirming] = useState(false);
  const [openRunId, setOpenRunId] = useState<string | null>(null);
  const canApply = data.myTier !== 'request';

  const nameFor = (ref: string) => snapshot.users.get(ref)?.name ?? ref;
  const rows = runs.runs.map((run) => runRow(run, nameFor));
  const working = preview.projects.filter(
    (project) => project.outcome === 'allocate' || project.outcome === 'blocked'
  );
  const quiet = preview.projects.filter(
    (project) => project.outcome !== 'allocate' && project.outcome !== 'blocked'
  );

  const report = (run: AllocationRun) => {
    const { assigned, failed, wouldAssign } = run.counts;
    toasts.push(
      run.mode === 'dry_run'
        ? {
            title: `Dry run recorded: ${plural(wouldAssign, 'issue')} would be assigned`,
            tone: 'success',
          }
        : {
            title: `${plural(assigned, 'issue')} assigned${failed > 0 ? `, ${failed} failed` : ''}`,
            tone: failed > 0 ? 'error' : 'success',
          }
    );
  };
  const fail = (title: string) => (err: unknown) =>
    toasts.push({ title, description: describeError(err), tone: 'error' });

  return (
    <div className={styles.root} data-testid="allocation-view">
      <header className={styles.head}>
        {onBack === undefined ? null : <TasksBackButton onBack={onBack} />}
        <div className={styles.headText}>
          <h1 className={styles.title}>Allocation</h1>
          <p className={styles.receipts}>{preview.receipts}</p>
        </div>
        <span className={styles.headActions}>
          <Button
            size="sm"
            busy={runs.busy === 'dry_run'}
            onClick={() =>
              void runs
                .recordDryRun()
                .then(report, fail('Dry run not recorded'))
            }
          >
            Record dry run
          </Button>
          {canApply ? (
            <Button
              size="sm"
              variant="primary"
              disabled={preview.actions === 0}
              busy={runs.busy === 'applied'}
              onClick={() => setConfirming(true)}
            >
              {preview.actions === 0
                ? 'Apply'
                : `Apply ${plural(preview.actions, 'change')}`}
            </Button>
          ) : null}
        </span>
      </header>
      <p className={styles.explain}>
        Each unassigned issue in a project's next milestone goes to the
        project's lead and moves out of Backlog, with a comment saying why.
        Projects missing a lead, a date or a "Done means…" are skipped until
        they have one. Settings → Planning can have the daemon do this daily.
      </p>

      <section aria-label="Preview" className={styles.section}>
        <BlockBar title="Preview" meta="If applied now" />
        {working.length === 0 ? (
          <EmptyState>
            Nothing to assign: every next milestone's issues have an owner.
          </EmptyState>
        ) : (
          working.map((project) => (
            <PreviewProject key={project.projectId} project={project} />
          ))
        )}
        {quiet.length > 0 ? (
          <p className={styles.quiet}>
            No changes in{' '}
            {quiet
              .map(
                (project) =>
                  `${project.projectName} (${project.outcomeLabel.toLowerCase()})`
              )
              .join(', ')}
            .
          </p>
        ) : null}
      </section>

      <section aria-label="Runs" className={styles.section}>
        <BlockBar title="Runs" meta={plural(rows.length, 'run')} />
        {runs.loading ? (
          <Skeleton />
        ) : rows.length === 0 ? (
          <EmptyState>
            No runs yet. Record a dry run to keep what the plan would do.
          </EmptyState>
        ) : (
          <Register
            label="Allocation runs"
            columns={RUN_COLUMNS}
            header={RUN_HEADER}
            stackWithin={700}
            stackedColumns="repeat(auto-fill, minmax(140px, 1fr))"
          >
            {rows.map((row) => (
              <RegisterRow
                key={row.id}
                rowLabel={`${row.modeLabel} ${formatRelativeTimeFromIso(row.at)}: ${row.summary}`}
                onActivate={() => setOpenRunId(row.id)}
              >
                <RegisterCell label="When">
                  {formatRelativeTimeFromIso(row.at)}
                </RegisterCell>
                <RegisterCell label="Mode">
                  <Chip tone={row.modeTone}>{row.modeLabel}</Chip>
                </RegisterCell>
                <RegisterCell label="Result">{row.summary}</RegisterCell>
                <RegisterCell label="By">{row.by}</RegisterCell>
                <RegisterCell label="Blocked" align="end">
                  <span className="num">{row.blocked}</span>
                </RegisterCell>
              </RegisterRow>
            ))}
          </Register>
        )}
      </section>

      <ConfirmDialog
        open={confirming}
        title={`Apply ${plural(preview.actions, 'change')}?`}
        confirmLabel="Apply"
        busy={runs.busy === 'applied'}
        onCancel={() => setConfirming(false)}
        onConfirm={() =>
          runs
            .apply()
            .then(report, fail('Allocation not applied'))
            .finally(() => setConfirming(false))
        }
      >
        {plural(preview.actions, 'issue')} will be assigned to their project's
        lead, moved out of Backlog and commented on. Undo by hand.
      </ConfirmDialog>
      <RunDialog
        data={data}
        runId={openRunId}
        onClose={() => setOpenRunId(null)}
      />
    </div>
  );
}

/** One project of the preview: its verdict and the issues it would assign. */
function PreviewProject({ project }: { project: AllocationPreviewProject }) {
  return (
    <section aria-label={project.projectName} className={styles.project}>
      <div className={styles.projectHead}>
        <span className={styles.projectName}>{project.projectName}</span>
        <Chip tone={project.tone} filled={project.outcome === 'blocked'}>
          {project.outcomeLabel}
        </Chip>
        {project.detail === null ? null : (
          <span
            className={styles.projectDetail}
            data-tone={project.outcome === 'blocked' ? 'warning' : undefined}
          >
            {project.detail}
          </span>
        )}
      </div>
      {project.items.length > 0 ? (
        <Register
          label={`${project.projectName}: issues to assign`}
          columns={ITEM_COLUMNS}
          header={ITEM_HEADER}
          stackWithin={600}
          stackedColumns="minmax(0, 1fr)"
        >
          {project.items.map((item) => (
            <RegisterRow
              key={item.issueId}
              href={item.href}
              rowLabel={`${item.identifier} ${item.title}`}
            >
              <RegisterCell label="Issue" variant="name" sub={item.identifier}>
                {item.title}
              </RegisterCell>
              <RegisterCell label="Assign to">{item.assigneeName}</RegisterCell>
              <RegisterCell label="Status">{item.statusChange}</RegisterCell>
            </RegisterRow>
          ))}
        </Register>
      ) : null}
    </section>
  );
}

const OUTCOME_LABEL = {
  assigned: { label: 'Assigned', tone: 'success' },
  would_assign: { label: 'Would assign', tone: 'default' },
  failed: { label: 'Failed', tone: 'danger' },
} as const;

/** A recorded run, item by item, over the page. */
function RunDialog({
  data,
  runId,
  onClose,
}: {
  data: DispatchProjectData;
  runId: string | null;
  onClose: () => void;
}) {
  const q = useQuery({
    queryKey: ['allocation-runs', data.port, runId],
    enabled: data.client !== null && runId !== null,
    queryFn: () => {
      if (data.client === null || runId === null) throw new Error('no run');
      return data.client.fetchAllocationRun(runId);
    },
  });
  const run = q.data;
  return (
    <Dialog
      open={runId !== null}
      onClose={onClose}
      size="lg"
      title={
        run === undefined
          ? 'Allocation run'
          : `${runRow(run, (ref) => ref).modeLabel} · ${formatRelativeTimeFromIso(run.at)}`
      }
    >
      {run === undefined ? (
        <Skeleton />
      ) : run.items.length === 0 ? (
        <EmptyState>This run had nothing to assign.</EmptyState>
      ) : (
        <Register
          label="Run items"
          columns="minmax(0, 1fr) minmax(110px, 0.5fr) 110px"
          header={[
            { id: 'issue', label: 'Issue' },
            { id: 'assignee', label: 'Assigned to' },
            { id: 'outcome', label: 'Outcome', align: 'end' },
          ]}
        >
          {run.items.map((item) => {
            const outcome = OUTCOME_LABEL[item.outcome];
            return (
              <RegisterRow
                key={item.issueId}
                href={taskHref(item.issueId)}
                rowLabel={`${item.title}: ${outcome.label}`}
              >
                <RegisterCell
                  label="Issue"
                  variant="name"
                  sub={
                    item.note ?? `${item.projectName} · ${item.milestoneName}`
                  }
                  tone={item.note === null ? undefined : 'danger'}
                  toneSub={item.note !== null}
                >
                  {item.title}
                </RegisterCell>
                <RegisterCell label="Assigned to">
                  {item.assigneeName}
                </RegisterCell>
                <RegisterCell label="Outcome" align="end">
                  <Chip tone={outcome.tone}>{outcome.label}</Chip>
                </RegisterCell>
              </RegisterRow>
            );
          })}
        </Register>
      )}
    </Dialog>
  );
}
