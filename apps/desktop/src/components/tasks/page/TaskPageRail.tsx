import { Button, InitialsAvatar, TaskDetailSection } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { ArrowUpRight } from 'lucide-react';
import { useMemo, useState } from 'react';

import { threadListsKey } from '../../../hooks/useThreads';
import { formatRelativeTimeFromIso } from '../../../lib/format';
import { resolveExecuteModel } from '../../../lib/models';
import {
  isTerminalRunState,
  tasksWithFinishedRun,
} from '../../../lib/runState';
import { partySummary, taskAgentParties } from '../../../lib/taskAgents';
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
// docs and the stack. Each is a @dispatch/ui TaskDetailSection hosting Dispatch's own
// blocks (built on @dispatch/ui) as children.

export interface TaskPageRailProps {
  page: TaskPageModel;
  state: TaskDetailState;
  view: TaskPageView;
  /** Puts the writes editor's field in view and focuses it (the card's "Add writes"). */
  onAddWrites: () => void;
}

/**
 * The outside (A2A) agents this task has traded messages with, one row each: who they
 * are, whether a question waits on you or on them, and when they last spoke. Reads the
 * task's conversation, as the task's home does; hidden when no outside agent is involved.
 */
function OutsideAgentsSection({ page }: { page: TaskPageModel }) {
  const { client, port, messageAccess } = page.project;
  const query = { about: `task:${page.item.meta.id}` };
  const conversation = useQuery({
    queryKey: [...threadListsKey(port), 'conversation', query],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getConversation({ ...query, limit: 200 });
    },
    enabled: client !== null && messageAccess.canMessage,
    retry: false,
  });
  const parties = useMemo(
    () => taskAgentParties(conversation.data?.messages ?? []),
    [conversation.data]
  );
  if (parties.length === 0) return null;
  return (
    <TaskDetailSection title="Outside agents" count={parties.length}>
      <ul data-slot="outside-agents" className={styles.agents}>
        {parties.map((party) => (
          <li
            key={party.address}
            title={party.address}
            className={styles.agent}
          >
            <InitialsAvatar name={party.label} />
            <span className={styles.agentText}>
              <span className={styles.agentName}>{party.label}</span>
              <span
                data-slot="outside-agent-summary"
                data-waiting={party.waitingOnYou > 0 ? 'true' : undefined}
                className={styles.agentSummary}
              >
                {partySummary(party)}
              </span>
            </span>
            <span className={styles.agentWhen}>
              {formatRelativeTimeFromIso(party.lastAt)}
            </span>
          </li>
        ))}
      </ul>
    </TaskDetailSection>
  );
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
        project.milestoneProgressById.get(taskId)?.session?.concurrency ?? null,
      withFinishedRun: tasksWithFinishedRun(project.runs),
    });
  }, [
    page.children,
    page.statusModel,
    project.runs,
    project.milestoneProgressById,
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
      <OutsideAgentsSection page={page} />
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
      {/* Its own section: the block's fold button is the section's one heading,
          carrying the title and the done/total progress, so neither is said twice. */}
      {page.isContainer && view !== 'plan' && (
        <SubtasksBlock
          section
          title="Sub-issues"
          lead={
            plan !== null && (
              <button
                type="button"
                className={styles.miniPlan}
                title="Open the plan"
                aria-label="Open the plan"
                onClick={() => page.selectMode('plan')}
              >
                <FlightPlanMini plan={plan} />
              </button>
            )
          }
          parent={item}
          tasks={page.children}
          model={page.statusModel}
          latestRunByTaskId={project.latestRunByTaskId}
          onOpenTask={page.openTask}
          createPreset={canEdit ? { milestone: taskId } : undefined}
        />
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
        // TaskDocsBlock is its own "Docs" TaskDetailSection (its New spec and Link doc
        // actions sit in the heading row), so the rail places it without a wrapper.
        <TaskDocsBlock
          client={client}
          port={project.port}
          taskId={taskId}
          canLink={canEdit}
          onOpenDoc={(id) => page.host.openDoc?.(id, null)}
        />
      )}
      {hasStack && (
        <TaskDetailSection title="Stack">
          <div className={styles.block}>
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
