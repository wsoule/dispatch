import { isDoneStatus } from '@dispatch/core/browser';
import { Waypoints } from 'lucide-react';
import { useRef, useState } from 'react';

import { filesFromDataTransfer } from '../../../lib/attachments';
import { resolveExecuteModel } from '../../../lib/models';
import { isTerminalRunState } from '../../../lib/runState';
import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
} from '../../../lib/taskEnrich';
import { PlanQuestionsForm } from '../../plans/PlanQuestionsForm';
import { EnrichReview } from '../EnrichReview';
import { SpecSection, TaskSpecView } from '../TaskSpecView';
import { AttachmentsRow, useAttachmentUpload } from './AttachmentsRow';
import { DispatchCard } from './DispatchCard';
import type { TaskPageModel } from './pageModel';
import { RelationsEditor } from './RelationsEditor';
import { SubtasksBlock } from './SubtasksBlock';
import { TaskDocsBlock } from './TaskDocsBlock';
import { Button } from '@/ui/button';

/** A container's call to action: it goes out as waves of its sub-issues from its plan,
 * never as one run of its own. */
function FanoutCard({ page }: { page: TaskPageModel }) {
  const total = page.children.length;
  const done = page.children.filter((c) =>
    isDoneStatus(c.meta.status, page.statusModel)
  ).length;
  return (
    <section
      data-slot="fanout-card"
      aria-label="Fan out"
      className="rounded-card border-border-strong bg-surface-quaternary mx-4 flex flex-wrap items-center gap-x-3 gap-y-1 border-[0.5px] px-3.5 py-3"
    >
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="text-foreground text-[13px] font-semibold">
          {total === 0
            ? 'No sub-issues yet'
            : `${done} of ${total} sub-issues done`}
        </p>
        <p className="font-book text-[12px] text-(--text-secondary)">
          Agents take its sub-issues in waves from the plan, each as its
          blockers land.
        </p>
      </div>
      <Button size="sm" onClick={() => page.selectMode('plan')}>
        <Waypoints />
        Open plan
      </Button>
    </section>
  );
}

/**
 * Spec mode — what a task is and whether it can go: the dispatch card with its readiness
 * checks up top (a container's points at its plan instead), then the spec itself
 * (TaskSpecView, editable in place), its dependencies, attachments, linked docs and
 * amendments, and a container's sub-issues. The AI "Add detail" pass for a thin spec reviews its draft here
 * before anything is written.
 */
export function SpecMode({ page }: { page: TaskPageModel }) {
  const { item, project } = page;
  const meta = item.meta;
  const writesRef = useRef<HTMLDivElement>(null);
  const upload = useAttachmentUpload(project.client, meta.id);
  const [enrichStarted, setEnrichStarted] = useState(false);
  const [applyingEnrich, setApplyingEnrich] = useState(false);

  const live = page.runs.some((r) => !isTerminalRunState(r.state));

  // The enrich draft is app-level (it survives closing the page), so only this task's.
  const enrichPlan =
    project.enrichTaskId === meta.id ? project.enrichPlanRecord : undefined;
  const enrichDraft = enrichDraftFromPlan(enrichPlan);
  const enrichError = enrichPlanError(enrichPlan);
  const awaitingAnswer = (enrichPlan?.questions.length ?? 0) > 0;
  const enriching =
    enrichPlan?.state === 'running' ||
    (enrichStarted &&
      !awaitingAnswer &&
      enrichDraft === null &&
      enrichError === null);

  function enrich() {
    setEnrichStarted(true);
    project.handleEnrichTask(meta.id).catch((err: unknown) => {
      setEnrichStarted(false);
      page.fail('Could not start the draft', err);
    });
  }
  function dismissEnrich() {
    setEnrichStarted(false);
    project.handleDismissEnrich();
  }
  async function applyEnrich() {
    if (enrichDraft === null) return;
    setApplyingEnrich(true);
    try {
      await page.patch(enrichPatch(enrichDraft));
      dismissEnrich();
    } finally {
      setApplyingEnrich(false);
    }
  }

  const archived = meta.archivedAt !== undefined;
  const client = project.client;
  const config = project.config;
  const { openDoc } = page.host;

  // Files dropped or pasted anywhere on the spec attach to the task; a text paste is left
  // to whatever field has focus.
  const attachable = !archived && client !== null;
  function attach(dt: DataTransfer | null): boolean {
    if (!attachable) return false;
    const files = filesFromDataTransfer(dt);
    if (files.length === 0) return false;
    void upload.upload(files);
    return true;
  }

  return (
    <div
      data-slot="spec-mode"
      className="flex flex-col gap-4 pb-10"
      onDragOver={(e) => {
        if (attachable) e.preventDefault();
      }}
      onDrop={(e) => {
        if (attach(e.dataTransfer)) e.preventDefault();
      }}
      onPaste={(e) => {
        if (attach(e.clipboardData)) e.preventDefault();
      }}
    >
      {page.isContainer ? (
        <FanoutCard page={page} />
      ) : (
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
          onEnrich={enrich}
          enriching={enriching}
          onAddWrites={() => {
            const input = writesRef.current?.querySelector<HTMLInputElement>(
              'input[aria-label="Add a write path"]'
            );
            input?.scrollIntoView({ block: 'center', behavior: 'smooth' });
            input?.focus();
          }}
        />
      )}
      {enrichError !== null && (
        <p className="text-red font-book px-4 text-[12px]">{enrichError}</p>
      )}
      {enrichPlan !== undefined && awaitingAnswer && client !== null && (
        <div className="px-4">
          <PlanQuestionsForm
            questions={enrichPlan.questions}
            disabled={enrichPlan.state === 'running'}
            onSend={async (message) => {
              await client.sendPlanMessage(enrichPlan.id, message);
            }}
          />
        </div>
      )}
      {enrichDraft !== null && (
        <div className="px-4">
          <EnrichReview
            draft={enrichDraft}
            applying={applyingEnrich}
            onApply={() => void applyEnrich()}
            onDiscard={dismissEnrich}
          />
        </div>
      )}

      <div ref={writesRef}>
        <TaskSpecView
          header={null}
          spec={{
            title: meta.title,
            status: meta.status,
            priority: meta.priority,
            description: page.description,
            acceptanceCriteria: page.criteria,
            writes: meta.writes,
            risk: meta.risk,
            blockedBy: [],
          }}
          editing={{
            loading: !page.bodyLoaded,
            description: page.description,
            acceptance: page.acceptance,
            onSaveDescription: (description) =>
              void page.patch({ description }),
            onSaveAcceptance: (acceptanceCriteria) =>
              void page.patch({ acceptanceCriteria }),
            onSaveWrites: (writes) => void page.patch({ writes }),
          }}
          dependencies={
            <SpecSection label="Dependencies">
              <RelationsEditor
                item={item}
                tasks={project.tasksIncludingArchived}
                tasksById={page.tasksById}
                model={page.statusModel}
                onPatch={(patch) => void page.patch(patch)}
                onOpenTask={page.openTask}
              />
            </SpecSection>
          }
        >
          <SpecSection label="Attachments">
            <AttachmentsRow
              taskId={meta.id}
              attachments={meta.attachments ?? []}
              client={client}
              port={project.port}
              editable={!archived}
              upload={upload.upload}
              uploading={upload.uploading}
            />
          </SpecSection>
          {client !== null && openDoc !== undefined && (
            <div className="shadow-hairline-top px-4 py-1.5">
              <TaskDocsBlock
                client={client}
                port={project.port}
                taskId={meta.id}
                canLink
                onOpenDoc={(id) => openDoc(id, null)}
              />
            </div>
          )}
          {page.amendments !== '' && (
            <SpecSection label="Amendments">
              <p className="text-muted-foreground font-book text-[13px] whitespace-pre-wrap">
                {page.amendments}
              </p>
            </SpecSection>
          )}
        </TaskSpecView>
      </div>
      {page.isContainer && (
        <div className="px-4">
          <SubtasksBlock
            title="Sub-issues"
            parent={item}
            tasks={page.children}
            latestRunByTaskId={project.latestRunByTaskId}
            onOpenTask={page.openTask}
            createPreset={{ epic: meta.id }}
            model={page.statusModel}
          />
        </div>
      )}
    </div>
  );
}
