import { Button, TaskDetailSection } from '@dispatch/ui';
import { ArrowUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { resolveExecuteModel } from '../../../lib/models';
import { isTerminalRunState } from '../../../lib/runState';
import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
  pendingEnrichQuestions,
} from '../../../lib/taskEnrich';
import { buildFlightPlan } from '../../flightplan/flightPlan';
import { FlightPlanMini } from '../../flightplan/FlightPlanMini';
import { PlanQuestionsForm } from '../../plans/PlanQuestionsForm';
import { MergeLadderPill } from '../../runs/MergeLadderDot';
import type { TaskDetailState } from '../detail/useTaskDetail';
import { EnrichReview } from '../EnrichReview';
import { getStackByTaskId, StackRail } from '../StackRail';
import { AttachmentsRow, useAttachmentUpload } from './AttachmentsRow';
import { DispatchCard } from './DispatchCard';
import type { TaskPageModel } from './pageModel';
import { RunStrip } from './RunStrip';
import { SubtasksBlock } from './SubtasksBlock';
import { TaskDocsBlock } from './TaskDocsBlock';
import styles from './TaskPageView.module.css';
import type { TaskPageView } from './useTaskPageModel';

// The task page's rail sections under TaskDetail's property sheet: what the old
// TaskRail held that the properties do not cover. Work (the dispatch card with its
// readiness checks and the "Add detail" pass, the latest run, the attachments), a
// container's sub-issues with their mini Flight Plan, the run's pull request, the linked
// docs and the stack. Each is a @dispatch/ui TaskDetailSection hosting Dispatch's legacy
// pieces as children until Phase 7 restyles them.

export interface TaskPageRailProps {
  page: TaskPageModel;
  state: TaskDetailState;
  view: TaskPageView;
  /** Puts the writes editor's field in view and focuses it (the card's "Add writes"). */
  onAddWrites: () => void;
}

/**
 * The "Add detail" pass for a thin spec, answered and reviewed beside the dispatch card:
 * the planner's questions, its error, then the draft to apply or discard. The draft is
 * app-level (it survives closing the page), so only this task's shows.
 */
function useEnrich(page: TaskPageModel) {
  const { project } = page;
  const taskId = page.item.meta.id;
  const [started, setStarted] = useState(false);
  const [applying, setApplying] = useState(false);
  const plan =
    project.enrichTaskId === taskId ? project.enrichPlanRecord : undefined;
  const draft = enrichDraftFromPlan(plan);
  const error = enrichPlanError(plan);
  const questions = pendingEnrichQuestions(
    taskId,
    project.enrichTaskId,
    project.enrichPlanRecord
  );
  const enriching =
    plan?.state === 'running' ||
    (started && questions === null && draft === null && error === null);
  function start() {
    setStarted(true);
    project.handleEnrichTask(taskId).catch((err: unknown) => {
      setStarted(false);
      page.fail('Could not start the draft', err);
    });
  }
  function dismiss() {
    setStarted(false);
    project.handleDismissEnrich();
  }
  async function apply() {
    if (draft === null) return;
    setApplying(true);
    try {
      await page.patch(enrichPatch(draft));
      dismiss();
    } finally {
      setApplying(false);
    }
  }
  return {
    plan,
    draft,
    error,
    questions,
    enriching,
    applying,
    start,
    dismiss,
    apply,
  };
}

export function TaskPageRail({
  page,
  state,
  view,
  onAddWrites,
}: TaskPageRailProps) {
  const { project, item } = page;
  const meta = item.meta;
  const taskId = meta.id;
  const { canEdit, archived } = state;
  const client = project.client;
  const config = project.config;
  const latestRun = page.runs[0];
  const live = page.runs.some((r) => !isTerminalRunState(r.state));
  const upload = useAttachmentUpload(client, taskId);
  const enrich = useEnrich(page);
  const tasks = project.tasksIncludingArchived;
  const hasStack = getStackByTaskId(tasks).has(taskId);

  // The mini Flight Plan over the sub-issue list: the plan's waves at a glance.
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
        project.epicProgressById.get(taskId)?.session?.concurrency ?? null,
    });
  }, [
    page.children,
    page.statusModel,
    project.runs,
    project.epicProgressById,
    taskId,
  ]);

  const attachments = meta.attachments ?? [];
  const showAttachments = attachments.length > 0 || (canEdit && !archived);
  // Run and Review draw the run's strip themselves, over the transcript or the diff.
  const showRunStrip =
    latestRun !== undefined && view !== 'run' && view !== 'review';
  const showCard = !page.isContainer && canEdit;
  const hasWork =
    enrich.questions !== null ||
    showCard ||
    enrich.error !== null ||
    enrich.draft !== null ||
    showRunStrip ||
    showAttachments;
  const prUrl = latestRun?.prUrl;
  const questions = enrich.questions;

  return (
    <>
      {hasWork && (
        <TaskDetailSection title="Work">
          <div className={styles.work}>
            {questions !== null && client !== null && (
              <PlanQuestionsForm
                questions={questions.questions}
                disabled={questions.state === 'running'}
                onSend={async (message) => {
                  await client.sendPlanMessage(questions.id, message);
                }}
              />
            )}
            {showCard && (
              <DispatchCard
                readiness={page.readiness}
                live={live}
                starting={page.dispatching}
                executors={project.executors ?? undefined}
                defaultModel={
                  config === null ? undefined : resolveExecuteModel(config)
                }
                defaultEffort={config?.effort?.execute}
                onDispatch={(executor, model, effort) =>
                  void page.dispatch(executor, model, effort)
                }
                onOpenRun={() => page.selectMode('run')}
                onOpenTask={page.openTask}
                onEnrich={enrich.start}
                enriching={enrich.enriching}
                onAddWrites={onAddWrites}
              />
            )}
            {enrich.error !== null && (
              <p className={styles.enrichError}>{enrich.error}</p>
            )}
            {enrich.draft !== null && (
              <EnrichReview
                draft={enrich.draft}
                applying={enrich.applying}
                onApply={() => void enrich.apply()}
                onDiscard={enrich.dismiss}
              />
            )}
            {showRunStrip && latestRun !== undefined && (
              <RunStrip
                run={latestRun}
                runs={page.runs}
                onSelectRun={(runId) => {
                  page.selectRun(runId);
                  page.selectMode('run');
                }}
              />
            )}
            {showAttachments && (
              <AttachmentsRow
                taskId={taskId}
                attachments={attachments}
                client={client}
                port={project.port}
                editable={canEdit && !archived}
                upload={upload.upload}
                uploading={upload.uploading}
              />
            )}
          </div>
        </TaskDetailSection>
      )}
      {page.isContainer && view !== 'plan' && (
        <TaskDetailSection title="Sub-issues" count={page.children.length}>
          <div className={styles.work}>
            {plan !== null && (
              <button
                type="button"
                className={styles.miniPlan}
                title="Open the plan"
                aria-label="Open the plan"
                onClick={() => page.selectMode('plan')}
              >
                <FlightPlanMini plan={plan} />
              </button>
            )}
            <div className={styles.legacy}>
              <SubtasksBlock
                title="Sub-issues"
                parent={item}
                tasks={page.children}
                model={page.statusModel}
                latestRunByTaskId={project.latestRunByTaskId}
                onOpenTask={page.openTask}
                createPreset={canEdit ? { epic: taskId } : undefined}
              />
            </div>
          </div>
        </TaskDetailSection>
      )}
      {prUrl !== undefined && latestRun !== undefined && (
        <TaskDetailSection title="Links">
          <div className={styles.links}>
            <Button
              href={prUrl}
              external
              variant="quiet"
              size="sm"
              iconAfter={<ArrowUpRight size={14} strokeWidth={1.8} />}
            >
              Pull request
            </Button>
            <MergeLadderPill meta={latestRun} />
          </div>
        </TaskDetailSection>
      )}
      {client !== null && page.host.openDoc !== undefined && (
        <TaskDetailSection title="Docs">
          <div className={styles.legacy}>
            <TaskDocsBlock
              client={client}
              port={project.port}
              taskId={taskId}
              canLink={canEdit}
              onOpenDoc={(id) => page.host.openDoc?.(id, null)}
            />
          </div>
        </TaskDetailSection>
      )}
      {hasStack && (
        <TaskDetailSection title="Stack">
          <div className={styles.legacy}>
            <StackRail
              tasks={tasks}
              taskId={taskId}
              latestRunByTaskId={project.latestRunByTaskId}
              onOpenTask={page.openTask}
            />
          </div>
        </TaskDetailSection>
      )}
    </>
  );
}
