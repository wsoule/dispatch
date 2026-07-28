import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import {
  Info,
  Megaphone,
  MessageSquare,
  MessageSquarePlus,
  Send,
} from 'lucide-react';
import { useState } from 'react';

import { useStickToBottom } from '../../hooks/useStickToBottom';
import { groupLogEntries } from '../../lib/runLog';
import { isTerminalRunState } from '../../lib/runState';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { TranscriptRow } from './TranscriptRow';
import { cn } from '@/lib/utils';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

// The two states where the composer talks to a still-running agent (send a follow-up
// message) rather than resuming a finished one (request changes) — deliberately excludes
// `provisioning`, which has no agent listening yet.
const SENDABLE_STATES = new Set<RunMeta['state']>([
  'running',
  'awaiting-approval',
]);

function ChatMessageBubble({ entry }: { entry: NormalizedEntry }) {
  const fromUser = entry.from === 'user';
  const toUser = entry.from === 'agent' && entry.toUser === true;

  if (toUser) {
    return (
      <div className="border-primary/40 bg-primary/10 flex w-full flex-col gap-0.5 rounded-md border px-3 py-2">
        <div className="text-primary flex items-center gap-1.5 text-[11px] font-medium tracking-wide uppercase">
          <Megaphone className="size-3" />
          To you
          <span className="text-muted-foreground/70 normal-case">
            from {entry.fromLabel ?? 'an agent'}
          </span>
        </div>
        <Markdown content={entry.text ?? ''} className="text-[13px]" />
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex max-w-[90%] flex-col gap-0.5 rounded-md px-3 py-2',
        fromUser
          ? 'bg-primary text-primary-foreground self-end'
          : 'border-state-waiting-edge bg-state-waiting-surface self-start border'
      )}
    >
      <div
        className={cn(
          'text-[11px] font-medium tracking-wide uppercase',
          fromUser ? 'text-primary-foreground/70' : 'text-state-waiting'
        )}
      >
        {fromUser ? 'You' : `↳ ${entry.fromLabel ?? 'another agent'}`}
      </div>
      <Markdown content={entry.text ?? ''} className="text-[13px]" />
    </div>
  );
}

interface RunLogViewProps {
  meta: RunMeta;
  entries: NormalizedEntry[];
  /** The pending approval this window has seen live via the `approval.requested` WS event, or
   * `null` when there isn't one (or when `meta.state` is `awaiting-approval` because a run
   * paused before this window connected — see the banner below for that case; the daemon
   * doesn't expose a paused run's requestId over `GET /api/runs/:id`, only the live WS event
   * carries it, so there's nothing to resume approving from here without it). */
  pendingApproval: { requestId: string; toolName: string } | null;
  onApprove: (
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  onSendMessage: (text: string) => Promise<void>;
  /** Resumes a terminal run with feedback (the same action the Diff tab's "Request changes"
   * button drives) — this view offers it too once the run is done, so talking to the agent
   * works the same way (one composer, always in the same place) whether the run is still
   * going or already finished. */
  onRequestChanges: (text: string) => Promise<void>;
}

/** The run's transcript: chat-style normalized log, the approval gate when one is pending, and
 * a message composer whose action switches with the run's own state — "Send" while an agent
 * is actually listening (running/awaiting-approval), "Request changes" once the run is done
 * (resumes it with feedback). Always shown in RunsView's Session tab, live or terminal, so the
 * user can see and talk to the agent regardless of which tab they're on. */
export function RunLogView({
  meta,
  entries,
  pendingApproval,
  onApprove,
  onSendMessage,
  onRequestChanges,
}: RunLogViewProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keyed on the run id because this view is reused (not remounted) when the user picks a
  // different run on the left, and each run should open at its latest output.
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom(meta.id);

  const groups = groupLogEntries(entries);
  const terminal = isTerminalRunState(meta.state);
  const canSend = SENDABLE_STATES.has(meta.state);

  // Finds the most recent tool-log entry with a matching name to back the
  // approval card's input preview — see the field doc comment above for why
  // this is a best-effort lookup rather than something the API hands us
  // directly.
  const pendingApprovalInput =
    pendingApproval !== null
      ? entries
          .filter(
            (e) => e.kind === 'tool' && e.toolName === pendingApproval.toolName
          )
          .at(-1)?.toolInput
      : undefined;

  async function submit() {
    if (draft.trim() === '') return;
    setSending(true);
    setError(null);
    try {
      if (terminal) await onRequestChanges(draft.trim());
      else await onSendMessage(draft.trim());
      setDraft('');
      // Sending is an explicit "I'm caught up" signal, so re-pin even if the user had
      // scrolled back through history to write the message.
      scrollToBottom();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto px-1">
        <div ref={contentRef} className="flex min-h-full flex-col gap-2">
          {meta.resumedFrom !== undefined && (
            <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-1 text-center text-[11px]">
              <Info className="size-3 shrink-0" />
              Resumed from run {meta.resumedFrom} — earlier conversation lives
              there.
            </div>
          )}
          {groups.length === 0 && (
            <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
              <MessageSquare className="size-5" />
              <p className="text-[13px]">
                {meta.state === 'provisioning'
                  ? 'Waiting for the run to start…'
                  : 'No log entries yet.'}
              </p>
            </div>
          )}
          {/* A tagged gutter rather than chat bubbles: fixed-width tags turn the transcript
              into a scannable spine, so the shape of what the agent did is visible without
              reading it. The user's own turns keep the bubble treatment — they are the one
              thing you want to pick out of the stream at a glance, and a bubble does that
              better than a tag. */}
          {groups.map((group, i) =>
            group.kind === 'tools' ? (
              <div key={i} className="flex flex-col">
                {group.entries.map((entry, j) => (
                  <TranscriptRow key={j} entry={entry} />
                ))}
              </div>
            ) : group.entries[0].kind === 'message' ? (
              <ChatMessageBubble key={i} entry={group.entries[0]} />
            ) : (
              <TranscriptRow key={i} entry={group.entries[0]} />
            )
          )}

          {/* The gate belongs in the conversation, at the point it was asked: the turns above it
              are the context for the decision. Rendered last inside the scroller rather than
              pinned below it, so it scrolls with the transcript and the surrounding work stays
              readable while you decide. */}
          {meta.state === 'awaiting-approval' &&
            (pendingApproval !== null ? (
              <ApprovalCard
                toolName={pendingApproval.toolName}
                toolInput={pendingApprovalInput}
                frozenSince={meta.updatedAt}
                onDecide={(allow, opts) =>
                  onApprove(pendingApproval.requestId, allow, opts)
                }
              />
            ) : (
              <div className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]">
                <Info className="size-3.5 shrink-0 translate-y-0.5" />
                This run is waiting on an approval this window didn&rsquo;t see
                live — reopen it from a session that was connected when the
                approval was requested, or check the run&rsquo;s process
                directly.
              </div>
            ))}
        </div>
      </div>

      {error !== null && (
        <div className="border-destructive/30 bg-destructive/10 text-destructive rounded-md border px-3 py-2 text-[12px]">
          {error}
        </div>
      )}

      {(canSend || terminal) && (
        <div className="border-border flex flex-col gap-1.5 border-t pt-3">
          <span className="text-muted-foreground text-[11px]">
            {terminal
              ? 'This run is done — sending feedback resumes it with your notes.'
              : 'Talk to the agent — it reads this while the run keeps going.'}
          </span>
          <div className="flex gap-2">
            <Textarea
              rows={2}
              placeholder={
                terminal
                  ? 'Describe what should change…'
                  : 'Send a follow-up message…'
              }
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void submit();
                }
              }}
              disabled={sending}
              className="min-h-0 flex-1 resize-none"
            />
            <Button
              disabled={sending}
              onClick={() => void submit()}
              className="self-end"
            >
              {terminal ? (
                <>
                  <MessageSquarePlus className="size-3.5" />
                  Request changes
                </>
              ) : (
                <>
                  <Send className="size-3.5" />
                  Send
                </>
              )}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
