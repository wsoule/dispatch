import type { OverseerAction, OverseerApproval } from '@dispatch/client';
import {
  Check,
  CircleAlert,
  Plus,
  Shield,
  TerminalSquare,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef } from 'react';

import type {
  OverseerApprovalDecision,
  OverseerSession,
} from '../../hooks/useOverseerSession';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { effortOptions, modelLabel, MODELS } from '../../lib/models';
import type { OverseerThreadItem } from '../../lib/overseerThread';
import { buildOverseerThread } from '../../lib/overseerThread';
import { Markdown } from '../runs/Markdown';
import { cn } from '@/lib/utils';
import { PillButton } from '@/ui/ai/pill';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';

/** The models the opening composer offers, in `PromptBar`'s shape. */
const COMPOSER_MODELS = MODELS.map((m) => ({ id: m.id, label: m.label }));

/** An inline failure line — a send that dispatchd refused, a decision that threw. */
function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div className="bg-state-failed-surface text-state-failed rounded-control flex items-start gap-2 px-3 py-2 text-[13px]">
      <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
      <span>{children}</span>
    </div>
  );
}

/** One turn of the overseer conversation — the same bubble treatment as the plan
 * thread: the assistant's replies are markdown (it's an agent transcript), the
 * user's own words render verbatim. */
function OverseerMessageBubble({
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
        fromUser
          ? 'bg-surface-secondary shadow-hairline self-end'
          : 'bg-surface-quaternary shadow-card self-start'
      )}
    >
      <div className="text-muted-foreground flex items-baseline gap-1.5 text-[12px] font-medium">
        {fromUser ? 'You' : 'Assistant'}
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

interface OverseerConfirmCardProps {
  action: OverseerAction;
  /** The server's explanation when the last approval attempt threw. */
  failure: string | null;
  /** A decision for *this* action is currently in flight — this card owns the
   * spinner. */
  deciding: boolean;
  /** Some decision is in flight, this card's or another card's. One model turn
   * can queue several actions, and the session holds a single lock: without
   * disabling the others, their buttons stay live and eat the click. */
  locked: boolean;
  onDecide: (approve: boolean) => void;
}

/**
 * A queued mutating action awaiting the human — deliberately not a chat
 * bubble: this is the one row in the transcript that's a control, not a
 * record, so it gets its own bordered card with the action's human-readable
 * summary and the approve/deny pair. Denying never runs the underlying
 * mutation; approving runs it server-side before the call resolves.
 */
function OverseerConfirmCard({
  action,
  failure,
  deciding,
  locked,
  onDecide,
}: OverseerConfirmCardProps) {
  return (
    <div className="bg-state-waiting-surface rounded-card flex flex-col gap-2 self-stretch border-[0.5px] border-(--state-waiting-edge) px-3 py-2.5">
      <div className="text-state-waiting flex items-center gap-1.5 text-[12px] font-medium">
        <Shield className="size-3.5" />
        Needs your approval
        <span className="text-muted-foreground font-book">{action.tool}</span>
      </div>
      <p className="font-book text-[13px]">{action.summary}</p>
      {failure !== null && <ErrorLine>{failure}</ErrorLine>}
      <div className="flex items-center gap-2">
        <Button
          disabled={locked}
          onClick={() => onDecide(true)}
          aria-label={`Approve: ${action.summary}`}
        >
          {deciding ? (
            <Spinner className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          {failure !== null ? 'Retry' : 'Approve'}
        </Button>
        <PillButton
          disabled={locked}
          onClick={() => onDecide(false)}
          aria-label={`Deny: ${action.summary}`}
        >
          <X className="size-3.5" />
          Deny
        </PillButton>
      </div>
    </div>
  );
}

interface OverseerApproveCardProps {
  approval: OverseerApproval;
  /** A decision for *this* call is in flight — this card owns the spinner. */
  deciding: boolean;
  /** Some approval decision is in flight; every approve card locks. */
  locked: boolean;
  onDecide: (decision: OverseerApprovalDecision) => void;
}

/**
 * A built-in tool call the overseer's turn is parked on — Bash, Edit, a
 * project MCP tool — which is a different question from the confirm card
 * above: nothing is queued for later, the session is blocked right now and
 * allowing runs the call at once. Three answers rather than two, because
 * "yes", "yes and stop asking about this tool" and "no" are genuinely
 * different instructions, the same trio a run's approval offers.
 */
function OverseerApproveCard({
  approval,
  deciding,
  locked,
  onDecide,
}: OverseerApproveCardProps) {
  return (
    <div className="bg-state-waiting-surface rounded-card flex flex-col gap-2 self-stretch border-[0.5px] border-(--state-waiting-edge) px-3 py-2.5">
      <div className="text-state-waiting flex items-center gap-1.5 text-[12px] font-medium">
        <TerminalSquare className="size-3.5" />
        Wants to run
        <span className="text-muted-foreground font-book">
          {approval.toolName}
        </span>
      </div>
      {/* The call itself — a command line, so it keeps the code face. */}
      <p className="font-mono text-[12px] break-all">{approval.summary}</p>
      <div className="flex flex-wrap items-center gap-2">
        <Button
          disabled={locked}
          onClick={() => onDecide({ allow: true })}
          aria-label={`Allow: ${approval.summary}`}
        >
          {deciding ? (
            <Spinner className="size-3.5" />
          ) : (
            <Check className="size-3.5" />
          )}
          Allow
        </Button>
        <PillButton
          disabled={locked}
          onClick={() => onDecide({ allow: true, scope: 'session' })}
          aria-label={`Allow ${approval.toolName} for this conversation`}
        >
          Allow for this conversation
        </PillButton>
        <PillButton
          disabled={locked}
          onClick={() => onDecide({ allow: false })}
          aria-label={`Deny: ${approval.summary}`}
        >
          <X className="size-3.5" />
          Deny
        </PillButton>
      </div>
    </div>
  );
}

/** A decided action's audit line — kept in the transcript so "what actually
 * happened" survives the card it replaced. */
function OverseerOutcomeRow({
  outcome,
  text,
  at,
}: {
  outcome: 'applied' | 'allowed' | 'denied' | 'failed';
  text: string;
  at: string;
}) {
  return (
    <div
      className={cn(
        'rounded-control font-book flex items-start gap-2 self-start px-3 py-1.5 text-[12px]',
        (outcome === 'applied' || outcome === 'allowed') &&
          'bg-state-review-surface text-state-review',
        outcome === 'denied' && 'bg-surface-quaternary text-muted-foreground',
        outcome === 'failed' && 'bg-state-failed-surface text-state-failed'
      )}
    >
      {outcome === 'applied' || outcome === 'allowed' ? (
        <Check className="size-3.5 shrink-0 translate-y-0.5" />
      ) : outcome === 'denied' ? (
        <X className="size-3.5 shrink-0 translate-y-0.5" />
      ) : (
        <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
      )}
      <span>
        {text}
        <span className="text-muted-foreground">
          {' '}
          · {formatRelativeTimeFromIso(at)}
        </span>
      </span>
    </div>
  );
}

interface OverseerChatProps {
  overseer: OverseerSession;
  /**
   * Rail-sized: drops the card chrome and the long intro copy, stacks the
   * composer under the transcript, and adds its own "New" reset (the full page
   * keeps that in its header). Every conversation row — bubbles, confirm
   * cards, outcomes — is the same component either way, so approving a
   * mutation from the rail goes through exactly the path the full page uses.
   */
  compact?: boolean;
}

/**
 * The overseer conversation itself — transcript, composer, and the approve/deny
 * confirm cards — extracted from OverseerView so the LiveRail's Overseer tab and
 * the full page render the one `useOverseerSession` the App mounts. Status
 * questions are answered directly; anything mutating shows up as a confirm
 * card in the transcript and runs only once approved there.
 */
export function OverseerChat({ overseer, compact = false }: OverseerChatProps) {
  // The composer's text is the session's, not this component's: the rail
  // unmounts this chat on a tab flip and on collapse, and navigating to the
  // Overseer page unmounts the rail entirely. Only one of the two textareas
  // below is ever on screen (which one depends on `conversationId`), so a
  // single draft is unambiguous.
  const { draft, setDraft } = overseer;

  // Sending state is the session's too, and for the same reason as the draft:
  // the rail's tab flip unmounts this panel, so a `setState` from a call that
  // fails after the flip would land on an unmounted component and report the
  // failure to nobody. One flag and one error cover both composers — only one
  // of them is ever on screen, and `conversationId` decides which.
  const { sending, sendError } = overseer;

  // Both are the session's, for the same reason: approving runs the real
  // mutation before the call resolves, and every surface that renders a
  // confirm card is unmounted by an ordinary tab flip, collapse or navigation.
  // A local lock would reset to null on remount and re-enable cards whose
  // effect is still running; a local error would land on an unmounted tree and
  // report the failure to nobody. One error at a time is plenty — per-card
  // error maps would complicate a state the failure row on the card covers.
  const decidingId = overseer.decidingActionId;
  const decidingRequestId = overseer.decidingRequestId;
  const decideError = overseer.decideError;

  const thread = useMemo(
    () => buildOverseerThread(overseer.record),
    [overseer.record]
  );

  // Pin the transcript to the newest row — keyed on the last row's identity as
  // well as the count, since a turn settling in place (pending spinner → reply)
  // can change what's at the bottom without changing how many rows there are.
  // Mount counts as a change: every surface that renders this chat mounts it
  // with a real layout box, so there is no zero-scrollHeight case to skip.
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = thread.length > 0 ? thread[thread.length - 1].key : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [thread.length, lastKey]);

  // A turn is in flight — dispatchd 409s a second message until it settles.
  // Confirm cards stay live on purpose: the server accepts a decision mid-turn.
  // `recordError` only decides the no-record case (fetch never succeeded →
  // broken conversation showing its 404 banner, not the overseer answering);
  // with a record cached, one failed *background* refetch mid-turn must not
  // flip the composer open against a turn the server would still 409.
  const busy =
    overseer.conversationId !== null &&
    (overseer.record === undefined
      ? overseer.recordError === null
      : overseer.record.state === 'running');

  // A queued mutation nobody has decided on, or a built-in call the turn is
  // parked on. Gates the compact reset: dropping the conversation is the only
  // way to lose the card in the UI, and a parked call would block its session
  // for good. No `recordError` guard needed — useOverseerSession clears
  // `record` when the daemon says the conversation is gone, so this cannot
  // lock on a ghost.
  const hasPendingAction =
    (overseer.record?.pendingActions.length ?? 0) > 0 ||
    (overseer.record?.pendingApprovals.length ?? 0) > 0;

  /**
   * Both composers' submit. Everything past the guard — clearing the draft,
   * putting it back on failure, the in-flight flag, the error — belongs to
   * `overseer.submit`, which picks `start` or `sendMessage` off `conversationId`
   * exactly as the branch below picks which composer to render.
   *
   * `busy` is re-checked here rather than only on the button because the
   * composer stays editable mid-turn: Enter must not slip a message past a
   * turn the server would 409.
   */
  function submitDraft() {
    const text = draft.trim();
    if (text === '' || sending || busy) return;
    void overseer.submit(text);
  }

  // The session owns the whole decide cycle — the re-entrancy guard, the lock
  // and the failure — so this is a plain forward rather than a wrapper.
  function decide(actionId: string, approve: boolean) {
    void overseer.confirmAction(actionId, approve);
  }

  function decideApproval(
    requestId: string,
    decision: OverseerApprovalDecision
  ) {
    void overseer.decideApproval(requestId, decision);
  }

  function renderRow(item: OverseerThreadItem) {
    switch (item.kind) {
      case 'message':
        return (
          <OverseerMessageBubble
            key={item.key}
            role={item.role}
            text={item.text}
            at={item.at}
          />
        );
      case 'tool':
        return (
          <div
            key={item.key}
            className="text-muted-foreground font-book flex items-start gap-1.5 self-start px-1 text-[12px]"
          >
            <Wrench className="size-3 shrink-0 translate-y-0.5" />
            <span className="line-clamp-2">
              <span className="font-medium">{item.tool}</span> — {item.text}
            </span>
          </div>
        );
      case 'confirm':
        return (
          <OverseerConfirmCard
            key={item.key}
            action={item.action}
            failure={item.failure}
            deciding={decidingId === item.action.id}
            locked={decidingId !== null}
            onDecide={(approve) => decide(item.action.id, approve)}
          />
        );
      case 'approve':
        return (
          <OverseerApproveCard
            key={item.key}
            approval={item.approval}
            deciding={decidingRequestId === item.approval.requestId}
            locked={decidingRequestId !== null}
            onDecide={(decision) =>
              decideApproval(item.approval.requestId, decision)
            }
          />
        );
      case 'outcome':
        return (
          <OverseerOutcomeRow
            key={item.key}
            outcome={item.outcome}
            text={item.text}
            at={item.at}
          />
        );
      case 'pending':
        return (
          <div
            key={item.key}
            className="bg-surface-quaternary text-muted-foreground rounded-control font-book flex items-center gap-2 self-start px-3 py-2 text-[13px]"
          >
            <Spinner className="text-state-working size-3.5" />
            The overseer is working…
          </div>
        );
      case 'failed':
        return (
          <div key={item.key} className="self-start">
            <ErrorLine>{item.error}</ErrorLine>
          </div>
        );
    }
  }

  if (overseer.conversationId === null) {
    return (
      <div className="flex flex-col gap-3">
        <p className="text-muted-foreground font-book text-[13px]">
          {compact
            ? 'Ask about runs, tasks, the queue — or the code. Actions wait for your approval.'
            : 'Ask about this project — runs, tasks, the merge queue, what needs you — or about the code itself: the overseer is a full agent session in the checkout and can read, search, run commands and edit. It can also act on the project (dispatch, cancel, approve), but every mutation waits for your explicit approval here first, and tool calls the permission policy does not settle pause for you to allow.'}
        </p>
        {sendError !== null && <ErrorLine>{sendError}</ErrorLine>}
        {/* Which model the conversation opens on — remembered per device, so
            "always Fable" sticks. An open conversation keeps its model. */}
        <PromptBar
          value={draft}
          onChange={setDraft}
          onSubmit={submitDraft}
          disabled={sending}
          placeholder="What's going on with my agents?"
          ariaLabel="Overseer opening question"
          models={COMPOSER_MODELS}
          modelId={overseer.model}
          onModelChange={overseer.setModel}
          efforts={effortOptions(overseer.configuredEffort)}
          effortId={overseer.effortId}
          onEffortChange={overseer.setEffortId}
        />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        compact ? 'gap-2' : 'gap-3'
      )}
    >
      {overseer.recordError !== null && overseer.record === undefined && (
        <ErrorLine>{overseer.recordError}</ErrorLine>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Overseer conversation"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        {thread.map(renderRow)}
      </div>

      <div className="flex flex-col gap-1.5">
        {(sendError ?? decideError) !== null && (
          <ErrorLine>{sendError ?? decideError}</ErrorLine>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-book min-w-0 flex-1 truncate text-[12px]">
            {busy
              ? 'The overseer is answering…'
              : compact
                ? 'Actions wait for your approval.'
                : 'Ask a follow-up. Actions always wait for your approval.'}
            {overseer.record?.model !== undefined && (
              <> · {modelLabel(overseer.record.model)}</>
            )}
          </span>
          {compact && (
            // The full page's "New conversation" lives in its header; the rail
            // has no header of its own, so the reset rides the composer row.
            // Disabled while an action awaits a decision: reset() drops the
            // only UI handle on this conversation, and a pending mutation must
            // stay decidable. Its accessible name deliberately omits the word
            // "overseer": the sidebar's global nav has a button named exactly
            // "Overseer", and role-name matching is case-insensitive substring
            // by default, so any rail button carrying the word would make that
            // name ambiguous.
            <Button
              variant="ghost"
              size="xs"
              disabled={hasPendingAction}
              onClick={() => overseer.reset()}
              aria-label="Start a new conversation"
              title={
                hasPendingAction ? 'Decide the pending action first' : undefined
              }
              className="shrink-0"
            >
              <Plus className="size-3" /> New
            </Button>
          )}
        </div>
        {/* Disabled for the whole turn, not just the send: the composer is the
            primitive's, and a Send that looks live against a turn the server
            would 409 is the worse of the two. */}
        <PromptBar
          value={draft}
          onChange={setDraft}
          onSubmit={submitDraft}
          disabled={busy || sending}
          placeholder="Ask about runs, tasks, the queue — or ask it to act…"
          ariaLabel="Follow-up message"
        />
      </div>
    </div>
  );
}
