import type { AllocationRun } from '@dispatch/client';
import {
  BlockBar,
  Button,
  Chip,
  Dialog,
  EmptyState,
  Register,
  RegisterCell,
  RegisterRow,
} from '@dispatch/ui';
import { useMemo, useState } from 'react';

import { buildAllocationPreview } from '../adapters/allocation';
import { plural } from '../adapters/planningFormat';
import { useToasts } from '../components/shell/Toasts';
import { useApplyAllocation } from '../hooks/useApplyAllocation';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { Planning } from '../hooks/usePlanning';
import { describeError } from '../lib/actionFeedback';
import styles from './AssignMilestonesDialog.module.css';

// Projects' "Assign next milestones": the button names how many issues the
// planning would hand out, and the dialog lists them by project with the
// projects it skips and why, then applies (useApplyAllocation). A
// request-tier window sees the preview without Apply.

const ITEM_COLUMNS = 'minmax(0, 1fr) minmax(100px, 0.5fr) minmax(120px, 0.5fr)';
const ITEM_HEADER = [
  { id: 'issue', label: 'Issue' },
  { id: 'assignee', label: 'Assign to' },
  { id: 'status', label: 'Status' },
];

export interface AssignMilestonesProps {
  data: Pick<DispatchProjectData, 'client' | 'myTier'>;
  planning: Planning;
}

export function AssignMilestones({ data, planning }: AssignMilestonesProps) {
  const toasts = useToasts();
  const { allocation, snapshot } = planning;
  const preview = useMemo(
    () => buildAllocationPreview(allocation, snapshot),
    [allocation, snapshot]
  );
  const { busy, apply } = useApplyAllocation(data.client, allocation, snapshot);
  const [open, setOpen] = useState(false);
  const canApply = data.myTier !== 'request';
  const assigning = preview.projects.filter((p) => p.items.length > 0);
  const skipped = preview.projects.filter((p) => p.items.length === 0);

  const run = () =>
    apply().then(
      (result: AllocationRun) => {
        const { assigned, failed } = result.counts;
        toasts.push({
          title: `${plural(assigned, 'issue')} assigned${failed > 0 ? `, ${failed} failed` : ''}`,
          tone: failed > 0 ? 'error' : 'success',
        });
        setOpen(false);
      },
      (err: unknown) =>
        toasts.push({
          title: 'Milestones not assigned',
          description: describeError(err),
          tone: 'error',
        })
    );

  // Nothing to assign is a dialog that says so: the button shows once there is work.
  if (preview.actions === 0 && !open) return null;

  return (
    <>
      <Button variant="quiet" size="sm" onClick={() => setOpen(true)}>
        {`Assign next milestones · ${preview.actions}`}
      </Button>
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        dismissible={!busy}
        size="lg"
        title="Assign next milestones"
        description="Each unassigned issue in a project's next milestone goes to the project's lead and moves out of Backlog, with a comment saying why."
        actions={
          <>
            <Button size="sm" onClick={() => setOpen(false)} disabled={busy}>
              Cancel
            </Button>
            {canApply ? (
              <Button
                size="sm"
                variant="primary"
                disabled={preview.actions === 0}
                busy={busy}
                onClick={() => void run()}
              >
                {preview.actions === 0
                  ? 'Assign'
                  : `Assign ${plural(preview.actions, 'issue')}`}
              </Button>
            ) : null}
          </>
        }
      >
        <div className={styles.body}>
          {assigning.length === 0 ? (
            <EmptyState>
              Nothing to assign: every next milestone's issues have an owner.
            </EmptyState>
          ) : (
            assigning.map((project) => (
              <section
                key={project.projectId}
                aria-label={project.projectName}
                className={styles.project}
              >
                <BlockBar
                  title={project.projectName}
                  meta={project.detail ?? undefined}
                />
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
                      <RegisterCell
                        label="Issue"
                        variant="name"
                        sub={item.identifier}
                      >
                        {item.title}
                      </RegisterCell>
                      <RegisterCell label="Assign to">
                        {item.assigneeName}
                      </RegisterCell>
                      <RegisterCell label="Status">
                        {item.statusChange}
                      </RegisterCell>
                    </RegisterRow>
                  ))}
                </Register>
              </section>
            ))
          )}
          {skipped.length > 0 ? (
            <section aria-label="Skipped" className={styles.project}>
              <BlockBar
                title="Skipped"
                meta={plural(skipped.length, 'project')}
              />
              <Register
                label="Skipped projects"
                columns="minmax(0, 1fr) auto"
                stackWithin={480}
                stackedColumns="minmax(0, 1fr)"
              >
                {skipped.map((project) => (
                  <RegisterRow key={project.projectId}>
                    <RegisterCell
                      label="Project"
                      variant="name"
                      sub={project.detail ?? undefined}
                    >
                      {project.projectName}
                    </RegisterCell>
                    <RegisterCell align="end">
                      <Chip tone={project.tone}>{project.outcomeLabel}</Chip>
                    </RegisterCell>
                  </RegisterRow>
                ))}
              </Register>
            </section>
          ) : null}
        </div>
      </Dialog>
    </>
  );
}
