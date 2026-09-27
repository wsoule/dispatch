import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import { foldSubagents } from '@dispatch/core/browser';
import {
  Info,
  Mail,
  Megaphone,
  MessageSquare,
  MessageSquarePlus,
  Play,
} from 'lucide-react';
import { memo, useMemo, useState } from 'react';

import { useStickToBottom } from '../../hooks/useStickToBottom';
import type { DecideAvailability } from '../../lib/daemonAuth';
import type { RunQuestion, RunScopeRequest } from '../../lib/gates';
import type { PendingApproval } from '../../lib/pendingApprovals';
import { groupLogEntries } from '../../lib/runLog';
import { parseDeliveredText, parseDigestLine } from '../../lib/runMessages';
import {
  continueMessage,
  deriveRunDisposition,
  isTerminalRunState,
  postFailWorkLabel,
} from '../../lib/runState';
import { ApprovalCard } from './ApprovalCard';
import { Markdown } from './Markdown';
import { QuestionCard } from './QuestionCard';
import { ScopeRequestCard } from './ScopeRequestCard';
import { SubagentTree } from './SubagentTree';
import { TranscriptRow } from './TranscriptRow';
import { cn } from '@/lib/utils';
import { LoadingState } from '@/ui/ai/loading-state';
import { Pill } from '@/ui/ai/pill';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { Alert, AlertDescription } from '@/ui/alert';
import { Button } from '@/ui/button';
import { Textarea } from '@/ui/textarea';

// The two states where the composer talks to a still-running agent (send a follow-up
// message) rather than resuming a finished one (request changes) — deliberately excludes
// `provisioning`, which has no agent listening yet.
const SENDABLE_STATES = new Set<RunMeta['state']>([
  'running',
  'awaiting-approval',
]);

const KIND_LABEL: Record<string, string> = {
  question: 'Question',
  handoff: 'Handoff',
  notice: 'Notice',
  answer: 'Answer',
};
// The agent-facing prompt to answer with msg_reply; a person reading the chat has no use for it.
const WAITING_NOTE = 'The sender is waiting.';

// `about` names the message, so a list of these links reads apart for a screen reader.
function OpenThread({
  messageId,
  about,
  onOpen,
}: {
  messageId: string;
  about: string | undefined;
  onOpen: (messageId: string) => void;
}) {
  return (
    <button
      type="button"
      aria-label={about === undefined ? undefined : `Open thread: ${about}`}
      className="text-muted-foreground hover:text-foreground ml-auto text-[12px] font-normal hover:underline"
      onClick={() => onOpen(messageId)}
    >
      Open thread
    </button>
  );
}

// Memoized so a run.log append re-renders only the new row; entries keep their identity.
const ChatMessageBubble = memo(function ChatMessageBubble({
  entry,
  me,
  onOpenMessage,
}: {
  entry: NormalizedEntry;
  me: string | null | undefined;
  onOpenMessage?: (messageId: string) => void;
}) {
  const text = entry.text ?? '';
  const link = (messageId: string | undefined, about?: string) =>
    messageId !== undefined && onOpenMessage !== undefined ? (
      <OpenThread messageId={messageId} about={about} onOpen={onOpenMessage} />
    ) : null;

  if (entry.digest === true) {
    const digest = parseDigestLine(text);
    const line =
      digest === null
        ? text
        : `${digest.channel === null ? '' : `#${digest.channel} · `}${digest.kind} from ${digest.from}: ${digest.summary}`;
    return (
      <div className="text-muted-foreground font-book flex items-center gap-1.5 px-1 text-[12px]">
        <Mail className="size-3 shrink-0" />
        <span className="min-w-0 flex-1 truncate" title={line}>
          {line}
        </span>
        {link(
          entry.messageId ?? digest?.messageId,
          digest === null ? undefined : `${digest.kind} from ${digest.from}`
        )}
      </div>
    );
  }

  const fromUser = entry.from === 'user';
  const toUser = entry.from === 'agent' && entry.toUser === true;

  if (toUser) {
    const sender = entry.fromLabel ?? 'an agent';
    return (
      <div className="bg-surface-quaternary border-border-strong rounded-card flex w-full flex-col gap-0.5 border-[0.5px] px-3 py-2">
        <div className="flex items-center gap-1.5 text-[12px] font-medium text-(--text-secondary)">
          <Megaphone className="size-3" />
          To you
          <span className="text-muted-foreground font-book">from {sender}</span>
          {link(entry.messageId, `to you from ${sender}`)}
        </div>
        <Markdown content={text} className="font-book text-[13px]" />
      </div>
    );
  }

  // A pushed bus message is stored as the agent saw it; show its body, not the framing.
  const delivered =
    entry.messageId === undefined ? null : parseDeliveredText(text);
  const notes =
    delivered?.notes.filter((line) => !line.startsWith(WAITING_NOTE)) ?? [];
  const kind = delivered?.kind;
  const kindLabel =
    kind === undefined || kind === 'message'
      ? undefined
      : (KIND_LABEL[kind] ?? kind);
  const sender = entry.fromLabel ?? delivered?.from;
  // A human sender reads as "You" only when it is the viewer, or composer text with no sender.
  const heading = fromUser
    ? sender === undefined || sender === me
      ? 'You'
      : sender
    : `↳ ${sender ?? 'another agent'}`;
  return (
    <div
      className={cn(
        'flex max-w-[90%] flex-col gap-0.5 rounded-card px-3 py-2',
        fromUser
          ? 'bg-surface-quaternary self-end border-[0.5px] border-border-strong'
          : 'bg-state-waiting-surface self-start'
      )}
    >
      <div
        className={cn(
          'flex items-center gap-1.5 text-[12px] font-medium',
          fromUser ? 'text-muted-foreground' : 'text-state-waiting'
        )}
      >
        {heading}
        {kindLabel !== undefined && <Pill>{kindLabel}</Pill>}
        {delivered?.urgent === true && <Pill>Urgent</Pill>}
        {link(
          entry.messageId,
          `${kind ?? 'message'} from ${sender ?? 'another agent'}`
        )}
      </div>
      <Markdown
        content={delivered?.body ?? text}
        className="font-book text-[13px]"
      />
      {notes.length > 0 && (
        <div className="text-muted-foreground font-book text-[12px]">
          {notes.map((line, i) => (
            <p key={i}>{line}</p>
          ))}
        </div>
      )}
    </div>
  );
});

interface RunLogViewProps {
  meta: RunMeta;
  entries: NormalizedEntry[];
  /** Each tool call this run is parked on, oldest first, one card per call. Empty while
   * this window cannot read gates or the list has not loaded; a banner covers that. */
  pendingApprovals: readonly PendingApproval[];
  onApprove: (
    requestId: string,
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  /** Reads a parked call's full input, for a card whose gate carries only a preview. */
  onLoadApprovalInput?: (requestId: string) => Promise<unknown>;
  onSendMessage: (text: string) => Promise<void>;
  /** Blocking questions this run's agent sent a human, oldest first. Usually one, but an
   * agent can send several in a single turn. */
  openQuestions: RunQuestion[];
  onAnswerQuestion: (questionId: string, answer: string) => Promise<void>;
  /** The run's open scope gate (paths + reason), or `null` when there isn't one. */
  pendingScopeRequest: RunScopeRequest | null;
  onDecideScopeRequest: (granted: boolean) => Promise<void>;
  /** Whether this window can decide at all — see `decideAvailability`. Gates the approval
   * card and the scope card alike: both are adjudications the daemon only takes on the app
   * token. */
  scopeDecide: DecideAvailability;
  onRestartDaemon: () => Promise<void>;
  /** Resumes a terminal run with feedback (the same action the Diff tab's "Request changes"
   * button drives) — this view offers it too once the run is done, so talking to the agent
   * works the same way (one composer, always in the same place) whether the run is still
   * going or already finished. */
  onRequestChanges: (text: string) => Promise<void>;
  /** Opens the Threads view on a delivered message's thread; without it, no links. */
  onOpenMessage?: (messageId: string) => void;
  /** The viewer's address (`human:<handle>`): a human sender matching it reads as "You".
   * While it is unknown, every addressed human sender shows its address. */
  me?: string | null;
}

/** The run's transcript: chat-style normalized log, the approval gate when one is pending, and
 * a message composer whose action switches with the run's own state — "Send" while an agent
 * is actually listening (running/awaiting-approval), "Request changes" once the run is done
 * (resumes it with feedback). Always shown in the task view's Chat tab, live or terminal, so the
 * user can see and talk to the agent regardless of which tab they're on. */
export function RunLogView({
  meta,
  entries,
  pendingApprovals,
  onApprove,
  onLoadApprovalInput,
  onSendMessage,
  openQuestions,
  onAnswerQuestion,
  pendingScopeRequest,
  onDecideScopeRequest,
  scopeDecide,
  onRestartDaemon,
  onRequestChanges,
  onOpenMessage,
  me,
}: RunLogViewProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Keyed on the run id because this view is reused (not remounted) when the user picks a
  // different run on the left, and each run should open at its latest output.
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom(meta.id);

  const groups = groupLogEntries(entries);
  // The sub-agents this run fanned out into, folded from the same entries the
  // transcript renders — so the tree ticks with each `run.log` event.
  const subagents = useMemo(() => foldSubagents(entries), [entries]);
  const terminal = isTerminalRunState(meta.state);
  const canSend = SENDABLE_STATES.has(meta.state);
  // The transcript's one genuinely live entry — the run's last *rendered* entry while it's
  // actually still producing output. Drives `TranscriptRow`'s `live` prop (StreamingText's
  // reveal, Thinking's shimmer, ToolChip's running state); never true for a paused or finished
  // run, and never true for anything but the last entry, so history never fakes still being
  // written. Derived from `groups` (post `groupLogEntries`), not the raw `entries` array —
  // `groupLogEntries` drops `usage`-kind entries, which never render a `TranscriptRow` at all,
  // so a `usage` entry arriving after the last visible one would otherwise make `entries.at(-1)`
  // point at something nothing on screen matches, killing every live indicator.
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;
  const lastEntry =
    lastGroup !== undefined
      ? lastGroup.entries[lastGroup.entries.length - 1]
      : undefined;
  const isLive = (entry: NormalizedEntry) =>
    meta.state === 'running' && entry === lastEntry;
  // Only a run that stopped short of finishing has something to *continue* —
  // and only one with a session id, which is the same thing the server's own
  // resume gate checks, so the button never offers what would 400.
  const canContinue = deriveRunDisposition(meta) === 'stopped-short';
  const orphanWork = postFailWorkLabel(meta);

  async function send(text: string, resume: boolean) {
    setSending(true);
    setError(null);
    try {
      if (resume) await onRequestChanges(text);
      else await onSendMessage(text);
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

  async function submit() {
    if (draft.trim() === '') return;
    await send(draft.trim(), terminal);
  }

  // Deliberately not gated on a non-empty draft, unlike submit(): a run that was
  // cut off mid-task needs no feedback written to be worth resuming.
  async function continueRun() {
    await send(continueMessage(draft), true);
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      {/* The fan-out, above the transcript rather than in it: a run with thirty sub-agents is
          one event in its own story, but each of the thirty is a thing you want to watch, and
          a list of them scrolling by inside the log would be unreadable. Outside the scroller
          so it never covers the log; it caps its own height and scrolls within itself. */}
      {subagents.length > 0 && (
        <SubagentTree nodes={subagents} className="mx-1 shrink-0" />
      )}
      <div
        ref={scrollRef}
        role="region"
        aria-label="Run log"
        className="min-h-0 flex-1 overflow-y-auto px-1"
      >
        <div ref={contentRef} className="flex min-h-full flex-col gap-3">
          {meta.resumedFrom !== undefined && (
            <div className="text-muted-foreground font-book flex items-center justify-center gap-1.5 py-1 text-center text-[12px]">
              <Info className="size-3 shrink-0" />
              Resumed from run {meta.resumedFrom} — earlier conversation lives
              there.
            </div>
          )}
          {groups.length === 0 &&
            (meta.state === 'provisioning' || meta.state === 'running' ? (
              <div className="flex flex-1 items-center justify-center">
                <LoadingState
                  label={
                    meta.state === 'provisioning'
                      ? 'Waiting for the run to start…'
                      : 'Working…'
                  }
                  startedAt={Date.parse(meta.createdAt)}
                />
              </div>
            ) : (
              <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 text-center">
                <MessageSquare className="size-5" />
                <p className="font-book text-[13px]">No log entries yet.</p>
              </div>
            ))}
          {/* Three levels of emphasis, which is what the flat version was missing. What the
              agent SAID is the transcript's spine and gets full weight. What it DID is
              subordinate — a run of tool calls collapses into one quiet block behind a rule, so
              twelve file reads read as one event rather than twelve. What YOU said is a bubble,
              because finding your own interjections is a different job from reading along. */}
          {groups.map((group, i) =>
            group.kind === 'tools' ? (
              <div
                key={i}
                className="border-border my-0.5 flex flex-col border-l-[0.5px] pl-2"
              >
                {group.entries.map((entry, j) => (
                  <TranscriptRow key={j} entry={entry} live={isLive(entry)} />
                ))}
              </div>
            ) : group.entries[0].kind === 'message' ? (
              <ChatMessageBubble
                key={i}
                entry={group.entries[0]}
                me={me}
                onOpenMessage={onOpenMessage}
              />
            ) : (
              <TranscriptRow
                key={i}
                entry={group.entries[0]}
                live={isLive(group.entries[0])}
              />
            )
          )}

          {/* Why the run stopped, in the run itself — without this a force-failed run (a
              daemon restart, not the agent's doing) reads as "failed, $0" with zero
              explanation. Rendered at the end of the transcript because the failure is
              chronologically the run's last event. */}
          {(meta.state === 'failed' || meta.state === 'interrupted-dirty') &&
            meta.error !== undefined && (
              <div className="bg-state-failed-surface text-state-failed rounded-card font-book flex items-start gap-2 px-3 py-2 text-[12px]">
                <Info className="size-3.5 shrink-0 translate-y-0.5" />
                {meta.error}
              </div>
            )}

          {/* A merge or discard that threw partway (a squash conflict, say) leaves the
              run unreviewed and resumable — but the operator has to be told why, or a
              run that failed to merge looks identical to one nobody has reviewed yet.
              Cleared by the server the moment a later review completes. */}
          {meta.reviewedAt === undefined &&
            meta.reviewFailure !== undefined && (
              <div className="bg-state-failed-surface text-state-failed rounded-card font-book flex items-start gap-2 px-3 py-2 text-[12px]">
                <Info className="size-3.5 shrink-0 translate-y-0.5" />
                <span className="whitespace-pre-wrap">
                  {meta.reviewFailure.action} failed:{' '}
                  {meta.reviewFailure.reason}
                </span>
              </div>
            )}

          {/* The run failed but its branch kept moving — the orphaned agent process
              survived and committed. Distinguishes "dead $0 run" from "the work actually
              landed, go look at the branch". */}
          {orphanWork !== null && (
            <div className="bg-state-review-surface text-state-review rounded-card font-book flex items-start gap-2 px-3 py-2 text-[12px]">
              <Info className="size-3.5 shrink-0 translate-y-0.5" />
              {orphanWork}
            </div>
          )}

          {/* A live run that has not printed anything for a moment is indistinguishable from a
              wedged one without this. Only while genuinely running — never on a paused or
              finished run, where a spinner would be a lie. Suppressed when the empty-state
              LoadingState above is already showing the same "Working…" label. */}
          {meta.state === 'running' && groups.length > 0 && (
            <LoadingState
              label="Working…"
              startedAt={Date.parse(meta.createdAt)}
            />
          )}

          {/* The gate belongs in the conversation, at the point it was asked: the turns above it
              are the context for the decision. Rendered last inside the scroller rather than
              pinned below it, so it scrolls with the transcript and the surrounding work stays
              readable while you decide. */}
          {meta.state === 'awaiting-approval' &&
            (pendingApprovals.length > 0 ? (
              pendingApprovals.map((approval) => (
                <ApprovalCard
                  key={approval.requestId}
                  toolName={approval.toolName}
                  toolInput={approval.input}
                  truncated={approval.truncated}
                  loadFullInput={
                    onLoadApprovalInput === undefined
                      ? undefined
                      : () => onLoadApprovalInput(approval.requestId)
                  }
                  frozenSince={meta.updatedAt}
                  onDecide={(allow, opts) =>
                    onApprove(approval.requestId, allow, opts)
                  }
                  availability={scopeDecide}
                  onRestartDaemon={onRestartDaemon}
                />
              ))
            ) : (
              <div className="bg-surface-quaternary text-muted-foreground rounded-card border-border font-book flex items-start gap-2 border-[0.5px] px-3 py-2 text-[12px]">
                <Info className="size-3.5 shrink-0 translate-y-0.5" />
                {/* A window that cannot decide cannot read open gates, so it says why. */}
                {scopeDecide.explanation ??
                  'This run is waiting on an approval that has not reached this window yet; it will appear here shortly.'}
              </div>
            ))}
        </div>
      </div>

      {/* Pinned above the composer, not left in the scroller like the approval gate: the agent
          is frozen inside a tool call, so it must not be possible to scroll past this. */}
      {openQuestions.map((question) => (
        <QuestionCard
          key={question.id}
          question={question.question}
          options={question.options}
          askedAt={question.askedAt}
          onAnswer={(answer) => onAnswerQuestion(question.id, answer)}
        />
      ))}

      {pendingScopeRequest !== null && pendingScopeRequest.granted === null && (
        <ScopeRequestCard
          paths={pendingScopeRequest.paths}
          reason={pendingScopeRequest.reason}
          onDecide={onDecideScopeRequest}
          availability={scopeDecide}
          onRestartDaemon={onRestartDaemon}
        />
      )}

      {error !== null && (
        <Alert
          variant="destructive"
          className="bg-state-failed-surface rounded-card border-none px-3 py-2"
        >
          <AlertDescription className="text-state-failed font-book text-[12px]">
            {error}
          </AlertDescription>
        </Alert>
      )}

      {(canSend || terminal) && (
        <div className="shadow-hairline-top flex flex-col gap-1.5 pt-3">
          <span className="text-muted-foreground font-book text-[12px]">
            {!terminal
              ? 'Talk to the agent. It reads this while it works.'
              : canContinue
                ? 'Stopped early. Continue picks it up, or send notes to change course.'
                : 'Done. Feedback resumes it with your notes.'}
          </span>
          {terminal ? (
            // Resuming a finished run offers two distinctly-labeled actions (Continue picks the
            // session back up as-is; Request changes resumes it with feedback) that the
            // PromptBar primitive's single fixed "Send" action can't express, so this branch
            // keeps its own buttons rather than forcing a primitive built for one action onto a
            // composer that genuinely has two.
            <div className="flex gap-2">
              <Textarea
                rows={2}
                placeholder="Describe what should change…"
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
              {canContinue && (
                <Button
                  variant="secondary"
                  disabled={sending}
                  onClick={() => void continueRun()}
                  className="self-end"
                >
                  <Play className="size-3.5" />
                  Continue
                </Button>
              )}
              <Button
                disabled={sending}
                onClick={() => void submit()}
                className="self-end"
              >
                <MessageSquarePlus className="size-3.5" />
                Request changes
              </Button>
            </div>
          ) : (
            // The live case is a genuine single-action send — this is the composer PromptBar
            // was built for, wired to the same `submit()` (Enter-to-send, Shift+Enter newline)
            // the terminal branch uses.
            <PromptBar
              value={draft}
              onChange={setDraft}
              onSubmit={() => void submit()}
              disabled={sending}
              placeholder="Send a follow-up message…"
            />
          )}
        </div>
      )}
    </div>
  );
}
