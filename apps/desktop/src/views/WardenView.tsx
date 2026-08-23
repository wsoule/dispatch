import type { WardenAction } from '@dispatch/client';
import { Check, CircleAlert, Plus, Shield, Wrench, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { Markdown } from '../components/runs/Markdown';
import { DaemonUnavailable } from '../components/shell/DaemonUnavailable';
import type { DispatchProjectData } from '../hooks/useDispatchProject';
import type { WardenSession } from '../hooks/useWardenSession';
import { formatRelativeTimeFromIso } from '../lib/format';
import type { WardenThreadItem } from '../lib/wardenThread';
import { buildWardenThread } from '../lib/wardenThread';
import { cn } from '@/lib/utils';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Button } from '@/ui/button';
import { Spinner } from '@/ui/spinner';

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
  /** A decision for *this* action is currently in flight. */
  deciding: boolean;
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
          disabled={deciding}
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
          disabled={deciding}
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

interface WardenViewProps {
  data: DispatchProjectData;
  warden: WardenSession;
}

/**
 * The Warden tab — a chat with the project assistant. Status questions are
 * answered directly; anything mutating shows up as a confirm card in the
 * transcript and runs only once approved there. The conversation itself lives
 * in `useWardenSession` (mounted by App), so switching tabs and coming back
 * lands on the same transcript.
 */
export function WardenView({ data, warden }: WardenViewProps) {
  const [prompt, setPrompt] = useState('');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState<string | null>(null);

  const [followUp, setFollowUp] = useState('');
  const [sending, setSending] = useState(false);
  const [sendError, setSendError] = useState<string | null>(null);

  // Which action a decision is in flight for, and the last decision's error —
  // one at a time is plenty: the confirm call is quick, and per-card error
  // maps would complicate a state the failure row on the card already covers.
  const [decidingId, setDecidingId] = useState<string | null>(null);
  const [decideError, setDecideError] = useState<string | null>(null);

  const thread = useMemo(
    () => buildWardenThread(warden.record),
    [warden.record]
  );

  // Pin the transcript to the newest row — keyed on the last row's identity as
  // well as the count, since a turn settling in place (pending spinner → reply)
  // can change what's at the bottom without changing how many rows there are.
  const scrollRef = useRef<HTMLDivElement>(null);
  const lastKey = thread.length > 0 ? thread[thread.length - 1].key : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null) el.scrollTop = el.scrollHeight;
  }, [thread.length, lastKey]);

  if (data.portLoading || data.portError || data.client === null) {
    return (
      <DaemonUnavailable
        starting={data.portLoading}
        errorDetail={data.portErrorDetail}
        onRetry={data.retryEnsureDispatchd}
      />
    );
  }

  // A turn is in flight — dispatchd 409s a second message until it settles.
  // Confirm cards stay live on purpose: the server accepts a decision mid-turn.
  const busy =
    warden.conversationId !== null &&
    (warden.record === undefined || warden.record.state === 'running');

  async function startConversation() {
    const text = prompt.trim();
    if (text === '' || starting) return;
    setStarting(true);
    setStartError(null);
    try {
      await warden.start(text);
      setPrompt('');
    } catch (err) {
      setStartError(err instanceof Error ? err.message : String(err));
    } finally {
      setStarting(false);
    }
  }

  async function sendFollowUp() {
    const text = followUp.trim();
    // Re-checked here, not just on the button: the composer stays editable
    // mid-turn, so Enter must not slip a message past a turn the server
    // would 409.
    if (text === '' || busy || sending) return;
    setSending(true);
    setSendError(null);
    try {
      await warden.sendMessage(text);
      setFollowUp('');
    } catch (err) {
      setSendError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  async function decide(actionId: string, approve: boolean) {
    if (decidingId !== null) return;
    setDecidingId(actionId);
    setDecideError(null);
    try {
      await warden.confirmAction(actionId, approve);
    } catch (err) {
      // An approved-but-failed effect: the server already put the action back
      // in the queue with a failure row (the card re-renders with it), so this
      // banner is for transport-level failures where no record came back.
      setDecideError(err instanceof Error ? err.message : String(err));
    } finally {
      setDecidingId(null);
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

  return (
    <div className="mx-auto flex h-full min-h-0 w-full max-w-[60rem] flex-col gap-4">
      <div className="flex items-center justify-end gap-3">
        {warden.conversationId !== null && (
          <Button variant="outline" size="sm" onClick={() => warden.reset()}>
            <Plus className="size-3.5" /> New conversation
          </Button>
        )}
      </div>

      {warden.conversationId === null ? (
        <div className="bg-card shadow-card animate-in fade-in-0 rounded-card flex flex-col gap-3 p-4 duration-150">
          <p className="text-muted-foreground text-[13px]">
            Ask about this project — runs, tasks, the merge queue, what needs
            you. The warden can also act (dispatch, cancel, approve), but every
            mutation waits for your explicit approval here first.
          </p>
          {startError !== null && (
            <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
              <CircleAlert className="size-4 shrink-0" />
              <span>{startError}</span>
            </div>
          )}
          <PromptBar
            value={prompt}
            onChange={setPrompt}
            onSubmit={() => void startConversation()}
            disabled={starting}
            placeholder="What's going on with my agents?"
          />
        </div>
      ) : (
        <div className="bg-card shadow-card animate-in fade-in-0 rounded-card flex min-h-0 flex-1 flex-col gap-3 p-4 duration-150">
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

          <div className="border-border flex flex-col gap-1.5 border-t pt-3">
            {(sendError ?? decideError) !== null && (
              <div className="border-destructive/30 bg-destructive/10 text-destructive flex items-center gap-2 rounded-md border px-3 py-2 text-[13px]">
                <CircleAlert className="size-4 shrink-0" />
                <span>{sendError ?? decideError}</span>
              </div>
            )}
            <span className="text-muted-foreground text-[11px]">
              {busy
                ? 'The warden is answering…'
                : 'Ask a follow-up. Actions always wait for your approval.'}
            </span>
            <PromptBar
              value={followUp}
              onChange={setFollowUp}
              onSubmit={() => void sendFollowUp()}
              disabled={busy || sending}
              placeholder="Ask about runs, tasks, the queue — or ask it to act…"
            />
          </div>
        </div>
      )}
    </div>
  );
}
