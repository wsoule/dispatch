import type { Priority } from '@dispatch-foo/core/browser';
import type {
  ConfirmResult,
  PlannedTask,
  PlannerQuestion,
  PlanState,
  ProposalAction,
} from '@dispatch/client';
import {
  Check,
  CircleAlert,
  History,
  Link2,
  Maximize2,
  Plus,
  Rows3,
  Trash2,
  Waypoints,
  Zap,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import { DependencyGraph } from '../components/graph/DependencyGraph';
import { PlanQuestionsForm } from '../components/plans/PlanQuestionsForm';
import { PlanTaskSpecDialog } from '../components/plans/PlanTaskSpecDialog';
import { Markdown } from '../components/runs/Markdown';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useToasts } from '../components/shell/Toasts';
import { PriorityIcon } from '../components/tasks/PriorityIcon';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import {
  modelLabel,
  MODELS,
  readRoleModelOverride,
  resolveRoleModel,
  storeRoleModelOverride,
} from '../lib/models';
import type { PlanDraft, PlanThreadItem } from '../lib/planThread';
import {
  buildPlanThread,
  editPlanDraft,
  syncPlanDraft,
} from '../lib/planThread';
import { priorityLabel } from '../lib/taskDisplay';
import { cn } from '@/lib/utils';
import { ListRow } from '@/ui/ai/list-row';
import { PageHeader } from '@/ui/ai/page-header';
import { Pill, PillButton } from '@/ui/ai/pill';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';
import { EmptyState, SectionLabel } from '@/ui/chrome';
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import { ToggleGroup, ToggleGroupItem } from '@/ui/toggle-group';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

/** The models the composer offers, in `PromptBar`'s shape. */
const COMPOSER_MODELS = MODELS.map((m) => ({ id: m.id, label: m.label }));

/** Small colored dot for a history entry's plan state — the brief's "status = a dot, not a
 * text pill" rule, on the run-state tokens. */
function PlanStateDot({ state }: { state: PlanState | 'unknown' }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'ready' && 'bg-state-review',
        state === 'failed' && 'bg-state-failed',
        state === 'running' && 'bg-state-working',
        state === 'unknown' && 'bg-muted-foreground/40'
      )}
    />
  );
}

/** An inline failure line — a turn dispatchd refused, a confirm that threw. */
function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div className="bg-state-failed-surface text-state-failed rounded-control flex items-start gap-2 px-3 py-2 text-[13px]">
      <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
      <span>{children}</span>
    </div>
  );
}

/** One turn of the plan conversation. The planner's replies are markdown (same agent, same
 * output style as a run's transcript, so they get the same renderer); the user's own text is
 * shown verbatim, since it was typed as prose and not as markup. */
function PlanMessageBubble({
  role,
  text,
  at,
}: {
  role: 'user' | 'assistant';
  text: string;
  at: string;
}) {
  const fromUser = role === 'user';
  return (
    <div
      className={cn(
        'rounded-card flex max-w-[85%] flex-col gap-1 px-3 py-2',
        // Neutral surfaces both ways — a wall of saturated bubbles was the
        // loudest surface in the app, and the words are the point.
        fromUser
          ? 'bg-surface-secondary shadow-hairline self-end'
          : 'bg-surface-quaternary shadow-card self-start'
      )}
    >
      <div className="text-muted-foreground flex items-baseline gap-1.5 text-[12px] font-medium">
        {fromUser ? 'You' : 'Planner'}
        <span className="font-book">{formatRelativeTimeFromIso(at)}</span>
      </div>
      {fromUser ? (
        <p className="font-book text-[13px] whitespace-pre-wrap">{text}</p>
      ) : (
        <Markdown content={text} className="text-[13px]" />
      )}
    </div>
  );
}

interface PlanConversationProps {
  items: PlanThreadItem[];
  /** A turn is in flight — dispatchd rejects a second message until it lands. */
  busy: boolean;
  /** This plan's tasks are already written, so the conversation is closed. */
  confirmed: boolean;
  /** The latest turn's clarifying questions, if any — rendered as an answerable form above
   * the composer. */
  questions: PlannerQuestion[];
  onSend: (text: string) => Promise<void>;
}

/**
 * The plan's transcript plus the follow-up composer that keeps it going: every turn the
 * planner has answered, the live turn's spinner or error as its own trailing row, and a
 * composer that posts the next message onto the same conversation. Owns its own draft/sending
 * state the way the run session composer does — the view above only supplies the transcript
 * and the send call.
 */
function PlanConversation({
  items,
  busy,
  confirmed,
  questions,
  onSend,
}: PlanConversationProps) {
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  // Pin the transcript to the newest turn. Keyed on the last row's identity as well as the
  // row count because a turn settling in place (the `pending` spinner becoming a `failed`
  // row) changes what's at the bottom without changing how many rows there are.
  const lastKey = items.length > 0 ? items[items.length - 1].key : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [items.length, lastKey]);

  async function submit() {
    const message = text.trim();
    // `busy`/`sending` are re-checked here, not just on the Send button: the composer stays
    // editable mid-turn (drafting the next ask while the planner works is the whole point of
    // a conversation), so Enter must not slip a message past a turn dispatchd would 409.
    if (message === '' || busy || sending) return;
    setSending(true);
    setError(null);
    try {
      await onSend(message);
      setText('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={scrollRef}
        role="log"
        aria-label="Plan conversation"
        className="flex max-h-[22rem] flex-col gap-2 overflow-y-auto"
      >
        {items.map((item) => {
          if (item.kind === 'pending') {
            return (
              <div
                key={item.key}
                className="bg-surface-quaternary text-muted-foreground rounded-control font-book flex items-center gap-2 self-start px-3 py-2 text-[13px]"
              >
                <Spinner className="text-state-working size-3.5" />
                Planning — reading the codebase and updating the proposal…
              </div>
            );
          }
          if (item.kind === 'failed') {
            return (
              <div key={item.key} className="self-start">
                <ErrorLine>{item.error}</ErrorLine>
              </div>
            );
          }
          return (
            <PlanMessageBubble
              key={item.key}
              role={item.role}
              text={item.text}
              at={item.at}
            />
          );
        })}
      </div>

      {!confirmed && questions.length > 0 && (
        <PlanQuestionsForm
          questions={questions}
          disabled={busy || sending}
          onSend={onSend}
        />
      )}

      <div className="flex flex-col gap-1.5">
        {error !== null && <ErrorLine>{error}</ErrorLine>}
        <span className="text-muted-foreground font-book text-[12px]">
          {confirmed
            ? 'Confirmed. Tasks are created. Start a new plan to keep going.'
            : busy
              ? 'The planner is answering…'
              : 'Ask for a change. The proposal updates.'}
        </span>
        {!confirmed && (
          // Disabled for the whole turn, not just the send: the composer is the
          // primitive's, and a Send that looks live against a turn dispatchd
          // would 409 is the worse of the two.
          <PromptBar
            value={text}
            onChange={setText}
            onSubmit={() => void submit()}
            disabled={busy || sending}
            placeholder="Split a task, add one, change the order…"
            ariaLabel="Follow-up message"
          />
        )}
      </div>
    </div>
  );
}

interface PlanTaskRowProps {
  task: PlannedTask;
  index: number;
  allTasks: PlannedTask[];
  /** Every field edit goes through `reduceProposal`'s own action type rather than a loose
   * patch object, so the row and the reducer can never disagree about what an edit means. */
  onEdit: (action: ProposalAction) => void;
  onRemove: (index: number) => void;
  /** Expands a task (this one, or a blocker named in its chips) into the full spec dialog. */
  onExpand: (index: number) => void;
}

/** One card of the proposal review list: a quaternary `shadow-card` card with a sans `Pill`
 * index beside the borderless editable title and muted description, then a hairline-topped
 * footer holding the blocked-by pills on the left and the priority/expand/remove controls on
 * the right. Blocker titles are looked up live off the current draft so an edited blocker's
 * new title shows immediately in its dependents' rows. */
function PlanTaskRow({
  task,
  index,
  allTasks,
  onEdit,
  onRemove,
  onExpand,
}: PlanTaskRowProps) {
  return (
    <div className="bg-surface-quaternary rounded-card shadow-card group/plan-task flex flex-col overflow-hidden">
      <div className="flex items-start gap-2.5 px-3 pt-3 pb-2.5">
        <Pill className="text-muted-foreground shrink-0 px-1.5 tabular-nums">
          {index + 1}
        </Pill>
        <div className="min-w-0 flex-1">
          <Input
            variant="borderless"
            value={task.title}
            onChange={(e) =>
              onEdit({ type: 'setTaskTitle', index, title: e.target.value })
            }
            aria-label={`Task ${String(index + 1)} title`}
            className="h-6 w-full min-w-0 text-[13px] font-medium"
          />
          <Textarea
            variant="borderless"
            rows={2}
            value={task.description}
            onChange={(e) =>
              onEdit({
                type: 'setTaskDescription',
                index,
                description: e.target.value,
              })
            }
            aria-label={`Task ${String(index + 1)} description`}
            className="text-muted-foreground mt-1 min-h-0 resize-none text-[13px] leading-relaxed"
          />
        </div>
      </div>

      <div className="shadow-hairline-top flex items-center gap-2 px-3 py-1.5">
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5">
          {task.blockedByIndices.length > 0 && (
            <>
              <Link2 className="text-muted-foreground size-3 shrink-0" />
              {task.blockedByIndices.map((blockerIndex) => {
                const title = allTasks[blockerIndex]?.title;
                if (title === undefined) return null;
                return (
                  <button
                    key={blockerIndex}
                    type="button"
                    onClick={() => onExpand(blockerIndex)}
                    aria-label={`Expand task ${String(blockerIndex + 1)}`}
                    className="rounded-pill focus-visible:ring-ring focus-visible:ring-2 focus-visible:outline-none"
                  >
                    <Pill
                      title={title}
                      className="hover:bg-surface-active max-w-[11rem] cursor-pointer"
                    >
                      <span className="text-muted-foreground font-book shrink-0 tabular-nums">
                        #{blockerIndex + 1}
                      </span>
                      <span className="truncate">{title}</span>
                    </Pill>
                  </button>
                );
              })}
            </>
          )}
        </div>
        <Select
          value={task.priority}
          onValueChange={(value) =>
            onEdit({
              type: 'setTaskPriority',
              index,
              priority: value as Priority,
            })
          }
        >
          {/* No icon of its own: SelectValue already renders the selected
              item's icon+label — a second icon was how the trigger ended up
              double-glyphed and clipped. */}
          <SelectTrigger
            aria-label={`Task ${String(index + 1)} priority`}
            className="w-[7.5rem] shrink-0 border-transparent bg-transparent"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent align="end">
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                <PriorityIcon priority={p} />
                <span>{priorityLabel(p)}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onExpand(index)}
          aria-label={`Expand task ${String(index + 1)}`}
          className="shrink-0 opacity-0 transition-opacity duration-100 group-focus-within/plan-task:opacity-100 group-hover/plan-task:opacity-100"
        >
          <Maximize2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(index)}
          aria-label={`Remove task ${String(index + 1)}`}
          className="hover:text-red shrink-0 opacity-0 transition-opacity duration-100 group-focus-within/plan-task:opacity-100 group-hover/plan-task:opacity-100"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>
    </div>
  );
}

/** The list row's text for a free-form plan: the ask's own first line. */
function firstPromptLine(prompt: string): string {
  return prompt.split('\n', 1)[0] ?? '';
}

interface PlansViewProps {
  data: DispatchProjectData;
  /** The active project's display name — the header's `Project › Plans` crumb. */
  projectName?: string;
  /** Navigates to the board — a flat plan's confirm toast's "View board" action. */
  onGoToBoard: () => void;
  /** Opens the Tasks page's milestones layout on the epic a plan created — the confirm
   * toast's "Open milestone", a history row's `→ milestone`, and with `dispatch` the
   * fan-out dialog there ("Create & send agents…"). */
  onOpenMilestone: (epicId: string, opts?: { dispatch?: boolean }) => void;
  /**
   * Text to open the composer with, when the user arrived here from somewhere that already had
   * the words — "hand it to the planner" in Brain dump, or "plan it" on a single inbox item.
   * Seeded once on mount rather than kept in sync, so arriving with a seed and then editing it
   * does not fight the prop on every re-render.
   */
  initialPrompt?: string;
}

/**
 * The plan-work flow as its own primary view rather than a modal: a composer at top
 * ("Describe the work…") until a plan is open, then that plan's conversation — every turn of
 * it, plus a follow-up composer — with the latest proposal below as an editable review list,
 * and this session's plan history at the bottom. Planning is a conversation, so the proposal
 * on screen is whatever the newest turn produced: a follow-up ("split task 3", "drop the
 * migration") re-renders the review list in place rather than starting a second plan.
 */
export function PlansView({
  data,
  projectName,
  onGoToBoard,
  onOpenMilestone,
  initialPrompt,
}: PlansViewProps) {
  const toasts = useToasts();
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  // The model the next plan opens on. The human's own pick is remembered per
  // device (so "always Fable" sticks); until they pick, the project's
  // configured `models.plan` shows. An open plan keeps the model it started
  // on, which is what the thread header names.
  const [chosenModel, setChosenModel] = useState<string | null>(
    () => readRoleModelOverride('plan') ?? null
  );
  const planModel = chosenModel ?? resolveRoleModel('plan', data.config);
  function pickModel(id: string) {
    setChosenModel(id);
    storeRoleModelOverride('plan', id);
  }
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The editable proposal plus its per-row keys and the server proposal it came from — see
  // `PlanDraft`, which owns the "a later turn refined the plan, adopt it / a poll returned
  // the same plan, keep my edits" rule this view used to approximate with `prev ?? proposal`.
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  // Which proposal task is expanded into the full spec dialog (by index), and whether the
  // proposal renders as the editable list or the dependency graph.
  const [specIndex, setSpecIndex] = useState<number | null>(null);
  const [proposalView, setProposalView] = useState<'list' | 'graph'>('list');

  // The proposal projected onto the shared graph shape. Drafts have no task ids, so nodes
  // are keyed by proposal index; `created` is the same index (zero-padded) purely as the
  // layout's deterministic tie-break.
  const graphTasks = useMemo(() => {
    if (draft === null) return [];
    return draft.proposal.tasks.map((task, i) => ({
      id: String(i),
      title: task.title.trim() === '' ? `Task ${i + 1}` : task.title,
      status: 'draft',
      created: String(i).padStart(4, '0'),
      blockedBy: task.blockedByIndices.map(String),
    }));
  }, [draft]);

  // Folds each turn's proposal into the editable draft as the conversation
  // produces it. History is server truth now — no snapshot to keep fresh.
  useEffect(() => {
    if (data.planId === null || data.planRecord === undefined) return;
    const planId = data.planId;
    const planRecord = data.planRecord;
    if (planRecord.state === 'ready' && planRecord.proposal) {
      const proposal = planRecord.proposal;
      setDraft((prev) => syncPlanDraft(prev, proposal, planId));
    }
  }, [data.planId, data.planRecord]);

  const thread = useMemo(
    () => buildPlanThread(data.planRecord),
    [data.planRecord]
  );

  async function submitPrompt() {
    if (prompt.trim() === '') return;
    setSubmitting(true);
    setSubmitError(null);
    setDraft(null);
    try {
      await data.handleSubmitPrompt(prompt.trim(), planModel);
      setPrompt('');
    } catch (err) {
      setSubmitError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  function applyEdit(action: ProposalAction) {
    setDraft((prev) => (prev === null ? prev : editPlanDraft(prev, action)));
  }

  async function sendFollowUp(text: string) {
    await data.handleSendPlanMessage(text);
  }

  // Writes the proposal. A plan with an epic lands on its milestone: the toast links there,
  // and `sendAgents` goes straight on to the fan-out dialog. A flat plan links to the board.
  // App's action-feedback wrapper resolves a failed confirm to `undefined` after toasting
  // the error itself, so that case leaves the review list up without a second toast.
  async function submitConfirm(sendAgents = false) {
    if (draft === null) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const count = draft.proposal.tasks.length;
      const tasks = `${count} ${count === 1 ? 'task' : 'tasks'}`;
      const result: ConfirmResult | undefined = await data.handleConfirmPlan(
        draft.proposal
      );
      if (result === undefined) return;
      const epicId = result.epicId;
      if (epicId !== undefined) {
        toasts.push({
          tone: 'success',
          title: `Milestone created · ${tasks}`,
          action: {
            label: 'Open milestone',
            onClick: () => onOpenMilestone(epicId),
          },
        });
      } else {
        toasts.push({
          tone: 'success',
          title: `${tasks} created`,
          action: { label: 'View board', onClick: onGoToBoard },
        });
      }
      closePlan();
      if (sendAgents && epicId !== undefined) {
        onOpenMilestone(epicId, { dispatch: true });
      }
    } catch (err) {
      setConfirmError(err instanceof Error ? err.message : String(err));
    } finally {
      setConfirming(false);
    }
  }

  /** Closes whatever plan is open and returns the view to its "start a new plan" state.
   * Clearing the draft matters as much as clearing the id: a draft left behind would be
   * re-adopted the moment another plan's proposal arrived. */
  function closePlan() {
    setDraft(null);
    setConfirmError(null);
    setSpecIndex(null);
    data.setPlanId(null);
  }

  function openHistoryEntry(planId: string) {
    setDraft(null);
    setConfirmError(null);
    setSpecIndex(null);
    data.setPlanId(planId);
  }

  // A plan whose tasks are already written (reopened from history): dispatchd 409s both a
  // follow-up turn and a second confirm, so the UI says so instead of offering either.
  const planConfirmed = data.planRecord?.confirmedAt !== undefined;

  // A composer that submits against a dead daemon would just hang on "Starting…" forever
  // (`handleSubmitPrompt` throws once `client` is null, but only *after* the click) — show
  // the same daemon-unavailable state every other primary view shows instead of a live
  // composer with nothing behind it (I4).
  const crumb = projectName !== undefined ? [projectName, 'Plans'] : ['Plans'];

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <div className="flex h-full min-h-0 flex-col">
        <PageHeader crumb={crumb} />
        <div className="px-6 py-4">
          <DaemonUnavailable
            starting={data.portLoading}
            errorDetail={data.portErrorDetail}
            onRetry={data.retryEnsureDispatchd}
          />
        </div>
      </div>
    );
  }

  // A turn is in flight: dispatchd rejects both a second follow-up and a confirm until the
  // planner's reply lands, so every control that would 409 is disabled while this holds.
  const turnRunning =
    data.planId !== null &&
    (data.planRecord === undefined || data.planRecord.state === 'running');
  // The opening turn, which has no proposal to show underneath it yet — the only time the
  // review-list skeleton is the right stand-in (a later turn refines a plan that's already
  // on screen, and replacing it with a skeleton would throw that context away).
  const awaitingFirstProposal = turnRunning && draft === null;
  // Confirm is gated on the *record*, not on having a draft on screen: a turn that fails
  // leaves the previous turn's proposal in place (so the review list rightly stays up), but
  // dispatchd refuses to confirm any plan that isn't `ready`, so the button would 409.
  const canConfirm = data.planRecord?.state === 'ready' && !planConfirmed;
  // Both confirm buttons follow the one rule.
  const confirmDisabled =
    confirming || !canConfirm || (draft?.proposal.tasks.length ?? 0) === 0;
  // Why the review list may not be confirmable right now — the review list is the last
  // proposal the planner sent either way, so it stays on screen and this line says what
  // changed underneath it.
  const reviewNotice = turnRunning
    ? 'The planner is revising. Edits here get replaced when the new version lands.'
    : data.planRecord?.state === 'failed'
      ? 'That turn failed. Send another message to retry.'
      : null;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        crumb={crumb}
        actions={
          <>
            {data.planRecord?.model !== undefined && (
              <span className="text-muted-foreground font-book px-2 text-[12px]">
                Planning on {modelLabel(data.planRecord.model)}
              </span>
            )}
            {data.planId !== null && (
              <Button variant="ghost" size="sm" onClick={closePlan}>
                <Plus className="size-3.5" /> New plan
              </Button>
            )}
          </>
        }
      />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
        <div className="mx-auto flex w-full max-w-[800px] flex-col gap-6 pb-8">
          {data.planId === null ? (
            <div className="flex flex-col gap-3">
              {submitError !== null && <ErrorLine>{submitError}</ErrorLine>}
              {/* Which model the plan opens on — remembered per device, so "always
              Fable" sticks. An open plan keeps the model it started on. */}
              <PromptBar
                value={prompt}
                onChange={setPrompt}
                onSubmit={() => void submitPrompt()}
                disabled={submitting}
                placeholder="Describe the work…"
                ariaLabel="Describe the work"
                models={COMPOSER_MODELS}
                modelId={planModel}
                onModelChange={pickModel}
              />
              {submitting && (
                <span className="text-muted-foreground font-book flex items-center gap-2 text-[12px]">
                  <Spinner className="text-state-working size-3.5" /> Starting…
                </span>
              )}
            </div>
          ) : (
            thread.length > 0 && (
              // Keyed by plan so opening a different one starts with an empty composer rather
              // than the half-typed follow-up meant for the plan the user just left.
              <PlanConversation
                key={data.planId}
                items={thread}
                busy={turnRunning}
                confirmed={planConfirmed}
                questions={data.planRecord?.questions ?? []}
                onSend={sendFollowUp}
              />
            )
          )}

          {awaitingFirstProposal && (
            // Shape-only: the conversation's own pending row above already says the planner is
            // working, so this is where the epic and its tasks are *going* to be and nothing more
            // — a second "Planning…" line here just says the same thing twice.
            <div className="flex flex-col gap-2" aria-hidden="true">
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
              <Skeleton className="h-14 w-full" />
            </div>
          )}

          {draft !== null && (
            <div className="flex flex-col gap-4">
              {confirmError !== null && <ErrorLine>{confirmError}</ErrorLine>}

              {reviewNotice !== null && (
                <div className="text-muted-foreground font-book flex items-center gap-2 text-[12px]">
                  {turnRunning ? (
                    <Spinner className="text-state-working size-3.5 shrink-0" />
                  ) : (
                    <CircleAlert className="text-state-failed size-3.5 shrink-0" />
                  )}
                  <span>{reviewNotice}</span>
                </div>
              )}

              {draft.proposal.epic !== undefined && (
                <div className="bg-surface-quaternary rounded-card shadow-card flex flex-col gap-1 p-3">
                  <SectionLabel>Milestone</SectionLabel>
                  <Input
                    variant="borderless"
                    value={draft.proposal.epic.title}
                    onChange={(e) =>
                      applyEdit({ type: 'setEpicTitle', title: e.target.value })
                    }
                    aria-label="Epic title"
                    className="text-[15px] font-semibold"
                  />
                  <Textarea
                    variant="borderless"
                    rows={2}
                    value={draft.proposal.epic.description}
                    onChange={(e) =>
                      applyEdit({
                        type: 'setEpicDescription',
                        description: e.target.value,
                      })
                    }
                    aria-label="Epic description"
                    className="text-muted-foreground min-h-0 resize-y text-[13px]"
                  />
                </div>
              )}

              {draft.proposal.tasks.length > 1 && (
                <div className="flex justify-end">
                  <ToggleGroup
                    variant="outline"
                    size="sm"
                    value={[proposalView]}
                    onValueChange={([value]) => {
                      // The group hands back an empty list when the active item is
                      // re-clicked; a proposal is always one of the two views, so
                      // ignore the deselect.
                      if (value === 'list' || value === 'graph')
                        setProposalView(value);
                    }}
                    aria-label="Proposal layout"
                  >
                    <ToggleGroupItem value="list" aria-label="List view">
                      <Rows3 className="size-3.5" /> List
                    </ToggleGroupItem>
                    <ToggleGroupItem value="graph" aria-label="Graph view">
                      <Waypoints className="size-3.5" /> Graph
                    </ToggleGroupItem>
                  </ToggleGroup>
                </div>
              )}

              {proposalView === 'graph' && draft.proposal.tasks.length > 1 ? (
                <div className="p-4">
                  <DependencyGraph
                    tasks={graphTasks}
                    refFor={(id) => `#${Number(id) + 1}`}
                    accessoryFor={(id) => {
                      const task = draft.proposal.tasks[Number(id)];
                      return task === undefined ? undefined : (
                        <PriorityIcon priority={task.priority} />
                      );
                    }}
                    onOpenNode={(id) => setSpecIndex(Number(id))}
                    ariaLabel="Plan dependency graph"
                  />
                </div>
              ) : (
                <div className="flex flex-col gap-2">
                  {draft.proposal.tasks.map((task, i) => (
                    <PlanTaskRow
                      key={draft.taskKeys[i] ?? i}
                      task={task}
                      index={i}
                      allTasks={draft.proposal.tasks}
                      onEdit={applyEdit}
                      onRemove={(index) =>
                        applyEdit({ type: 'removeTask', index })
                      }
                      onExpand={setSpecIndex}
                    />
                  ))}
                </div>
              )}

              <PlanTaskSpecDialog
                index={specIndex}
                tasks={draft.proposal.tasks}
                onOpenIndex={setSpecIndex}
                onClose={() => setSpecIndex(null)}
              />

              <div className="shadow-hairline-top flex items-center justify-end gap-2 pt-3">
                <Button
                  variant="ghost"
                  onClick={closePlan}
                  disabled={confirming}
                >
                  Cancel
                </Button>
                {/* Only a plan with an epic has a milestone to send agents at. */}
                {draft.proposal.epic !== undefined && (
                  <Button
                    variant="ghost"
                    disabled={confirmDisabled}
                    onClick={() => void submitConfirm(true)}
                  >
                    <Zap className="size-3.5" /> Create & send agents…
                  </Button>
                )}
                <Button
                  disabled={confirmDisabled}
                  onClick={() => void submitConfirm()}
                >
                  {confirming ? (
                    <>
                      <Spinner className="size-3.5" /> Creating…
                    </>
                  ) : planConfirmed ? (
                    <>
                      <Check className="size-3.5" /> Tasks created
                    </>
                  ) : (
                    <>
                      <Check className="size-3.5" /> Create tasks
                    </>
                  )}
                </Button>
              </div>
            </div>
          )}

          <div className="flex flex-col gap-2">
            <SectionLabel>History</SectionLabel>
            {data.plans.length === 0 ? (
              <EmptyState icon={History} heading="No plans yet" />
            ) : (
              <div
                role="list"
                aria-label="Plans"
                className="bg-surface-quaternary rounded-card shadow-card [&>*+*]:shadow-hairline-top flex flex-col overflow-hidden"
              >
                {data.plans.map((entry) => {
                  const epicId = entry.epicId;
                  return (
                    // The shared 36px row (a list item, not a grid row): the `→ milestone`
                    // pill is a real button that never opens the entry.
                    <ListRow
                      key={entry.id}
                      role="listitem"
                      aria-current={
                        entry.id === data.planId ? 'true' : undefined
                      }
                      selected={entry.id === data.planId}
                      onClick={() => openHistoryEntry(entry.id)}
                      leading={<PlanStateDot state={entry.state} />}
                      title={entry.subject ?? firstPromptLine(entry.prompt)}
                      trailing={
                        <>
                          {epicId !== undefined && (
                            <PillButton
                              className="h-6 px-2"
                              onClick={(e) => {
                                e.stopPropagation();
                                onOpenMilestone(epicId);
                              }}
                            >
                              → milestone
                            </PillButton>
                          )}
                          <span className="text-muted-foreground font-book shrink-0 text-[12px] capitalize">
                            {entry.confirmedAt !== undefined
                              ? 'confirmed'
                              : entry.state}
                          </span>
                        </>
                      }
                      date={formatRelativeTimeFromIso(entry.updatedAt)}
                      className="rounded-none"
                    />
                  );
                })}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
