import type { Finding, RunMeta, Snippet } from '@dispatch/client';
import { canPostReviewToPr } from '@dispatch/client';
import {
  ChevronDown,
  Circle,
  CircleCheck,
  FileDiff,
  GitMerge,
  GitPullRequest,
  MessageSquarePlus,
  RotateCcw,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useAdjudicateFinding,
  useFixLoop,
  useStartFixLoop,
  useStopFixLoop,
  useTaskFindings,
  useTaskVerification,
} from '../../../hooks/useOrchestration';
import {
  useRunDetail,
  useRunDiff,
  useRunReviewThreads,
} from '../../../hooks/useRunData';
import { fixLoopNeedsRuling } from '../../../lib/fixLoopStatus';
import {
  readCriteriaChecks,
  writeCriteriaChecks,
} from '../../../lib/reviewCriteria';
import {
  isTerminalRunState,
  liveReviewAgentFor,
  postFailWorkLabel,
} from '../../../lib/runState';
import { reviewedRun } from '../../../lib/taskPageMode';
import { diffStat } from '../../../lib/taskTimeline';
import { DiffEmptyState } from '../../runs/DiffEmptyState';
import { PierreReviewDiff } from '../../runs/PierreReviewDiff';
import { QueueMergeControl } from '../../runs/QueueMergeControl';
import { ReviewCasePanel } from '../../runs/ReviewCasePanel';
import type { ReviewChatHandle } from '../../runs/ReviewChatPanel';
import { ReviewChatPanel } from '../../runs/ReviewChatPanel';
import { ReviewCommentsPanel } from '../../runs/ReviewCommentsPanel';
import { RunDiffView } from '../../runs/RunDiffView';
import { FindingsPanel } from '../detail/FindingsPanel';
import { FixLoopSection } from '../detail/FixLoopSection';
import { VerificationSection } from '../detail/VerificationSection';
import { TabSkeleton } from '../TabSkeleton';
import type { TaskPageModel } from './pageModel';
import { RunStrip } from './RunStrip';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Textarea } from '@/ui/textarea';

/** The acceptance criteria as a checklist the reviewer ticks while reading the diff. The
 * ticks are theirs alone, kept per run in this browser. */
function CriteriaChecklist({
  runId,
  criteria,
  loading,
}: {
  runId: string;
  criteria: string[];
  loading: boolean;
}) {
  const [checked, setChecked] = useState(() => readCriteriaChecks(runId));
  function toggle(index: number) {
    setChecked((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      writeCriteriaChecks(runId, next);
      return next;
    });
  }
  const done = criteria.filter((_, i) => checked.has(i)).length;
  return (
    <section data-slot="criteria-checklist" className="flex flex-col gap-1.5">
      <div className="flex h-6 items-center gap-2">
        <h3 className="text-muted-foreground text-[12px] font-medium">
          Acceptance criteria
        </h3>
        {criteria.length > 0 && (
          <span
            className={cn(
              'font-book ml-auto text-[12px] tabular-nums',
              done === criteria.length
                ? 'text-state-review'
                : 'text-muted-foreground'
            )}
          >
            {done}/{criteria.length}
          </span>
        )}
      </div>
      {loading ? null : criteria.length === 0 ? (
        <p className="text-muted-foreground font-book text-[12px]">
          This task names no criteria; judge the diff on its description.
        </p>
      ) : (
        <ul className="-mx-1.5 flex flex-col">
          {criteria.map((criterion, i) => {
            const on = checked.has(i);
            return (
              <li key={i}>
                <button
                  type="button"
                  aria-pressed={on}
                  onClick={() => toggle(i)}
                  className="hover:bg-surface-hover rounded-control focus-visible:ring-ring flex w-full items-start gap-2 px-1.5 py-1 text-left outline-none focus-visible:ring-2"
                >
                  {on ? (
                    <CircleCheck className="text-state-review mt-0.5 size-3.5 shrink-0" />
                  ) : (
                    <Circle className="text-muted-foreground/60 mt-0.5 size-3.5 shrink-0" />
                  )}
                  <span
                    className={cn(
                      'font-book text-[13px] leading-5',
                      on ? 'text-muted-foreground' : 'text-(--text-secondary)'
                    )}
                  >
                    {criterion}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

// Resumes the run's own agent with the checked findings as the change request.
function fixFindingsRequest(selected: Finding[]): string {
  const lines = selected.map((f) => {
    const loc =
      f.file === null
        ? ''
        : ` (${f.file}${f.line === null ? '' : `:${f.line}`})`;
    return `- ${f.title}${loc}\n  ${f.detail}`;
  });
  return `Fix these review findings, then re-run the checks you'd normally run:\n\n${lines.join('\n')}`;
}

/** The verdict controls: Land (merge) with the queue, PR and discard behind its menu, or
 * Review PR once a PR carries the work; Request changes and Re-run beside it. None while
 * the run is live: the daemon only lands, queues or discards a finished run. */
function Verdict({
  page,
  run,
  onRequestChanges,
  onReviewPr,
  busy,
  act,
}: {
  page: TaskPageModel;
  run: RunMeta;
  onRequestChanges: () => void;
  onReviewPr: () => void;
  busy: boolean;
  act: (action: () => Promise<void>) => void;
}) {
  const { project } = page;
  if (!isTerminalRunState(run.state)) {
    return (
      <span className="text-muted-foreground font-book text-[12px]">
        Lands once it finishes
      </span>
    );
  }
  const reviewed = run.reviewedAt !== undefined;
  const live = page.runs.some((r) => !isTerminalRunState(r.state));
  if (run.prUrl !== undefined && !reviewed) {
    return (
      <>
        <QueueMergeControl
          meta={run}
          mergeQueue={project.mergeQueue}
          busy={busy}
          onQueueMerge={() => act(() => project.handleEnqueueMerge(run.id))}
        />
        <Button size="sm" variant="secondary" onClick={onReviewPr}>
          <GitPullRequest />
          Review PR
        </Button>
      </>
    );
  }
  if (reviewed) return null;
  const canOpenPr = project.health?.pr === true;
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy}
        onClick={onRequestChanges}
      >
        <MessageSquarePlus />
        Request changes
      </Button>
      <Button
        variant="ghost"
        size="sm"
        disabled={busy || live}
        title="Start a fresh run of this task"
        onClick={() => act(() => page.dispatch())}
      >
        <RotateCcw />
        Re-run
      </Button>
      <div className="flex items-center">
        <Button
          size="sm"
          disabled={busy}
          className="rounded-r-none"
          onClick={() => act(() => project.handleReview(run.id, 'merge'))}
        >
          <GitMerge />
          Land
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button
                size="sm"
                aria-label="More ways to land"
                disabled={busy}
                className="shadow-hairline-left rounded-l-none px-1.5"
              />
            }
          >
            <ChevronDown />
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-48">
            <DropdownMenuItem
              onClick={() => act(() => project.handleEnqueueMerge(run.id))}
            >
              Queue merge
            </DropdownMenuItem>
            <DropdownMenuItem
              onClick={() =>
                act(() => project.handleEnqueueMergeStack(run.taskId))
              }
            >
              Queue the stack
            </DropdownMenuItem>
            {canOpenPr && (
              <DropdownMenuItem
                onClick={() => act(() => project.handleOpenPr(run.id))}
              >
                Open a pull request
              </DropdownMenuItem>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => act(() => project.handleReview(run.id, 'discard'))}
            >
              Discard the run
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </>
  );
}

/**
 * Review mode — a finished run's work beside what done means: the run's vitals and
 * verdict (Land, Request changes, Re-run) on top; the diff with line comments on the left;
 * on the right the acceptance criteria as a checklist, the changed files, the fix loop,
 * the agent's evidence and findings, verification, and the comment batch to submit. On a
 * narrow pane the side column stacks above the diff.
 */
export function ReviewMode({ page }: { page: TaskPageModel }) {
  const { project, item } = page;
  const run = reviewedRun(page.selectedRun, page.runs);
  const runId = run?.id ?? null;
  const live = run !== undefined && !isTerminalRunState(run.state);
  const detail = useRunDetail(project.client, project.port, runId);
  // The run's PR, reviewed in place of the diff when the host can show it.
  const [prOpen, setPrOpen] = useState(false);
  const {
    diff,
    loading: diffLoading,
    error: diffError,
  } = useRunDiff(project.client, project.port, runId, live);
  const threads = useRunReviewThreads(project.client, project.port, runId);
  const { findings } = useTaskFindings(
    project.client,
    project.port,
    item.meta.id
  );
  const { fixLoop } = useFixLoop(project.client, project.port, item.meta.id);
  const { result: verification, error: verificationError } =
    useTaskVerification(project.client, project.port, item.meta.id);
  const startFixLoop = useStartFixLoop(project.client, project.port);
  const stopFixLoop = useStopFixLoop(project.client, project.port);
  const adjudicate = useAdjudicateFinding(project.client, project.port);
  const [startingFix, setStartingFix] = useState(false);
  const [fixError, setFixError] = useState<string | null>(null);
  const [changing, setChanging] = useState(false);
  const [changesDraft, setChangesDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [scrollTo, setScrollTo] = useState<{
    file: string;
    nonce: number;
  } | null>(null);
  const stat = useMemo(
    () => (diff === undefined ? null : diffStat(diff.patch, diff.files.length)),
    [diff]
  );
  // The chat dock owns its pending attachments; the diff only hands selections over.
  const chatRef = useRef<ReviewChatHandle>(null);
  const changesRef = useRef<HTMLTextAreaElement>(null);
  // Opening the change request puts the caret in it.
  useEffect(() => {
    if (changing) changesRef.current?.focus();
  }, [changing]);
  const addToChat = useCallback((snippet: Snippet) => {
    chatRef.current?.attach(snippet);
  }, []);

  if (run === undefined) {
    return (
      <EmptyState
        icon={FileDiff}
        heading="Nothing to review yet"
        description="A run's diff lands here once an agent has worked the task."
        className="h-full justify-center"
        primary={{ label: 'Open spec', onClick: () => page.selectMode('spec') }}
      />
    );
  }

  const meta = detail?.meta.id === run.id ? detail.meta : run;
  function act(action: () => Promise<void>) {
    setBusy(true);
    action()
      .catch((err: unknown) => page.fail('That did not go through', err))
      .finally(() => setBusy(false));
  }
  async function sendChanges() {
    const text = changesDraft.trim();
    if (text === '' || run === undefined) return;
    setBusy(true);
    try {
      await project.handleRequestChanges(run.id, text);
      setChangesDraft('');
      setChanging(false);
    } finally {
      setBusy(false);
    }
  }
  async function startFix() {
    setStartingFix(true);
    setFixError(null);
    try {
      await startFixLoop(item.meta.id);
    } catch (err) {
      setFixError(
        err instanceof Error ? err.message : 'Could not start the fix loop.'
      );
    } finally {
      setStartingFix(false);
    }
  }
  const orphanWork = postFailWorkLabel(meta);
  const reviewAgentLive = liveReviewAgentFor(project.runs, meta.branch);

  const side = (
    <div className="flex flex-col gap-5">
      <CriteriaChecklist
        key={run.id}
        runId={run.id}
        criteria={page.criteria}
        loading={!page.bodyLoaded}
      />
      {diff !== undefined && diff.files.length > 0 && (
        <section className="flex flex-col gap-1">
          <h3 className="text-muted-foreground flex h-6 items-center text-[12px] font-medium">
            Changed files
          </h3>
          <ul className="-mx-1.5 flex flex-col">
            {diff.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() =>
                    setScrollTo({ file: f.path, nonce: Date.now() })
                  }
                  className="hover:bg-surface-hover rounded-control focus-visible:ring-ring flex h-6 w-full items-center gap-1.5 px-1.5 text-left outline-none focus-visible:ring-2"
                  title={f.path}
                >
                  <span className="text-muted-foreground w-3 shrink-0 font-mono text-[11px] uppercase">
                    {f.status.slice(0, 1)}
                  </span>
                  <span className="truncate font-mono text-[12px] text-(--text-secondary)">
                    {f.path}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      <FixLoopSection
        fixLoop={fixLoop}
        escalation={project.config?.fixLoop.escalation ?? []}
        onStart={() => void startFix()}
        onStop={() => void stopFixLoop(item.meta.id)}
        starting={startingFix}
        startError={fixError}
      />
      <FindingsPanel
        findings={findings}
        needsRuling={fixLoopNeedsRuling(fixLoop)}
        onAdjudicate={async (findingId, input) => {
          await adjudicate(item.meta.id, findingId, input);
        }}
      />
      <VerificationSection
        exercised={item.meta.exercised}
        result={verification}
        error={verificationError}
      />
      {detail !== undefined && detail.meta.id === run.id && (
        <ReviewCasePanel
          evidence={detail.evidence}
          mutations={detail.mutations}
          findings={findings}
          decisions={[]}
          onStartAiReview={
            project.client === null
              ? undefined
              : async () => {
                  await project.client?.startReview(meta.taskId, {
                    base: meta.baseBranch,
                    head: meta.branch,
                    runId: meta.id,
                  });
                }
          }
          reviewAgentLive={reviewAgentLive !== undefined}
          onFixFindings={
            isTerminalRunState(meta.state) && meta.reviewedAt === undefined
              ? (selected) =>
                  project.handleRequestChanges(
                    meta.id,
                    fixFindingsRequest(selected)
                  )
              : undefined
          }
          client={project.client}
          runId={meta.id}
          onOpenImpact={page.host.openImpact}
        />
      )}
      {threads.comments.length > 0 && (
        <ReviewCommentsPanel
          comments={threads.comments}
          onResolve={threads.resolve}
          onReply={threads.reply}
          onSubmit={threads.submit}
          canPostToGitHub={canPostReviewToPr(meta.prUrl)}
        />
      )}
    </div>
  );

  let diffPane;
  if (live) {
    diffPane = (
      <RunDiffView
        diff={diff}
        diffLoading={diffLoading}
        diffError={diffError}
      />
    );
  } else if (diffError !== null) {
    diffPane = <DiffEmptyState message="This run has no changes to review." />;
  } else if (diff === undefined) {
    diffPane = <TabSkeleton />;
  } else {
    diffPane = (
      <PierreReviewDiff
        client={project.client}
        runId={meta.id}
        meta={meta}
        patch={diff.patch}
        comments={threads.comments}
        onAdd={threads.add}
        onResolve={threads.resolve}
        onReply={threads.reply}
        onApply={threads.apply}
        findings={findings}
        scrollTo={scrollTo}
        onAddToChat={project.client === null ? undefined : addToChat}
      />
    );
  }

  return (
    <div
      data-slot="review-mode"
      className="@container/review flex h-full min-h-0 flex-col gap-2"
    >
      <div className="flex shrink-0 flex-col gap-2">
        <RunStrip
          run={meta}
          runs={page.runs}
          onSelectRun={page.selectRun}
          detail={
            stat !== null && (
              <span className="font-book text-muted-foreground text-[12px] tabular-nums">
                <span className="text-state-review">+{stat.additions}</span>{' '}
                <span className="text-state-failed">−{stat.deletions}</span> in{' '}
                {stat.files} file{stat.files === 1 ? '' : 's'}
                {live && ' so far'}
              </span>
            )
          }
          actions={
            <Verdict
              page={page}
              run={meta}
              busy={busy}
              act={act}
              onRequestChanges={() => setChanging(true)}
              onReviewPr={() => {
                if (page.host.prView === undefined) page.host.openPr(meta.id);
                else setPrOpen(true);
              }}
            />
          }
        />
        {orphanWork !== null && (
          <p className="bg-state-review-surface text-state-review rounded-card font-book px-3 py-2 text-[12px]">
            {orphanWork}
          </p>
        )}
        {changing && (
          <div className="flex flex-col gap-2">
            <Textarea
              rows={3}
              ref={changesRef}
              aria-label="What should change"
              placeholder="What should change? The agent resumes on its branch with this."
              value={changesDraft}
              onChange={(e) => setChangesDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  void sendChanges();
                }
              }}
            />
            <div className="flex justify-end gap-2">
              <Button
                variant="ghost"
                size="sm"
                disabled={busy}
                onClick={() => setChanging(false)}
              >
                Cancel
              </Button>
              <Button
                size="sm"
                disabled={busy || changesDraft.trim() === ''}
                onClick={() => void sendChanges()}
              >
                Send to the agent
              </Button>
            </div>
          </div>
        )}
      </div>
      {prOpen && page.host.prView !== undefined ? (
        <div className="min-h-0 flex-1 overflow-hidden">
          {page.host.prView(meta.id, () => setPrOpen(false))}
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-col gap-4 @min-[760px]/review:flex-row">
          <div className="order-2 flex min-h-0 min-w-0 flex-1 flex-col gap-2 @min-[760px]/review:order-1">
            <div className="min-h-0 flex-1 overflow-auto">{diffPane}</div>
            {project.client !== null && (
              <ReviewChatPanel
                client={project.client}
                ref={chatRef}
                runId={meta.id}
                canResumeAgent={
                  isTerminalRunState(meta.state) &&
                  meta.reviewedAt === undefined
                }
              />
            )}
          </div>
          <aside
            aria-label="Review checklist"
            className="order-1 max-h-[40%] shrink-0 overflow-y-auto @min-[760px]/review:order-2 @min-[760px]/review:max-h-none @min-[760px]/review:w-[300px]"
          >
            {side}
          </aside>
        </div>
      )}
    </div>
  );
}
