import type {
  PlannedTask,
  PlannerQuestion,
  PlanState,
  ProposalAction,
} from '@dispatch/client';
import type { Priority } from '@dispatch/core';
import {
  AlertTriangle,
  Check,
  CircleAlert,
  History,
  Link2,
  Loader2,
  Minus,
  Plus,
  Send,
  SignalHigh,
  SignalLow,
  SignalMedium,
  Trash2,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { PlanQuestionsForm } from '../components/plans/PlanQuestionsForm';
import { Markdown } from '../components/runs/Markdown';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
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
import { Input } from '@/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/ui/select';
import { Skeleton } from '@/ui/skeleton';
import { Textarea } from '@/ui/textarea';

const PRIORITIES: Priority[] = ['urgent', 'high', 'medium', 'low', 'none'];

interface PlanHistoryEntry {
  id: string;
  prompt: string;
  createdAt: string;
  state: PlanState | 'unknown';
}

/** dispatchd has no "list every plan" endpoint (each plan is fetched by id) — history is
 * this window's own session record of prompts it started, persisted to localStorage per
 * project so switching views (or a reload) doesn't lose it. This is a deliberate scope cut
 * from a server-backed plan history; see the phase-8 report for the tradeoff. */
function historyStorageKey(projectPath: string): string {
  return `dispatch:planHistory:${projectPath}`;
}

function loadHistory(projectPath: string): PlanHistoryEntry[] {
  try {
    const raw = window.localStorage.getItem(historyStorageKey(projectPath));
    return raw !== null ? (JSON.parse(raw) as PlanHistoryEntry[]) : [];
  } catch {
    return [];
  }
}

function saveHistory(projectPath: string, history: PlanHistoryEntry[]): void {
  try {
    window.localStorage.setItem(
      historyStorageKey(projectPath),
      JSON.stringify(history)
    );
  } catch {
    // Best-effort — a full/disabled localStorage just means history doesn't persist across
    // reloads this session, not a reason to break the plan flow itself.
  }
}

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
function PlanStateDot({ state }: { state: PlanHistoryEntry['state'] }) {
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
        'flex max-w-[85%] flex-col gap-1 rounded-md px-3 py-2',
        fromUser
          ? 'bg-primary text-primary-foreground self-end'
          : 'border-border bg-card self-start border'
      )}
    >
      <div
        className={cn(
          'flex items-baseline gap-1.5 text-[11px] font-medium tracking-wide uppercase',
          fromUser ? 'text-primary-foreground/70' : 'text-muted-foreground'
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
    <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
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
                className="border-border bg-muted/40 text-muted-foreground flex items-center gap-2 self-start rounded-md border px-3 py-2 text-[13px]"
              >
                <Loader2 className="text-primary size-3.5 animate-spin" />
                Planning — reading the codebase and updating the proposal…
              </div>
            );
          }
          if (item.kind === 'failed') {
            return (
              <div
                key={item.key}
                className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 self-start rounded-md border px-3 py-2 text-[13px]"
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

      <div className="border-border flex flex-col gap-1.5 border-t pt-3">
        {error !== null && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
            <CircleAlert className="size-4 shrink-0" />
            <span>{error}</span>
          </div>
        )}
        <span className="text-muted-foreground text-[11px]">
          {confirmed
            ? 'This plan is confirmed — its tasks are already created. Start a new plan to keep planning.'
            : busy
              ? 'The planner is answering — send your next message once its reply lands.'
              : 'Keep refining — ask for a change and the proposal below updates.'}
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
                  <Loader2 className="size-4 animate-spin" /> Sending…
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
}

/** One card of the proposal review list. "Dependency arrows" are rendered as a plain
 * "blocked by …" badge line naming the blocking tasks by their (possibly just-edited)
 * title — a real arrow-diagram would need a layout engine this view doesn't have yet; the
 * badges convey the same ordering information, and titles are looked up live off the current
 * draft so an edited blocker's new title shows immediately in its dependents' rows. */
function PlanTaskRow({
  task,
  index,
  allTasks,
  onEdit,
  onRemove,
}: PlanTaskRowProps) {
  const blockerTitles = task.blockedByIndices
    .map((i) => allTasks[i]?.title)
    .filter((title): title is string => title !== undefined);

  return (
    <div className="border-border bg-card hover:border-muted-foreground/30 flex flex-col gap-2 rounded-lg border p-3 transition-colors duration-150">
      <div className="flex items-center gap-2">
        <span className="text-muted-foreground w-5 shrink-0 font-mono text-[11px]">
          {index + 1}
        </span>
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
          <SelectTrigger
            size="sm"
            aria-label={`Task ${index + 1} priority`}
            className="h-7 w-[112px] gap-1.5 px-2 text-[12px]"
          >
            <PriorityIcon priority={task.priority} className="size-3.5" />
            <SelectValue className="capitalize" />
          </SelectTrigger>
          <SelectContent align="start">
            {PRIORITIES.map((p) => (
              <SelectItem key={p} value={p}>
                <PriorityIcon priority={p} className="size-3.5" />
                <span className="capitalize">{p}</span>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <div className="flex-1" />
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          onClick={() => onRemove(index)}
          aria-label={`Remove task ${index + 1}`}
          className="text-muted-foreground hover:text-destructive hover:bg-destructive/10"
        >
          <Trash2 className="size-3.5" />
        </Button>
      </div>

      <Input
        value={task.title}
        onChange={(e) =>
          onEdit({ type: 'setTaskTitle', index, title: e.target.value })
        }
        aria-label={`Task ${index + 1} title`}
        className="focus-visible:ring-ring/40 h-auto border-none bg-transparent px-0 py-0.5 text-[13px] font-medium shadow-none focus-visible:ring-1"
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
        className="text-muted-foreground focus-visible:ring-ring/40 min-h-0 resize-y border-none bg-transparent px-0 py-0.5 text-[12px] shadow-none focus-visible:ring-1"
      />

      {blockerTitles.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5 pt-1">
          <Link2 className="text-muted-foreground size-3" />
          <span className="text-muted-foreground text-[11px]">Blocked by</span>
          {blockerTitles.map((title, i) => (
            <Badge
              key={`${title}-${i}`}
              variant="secondary"
              className="max-w-[12rem] truncate font-normal"
            >
              {title}
            </Badge>
          ))}
        </div>
      )}
    </div>
  );
}

interface PlansViewProps {
  data: DispatchProjectData;
  projectPath: string;
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
  projectPath,
  initialPrompt,
}: PlansViewProps) {
  const [history, setHistory] = useState<PlanHistoryEntry[]>(() =>
    loadHistory(projectPath)
  );
  const [prompt, setPrompt] = useState(initialPrompt ?? '');
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  // The editable proposal plus its per-row keys and the server proposal it came from — see
  // `PlanDraft`, which owns the "a later turn refined the plan, adopt it / a poll returned
  // the same plan, keep my edits" rule this view used to approximate with `prev ?? proposal`.
  const [draft, setDraft] = useState<PlanDraft | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);

  // Keeps the visible history entry's state snapshot fresh whenever the currently-open
  // plan's record changes (running -> ready/failed), and folds each turn's proposal into
  // the editable draft as the conversation produces it.
  useEffect(() => {
    if (data.planId === null || data.planRecord === undefined) return;
    const planId = data.planId;
    const planRecord = data.planRecord;
    setHistory((prev) => {
      const next = prev.map((entry) =>
        entry.id === planId ? { ...entry, state: planRecord.state } : entry
      );
      saveHistory(projectPath, next);
      return next;
    });
    if (planRecord.state === 'ready' && planRecord.proposal) {
      const proposal = planRecord.proposal;
      setDraft((prev) => syncPlanDraft(prev, proposal, planId));
    }
  }, [data.planId, data.planRecord, projectPath]);

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
      const newPlanId = await data.handleSubmitPrompt(prompt.trim());
      const entry: PlanHistoryEntry = {
        id: newPlanId,
        prompt: prompt.trim(),
        createdAt: new Date().toISOString(),
        state: 'running',
      };
      setHistory((prev) => {
        const next = [entry, ...prev];
        saveHistory(projectPath, next);
        return next;
      });
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
      await data.handleConfirmPlan(draft.proposal);
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
    data.setPlanId(null);
  }

  function openHistoryEntry(entry: PlanHistoryEntry) {
    setDraft(null);
    setConfirmError(null);
    data.setPlanId(entry.id);
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
    ? 'The planner is revising this plan — the version below is the last one it sent, and your edits to it will be replaced when the new one arrives.'
    : data.planRecord?.state === 'failed'
      ? 'That turn failed, so this is still the last plan the planner sent. Send another message to get a version you can confirm.'
      : null;

  return (
    <div className="mx-auto flex w-full max-w-[60rem] flex-col gap-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="view-topbar-title">Plans</h1>
        {data.planId !== null && (
          <Button variant="outline" size="sm" onClick={closePlan}>
            <Plus className="size-3.5" /> New plan
          </Button>
        )}
      </div>

      {data.planId === null ? (
        <div className="border-border bg-card animate-in fade-in-0 flex flex-col gap-3 rounded-lg border p-4 duration-150">
          {submitError !== null && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{submitError}</span>
            </div>
          )}
          <Textarea
            rows={4}
            placeholder="Describe the work — the planner will propose an epic and its tasks…"
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
                  <Loader2 className="size-4 animate-spin" /> Starting…
                </>
              ) : (
                <>
                  <Send className="size-4" /> Plan work…
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
          className="border-border bg-card animate-in fade-in-0 flex flex-col gap-2 rounded-lg border p-4 duration-150"
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
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{confirmError}</span>
            </div>
          )}

          {reviewNotice !== null && (
            <div className="text-muted-foreground flex items-center gap-2 text-[12px]">
              {turnRunning ? (
                <Loader2 className="text-primary size-3.5 shrink-0 animate-spin" />
              ) : (
                <CircleAlert className="text-destructive size-3.5 shrink-0" />
              )}
              <span>{reviewNotice}</span>
            </div>
          )}

          {draft.proposal.epic !== undefined && (
            <div className="border-border bg-card flex flex-col gap-2 rounded-lg border p-4">
              <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
                Epic
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

          <div className="flex flex-col gap-2">
            {draft.proposal.tasks.map((task, i) => (
              <PlanTaskRow
                key={draft.taskKeys[i] ?? i}
                task={task}
                index={i}
                allTasks={draft.proposal.tasks}
                onEdit={applyEdit}
                onRemove={(index) => applyEdit({ type: 'removeTask', index })}
              />
            ))}
          </div>

          <div className="border-border flex items-center justify-end gap-2 border-t pt-3">
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
                  <Loader2 className="size-4 animate-spin" /> Creating…
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
        {history.length === 0 ? (
          <div className="border-border flex flex-col items-center gap-2 rounded-lg border border-dashed py-8 text-center">
            <History className="text-muted-foreground size-5" />
            <p className="text-muted-foreground text-[13px]">
              No plans started yet this session.
            </p>
          </div>
        ) : (
          <div className="flex flex-col gap-1.5">
            {history.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => openHistoryEntry(entry)}
                className={cn(
                  'border-border bg-card hover:border-muted-foreground/30 flex items-center gap-2 rounded-md border px-3 py-2 text-left text-[13px] transition-colors duration-150',
                  entry.id === data.planId && 'border-primary/40 bg-accent'
                )}
              >
                <PlanStateDot state={entry.state} />
                <span className="min-w-0 flex-1 truncate">{entry.prompt}</span>
                <span className="text-muted-foreground shrink-0 text-[11px] capitalize">
                  {entry.state}
                </span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
