import {
  isCanceledStatus,
  isCompletedStatus,
} from '@dispatch-foo/core/browser';
import type { Finding, RunMeta, Snippet } from '@dispatch/client';
import { canPostReviewToPr } from '@dispatch/client';
import {
  Button,
  Checklist,
  cx,
  EmptyState,
  Menu,
  type MenuEntry,
  Notice,
  SkeletonRows,
} from '@dispatch/ui';
import {
  ChevronDown,
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
import { landButtonLabel, mergeLadderState } from '../../../lib/mergeLadder';
import {
  readCriteriaChecks,
  writeCriteriaChecks,
} from '../../../lib/reviewCriteria';
import {
  isTerminalRunState,
  liveReviewAgentFor,
  postFailWorkLabel,
} from '../../../lib/runState';
import { taskOutcome } from '../../../lib/taskOutcome';
import { reviewedRun } from '../../../lib/taskPageMode';
import { diffStat } from '../../../lib/taskTimeline';
import { DiffEmptyState } from '../../runs/DiffEmptyState';
import { LandedAs } from '../../runs/LandedAs';
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
import { OutcomeCard } from './OutcomeCard';
import type { TaskPageModel } from './pageModel';
import styles from './ReviewMode.module.css';
import { RunStrip } from './RunStrip';

// The verdict and request-changes buttons' 14px lucide glyphs.
const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

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
  // Ticking or clearing criterion `id` (its index, as Checklist hands it back), stored per
  // run in this browser at once.
  function toggle(id: string, met: boolean) {
    const index = Number(id);
    setChecked((prev) => {
      const next = new Set(prev);
      if (met) next.add(index);
      else next.delete(index);
      writeCriteriaChecks(runId, next);
      return next;
    });
  }
  const done = criteria.filter((_, i) => checked.has(i)).length;
  return (
    <section data-slot="criteria-checklist" className={styles.section}>
      <div className={styles.sectionHead}>
        <h3 className={styles.heading}>Acceptance criteria</h3>
        {criteria.length > 0 && (
          <span className={cx(styles.count, 'num')}>
            {done}/{criteria.length}
          </span>
        )}
      </div>
      {loading ? null : criteria.length === 0 ? (
        <p className={styles.quiet}>
          This task names no criteria; judge the diff on its description.
        </p>
      ) : (
        <Checklist
          label="Acceptance criteria"
          items={criteria.map((criterion, i) => ({
            id: String(i),
            label: criterion,
            met: checked.has(i),
          }))}
          onToggle={toggle}
        />
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
    return <span className={styles.quiet}>Lands once it finishes</span>;
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
        <Button
          size="sm"
          variant="secondary"
          icon={<GitPullRequest {...ICON} />}
          onClick={onReviewPr}
        >
          Review PR
        </Button>
      </>
    );
  }
  // A reviewed run says where its work went. A merge that never reached origin
  // carries its retry here, so the page that offered Land also owns the fix.
  if (reviewed) {
    return mergeLadderState(run) === 'unmerged' ? null : (
      <span className={styles.landed}>
        <LandedAs
          run={run}
          originWebUrl={project.health?.originWebUrl}
          onPublish={project.handlePublishRun}
        />
      </span>
    );
  }
  const canOpenPr = project.health?.pr === true;
  // A failed run's work is rarely what should land, so Re-run leads and
  // landing waits in the menu as "Land anyway".
  const failed = run.state === 'failed' || run.state === 'interrupted-dirty';
  // The ways to land besides a plain merge, and the discard, behind the split button's
  // chevron.
  const moreWays: MenuEntry[] = [
    {
      id: 'queue',
      label: 'Queue merge',
      onSelect: () => act(() => project.handleEnqueueMerge(run.id)),
    },
    {
      id: 'queue-stack',
      label: 'Queue the stack',
      onSelect: () => act(() => project.handleEnqueueMergeStack(run.taskId)),
    },
    ...(canOpenPr
      ? [
          {
            id: 'open-pr',
            label: 'Open a pull request',
            onSelect: () => act(() => project.handleOpenPr(run.id)),
          },
        ]
      : []),
    { kind: 'separator' },
    {
      id: 'discard',
      label: 'Discard the run',
      destructive: true,
      onSelect: () => act(() => project.handleReview(run.id, 'discard')),
    },
  ];
  const landVariant = failed ? 'secondary' : 'primary';
  return (
    <>
      <Button
        variant="quiet"
        size="sm"
        disabled={busy}
        icon={<MessageSquarePlus {...ICON} />}
        onClick={onRequestChanges}
      >
        Request changes
      </Button>
      <Button
        variant={failed ? 'primary' : 'quiet'}
        size="sm"
        disabled={busy || live}
        title="Start a fresh run of this task"
        icon={<RotateCcw {...ICON} />}
        onClick={() => act(() => page.dispatch())}
      >
        Re-run
      </Button>
      <div className={styles.split}>
        <Button
          size="sm"
          variant={landVariant}
          disabled={busy}
          className={styles.splitMain}
          icon={<GitMerge {...ICON} />}
          onClick={() => act(() => project.handleReview(run.id, 'merge'))}
        >
          {failed ? 'Land anyway' : landButtonLabel(run)}
        </Button>
        <Menu
          label="More ways to land"
          items={moreWays}
          align="end"
          trigger={(props) => (
            <Button
              {...props}
              size="sm"
              variant={landVariant}
              disabled={busy}
              aria-label="More ways to land"
              className={styles.splitMore}
              icon={<ChevronDown {...ICON} />}
            />
          )}
        />
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
      <div className={styles.fill}>
        <EmptyState
          icon={<FileDiff size={22} strokeWidth={1.8} />}
          label="Nothing to review yet"
          action={
            <Button size="sm" onClick={() => page.selectMode('spec')}>
              Open spec
            </Button>
          }
        >
          A run&apos;s diff lands here once an agent has worked the task.
        </EmptyState>
      </div>
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
  // How the task ended, when it has: settled work (landed, merged, dropped)
  // drops the tools for reviewing work still in flight.
  const ending = taskOutcome({
    completed: isCompletedStatus(item.meta.status, page.statusModel),
    canceled: isCanceledStatus(item.meta.status, page.statusModel),
    runs: page.runs,
  });
  const settled =
    meta.reviewedAt !== undefined ||
    ending?.kind === 'landed' ||
    ending?.kind === 'merged-local' ||
    ending?.kind === 'dropped';
  const showCard =
    ending !== null && ending.kind !== 'ready' && ending.kind !== 'pr-open';
  const reviewAgentLive = liveReviewAgentFor(project.runs, meta.branch);

  const side = (
    <div className={styles.side}>
      <CriteriaChecklist
        key={run.id}
        runId={run.id}
        criteria={page.criteria}
        loading={!page.bodyLoaded}
      />
      {diff !== undefined && diff.files.length > 0 && (
        <section className={styles.section}>
          <h3 className={styles.heading}>Changed files</h3>
          <ul className={styles.files}>
            {diff.files.map((f) => (
              <li key={f.path}>
                <button
                  type="button"
                  onClick={() =>
                    setScrollTo({ file: f.path, nonce: Date.now() })
                  }
                  className={styles.file}
                  title={f.path}
                >
                  <span className={cx(styles.fileStatus, 'mono')}>
                    {f.status.slice(0, 1).toUpperCase()}
                  </span>
                  <span className={cx(styles.filePath, 'mono')}>{f.path}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}
      {!settled && (
        <FixLoopSection
          fixLoop={fixLoop}
          escalation={project.config?.fixLoop.escalation ?? []}
          onStart={() => void startFix()}
          onStop={() => void stopFixLoop(item.meta.id)}
          starting={startingFix}
          startError={fixError}
        />
      )}
      <FindingsPanel
        findings={findings}
        needsRuling={fixLoopNeedsRuling(fixLoop)}
        onAdjudicate={async (findingId, input) => {
          await adjudicate(item.meta.id, findingId, input);
        }}
      />
      {!settled && (
        <VerificationSection
          exercised={item.meta.exercised}
          result={verification}
          error={verificationError}
        />
      )}
      {/* Settled work keeps the case only when there is evidence or a finding
          to read; an empty one just reads as a warning about finished work. */}
      {detail !== undefined &&
        detail.meta.id === run.id &&
        (!settled || detail.evidence.length > 0 || findings.length > 0) && (
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
    diffPane = (
      <DiffEmptyState
        message={
          settled
            ? "This work has landed, and its diff wasn't kept."
            : 'This run has no changes to review.'
        }
      />
    );
  } else if (diff === undefined) {
    diffPane = <SkeletonRows rows={3} label="Loading the diff" />;
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
    <div data-slot="review-mode" className={styles.root}>
      <div className={styles.head}>
        {showCard && (
          <OutcomeCard
            outcome={ending}
            page={page}
            place="review"
            updatedAt={item.meta.updated}
          />
        )}
        <RunStrip
          run={meta}
          runs={page.runs}
          onSelectRun={page.selectRun}
          detail={
            stat !== null && (
              <span className={cx(styles.stat, 'num')}>
                <span className="toneText" data-tone="success">
                  +{stat.additions}
                </span>{' '}
                <span className="toneText" data-tone="danger">
                  −{stat.deletions}
                </span>{' '}
                in {stat.files} file{stat.files === 1 ? '' : 's'}
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
        {orphanWork !== null && <Notice tone="warning">{orphanWork}</Notice>}
        {changing && (
          <div className={styles.changes}>
            <textarea
              rows={3}
              ref={changesRef}
              className="textarea"
              aria-label="What should change"
              placeholder="What should change? The agent resumes on its branch with this."
              value={changesDraft}
              onChange={(e) => setChangesDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.defaultPrevented) return;
                if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
                  e.preventDefault();
                  e.stopPropagation();
                  void sendChanges();
                }
              }}
            />
            <div className={styles.changeActions}>
              <Button
                variant="quiet"
                size="sm"
                disabled={busy}
                onClick={() => setChanging(false)}
              >
                Cancel
              </Button>
              <Button
                variant="primary"
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
        <div className={styles.pr}>
          {page.host.prView(meta.id, () => setPrOpen(false))}
        </div>
      ) : (
        <div className={styles.body}>
          <div className={styles.main}>
            <div className={styles.diff}>{diffPane}</div>
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
          <aside aria-label="Review checklist" className={styles.aside}>
            {side}
          </aside>
        </div>
      )}
    </div>
  );
}
