import type {
  ApiClient,
  ExecutorsResponse,
  LinearIssueLink,
  LinearSyncSummary,
  PlanRecord,
  RunMeta,
} from '@dispatch/client';
import type {
  EffortLevel,
  EscalationStep,
  TaskDoc,
  UpdatePatch,
} from '@dispatch/core/browser';
import { parseExternal } from '@dispatch/core/browser';
import {
  Archive,
  Ban,
  Check,
  Copy,
  Ellipsis,
  Link2,
  Maximize2,
  Play,
  Sparkles,
  Star,
  Waypoints,
  X,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  useAdjudicateFinding,
  useEpicLedger,
  useFixLoop,
  useProjectLedger,
  useStartFixLoop,
  useStopFixLoop,
  useTaskFindings,
  useTaskVerification,
} from '../../../hooks/useOrchestration';
import { parseActivity } from '../../../lib/activityFeed';
import { filesFromDataTransfer } from '../../../lib/attachments';
import { isFakeExecutorDevToolEnabled } from '../../../lib/devTools';
import { fixLoopNeedsRuling } from '../../../lib/fixLoopStatus';
import {
  isTypingTagName,
  type ListKeyCommand,
  resolveListKeyCommand,
} from '../../../lib/keyboard';
import { taskLedgerEntries } from '../../../lib/ledgerScope';
import {
  pushToLinearError,
  resolveLinearLink,
} from '../../../lib/linearSettings';
import {
  DEFAULT_EFFORT_ID,
  effortFromId,
  effortOptions,
  modelLabel,
  MODELS,
  readDefaultModel,
} from '../../../lib/models';
import { notePatch } from '../../../lib/noteDraft';
import { isTerminalRunState } from '../../../lib/runState';
import { parseTaskSections } from '../../../lib/taskDisplay';
import {
  enrichDraftFromPlan,
  enrichPatch,
  enrichPlanError,
} from '../../../lib/taskEnrich';
import { ImpactPanel } from '../../impact/ImpactPanel';
import { PlanQuestionsForm } from '../../plans/PlanQuestionsForm';
import { useDeepLinkActions } from '../../shell/DeepLinkContext';
import { useSavedViewsContext } from '../../shell/SavedViewsContext';
import { useShellActions } from '../../shell/ShellActionsContext';
import { useToasts } from '../../shell/Toasts';
import { FindingsPanel } from '../detail/FindingsPanel';
import { FixLoopSection } from '../detail/FixLoopSection';
import { LedgerSection } from '../detail/LedgerSection';
import { MainSection } from '../detail/MainSection';
import { VerificationSection } from '../detail/VerificationSection';
import { EnrichReview } from '../EnrichReview';
import { EpicDagModal } from '../EpicDagModal';
import { getStackByTaskId } from '../StackRail';
import { ActivitySection } from './ActivitySection';
import { AttachmentsRow, useAttachmentUpload } from './AttachmentsRow';
import { PropertiesRail, type RailPicker } from './PropertiesRail';
import { SessionsBlock } from './SessionsBlock';
import { SubtasksBlock } from './SubtasksBlock';
import { TaskDescription } from './TaskDescription';
import { TaskTitle } from './TaskTitle';
import { cn } from '@/lib/utils';
import { IconButton } from '@/ui/ai/icon-button';
import { PageHeader, SidePanelIconButton } from '@/ui/ai/page-header';
import { PillButton, SelectPill } from '@/ui/ai/pill';
import { Button } from '@/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/ui/dropdown-menu';

export interface TaskDetailPanelProps {
  doc: TaskDoc;
  /** The model a dispatch runs on when the picker is untouched — the project
   * config's `models.execute` resolved with the per-device override (see
   * resolveExecuteModel). Absent, the picker falls back to the device default,
   * which ignores the project config. */
  defaultModel?: string;
  /** The project's configured `effort.execute`, shown on the effort picker's
   *  Default entry. The daemon applies it; the page never sends it itself. */
  defaultEffort?: EffortLevel;
  /** What the daemon can dispatch on. Absent (or a single real executor) hides the picker. */
  executors?: ExecutorsResponse;
  statuses: string[];
  ready: boolean;
  run: RunMeta | undefined;
  /** Every run (agent session) this task has had — newest first — so the page can list
   * them and let you jump into any session's log/review, not just the latest one. */
  runs: RunMeta[];
  /** All epics in the project, for the editable Epic (parent) picker. */
  epics: TaskDoc[];
  /** All tasks in the project, for the editable Blocked-by picker (self is filtered out),
   * the sub-tasks block, and `StackRail`. */
  tasks: TaskDoc[];
  /** Every task's latest run, for the sub-task and stack rows' run marks. */
  latestRunByTaskId: Map<string, RunMeta>;
  onUpdate: (id: string, patch: UpdatePatch) => Promise<void>;
  /** Optimistic status change (see `useDispatchProject.moveTaskStatus`) — the same one the
   * board's drag-and-drop uses, so moving a task's status from the rail feels as immediate
   * as dragging its card, rather than waiting on a round-trip like every other field here
   * (`onUpdate`) does. */
  onMoveStatus: (id: string, status: string) => Promise<void>;
  onDispatch: (
    id: string,
    executor?: string,
    model?: string,
    opts?: { effort?: EffortLevel }
  ) => Promise<void>;
  /** Jumps to a run's session/log — the "View run"/"Review run" button and every Sessions
   * row call this with the run's id. */
  onOpenSession: (runId: string) => void;
  /** Starts an AI draft that adds the context an under-specified task is missing. Optional
   * so the older call sites that never had it keep compiling with the button hidden. */
  onEnrich?: (id: string) => Promise<void>;
  /** The plan carrying that draft, passed only while it belongs to *this* task. The caller
   * owns the slot, so a draft survives the page being closed and reopened. */
  enrichPlan?: PlanRecord;
  /** Drops the draft without applying it (Discard, and the cleanup after Apply). */
  onDismissEnrich?: () => void;
  /** Answers the enrich planner's clarifying questions on the same plan. Optional, like the
   * other enrich props, so older call sites keep compiling. */
  onAnswerEnrich?: (message: string) => Promise<void>;
  /** Re-points this page at a different task — a sub-task row, a blocker pill, the stack.
   * Omitted renders those as plain text. */
  onOpenTask?: (taskId: string) => void;
  /** Issue UUID -> display identifier/URL, for turning `doc.meta.external` into a real chip. */
  linearLinks: Record<string, LinearIssueLink>;
  /** Whether Linear is connected with a team chosen — gates the "Push to Linear" action. */
  linearConfigured: boolean;
  /** Pushes this task to Linear now (creating the issue if unlinked). Optional so a caller
   * without Linear plumbing gets no push affordance. */
  onPushToLinear?: (id: string) => Promise<LinearSyncSummary>;
  /** The dispatchd client — this page fetches its own findings/fix-loop/
   * verification/ledger data rather than going through the app-level hook. */
  client: ApiClient | null;
  /** The active project's daemon port, for namespacing this page's own
   * query keys — see useOrchestration.ts. */
  port: number | undefined;
  /** The project's escalation ladder, for the "fresh implementer" hint. */
  fixLoopEscalation: EscalationStep[];
  /** Extra header actions, rendered before the side-panel toggle. */
  headerTrailing?: ReactNode;
}

interface TaskPageProps extends TaskDetailPanelProps {
  /** `page` draws the two-row `PageHeader`; `peek` draws a 40px dialog chrome row instead. */
  mode: 'page' | 'peek';
  /** The active project's display name, the first crumb (`null` when none is active). */
  projectName: string | null;
  /** Page mode: the Details / Chat / Diff `ViewTabs` for the header's second row. */
  tabs?: ReactNode;
  /** Page mode: the header's second-row controls (the session select). */
  controls?: ReactNode;
  /** Page mode: replaces the details body — the Chat or Diff tab's content. */
  children?: ReactNode;
  /** Peek mode: grows the peek into the full task view (`⌘⏎`). */
  onExpand?: () => void;
  /** Peek mode: closes the dialog. */
  onClose?: () => void;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return typeof err === 'string' ? err : 'Something went wrong.';
}

// Which rail picker each single-key list command opens on this page.
const PICKER_FOR_KEY: Partial<Record<ListKeyCommand, RailPicker>> = {
  'list-set-status': 'status',
  'list-set-priority': 'priority',
  'list-set-assignee': 'assignee',
  'list-set-labels': 'labels',
  'list-set-epic': 'epic',
  'list-set-milestone': 'milestone',
};

/** `t-8f2a Apply to …` — the task's own crumb segment: a muted sans id at Linear's -0.26px
 * tracking beside the title. */
function TaskCrumb({ id, title }: { id: string; title: string }) {
  return (
    <span data-slot="task-crumb" className="flex min-w-0 items-center gap-1.5">
      <span className="font-book text-muted-foreground shrink-0 tracking-(--id-tracking)">
        {id}
      </span>
      <span className="min-w-0 truncate">{title || 'Untitled task'}</span>
    </span>
  );
}

/**
 * One task, on Linear's issue-page anatomy: a header crumb (`Project › Tasks › t-xxxx
 * Title`) with copy-id / `···` / side-panel icons, a ~800px content column — the 24px
 * in-place title, the dispatch actions, the rendered description and acceptance criteria,
 * sub-tasks, the orchestration sections, sessions, and the activity feed with its comment
 * composer — beside a 280px properties rail of 32px ghost rows. Renders both the full task
 * view (`mode: 'page'`, where the Chat/Diff tabs replace the body through `children`) and
 * the peek dialog (`mode: 'peek'`, a 40px chrome row instead of the page header), from the
 * same `TaskDetailPanelProps` bundle App.tsx builds once for both. Every field is editable
 * in place: frontmatter through `onUpdate`/`onMoveStatus`, body sections through
 * `onUpdate`'s `description`/`acceptanceCriteria`; failures surface as error toasts.
 */
export function TaskPage({
  mode,
  projectName,
  tabs,
  controls,
  children,
  onExpand,
  onClose,
  doc,
  defaultModel,
  defaultEffort,
  executors,
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
}: TaskPageProps) {
  const shell = useShellActions();
  const toasts = useToasts();
  // Both null until App mounts their providers (P7); the page then shows no
  // Copy link and no star, which is also the browser-harness and test state.
  const deepLink = useDeepLinkActions();
  const savedViews = useSavedViewsContext();
  const rootRef = useRef<HTMLDivElement>(null);
  const attachmentUpload = useAttachmentUpload(client, doc.meta.id);
  const attachmentInputRef = useRef<HTMLInputElement | null>(null);
  const [sidePanelOpen, setSidePanelOpen] = useState(true);
  const [picker, setPicker] = useState<RailPicker | null>(null);
  const [dispatching, setDispatching] = useState(false);
  const [pushingLinear, setPushingLinear] = useState(false);
  // Brief confirmation shown until the tasks cache refetches and `linearLinked` flips the
  // button into the real chip — the push itself gives no other positive signal.
  const [pushedLinear, setPushedLinear] = useState(false);
  // "Add detail" was clicked. Not cleared when the POST resolves — that 202 only means the
  // plan started; it clears when a draft or an error actually arrives.
  const [enrichStarted, setEnrichStarted] = useState(false);
  const [applyingEnrich, setApplyingEnrich] = useState(false);
  // The model this dispatch will use — seeded from the project's resolved default (config
  // models.execute layered under the device override), overridable per-dispatch.
  const [model, setModel] = useState(() => defaultModel ?? readDefaultModel());
  // The effort picker's id; the Default sentinel sends nothing.
  const [effortId, setEffortId] = useState(DEFAULT_EFFORT_ID);
  const efforts = effortOptions(defaultEffort);
  // The executor this dispatch will use; undefined means "the daemon's default", which is
  // sent as no executor at all so a resumable run is never refused for naming one.
  const [executor, setExecutor] = useState<string | undefined>(undefined);
  const executorChoices = useMemo(
    () => (executors?.executors ?? []).filter((e) => e.name !== 'fake'),
    [executors]
  );
  const effectiveExecutor = executor ?? executors?.default ?? 'claude';
  // The epic's dependency-graph dialog — only ever meaningful when `doc.meta.kind ===
  // 'epic'`; not lifted to nav state since nothing outside this page needs to know.
  const [showGraph, setShowGraph] = useState(false);

  // If the link never arrives, drop back to the button rather than claiming "Pushed" forever.
  useEffect(() => {
    if (!pushedLinear) return;
    const timer = setTimeout(() => setPushedLinear(false), 15_000);
    return () => clearTimeout(timer);
  }, [pushedLinear]);

  // Failures land as error toasts rather than a tinted banner in the column.
  const fail = useCallback(
    (title: string, err: unknown) => {
      toasts.push({ title, description: errorMessage(err), tone: 'error' });
    },
    [toasts]
  );

  // Derived from the run's own state, not the task's status string: a run that isn't in a
  // terminal state *is* an "open run" whatever the project calls its in-flight statuses.
  const hasOpenRun = run !== undefined && !isTerminalRunState(run.state);

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
  // Only ever meaningful for an epic — `useEpicLedger` no-ops (empty, disabled) when
  // `epicId` is undefined, so this is safe on a plain task.
  const { entries: epicLedgerEntries, error: epicLedgerError } = useEpicLedger(
    client,
    port,
    isEpic ? doc.meta.id : undefined
  );
  // A plain task's own entries live in the project-wide bucket instead, which is the only
  // place a scope grant on an epic-less task is ever recorded.
  const { entries: projectLedger, error: projectLedgerError } =
    useProjectLedger(client, port, !isEpic);
  const ledgerEntries = isEpic
    ? epicLedgerEntries
    : taskLedgerEntries(projectLedger, doc.meta.id);
  const ledgerError = isEpic ? epicLedgerError : projectLedgerError;
  const adjudicateFinding = useAdjudicateFinding(client, port);
  const startFixLoop = useStartFixLoop(client, port);
  const stopFixLoop = useStopFixLoop(client, port);
  const [startingFixLoop, setStartingFixLoop] = useState(false);
  const [startFixLoopError, setStartFixLoopError] = useState<string | null>(
    null
  );

  // The failure this reports is the useful half of the button: the server declines when
  // there is nothing to review yet, and that reason belongs on screen.
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
    try {
      const failure = pushToLinearError(await onPushToLinear(doc.meta.id));
      if (failure !== null) {
        toasts.push({
          title: 'Push to Linear failed',
          description: failure,
          tone: 'error',
        });
      } else {
        setPushedLinear(true);
      }
    } catch (err) {
      fail('Push to Linear failed', err);
    } finally {
      setPushingLinear(false);
    }
  }

  // Whether this task belongs to a stack (a connected chain of blockedBy edges) — gates
  // the rail's Stack section so a lone task never shows an empty heading. Read from the
  // same per-`tasks` cache StackRail draws from, so the adjacency is built once.
  const hasStack = getStackByTaskId(tasks).has(doc.meta.id);

  // This epic's children (the sub-tasks block and the graph dialog), and — for a plain
  // task — the tasks it blocks, which get the same block titled `Blocks`.
  const epicChildren = useMemo(
    () => tasks.filter((t) => t.meta.parent === doc.meta.id),
    [tasks, doc.meta.id]
  );
  const dependents = useMemo(
    () =>
      isEpic ? [] : tasks.filter((t) => t.meta.blockedBy.includes(doc.meta.id)),
    [tasks, doc.meta.id, isEpic]
  );

  // The caller only passes `enrichPlan` when it belongs to this task, so no id check here.
  const enrichDraft = enrichDraftFromPlan(enrichPlan);
  const enrichError = enrichPlanError(enrichPlan);
  // The `running` arm covers reopening this (per-task keyed, so remounted) page mid-pass,
  // where `enrichStarted` is back to false but the app-level plan is still going. Open
  // questions mean the planner is waiting on the user, not still reading.
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
    try {
      await onEnrich(doc.meta.id);
    } catch (err) {
      setEnrichStarted(false);
      fail('Could not start the draft', err);
    }
  }

  function dismissEnrich() {
    setEnrichStarted(false);
    onDismissEnrich?.();
  }

  // Writes the draft through the ordinary update path. Only dropped once that write lands,
  // so a failed save leaves the proposal on screen to retry.
  async function applyEnrich() {
    if (enrichDraft === null) return;
    setApplyingEnrich(true);
    try {
      await onUpdate(doc.meta.id, enrichPatch(enrichDraft));
      dismissEnrich();
    } catch (err) {
      fail('Could not apply the draft', err);
    } finally {
      setApplyingEnrich(false);
    }
  }

  const dispatch = useCallback(
    async (explicit?: string) => {
      setDispatching(true);
      try {
        const chosen = explicit ?? executor;
        const runsOn = chosen ?? executors?.default ?? 'claude';
        // The model and effort pickers are Claude's; any other executor picks its own.
        await onDispatch(
          doc.meta.id,
          chosen,
          runsOn === 'claude' ? model : undefined,
          runsOn === 'claude' ? { effort: effortFromId(effortId) } : undefined
        );
      } catch (err) {
        fail('Dispatch failed', err);
      } finally {
        setDispatching(false);
      }
    },
    [doc.meta.id, executor, executors, model, effortId, onDispatch, fail]
  );

  const patch = useCallback(
    async (next: UpdatePatch) => {
      try {
        await onUpdate(doc.meta.id, next);
      } catch (err) {
        fail('Could not save the task', err);
      }
    },
    [doc.meta.id, onUpdate, fail]
  );

  const changeStatus = useCallback(
    async (status: string) => {
      try {
        await onMoveStatus(doc.meta.id, status);
      } catch (err) {
        fail('Could not change the status', err);
      }
    },
    [doc.meta.id, onMoveStatus, fail]
  );

  // Linear's single-key property shortcuts (`s p a l e m`) and `d` to dispatch, for a
  // keystroke that lands on this page's body or on nothing at all. A key typed into a field,
  // or into a dialog stacked above this page, is left alone.
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const root = rootRef.current;
      const target = event.target;
      if (root === null || !(target instanceof HTMLElement)) return;
      // On this page's body, on nothing at all, or on the dialog popup around the peek.
      if (
        target !== document.body &&
        !root.contains(target) &&
        !target.contains(root)
      ) {
        return;
      }
      if (isTypingTagName(target.tagName, target.isContentEditable)) return;
      // A key inside an open menu or picker belongs to it.
      if (
        target.closest('[role="menu"], [data-slot="popover-content"]') !== null
      )
        return;
      const command = resolveListKeyCommand(
        { key: event.key, metaKey: event.metaKey, ctrlKey: event.ctrlKey },
        { isTyping: false }
      );
      const next = command === null ? undefined : PICKER_FOR_KEY[command];
      if (next !== undefined) {
        event.preventDefault();
        setSidePanelOpen(true);
        setPicker(next);
        return;
      }
      if (command === 'list-dispatch' && ready && !hasOpenRun && !dispatching) {
        event.preventDefault();
        void dispatch();
      }
    }
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [ready, hasOpenRun, dispatching, dispatch]);

  const sections = parseTaskSections(doc.body);
  const description = sections.get('Description') ?? '';
  const acceptance = sections.get('Acceptance Criteria') ?? '';
  const amendments = sections.get('Amendments') ?? '';
  const activitySection = sections.get('Activity') ?? '';
  const activity = useMemo(
    () => parseActivity(activitySection),
    [activitySection]
  );

  const crumb: ReactNode[] = [
    ...(projectName !== null ? [projectName] : []),
    'Tasks',
    <TaskCrumb key="task" id={doc.meta.id} title={doc.meta.title} />,
  ];

  const headerActions = (
    <>
      {headerTrailing}
      <IconButton
        label="Copy task id"
        onClick={() => shell.copyTaskId(doc.meta.id)}
      >
        <Copy />
      </IconButton>
      {deepLink !== null && (
        <IconButton
          label="Copy link"
          onClick={() => deepLink.copyTaskLink(doc.meta.id)}
        >
          <Link2 />
        </IconButton>
      )}
      <DropdownMenu>
        <DropdownMenuTrigger render={<IconButton label="More actions" />}>
          <Ellipsis />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-52">
          <DropdownMenuItem
            disabled={!ready || dispatching}
            onClick={() => void dispatch()}
          >
            <Play />
            Dispatch
          </DropdownMenuItem>
          {!linearLinked &&
            linearConfigured &&
            onPushToLinear !== undefined && (
              <DropdownMenuItem
                disabled={pushingLinear}
                onClick={() => void pushToLinear()}
              >
                <Link2 />
                Push to Linear
              </DropdownMenuItem>
            )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={doc.meta.archivedAt !== undefined}
            onClick={() => void patch({ archivedAt: new Date().toISOString() })}
          >
            <Archive />
            Archive
          </DropdownMenuItem>
          <DropdownMenuItem
            variant="destructive"
            disabled={doc.meta.status === 'dropped'}
            onClick={() => void changeStatus('dropped')}
          >
            <Ban />
            Drop
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SidePanelIconButton
        active={sidePanelOpen}
        onClick={() => setSidePanelOpen((open) => !open)}
      />
      {mode === 'peek' && onExpand !== undefined && (
        <IconButton label="Expand to full view" onClick={onExpand}>
          <Maximize2 />
        </IconButton>
      )}
      {mode === 'peek' && onClose !== undefined && (
        <IconButton label="Close" onClick={onClose}>
          <X />
        </IconButton>
      )}
    </>
  );

  const favoriteRef = { kind: 'task' as const, id: doc.meta.id };
  const favorite = savedViews?.isFavorite(favoriteRef) ?? false;
  const star =
    savedViews === null ? undefined : (
      <IconButton
        label={favorite ? 'Unfavorite' : 'Favorite'}
        active={favorite}
        onClick={() => savedViews.toggleFavorite(favoriteRef)}
      >
        <Star />
      </IconButton>
    );

  // A drop or a paste carrying files anywhere on the content column attaches
  // them; a text paste is left to whatever field has focus.
  const archived = doc.meta.archivedAt !== undefined;
  const attachable = !archived && client !== null;
  function attachFromTransfer(dt: DataTransfer | null): boolean {
    if (!attachable) return false;
    const files = filesFromDataTransfer(dt);
    if (files.length === 0) return false;
    void attachmentUpload.upload(files);
    return true;
  }

  const detailsBody = (
    <div
      className="flex flex-col gap-6"
      onDragOver={(e) => {
        if (attachable) e.preventDefault();
      }}
      onDrop={(e) => {
        if (attachFromTransfer(e.dataTransfer)) e.preventDefault();
      }}
      onPaste={(e) => {
        if (attachFromTransfer(e.clipboardData)) e.preventDefault();
      }}
    >
      <TaskTitle
        value={doc.meta.title}
        onCommit={(title) => void patch({ title })}
      />

      {/* Dispatch and the other verbs, as Linear's control row: the primary indigo button
          with the model select beside it, then pill buttons and a ghost. */}
      <div
        data-slot="task-actions"
        className="-mt-2 flex flex-wrap items-center gap-2"
      >
        {ready && (
          <>
            <Button disabled={dispatching} onClick={() => void dispatch()}>
              Dispatch
            </Button>
            {executorChoices.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SelectPill aria-label="Executor" />}
                >
                  {effectiveExecutor}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {executorChoices.map((e) => (
                    <DropdownMenuItem
                      key={e.name}
                      onClick={() =>
                        setExecutor(
                          e.name === executors?.default ? undefined : e.name
                        )
                      }
                    >
                      <span className="flex-1">{e.name}</span>
                      {e.name === effectiveExecutor && (
                        <Check className="ml-auto size-3" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {effectiveExecutor === 'claude' && (
              <DropdownMenu>
                <DropdownMenuTrigger render={<SelectPill aria-label="Model" />}>
                  {modelLabel(model)}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {MODELS.map((m) => (
                    <DropdownMenuItem key={m.id} onClick={() => setModel(m.id)}>
                      <span className="flex-1">{m.label}</span>
                      {m.id === model && <Check className="ml-auto size-3" />}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
            {effectiveExecutor === 'claude' && (
              <DropdownMenu>
                <DropdownMenuTrigger
                  render={<SelectPill aria-label="Effort" />}
                >
                  {efforts.find((e) => e.id === effortId)?.label}
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start">
                  {efforts.map((e) => (
                    <DropdownMenuItem
                      key={e.id}
                      onClick={() => setEffortId(e.id)}
                    >
                      <span className="flex-1">{e.label}</span>
                      {e.id === effortId && (
                        <Check className="ml-auto size-3" />
                      )}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </>
        )}
        {ready && isFakeExecutorDevToolEnabled() && (
          <PillButton
            disabled={dispatching}
            onClick={() => void dispatch('fake')}
          >
            Dispatch (fake)
          </PillButton>
        )}
        {hasOpenRun && run !== undefined && (
          <PillButton onClick={() => onOpenSession(run.id)}>
            {doc.meta.status === 'review' ? 'Review run' : 'View run'}
          </PillButton>
        )}
        {isEpic && (
          <PillButton onClick={() => setShowGraph(true)}>
            <Waypoints />
            View graph
          </PillButton>
        )}
        {onEnrich !== undefined && (
          // Deliberately outside the ready/hasOpenRun gate: a blocked or not-yet-ready
          // task is precisely the one worth specifying properly before an agent gets to it.
          <Button
            variant="ghost"
            size="sm"
            disabled={enriching}
            onClick={() => void enrich()}
          >
            <Sparkles />
            {enriching ? 'Reading the repo…' : 'Add detail'}
          </Button>
        )}
        {enrichError !== null && (
          <span className="text-red font-book text-[12px]">{enrichError}</span>
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

      <TaskDescription
        description={description}
        acceptance={acceptance}
        onSaveDescription={(next) => void patch({ description: next })}
        onSaveAcceptance={(next) => void patch({ acceptanceCriteria: next })}
      />

      <AttachmentsRow
        taskId={doc.meta.id}
        attachments={doc.meta.attachments ?? []}
        client={client}
        port={port}
        editable={!archived}
        upload={attachmentUpload.upload}
        uploading={attachmentUpload.uploading}
        inputRef={attachmentInputRef}
      />

      {amendments !== '' && (
        <MainSection title="Amendments">
          <p className="text-muted-foreground font-book text-[13px] whitespace-pre-wrap">
            {amendments}
          </p>
        </MainSection>
      )}

      {isEpic && (
        <SubtasksBlock
          parent={doc}
          tasks={epicChildren}
          latestRunByTaskId={latestRunByTaskId}
          onOpenTask={onOpenTask}
          createPreset={{ epic: doc.meta.id }}
        />
      )}
      {dependents.length > 0 && (
        <SubtasksBlock
          title="Blocks"
          parent={doc}
          tasks={dependents}
          latestRunByTaskId={latestRunByTaskId}
          onOpenTask={onOpenTask}
        />
      )}

      {ledgerError !== null && (
        <LoadError>Couldn&rsquo;t load the ledger: {ledgerError}</LoadError>
      )}
      <LedgerSection entries={ledgerEntries} />

      {fixLoopError !== null && (
        <LoadError>Couldn&rsquo;t load the fix loop: {fixLoopError}</LoadError>
      )}
      <FixLoopSection
        fixLoop={fixLoop}
        escalation={fixLoopEscalation}
        onStart={() => void handleStartFixLoop()}
        onStop={() => void stopFixLoop(doc.meta.id)}
        starting={startingFixLoop}
        startError={startFixLoopError}
      />

      {findingsError !== null && (
        <LoadError>
          Couldn&rsquo;t load findings: {findingsError}
          {fixLoopNeedsRuling(fixLoop) &&
            ' Open findings can’t be ruled on right now.'}
        </LoadError>
      )}
      <FindingsPanel
        findings={findings}
        needsRuling={fixLoopNeedsRuling(fixLoop)}
        onAdjudicate={async (findingId, input) => {
          await adjudicateFinding(doc.meta.id, findingId, input);
        }}
      />

      <SessionsBlock runs={runs} onOpenSession={onOpenSession} />

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

      <ActivitySection
        entries={activity}
        onSubmitNote={(text) => {
          const note = notePatch(text);
          if (note !== null) void patch(note);
        }}
        onAttach={
          !archived && client !== null
            ? () => attachmentInputRef.current?.click()
            : undefined
        }
      />
    </div>
  );

  return (
    <div
      ref={rootRef}
      data-slot="task-page"
      data-mode={mode}
      className="@container/task-page flex h-full min-h-0 flex-col"
    >
      {mode === 'page' ? (
        <PageHeader
          crumb={crumb}
          star={star}
          actions={headerActions}
          tabs={tabs}
          controls={controls}
        />
      ) : (
        <div
          data-slot="task-peek-chrome"
          className="shadow-hairline-bottom text-muted-foreground flex h-10 shrink-0 items-center gap-1.5 pr-2 pl-4 text-[12px] font-medium"
        >
          <div className="flex min-w-0 flex-1 items-center gap-1.5">
            {crumb.map((segment, index) => (
              <span key={index} className="flex min-w-0 items-center gap-1.5">
                {index > 0 && <span aria-hidden>›</span>}
                <span
                  className={cn(
                    'flex min-w-0 items-center truncate',
                    index === crumb.length - 1 && 'text-foreground'
                  )}
                >
                  {segment}
                </span>
              </span>
            ))}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {headerActions}
          </div>
        </div>
      )}

      <div className="flex min-h-0 flex-1">
        <div data-slot="task-main" className="min-w-0 flex-1 overflow-y-auto">
          {children !== undefined ? (
            <div className="flex h-full min-h-0 flex-col">{children}</div>
          ) : (
            // The 120px inset is measured against the whole panel (page or peek), not
            // the column left over beside the rail, so a 1440px laptop still gets it.
            <div className="px-6 py-6 @min-[1100px]/task-page:pl-[120px]">
              <div className="max-w-[800px]">{detailsBody}</div>
            </div>
          )}
        </div>
        {sidePanelOpen && children === undefined && (
          <PropertiesRail
            doc={doc}
            statuses={statuses}
            epics={epics}
            tasks={tasks}
            run={run}
            latestRunByTaskId={latestRunByTaskId}
            hasStack={hasStack}
            onChangeStatus={(status) => void changeStatus(status)}
            onPatch={(next) => void patch(next)}
            onOpenTask={onOpenTask}
            picker={picker}
            onPickerChange={setPicker}
            linearLink={linearLink}
            linearLinked={linearLinked}
            onPushToLinear={
              linearConfigured && onPushToLinear !== undefined
                ? () => void pushToLinear()
                : undefined
            }
            pushingLinear={pushingLinear}
            pushedLinear={pushedLinear}
          />
        )}
      </div>

      {isEpic && (
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

// A quiet one-liner for a section whose data failed to load — not a banner.
function LoadError({ children }: { children: ReactNode }) {
  return (
    <p data-slot="load-error" className="text-red font-book text-[12px]">
      {children}
    </p>
  );
}
