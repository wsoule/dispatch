import type {
  ApiClient,
  LinearIssueLink,
  LinearSyncSummary,
  PlanRecord,
  RunMeta,
} from '@dispatch/client';
import type {
  EscalationStep,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core/browser';
import { parseExternal } from '@dispatch/core/browser';
import { computeStack } from '@dispatch/core/graph';
import {
  ArrowUpRight,
  Ban,
  Check,
  ChevronDown,
  Layers,
  Link2,
  Sparkles,
  Tag,
  Waypoints,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  useAdjudicateFinding,
  useEpicLedger,
  useFixLoop,
  useProjectLedger,
  useStartFixLoop,
  useTaskFindings,
  useTaskVerification,
} from '../../../hooks/useOrchestration';
import { isFakeExecutorDevToolEnabled } from '../../../lib/devTools';
import { fixLoopNeedsRuling } from '../../../lib/fixLoopStatus';
import { formatRelativeTimeFromIso } from '../../../lib/format';
import { taskLedgerEntries } from '../../../lib/ledgerScope';
import {
  pushToLinearError,
  resolveLinearLink,
} from '../../../lib/linearSettings';
import { mergeLadderLabel, mergeLadderState } from '../../../lib/mergeLadder';
import { modelLabel, MODELS, readDefaultModel } from '../../../lib/models';
import { isTerminalRunState } from '../../../lib/runState';
import { parseTaskSections } from '../../../lib/taskDisplay';
import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
} from '../../../lib/taskEnrich';
import { ImpactPanel } from '../../impact/ImpactPanel';
import { PlanQuestionsForm } from '../../plans/PlanQuestionsForm';
import { MergeLadderDot } from '../../runs/MergeLadderDot';
import { RunStatePill } from '../../runs/RunStatePill';
import { EnrichReview } from '../EnrichReview';
import { EpicDagModal } from '../EpicDagModal';
import {
  AssigneeControl,
  EpicControl,
  PriorityControl,
  StatusControl,
} from '../PropertyControls';
import { StackRail } from '../StackRail';
import { StatusIcon } from '../StatusIcon';
import { BlockedByEditor } from './BlockedByEditor';
import { EditableBodySection } from './EditableBodySection';
import { FindingsPanel } from './FindingsPanel';
import { FixLoopSection } from './FixLoopSection';
import { LabelEditor } from './LabelEditor';
import { LedgerSection } from './LedgerSection';
import { MainSection } from './MainSection';
import { MilestoneRow } from './MilestoneRow';
import { RailSection } from './RailSection';
import { SelfReviewRow } from './SelfReviewRow';
import { VerificationSection } from './VerificationSection';
import { Alert, AlertDescription } from '@/ui/alert';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';
import { Input } from '@/ui/input';

export interface TaskDetailPanelProps {
  doc: TaskDoc;
  /** The model a dispatch runs on when the picker is untouched — the project
   * config's `models.execute` resolved with the per-device override (see
   * resolveExecuteModel). Absent, the picker falls back to the device default,
   * which ignores the project config. */
  defaultModel?: string;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  /** Every run (agent session) this task has had — newest first — so the detail panel can
   * list them and let you jump into any session's log/review, not just the latest one. */
  runs: RunMeta[];
  /** All epics in the project, for the editable Epic (parent) picker. */
  epics: TaskDoc[];
  /** All tasks in the project, for the editable Blocked-by picker (self is filtered out) and
   * for `StackRail` to derive this task's stack. */
  tasks: TaskDoc[];
  /** Every task's latest run, for `StackRail`'s per-row run/PR chip. */
  latestRunByTaskId: Map<string, RunMeta>;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  /** Optimistic status change (see `useDispatchProject.moveTaskStatus`) — the same one the
   * board's drag-and-drop uses, so moving a task's status from this panel's select feels as
   * immediate as dragging its card, rather than waiting on a round-trip like every other field
   * here (`onUpdate`) does. */
  onMoveStatus: (id: string, status: string) => Promise<void>;
  onDispatch: (
    id: string,
    executor?: 'fake' | 'claude',
    model?: string
  ) => Promise<void>;
  /** Jumps to a run's session/log — the "View run"/"Review run" button and every Sessions row
   * call this with the run's id. */
  onOpenSession: (runId: string) => void;
  /** Starts an AI draft that adds the context an under-specified task is missing. Optional so
   * the older call sites that never had it keep compiling with the button hidden. */
  onEnrich?: (id: string) => Promise<void>;
  /** The plan carrying that draft, passed only while it belongs to *this* task. The caller
   * owns the slot, so a draft survives the panel being closed and reopened. */
  enrichPlan?: PlanRecord;
  /** Drops the draft without applying it (Discard, and the cleanup after Apply). */
  onDismissEnrich?: () => void;
  /** Answers the enrich planner's clarifying questions on the same plan. Optional, like the
   * other enrich props, so older call sites keep compiling. */
  onAnswerEnrich?: (message: string) => Promise<void>;
  /** Re-points this panel at a different task — e.g. clicking another task in `StackRail`.
   * Omitted (the palette/board's older call sites) hides the rail's title links, rendering
   * them as plain text instead. */
  onOpenTask?: (taskId: string) => void;
  /** Issue UUID -> display identifier/URL, for turning `doc.meta.external` into a real chip. */
  linearLinks: Record<string, LinearIssueLink>;
  /** Whether Linear is connected with a team chosen — gates the "Push to Linear" action. */
  linearConfigured: boolean;
  /** Pushes this task to Linear now (creating the issue if unlinked). Optional so a caller
   * without Linear plumbing gets no push affordance. */
  onPushToLinear?: (id: string) => Promise<LinearSyncSummary>;
  /** The dispatchd client — this panel fetches its own findings/fix-loop/
   * verification/ledger data rather than going through the app-level hook. */
  client: ApiClient | null;
  /** The active project's daemon port, for namespacing this panel's own
   * query keys — see useOrchestration.ts. */
  port: number | undefined;
  /** The project's escalation ladder, for the "fresh implementer" hint. */
  fixLoopEscalation: EscalationStep[];
  /** Rendered at the right end of the breadcrumb strip — e.g. the peek's expand-to-full-view
   * button. Omitted (the full task view's call site) renders the strip without it. */
  headerTrailing?: ReactNode;
}

/**
 * Task detail as a wide, two-column layout, built to Linear's issue-detail anatomy: a
 * roomy main column (the title as the one loud element, then inline-editable Description /
 * Acceptance Criteria, Sessions, and Activity) beside a narrow right-hand *properties rail*
 * where status, priority, assignee, epic, blockers, and labels are all editable as compact
 * icon+value rows instead of boxed form fields. Every field on the task is editable in place:
 * frontmatter fields go through `onUpdate`/`onMoveStatus`, and the free-text body sections go
 * through `onUpdate`'s `description`/`acceptanceCriteria` (whole-section replacements — see
 * core's setSection). Shared by the peek dialog and the full task view — each caller owns its
 * own chrome (`Dialog`, tab strip) and hands this panel the same props.
 */
export function TaskDetailPanel({
  doc,
  defaultModel,
  statuses,
  ready,
  run,
  runs,
  epics,
  tasks,
  latestRunByTaskId,
  onUpdate,
  onMoveStatus,
  onDispatch,
  onEnrich,
  enrichPlan,
  onDismissEnrich,
  onAnswerEnrich,
  onOpenSession,
  onOpenTask,
  linearLinks,
  linearConfigured,
  onPushToLinear,
  client,
  port,
  fixLoopEscalation,
  headerTrailing,
}: TaskDetailPanelProps) {
  const [title, setTitle] = useState(doc.meta.title);
  const [activityDraft, setActivityDraft] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [pushingLinear, setPushingLinear] = useState(false);
  // Brief confirmation shown until the tasks cache refetches and `linearLinked` flips the
  // button into the real chip — the push itself gives no other positive signal.
  const [pushedLinear, setPushedLinear] = useState(false);
  // "Add detail" was clicked. Not cleared when the POST resolves — that 202 only means the
  // plan started; it clears when a draft or an error actually arrives.
  const [enrichStarted, setEnrichStarted] = useState(false);
  const [applyingEnrich, setApplyingEnrich] = useState(false);
  // The model this dispatch will use — seeded from the project's resolved
  // default (config models.execute layered under the device override),
  // overridable per-dispatch via the picker beside the Dispatch button.
  const [model, setModel] = useState(() => defaultModel ?? readDefaultModel());
  // View-local modal state for this epic's dependency graph — only ever meaningful when
  // `doc.meta.kind === 'epic'`; not lifted to App-level nav state since nothing outside this
  // panel needs to know the graph is open.
  const [showGraph, setShowGraph] = useState(false);

  // If the link never arrives, drop back to the button rather than claiming "Pushed" forever.
  useEffect(() => {
    if (!pushedLinear) return;
    const timer = setTimeout(() => setPushedLinear(false), 15_000);
    return () => clearTimeout(timer);
  }, [pushedLinear]);

  // Derived from the run's own state, not the task's status string: the old check compared
  // `doc.meta.status` against the literal built-in strings `'in-progress'`/`'in-review'`,
  // which silently stopped working for any project whose `.dispatch/config.yml` names its
  // in-flight statuses something else. A run that isn't in a terminal state *is* an "open
  // run" regardless of what the task's own status happens to be called.
  const hasOpenRun = run !== undefined && !isTerminalRunState(run.state);

  // The Linear issue this task is linked to, if any — null both when unlinked and when linked
  // but the display map has no entry for its UUID yet.
  const linearLink = resolveLinearLink(doc.meta.external, linearLinks);
  const linearLinked = parseExternal(doc.meta.external) !== null;

  const { findings, error: findingsError } = useTaskFindings(
    client,
    port,
    doc.meta.id
  );
  const { fixLoop, error: fixLoopError } = useFixLoop(
    client,
    port,
    doc.meta.id
  );
  const { result: verification, error: verificationError } =
    useTaskVerification(client, port, doc.meta.id);
  const isEpic = doc.meta.kind === 'epic';
  // Only ever meaningful for an epic — `useEpicLedger` no-ops (empty,
  // disabled) when `epicId` is undefined, so this is safe on a plain task.
  const { entries: epicLedgerEntries, error: epicLedgerError } = useEpicLedger(
    client,
    port,
    isEpic ? doc.meta.id : undefined
  );
  // A plain task's own entries live in the project-wide bucket instead, which
  // is the only place a scope grant on an epic-less task is ever recorded.
  const { entries: projectLedger, error: projectLedgerError } =
    useProjectLedger(client, port, !isEpic);
  const ledgerEntries = isEpic
    ? epicLedgerEntries
    : taskLedgerEntries(projectLedger, doc.meta.id);
  const ledgerError = isEpic ? epicLedgerError : projectLedgerError;
  const adjudicateFinding = useAdjudicateFinding(client, port);
  const startFixLoop = useStartFixLoop(client, port);
  const [startingFixLoop, setStartingFixLoop] = useState(false);
  const [startFixLoopError, setStartFixLoopError] = useState<string | null>(
    null
  );

  // The failure this reports is the useful half of the button: the server
  // declines when there is nothing to review yet (no implementer, one still
  // running, or a run that committed nothing), and that reason belongs on
  // screen rather than in a console.
  async function handleStartFixLoop() {
    setStartingFixLoop(true);
    setStartFixLoopError(null);
    try {
      await startFixLoop(doc.meta.id);
    } catch (err) {
      setStartFixLoopError(
        err instanceof Error ? err.message : 'Could not start the fix loop.'
      );
    } finally {
      setStartingFixLoop(false);
    }
  }

  async function pushToLinear() {
    if (onPushToLinear === undefined) return;
    setPushingLinear(true);
    setError(null);
    try {
      const failure = pushToLinearError(await onPushToLinear(doc.meta.id));
      if (failure !== null) setError(failure);
      else setPushedLinear(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setPushingLinear(false);
    }
  }

  // Whether this task belongs to a stack (a connected chain of blockedBy edges) — gates
  // whether the "Stack" rail section renders at all, so a lone task (the common case) never
  // shows an empty heading with nothing beneath it.
  const stack = useMemo(
    () => computeStack(tasks, doc.meta.id),
    [tasks, doc.meta.id]
  );

  // This epic's children, for the "View graph" button — only ever read when
  // `doc.meta.kind === 'epic'`, but cheap enough to always derive rather than branch the memo.
  const epicChildren = useMemo(
    () => tasks.filter((t) => t.meta.parent === doc.meta.id),
    [tasks, doc.meta.id]
  );

  // The caller only passes `enrichPlan` when it belongs to this task, so no id check here.
  const enrichDraft = enrichDraftFromPlan(enrichPlan);
  const enrichError = enrichPlanError(enrichPlan);
  // The `running` arm covers reopening this (per-task keyed, so remounted) panel mid-pass,
  // where `enrichStarted` is back to false but the app-level plan is still going.
  // Open questions mean the planner is waiting on the user, not still reading.
  const awaitingEnrichAnswer = (enrichPlan?.questions.length ?? 0) > 0;
  const enriching =
    enrichPlan?.state === 'running' ||
    (enrichStarted &&
      !awaitingEnrichAnswer &&
      enrichDraft === null &&
      enrichError === null);

  async function enrich() {
    if (onEnrich === undefined) return;
    setEnrichStarted(true);
    setError(null);
    try {
      await onEnrich(doc.meta.id);
    } catch (err) {
      setEnrichStarted(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  function dismissEnrich() {
    setEnrichStarted(false);
    onDismissEnrich?.();
  }

  // Writes the draft through the ordinary update path. Only dropped once that write lands, so
  // a failed save leaves the proposal on screen to retry.
  async function applyEnrich() {
    if (enrichDraft === null) return;
    setApplyingEnrich(true);
    setError(null);
    try {
      await onUpdate(doc.meta.id, enrichPatch(enrichDraft));
      dismissEnrich();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setApplyingEnrich(false);
    }
  }

  async function dispatch(executor?: 'fake' | 'claude') {
    setDispatching(true);
    setError(null);
    try {
      await onDispatch(
        doc.meta.id,
        executor,
        executor === 'fake' ? undefined : model
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDispatching(false);
    }
  }

  useEffect(() => {
    setTitle(doc.meta.title);
    setActivityDraft('');
    setError(null);
  }, [doc.meta.id, doc.meta.title]);

  const runUpdate = useCallback(
    async (patch: UpdatePatch) => {
      try {
        setError(null);
        await onUpdate(doc.meta.id, patch);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onUpdate]
  );

  const changeStatus = useCallback(
    async (status: string) => {
      try {
        setError(null);
        await onMoveStatus(doc.meta.id, status);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      }
    },
    [doc.meta.id, onMoveStatus]
  );

  const saveTitleIfChanged = useCallback(() => {
    if (title.trim() !== '' && title !== doc.meta.title) {
      void runUpdate({ title });
    }
  }, [title, doc.meta.title, runUpdate]);

  // Escape closes the dialog via Radix's own handling (which unmounts this component through
  // `onClose`/`onOpenChange`) — a plain `onBlur` on the title input can't be relied on to fire
  // before that unmount (removing a focused node's blur behavior is inconsistent enough across
  // browsers/webviews to not build a save on), so this listens for Escape itself and commits
  // the in-progress title edit explicitly. The choice here is to commit, not discard, on
  // Escape-while-editing — matching every other control on this panel (status/priority
  // selects, activity notes), which all save immediately rather than needing a separate "save"
  // step.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key === 'Escape') saveTitleIfChanged();
    }
    document.addEventListener('keydown', handleEscape);
    return () => document.removeEventListener('keydown', handleEscape);
  }, [saveTitleIfChanged]);

  function submitActivity() {
    if (activityDraft.trim() !== '') {
      void runUpdate({ appendActivity: activityDraft.trim() });
      setActivityDraft('');
    }
  }

  // Existing milestone names across the project, for the rail's pick-or-type field.
  const milestones = [
    ...new Set(
      tasks
        .map((t) => t.meta.milestone)
        .filter((m): m is string => m !== null && m !== '')
    ),
  ].sort();

  const sections = parseTaskSections(doc.body);
  const description = sections.get('Description') ?? '';
  const acceptance = sections.get('Acceptance Criteria') ?? '';
  const amendments = sections.get('Amendments') ?? '';
  // The Activity section body is append-only free text, one line per entry (see
  // core/store.ts's template) — split it into a feed of entries rather than one flat block.
  const activityEntries = (sections.get('Activity') ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '');

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Breadcrumb-style header, matching Linear's `Team › Issues › ID`: just the id and
      live status, quiet, above the two-column body. */}
      <div className="border-border flex shrink-0 items-center gap-2 border-b px-6 py-3">
        <span className="text-muted-foreground font-mono text-[11px]">
          {doc.meta.id}
        </span>
        <span className="text-muted-foreground/40">›</span>
        <StatusIcon status={doc.meta.status} />
        <span className="text-muted-foreground text-[12px]">
          {doc.meta.status}
        </span>
        <span className="text-muted-foreground/40">›</span>
        <MergeLadderDot meta={run} />
        <span className="text-muted-foreground text-[12px]">
          {mergeLadderLabel(
            mergeLadderState(run),
            run?.branch,
            run?.mergeCommit,
            run?.prUrl
          )}
        </span>
        {linearLinked && (
          <>
            <span className="text-muted-foreground/40">›</span>
            {linearLink !== null ? (
              <a
                href={linearLink.url}
                target="_blank"
                rel="noreferrer"
                onClick={(e) => e.stopPropagation()}
              >
                <Badge variant="outline" className="gap-1 text-[11px]">
                  <Link2 className="size-3" />
                  {linearLink.identifier}
                </Badge>
              </a>
            ) : (
              // The display map has no entry for this UUID yet (a baseline pass hasn't
              // covered it) — say "linked" without naming or linking to the issue.
              <Badge
                variant="outline"
                className="gap-1 text-[11px]"
                title="Linked to a Linear issue"
              >
                <Link2 className="size-3" />
                Linear
              </Badge>
            )}
          </>
        )}
        {!linearLinked && linearConfigured && onPushToLinear !== undefined && (
          <>
            <span className="text-muted-foreground/40">›</span>
            {pushedLinear ? (
              <span className="text-state-review inline-flex items-center gap-1 text-[11px]">
                <Link2 className="size-3" />
                Pushed
              </span>
            ) : (
              <Button
                type="button"
                variant="ghost"
                onClick={(e) => {
                  e.stopPropagation();
                  void pushToLinear();
                }}
                disabled={pushingLinear}
                className="text-muted-foreground hover:text-foreground h-auto gap-1 p-0 text-[11px] hover:bg-transparent has-[>svg]:px-0"
              >
                <Link2 className="size-3" />
                {pushingLinear ? 'Pushing…' : 'Push to Linear'}
              </Button>
            )}
          </>
        )}
        {headerTrailing !== undefined && (
          <div className="ml-auto">{headerTrailing}</div>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* Main column: the title leads, then dispatch actions, editable prose sections,
        sessions, and the activity feed + composer — all left-aligned in a roomy flow. */}
        <div className="flex min-w-0 flex-1 flex-col gap-6 overflow-y-auto px-8 py-6">
          {error !== null && (
            <Alert
              variant="destructive"
              className="bg-destructive/10 rounded-md border-0 px-3 py-2 text-[13px]"
            >
              <AlertDescription className="text-[13px]">
                {error}
              </AlertDescription>
            </Alert>
          )}

          <Input
            className="text-foreground hover:bg-muted/40 dark:hover:bg-muted/40 -mx-2 h-auto w-[calc(100%+1rem)] border-transparent bg-transparent px-2 py-1 text-[22px] leading-tight font-semibold shadow-none transition-colors duration-150 dark:bg-transparent"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onBlur={saveTitleIfChanged}
            aria-label="Task title"
          />

          {doc.meta.kind === 'epic' && (
            <div className="-mt-2 flex items-center gap-2">
              <Button
                variant="secondary"
                size="sm"
                onClick={() => setShowGraph(true)}
              >
                <Waypoints className="size-3.5" />
                View graph
              </Button>
            </div>
          )}

          {ledgerError !== null && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
            >
              <AlertDescription className="text-[12.5px]">
                Couldn&rsquo;t load the ledger: {ledgerError}
              </AlertDescription>
            </Alert>
          )}
          <LedgerSection entries={ledgerEntries} />

          {onEnrich !== undefined && (
            <div className="-mt-2 flex flex-col gap-2">
              <div className="flex items-center gap-2">
                {/* Deliberately outside the ready/hasOpenRun gate below: a blocked or
                not-yet-ready task is precisely the one worth specifying properly before
                an agent ever gets to it. */}
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={enriching}
                  onClick={() => void enrich()}
                >
                  <Sparkles className="size-3.5" />
                  {enriching ? 'Reading the repo…' : 'Add detail'}
                </Button>
                {enrichError !== null && (
                  <span className="text-state-failed text-[12.5px]">
                    {enrichError}
                  </span>
                )}
              </div>

              {enrichPlan !== undefined &&
                enrichPlan.questions.length > 0 &&
                onAnswerEnrich !== undefined && (
                  <PlanQuestionsForm
                    questions={enrichPlan.questions}
                    disabled={enrichPlan.state === 'running'}
                    onSend={onAnswerEnrich}
                  />
                )}

              {enrichDraft !== null && (
                <EnrichReview
                  draft={enrichDraft}
                  applying={applyingEnrich}
                  onApply={() => void applyEnrich()}
                  onDiscard={dismissEnrich}
                />
              )}
            </div>
          )}
          {(ready || hasOpenRun) && (
            <div className="-mt-2 flex items-center gap-2">
              {ready && (
                <>
                  <Button
                    size="sm"
                    disabled={dispatching}
                    onClick={() => void dispatch()}
                  >
                    Dispatch
                  </Button>
                  <DropdownMenu>
                    <DropdownMenuTrigger asChild>
                      <Button
                        type="button"
                        variant="ghost"
                        className="text-muted-foreground hover:bg-muted/60 hover:text-foreground h-auto gap-1 rounded-md border border-transparent px-2 py-1 text-[12px] has-[>svg]:px-2"
                      >
                        {modelLabel(model)}
                        <ChevronDown className="size-3" />
                      </Button>
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="start">
                      {MODELS.map((m) => (
                        <DropdownMenuItem
                          key={m.id}
                          onSelect={() => setModel(m.id)}
                          className="gap-2 pr-8 text-[13px]"
                        >
                          <span className="flex-1">{m.label}</span>
                          {m.id === model && (
                            <Check className="ml-auto size-3.5" />
                          )}
                        </DropdownMenuItem>
                      ))}
                    </DropdownMenuContent>
                  </DropdownMenu>
                </>
              )}
              {ready && isFakeExecutorDevToolEnabled() && (
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={dispatching}
                  onClick={() => void dispatch('fake')}
                >
                  Dispatch (fake)
                </Button>
              )}
              {hasOpenRun && run !== undefined && (
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => onOpenSession(run.id)}
                >
                  {doc.meta.status === 'in-review' ? 'Review run' : 'View run'}
                </Button>
              )}
              {run?.prUrl !== undefined && (
                <a href={run.prUrl} target="_blank" rel="noreferrer">
                  <Badge
                    variant="outline"
                    className="text-primary hover:bg-accent gap-1 rounded-full px-2 py-1 text-[11px] transition-colors duration-150"
                  >
                    PR
                    <ArrowUpRight className="size-3" />
                  </Badge>
                </a>
              )}
            </div>
          )}

          {fixLoopError !== null && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
            >
              <AlertDescription className="text-[12.5px]">
                Couldn&rsquo;t load the fix loop: {fixLoopError}
              </AlertDescription>
            </Alert>
          )}
          <FixLoopSection
            fixLoop={fixLoop}
            escalation={fixLoopEscalation}
            onStart={() => void handleStartFixLoop()}
            starting={startingFixLoop}
            startError={startFixLoopError}
          />

          {findingsError !== null && (
            <Alert
              variant="destructive"
              className="border-destructive/30 bg-destructive/10 rounded-md px-3 py-2 text-[12.5px]"
            >
              <AlertDescription className="text-[12.5px]">
                Couldn&rsquo;t load findings: {findingsError}
                {fixLoopNeedsRuling(fixLoop) &&
                  ' Open findings can’t be ruled on right now.'}
              </AlertDescription>
            </Alert>
          )}
          <FindingsPanel
            findings={findings}
            needsRuling={fixLoopNeedsRuling(fixLoop)}
            onAdjudicate={async (findingId, input) => {
              await adjudicateFinding(doc.meta.id, findingId, input);
            }}
          />

          <EditableBodySection
            title="Description"
            value={description}
            placeholder="Add a description…"
            onSave={(next) => void runUpdate({ description: next })}
          />

          <EditableBodySection
            title="Acceptance Criteria"
            value={acceptance}
            placeholder="Add acceptance criteria…"
            onSave={(next) => void runUpdate({ acceptanceCriteria: next })}
          />

          {amendments !== '' && (
            <MainSection title="Amendments">
              <p className="text-muted-foreground text-[13px] whitespace-pre-wrap">
                {amendments}
              </p>
            </MainSection>
          )}

          <MainSection
            title={`Sessions${runs.length > 0 ? ` · ${runs.length}` : ''}`}
          >
            {runs.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No agent has worked this task yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {runs.map((r) => (
                  <li key={r.id}>
                    <Button
                      type="button"
                      variant="ghost"
                      onClick={() => onOpenSession(r.id)}
                      className="border-border/60 hover:bg-muted/60 h-auto w-full justify-start gap-2 rounded-md border px-2.5 py-1.5 text-left"
                    >
                      <RunStatePill meta={r} />
                      <span className="text-muted-foreground font-mono text-[11px]">
                        {r.id}
                      </span>
                      <span className="text-muted-foreground/70 ml-auto text-[11px] whitespace-nowrap">
                        {r.costUsd !== undefined &&
                          `$${r.costUsd.toFixed(2)} · `}
                        {formatRelativeTimeFromIso(r.updatedAt)}
                      </span>
                    </Button>
                  </li>
                ))}
              </ul>
            )}
          </MainSection>

          <VerificationSection
            exercised={doc.meta.exercised}
            result={verification}
            error={verificationError}
          />

          <MainSection title="Impact">
            <div className="flex flex-col items-start gap-2">
              <ImpactPanel client={client} subject="task" id={doc.meta.id} />
            </div>
          </MainSection>

          <MainSection title="Activity">
            {activityEntries.length === 0 ? (
              <p className="text-muted-foreground text-[13px]">
                No activity yet.
              </p>
            ) : (
              <ul className="flex flex-col gap-2">
                {activityEntries.map((entry, i) => (
                  <li
                    key={i}
                    className="text-muted-foreground text-[13px] whitespace-pre-wrap"
                  >
                    {entry}
                  </li>
                ))}
              </ul>
            )}
            {/* Linear-style comment composer: one bordered, rounded box that focuses as a
            unit, with the send affordance tucked inside on the right. */}
            <div className="border-border focus-within:border-ring/60 mt-1 flex items-center gap-2 rounded-lg border px-2 py-1.5 transition-colors duration-150">
              <Input
                className="h-7 flex-1 border-transparent bg-transparent px-1 text-[13px] shadow-none focus-visible:ring-0"
                placeholder="Leave a note…"
                value={activityDraft}
                onChange={(e) => setActivityDraft(e.target.value)}
                onKeyDown={(e) => {
                  // Plain Enter only — the peek's cmd+Enter expand chord must not also submit.
                  if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey)
                    submitActivity();
                }}
              />
              <Button
                size="sm"
                disabled={activityDraft.trim() === ''}
                onClick={submitActivity}
              >
                Add
              </Button>
            </div>
          </MainSection>
        </div>

        {/* Properties rail: the signature Linear element — every property editable in place
        as a compact icon+value row (ghost selects) or chip editor, grouped under quiet
        headers, instead of a grid of boxed form fields. */}
        <aside className="border-border bg-muted/20 w-[248px] shrink-0 overflow-y-auto border-l px-4 py-6">
          <div className="flex flex-col gap-5">
            <RailSection title="Properties">
              <StatusControl
                value={doc.meta.status}
                statuses={statuses}
                onChange={(s) => void changeStatus(s)}
                variant="row"
              />
              <PriorityControl
                value={doc.meta.priority}
                onChange={(p) => void runUpdate({ priority: p })}
                variant="row"
              />
              <AssigneeControl
                value={doc.meta.assignee}
                onChange={(a) => void runUpdate({ assignee: a })}
                variant="row"
              />
              <EpicControl
                value={doc.meta.parent}
                epics={epics}
                onChange={(parent) => void runUpdate({ parent })}
                variant="row"
              />

              <MilestoneRow
                value={doc.meta.milestone}
                milestones={milestones}
                onChange={(milestone) => void runUpdate({ milestone })}
              />

              <SelfReviewRow
                value={doc.meta.selfReview}
                onChange={(selfReview) => void runUpdate({ selfReview })}
              />

              {/* Kind is fixed at creation (task vs epic) — the one property that stays
              read-only, shown for context alongside the editable rows. */}
              <div className="flex items-center gap-2 rounded-md px-2 py-1.5 text-[13px]">
                <Layers className="text-muted-foreground size-3.5" />
                <span>{doc.meta.kind}</span>
              </div>
            </RailSection>

            <RailSection title="Blocked by">
              {doc.meta.blockedBy.length === 0 && (
                <div className="text-muted-foreground flex items-center gap-2 px-2 py-1.5 text-[13px]">
                  <Ban className="size-3.5" />
                  No blockers
                </div>
              )}
              <BlockedByEditor
                blockedBy={doc.meta.blockedBy}
                candidates={tasks.filter((t) => t.meta.id !== doc.meta.id)}
                onChange={(next) => void runUpdate({ blockedBy: next })}
              />
            </RailSection>

            {/* Gated on `stack` (not just letting `StackRail` render null on its own) so a
            lone task — the common case, not a "stack" of one — never shows an empty
            "Stack" heading with nothing beneath it. */}
            {stack !== null && (
              <RailSection title="Stack">
                <StackRail
                  tasks={tasks}
                  taskId={doc.meta.id}
                  latestRunByTaskId={latestRunByTaskId}
                  onOpenTask={onOpenTask}
                />
              </RailSection>
            )}

            <RailSection title="Labels">
              {doc.meta.labels.length === 0 && (
                <div className="text-muted-foreground flex items-center gap-2 px-2 pb-0.5 text-[13px]">
                  <Tag className="size-3.5" />
                  No labels
                </div>
              )}
              <LabelEditor
                labels={doc.meta.labels}
                onChange={(next) => void runUpdate({ labels: next })}
              />
            </RailSection>
          </div>
        </aside>
      </div>

      {doc.meta.kind === 'epic' && (
        <EpicDagModal
          epic={showGraph ? doc : null}
          tasks={epicChildren}
          onOpenTask={onOpenTask}
          onClose={() => setShowGraph(false)}
        />
      )}
    </div>
  );
}
