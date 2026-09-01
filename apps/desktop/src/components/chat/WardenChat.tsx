import type { WardenAction } from '@dispatch/client';
import {
  Check,
  CircleAlert,
  Plus,
  Send,
  Shield,
  Wrench,
  X,
} from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import type { WardenSession } from '../../hooks/useWardenSession';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { WardenThreadItem } from '../../lib/wardenThread';
import { buildWardenThread } from '../../lib/wardenThread';
import { Markdown } from '../runs/Markdown';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';

/** One turn of the warden conversation — the same bubble treatment as the plan
 * thread: the assistant's replies are markdown (it's an agent transcript), the
 * user's own words render verbatim. */
function WardenMessageBubble({
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
        {fromUser ? 'You' : 'Warden'}
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

interface WardenConfirmCardProps {
  action: WardenAction;
  /** The server's explanation when the last approval attempt threw. */
  failure: string | null;
  /** A decision for *this* action is currently in flight — this card owns the
   * spinner. */
  deciding: boolean;
  /** Some decision is in flight, this card's or another card's. One model turn
   * can queue several actions, and `decide()` holds a single lock: without
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
function WardenConfirmCard({
  action,
  failure,
  deciding,
  locked,
  onDecide,
}: WardenConfirmCardProps) {
  return (
    <div className="flex flex-col gap-2 self-stretch rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2.5">
      <div className="flex items-center gap-1.5 text-[11px] font-medium tracking-wide text-amber-600 uppercase dark:text-amber-400">
        <Shield className="size-3.5" />
        Needs your approval
        <span className="text-muted-foreground font-mono font-normal normal-case">
          {action.tool}
        </span>
      </div>
      <p className="text-[13px]">{action.summary}</p>
      {failure !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[12px]">
          <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
          <span>{failure}</span>
        </div>
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
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
        <Button
          size="sm"
          variant="outline"
          disabled={locked}
          onClick={() => onDecide(false)}
          aria-label={`Deny: ${action.summary}`}
        >
          <X className="size-3.5" />
          Deny
        </Button>
      </div>
    </div>
  );
}

/** A decided action's audit line — kept in the transcript so "what actually
 * happened" survives the card it replaced. */
function WardenOutcomeRow({
  outcome,
  text,
  at,
}: {
  outcome: 'applied' | 'denied' | 'failed';
  text: string;
  at: string;
}) {
  return (
    <div
      className={cn(
        'flex items-start gap-2 self-start rounded-md border px-3 py-1.5 text-[12px]',
        outcome === 'applied' &&
          'border-emerald-500/30 bg-emerald-500/5 text-emerald-600 dark:text-emerald-400',
        outcome === 'denied' &&
          'border-border bg-muted/40 text-muted-foreground',
        outcome === 'failed' &&
          'border-destructive/30 bg-destructive/10 text-destructive'
      )}
    >
      {outcome === 'applied' ? (
        <Check className="size-3.5 shrink-0 translate-y-0.5" />
      ) : outcome === 'denied' ? (
        <X className="size-3.5 shrink-0 translate-y-0.5" />
      ) : (
        <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
      )}
      <span>
        {text}
        <span className="opacity-60"> · {formatRelativeTimeFromIso(at)}</span>
      </span>
    </div>
  );
}

interface WardenChatProps {
  warden: WardenSession;
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
 * The warden conversation itself — transcript, composer, and the approve/deny
 * confirm cards — extracted from WardenView so the LiveRail's Warden tab and
 * the full page render the one `useWardenSession` the App mounts. Status
 * questions are answered directly; anything mutating shows up as a confirm
 * card in the transcript and runs only once approved there.
 */
export function WardenChat({ warden, compact = false }: WardenChatProps) {
  // The composer's text is the session's, not this component's: the rail
  // unmounts this chat on a tab flip and on collapse, and navigating to the
  // Warden page unmounts the rail entirely. Only one of the two textareas
  // below is ever on screen (which one depends on `conversationId`), so a
  // single draft is unambiguous.
  const { draft, setDraft } = warden;

  // Sending state is the session's too, and for the same reason as the draft:
  // the rail's tab flip unmounts this panel, so a `setState` from a call that
  // fails after the flip would land on an unmounted component and report the
  // failure to nobody. One flag and one error cover both composers — only one
  // of them is ever on screen, and `conversationId` decides which.
  const { sending, sendError } = warden;

  // Which action a decision is in flight for — the session's, not this
  // component's: approving runs the real mutation before the call resolves, and
  // every surface that renders a confirm card is unmounted by an ordinary tab
  // flip, collapse or navigation. A local flag would reset to null on remount
  // and re-enable cards whose effect is still running.
  const decidingId = warden.decidingActionId;
  // The last decision's error. One at a time is plenty: per-card error maps
  // would complicate a state the failure row on the card already covers. This
  // one stays local — a banner is worth losing on unmount, a lock is not.
  const [decideError, setDecideError] = useState<string | null>(null);

  const thread = useMemo(
    () => buildWardenThread(warden.record),
    [warden.record]
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
  // broken conversation showing its 404 banner, not the warden answering);
  // with a record cached, one failed *background* refetch mid-turn must not
  // flip the composer open against a turn the server would still 409.
  const busy =
    warden.conversationId !== null &&
    (warden.record === undefined
      ? warden.recordError === null
      : warden.record.state === 'running');

  // A queued mutation nobody has decided on. Gates the compact reset: dropping
  // the conversation is the only way to lose the confirm card in the UI. No
  // `recordError` guard needed — useWardenSession clears `record` when the
  // daemon says the conversation is gone, so this cannot lock on a ghost.
  const hasPendingAction = (warden.record?.pendingActions.length ?? 0) > 0;

  /**
   * Both composers' submit. Everything past the guard — clearing the draft,
   * putting it back on failure, the in-flight flag, the error — belongs to
   * `warden.submit`, which picks `start` or `sendMessage` off `conversationId`
   * exactly as the branch below picks which composer to render.
   *
   * `busy` is re-checked here rather than only on the button because the
   * composer stays editable mid-turn: Enter must not slip a message past a
   * turn the server would 409.
   */
  function submitDraft() {
    const text = draft.trim();
    if (text === '' || sending || busy) return;
    void warden.submit(text);
  }

  async function decide(actionId: string, approve: boolean) {
    if (decidingId !== null) return;
    setDecideError(null);
    try {
      // The session raises and clears the lock around this call, so it outlives
      // this component.
      await warden.confirmAction(actionId, approve);
    } catch (err) {
      // An approved-but-failed effect: the server already put the action back
      // in the queue with a failure row (the card re-renders with it), so this
      // banner is for transport-level failures where no record came back.
      setDecideError(err instanceof Error ? err.message : String(err));
    }
  }

  function renderRow(item: WardenThreadItem) {
    switch (item.kind) {
      case 'message':
        return (
          <WardenMessageBubble
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
            className="text-muted-foreground flex items-start gap-1.5 self-start px-1 text-[12px]"
          >
            <Wrench className="size-3 shrink-0 translate-y-0.5" />
            <span className="line-clamp-2">
              <span className="font-mono">{item.tool}</span> — {item.text}
            </span>
          </div>
        );
      case 'confirm':
        return (
          <WardenConfirmCard
            key={item.key}
            action={item.action}
            failure={item.failure}
            deciding={decidingId === item.action.id}
            locked={decidingId !== null}
            onDecide={(approve) => void decide(item.action.id, approve)}
          />
        );
      case 'outcome':
        return (
          <WardenOutcomeRow
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
            className="border-border bg-muted/40 text-muted-foreground flex items-center gap-2 self-start rounded-md border px-3 py-2 text-[13px]"
          >
            <Spinner className="text-primary size-3.5" />
            The warden is looking at the project…
          </div>
        );
      case 'failed':
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
  }

  if (warden.conversationId === null) {
    return (
      <div
        className={cn(
          'flex flex-col gap-3',
          !compact &&
            'border-border bg-card animate-in fade-in-0 rounded-lg border p-4 duration-150'
        )}
      >
        <p className="text-muted-foreground text-[13px]">
          {compact
            ? 'Ask about runs, tasks, the queue. Actions wait for your approval.'
            : 'Ask about this project — runs, tasks, the merge queue, what needs you. The warden can also act (dispatch, cancel, approve), but every mutation waits for your explicit approval here first.'}
        </p>
        {sendError !== null && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
            <CircleAlert className="size-4 shrink-0" />
            <span>{sendError}</span>
          </div>
        )}
        <Textarea
          rows={compact ? 2 : 3}
          placeholder="What's going on with my agents?"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submitDraft();
            }
          }}
          aria-label="Warden opening question"
          className="resize-y text-[13px]"
        />
        <div className="flex justify-end">
          <Button
            size={compact ? 'sm' : 'default'}
            disabled={sending || draft.trim() === ''}
            onClick={submitDraft}
          >
            {sending ? (
              <>
                <Spinner className="size-4" /> Starting…
              </>
            ) : (
              <>
                <Send className="size-4" /> Ask
              </>
            )}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        compact
          ? 'gap-2'
          : 'border-border bg-card animate-in fade-in-0 gap-3 rounded-lg border p-4 duration-150'
      )}
    >
      {warden.recordError !== null && warden.record === undefined && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
          <CircleAlert className="size-4 shrink-0" />
          <span>{warden.recordError}</span>
        </div>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Warden conversation"
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto"
      >
        {thread.map(renderRow)}
      </div>

      <div
        className={cn(
          'border-border flex flex-col gap-1.5 border-t',
          compact ? 'pt-2' : 'pt-3'
        )}
      >
        {(sendError ?? decideError) !== null && (
          <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
            <CircleAlert className="size-4 shrink-0" />
            <span>{sendError ?? decideError}</span>
          </div>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground min-w-0 flex-1 truncate text-[11px]">
            {busy
              ? 'The warden is answering…'
              : compact
                ? 'Actions wait for your approval.'
                : 'Ask a follow-up. Actions always wait for your approval.'}
          </span>
          {compact && (
            // The full page's "New conversation" lives in its header; the rail
            // has no header of its own, so the reset rides the composer row.
            // Disabled while an action awaits a decision: reset() drops the
            // only UI handle on this conversation, and a pending mutation must
            // stay decidable. Its accessible name deliberately omits the word
            // "warden": the sidebar's global nav has a button named exactly
            // "Warden", and role-name matching is case-insensitive substring
            // by default, so any rail button carrying the word would make that
            // name ambiguous.
            <Button
              variant="ghost"
              size="xs"
              disabled={hasPendingAction}
              onClick={() => warden.reset()}
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
        <div className={cn('flex gap-2', compact && 'flex-col')}>
          <Textarea
            rows={2}
            placeholder="Ask about runs, tasks, the queue — or ask it to act…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                submitDraft();
              }
            }}
            aria-label="Follow-up message"
            className="min-h-0 flex-1 resize-none text-[13px]"
          />
          <Button
            size={compact ? 'sm' : 'default'}
            disabled={busy || sending || draft.trim() === ''}
            onClick={submitDraft}
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
      </div>
    </div>
  );
}
