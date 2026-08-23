import type {
  PlannedTask,
  PlannerQuestion,
  PlanState,
  ProposalAction,
} from '@dispatch/client';
import type { Priority } from '@dispatch/core/browser';
import {
  AlertTriangle,
  Check,
  CircleAlert,
  History,
  Link2,
  Maximize2,
  Minus,
  Plus,
  Rows3,
  Send,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Trash2,
  Waypoints,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { DependencyGraph } from '../components/graph/DependencyGraph';
import { PlanQuestionsForm } from '../components/plans/PlanQuestionsForm';
import { PlanTaskSpecDialog } from '../components/plans/PlanTaskSpecDialog';
import { Markdown } from '../components/runs/Markdown';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import { useToasts } from '../components/shell/Toasts';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { PlanDraft, PlanThreadItem } from '../lib/planThread';
import {
  buildPlanThread,
  editPlanDraft,
  syncPlanDraft,
} from '../lib/planThread';
import { cn } from '@/lib/utils';
import { Badge } from '@/ui/badge';
import { Button } from '@/ui/button';
import { EmptyState } from '@/ui/chrome';
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

/** Small color-coded lucide icon in place of a text pill — only urgent/high get a color
 * treatment (matches `priorityTone`'s "don't compete for attention" rule elsewhere in the
 * app); medium/low/none stay a muted, silent icon shape. */
function PriorityIcon({
  priority,
  className,
}: {
  priority: Priority;
  className?: string;
}) {
  switch (priority) {
    case 'urgent':
      return <AlertTriangle className={cn('text-destructive', className)} />;
    case 'high':
      return (
        <SignalHigh
          className={cn('text-amber-500 dark:text-amber-400', className)}
        />
      );
    case 'medium':
      return (
        <SignalMedium className={cn('text-muted-foreground', className)} />
      );
    case 'low':
      return <SignalLow className={cn('text-muted-foreground', className)} />;
    case 'none':
      return <Minus className={cn('text-muted-foreground/60', className)} />;
  }
}

/** Small colored dot for a history entry's plan state — the brief's "status = a dot, not a
 * text pill" rule. `running` pulses (mirrors the Board's live-run pulse) since it's the one
 * state that's actively changing underneath the user. */
function PlanStateDot({ state }: { state: PlanState | 'unknown' }) {
  return (
    <span
      className={cn(
        'size-1.5 shrink-0 rounded-full',
        state === 'ready' && 'bg-emerald-500',
        state === 'failed' && 'bg-destructive',
        state === 'running' && 'bg-primary animate-pulse',
        state === 'unknown' && 'bg-muted-foreground/40'
      )}
    />
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
        'rounded-control flex max-w-[85%] flex-col gap-1 px-3 py-2',
        // A quiet tint, not a solid fill — a wall of saturated bubbles was the
        // loudest surface in the app, and the words are the point.
        fromUser
          ? 'bg-primary/10 shadow-hairline self-end'
          : 'bg-card shadow-hairline self-start'
      )}
    >
      <div
        className={cn(
          'flex items-baseline gap-1.5 text-[11px] font-medium tracking-wide uppercase',
          fromUser ? 'text-primary' : 'text-muted-foreground'
        )}
      >
        {fromUser ? 'You' : 'Planner'}
        <span className="font-normal normal-case opacity-70">
          {formatRelativeTimeFromIso(at)}
        </span>
      </div>
      {fromUser ? (
        <p className="text-[13px] whitespace-pre-wrap">{text}</p>
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
    <div className="bg-card rounded-card shadow-card animate-in fade-in-0 flex flex-col gap-3 p-4 duration-150">
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
                className="bg-surface-inset text-muted-foreground shadow-hairline rounded-control flex items-center gap-2 self-start px-3 py-2 text-[13px]"
              >
                <Spinner className="text-primary size-3.5" />
                Planning — reading the codebase and updating the proposal…
              </div>
            );
          }
          if (item.kind === 'failed') {
            return (
              <div
                key={item.key}
                className="bg-state-failed-surface text-state-failed rounded-control flex items-start gap-2 self-start px-3 py-2 text-[13px]"
              >
                <CircleAlert className="size-4 shrink-0 translate-y-0.5" />
                <span>{item.error}</span>
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

      <div className="shadow-hairline-top flex flex-col gap-1.5 pt-3">
        {error !== null && (
          <div className="bg-state-failed-surface text-state-failed rounded-control flex items-center gap-2 px-3 py-2 text-[13px]">
            <CircleAlert className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <span className="text-muted-foreground text-[11px]">
          {confirmed
            ? 'Confirmed. Tasks are created. Start a new plan to keep going.'
            : busy
              ? 'The planner is answering…'
              : 'Ask for a change. The proposal updates.'}
        </span>
        {!confirmed && (
          <div className="flex gap-2">
            <Textarea
              rows={2}
              placeholder="Split a task, add one, change the order…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              aria-label="Follow-up message"
              className="min-h-0 flex-1 resize-none text-[13px]"
            />
            <Button
              disabled={busy || sending || text.trim() === ''}
              onClick={() => void submit()}
              className="self-end"
            >
              {sending ? (
                <>
                  <Spinner className="size-4" /> Sending…
                </>
              ) : (
                <>
                  <Send className="size-4" /> Send
                </>
              )}
            </Button>
          </div>
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

/** One card of the proposal review list, in the ai components' RecommendationCard shape:
 * a round accent-tinted badge (the task's number) beside the editable title and muted
 * description, then one inset top-bordered footer strip holding the blocked-by chips on the
 * left and the priority/expand/remove controls on the right. Blocker titles are looked up
 * live off the current draft so an edited blocker's new title shows immediately in its
 * dependents' rows. */
function PlanTaskRow({
  task,
  index,
  allTasks,
  onEdit,
  onRemove,
  onExpand,
}: PlanTaskRowProps) {
  return (
    <div className="bg-card rounded-card shadow-card group/plan-task flex flex-col overflow-hidden">
      <div className="flex items-start gap-2.5 px-4 pt-3 pb-2.5">
        <span className="bg-accent-tint text-primary flex size-7 shrink-0 items-center justify-center rounded-full font-mono text-[11px]">
          {index + 1}
        </span>
        <div className="min-w-0 flex-1 pt-0.5">
          <Input
            value={task.title}
            onChange={(e) =>
              onEdit({ type: 'setTaskTitle', index, title: e.target.value })
            }
            aria-label={`Task ${index + 1} title`}
            className="focus-visible:ring-ring/40 h-auto w-full min-w-0 border-none bg-transparent px-0 py-0 text-[13px] font-semibold shadow-none focus-visible:ring-1"
          />
          <Textarea
            rows={2}
            value={task.description}
            onChange={(e) =>
              onEdit({
                type: 'setTaskDescription',
                index,
                description: e.target.value,
              })
            }
            aria-label={`Task ${index + 1} description`}
            className="text-muted-foreground focus-visible:ring-ring/40 mt-1 min-h-0 resize-none border-none bg-transparent p-0 text-[12.5px] leading-relaxed shadow-none focus-visible:ring-1"
          />
        </div>
      </div>

      <div className="border-border bg-surface-inset flex items-center gap-2 border-t px-4 py-1.5">
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
                    aria-label={`Expand task ${blockerIndex + 1}`}
                    className="rounded-control focus-visible:ring-ring/40 focus-visible:ring-1 focus-visible:outline-none"
                  >
                    {/* `justify-start` matters: Badge centers its content, and a
                        centered flex box with overflow clips the START of the text. */}
                    <Badge
                      variant="secondary"
                      title={title}
                      className="hover:bg-accent max-w-[11rem] cursor-pointer justify-start font-normal"
                    >
                      <span className="text-muted-foreground shrink-0 font-mono">
                        #{blockerIndex + 1}
                      </span>
                      <span className="truncate">{title}</span>
                    </Badge>
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
            size="sm"
            aria-label={`Task ${index + 1} priority`}
            className="h-6.5 w-[6.75rem] shrink-0 gap-1 border-none bg-transparent px-2 text-[12px] shadow-none"
          >
            <SelectValue className="capitalize" />
          </SelectTrigger>
          <SelectContent align="end">
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                <PriorityIcon priority={p} className="size-3.5" />
                <span className="capitalize">{p}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onExpand(index)}
          aria-label={`Expand task ${index + 1}`}
          className="text-muted-foreground hover:text-foreground shrink-0 opacity-0 transition-opacity duration-100 group-focus-within/plan-task:opacity-100 group-hover/plan-task:opacity-100"
        >
          <Maximize2 className="size-3.5" />
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(index)}
          aria-label={`Remove task ${index + 1}`}
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10 shrink-0 opacity-0 transition-opacity duration-100 group-focus-within/plan-task:opacity-100 group-hover/plan-task:opacity-100"
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
  /** Navigates to the board — the confirm toast's "View board" action. */
  onGoToBoard: () => void;
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
  onGoToBoard,
  initialPrompt,
}: PlansViewProps) {
  const toasts = useToasts();
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
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
      await data.handleSubmitPrompt(prompt.trim());
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

  async function submitConfirm() {
    if (draft === null) return;
    setConfirming(true);
    setConfirmError(null);
    try {
      const count = draft.proposal.tasks.length;
      await data.handleConfirmPlan(draft.proposal);
      toasts.push({
        tone: 'success',
        title: `${count} ${count === 1 ? 'task' : 'tasks'} created`,
        action: { label: 'View board', onClick: onGoToBoard },
      });
      closePlan();
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
  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
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
  // Why the review list may not be confirmable right now — the review list is the last
  // proposal the planner sent either way, so it stays on screen and this line says what
  // changed underneath it.
  const reviewNotice = turnRunning
    ? 'The planner is revising. Edits here get replaced when the new version lands.'
    : data.planRecord?.state === 'failed'
      ? 'That turn failed. Send another message to retry.'
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6">
      <div className="flex items-center justify-end gap-3">
        {data.planId !== null && (
          <Button variant="outline" size="sm" onClick={closePlan}>
            <Plus className="size-3.5" /> New plan
          </Button>
        )}
      </div>

      {data.planId === null ? (
        <div className="bg-card rounded-card shadow-card animate-in fade-in-0 flex flex-col gap-3 p-4 duration-150">
          {submitError !== null && (
            <div className="bg-state-failed-surface text-state-failed rounded-control flex items-center gap-2 px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
          <Textarea
            rows={4}
            placeholder="Describe the work…"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            className="resize-y text-[13px]"
          />
          <div className="flex justify-end">
            <Button
              disabled={submitting || prompt.trim() === ''}
              onClick={() => void submitPrompt()}
            >
              {submitting ? (
                <>
                  <Spinner className="size-4" /> Starting…
                </>
              ) : (
                <>
                  <Send className="size-4" /> Plan
                </>
              )}
            </Button>
          </div>
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
        <div
          className="bg-card rounded-card shadow-card animate-in fade-in-0 flex flex-col gap-2 p-4 duration-150"
          aria-hidden="true"
        >
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
          <Skeleton className="h-14 w-full" />
        </div>
      )}

      {draft !== null && (
        <div className="animate-in fade-in-0 flex flex-col gap-4 duration-150">
          {confirmError !== null && (
            <div className="bg-state-failed-surface text-state-failed rounded-control flex items-center gap-2 px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{confirmError}</span>
            </div>
          )}

          {reviewNotice !== null && (
            <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
              {turnRunning ? (
                <Spinner className="text-primary size-3.5 shrink-0" />
              ) : (
                <CircleAlert className="text-destructive size-3.5 shrink-0" />
              )}
              <span>{reviewNotice}</span>
            </div>
          )}

          {draft.proposal.epic !== undefined && (
            <div className="bg-card rounded-card shadow-card flex flex-col gap-2 p-4">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Milestone
              </div>
              <Input
                value={draft.proposal.epic.title}
                onChange={(e) =>
                  applyEdit({ type: 'setEpicTitle', title: e.target.value })
                }
                aria-label="Epic title"
                className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 text-[14px] font-medium shadow-none focus-visible:ring-1"
              />
              <Textarea
                rows={2}
                value={draft.proposal.epic.description}
                onChange={(e) =>
                  applyEdit({
                    type: 'setEpicDescription',
                    description: e.target.value,
                  })
                }
                aria-label="Epic description"
                className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 text-[13px] shadow-none focus-visible:ring-1"
              />
            </div>
          )}

          {draft.proposal.tasks.length > 1 && (
            <div className="flex justify-end">
              <ToggleGroup
                type="single"
                variant="outline"
                size="sm"
                value={proposalView}
                onValueChange={(value) => {
                  // Radix clears to '' when the active item is re-clicked; a proposal is
                  // always one of the two views, so ignore the deselect.
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
            <div className="bg-card rounded-card shadow-card p-4">
              <DependencyGraph
                tasks={graphTasks}
                refFor={(id) => `#${Number(id) + 1}`}
                accessoryFor={(id) => {
                  const task = draft.proposal.tasks[Number(id)];
                  return task === undefined ? undefined : (
                    <PriorityIcon
                      priority={task.priority}
                      className="size-3.5"
                    />
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
                  onRemove={(index) => applyEdit({ type: 'removeTask', index })}
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
            <Button variant="ghost" onClick={closePlan} disabled={confirming}>
              Cancel
            </Button>
            <Button
              disabled={
                confirming || !canConfirm || draft.proposal.tasks.length === 0
              }
              onClick={() => void submitConfirm()}
            >
              {confirming ? (
                <>
                  <Spinner className="size-4" /> Creating…
                </>
              ) : planConfirmed ? (
                <>
                  <Check className="size-4" /> Tasks created
                </>
              ) : (
                <>
                  <Check className="size-4" /> Confirm{' '}
                  {draft.proposal.tasks.length} tasks
                </>
              )}
            </Button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-2">
        <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
          History
        </div>
        {data.plans.length === 0 ? (
          <EmptyState
            icon={History}
            message="No plans yet."
            className="border-border rounded-card border border-dashed px-0 py-8 [&_[data-slot=empty-description]]:text-[13px]"
          />
        ) : (
          <div className="flex flex-col gap-1.5">
            {data.plans.map((entry) => (
              <Button
                key={entry.id}
                type="button"
                variant="ghost"
                size="xs"
                onClick={() => openHistoryEntry(entry.id)}
                className={cn(
                  'rounded-control ease-out-expo h-auto w-full items-center justify-start gap-2 px-3 py-2 text-left text-[length:inherit] font-normal transition-colors duration-100 hover:text-foreground',
                  entry.id === data.planId
                    ? 'bg-accent ring-primary/40 ring-1'
                    : 'bg-card shadow-hairline hover:bg-surface-hover'
                )}
              >
                <PlanStateDot state={entry.state} />
                <span className="min-w-0 flex-1 truncate">
                  {entry.subject ?? firstPromptLine(entry.prompt)}
                </span>
                <span className="text-muted-foreground shrink-0 text-[11px] capitalize">
                  {entry.confirmedAt !== undefined ? 'confirmed' : entry.state}
                </span>
                <span className="dense-meta shrink-0">
                  {formatRelativeTimeFromIso(entry.updatedAt)}
                </span>
              </Button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
