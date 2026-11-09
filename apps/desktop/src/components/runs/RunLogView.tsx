import { foldSubagents, providerById } from '@dispatch-foo/core/browser';
import { withRunAttachmentNote } from '@dispatch/client';
import type {
  LiveSegment,
  NormalizedEntry,
  RunAttachment,
  RunMeta,
} from '@dispatch/client';
import { Button, Chip, cx, Notice, Spinner } from '@dispatch/ui';
import {
  FileText,
  Info,
  Mail,
  Megaphone,
  MessageSquare,
  MessageSquarePlus,
  Paperclip,
  Play,
} from 'lucide-react';
import {
  type ClipboardEvent,
  type DragEvent,
  memo,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { useElapsed } from '../../hooks/useElapsed';
import { useRunAttachments } from '../../hooks/useRunAttachments';
import { useStickToBottom } from '../../hooks/useStickToBottom';
import { isFromA2A } from '../../lib/a2a';
import { changedFilesFromLog } from '../../lib/changedFiles';
import type { DecideAvailability } from '../../lib/daemonAuth';
import type { RunQuestion, RunScopeRequest } from '../../lib/gates';
import type { PendingApproval } from '../../lib/pendingApprovals';
import { groupLogEntries, reportsToolResults } from '../../lib/runLog';
import { parseDeliveredText, parseDigestLine } from '../../lib/runMessages';
import {
  continueMessage,
  deriveRunDisposition,
  isTerminalRunState,
  postFailWorkLabel,
} from '../../lib/runState';
import { kindLabel } from '../../lib/threadSources';
import { PromptBar } from '../chat/PromptBar';
import { askAgentToFix, FailureNotice } from '../failure/FailureNotice';
import { ShimmerLabel } from '../transcript/ShimmerLabel';
import { ApprovalCard } from './ApprovalCard';
import { ChangedFilesCard } from './ChangedFilesCard';
import { Markdown } from './Markdown';
import { QuestionCard } from './QuestionCard';
import styles from './RunLogView.module.css';
import { ScopeRequestCard } from './ScopeRequestCard';
import { SubagentTree } from './SubagentTree';
import { TranscriptRow } from './TranscriptRow';
import { WorkFold } from './WorkFold';

// The two states where the composer talks to a still-running agent (send a follow-up
// message) rather than resuming a finished one (request changes) — deliberately excludes
// `provisioning`, which has no agent listening yet.
const SENDABLE_STATES = new Set<RunMeta['state']>([
  'running',
  'awaiting-approval',
]);

const NO_LIVE: readonly LiveSegment[] = [];

// The agent-facing prompt to answer with msg_reply; a person reading the chat has no use for it.
const WAITING_NOTE = 'The sender is waiting.';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** In-flight agent work with nothing on screen to show for it yet: a spinner, the label
 * shimmering (plain under reduced motion), and how long the run has been going, ticking
 * once a second in tabular figures. The spinner stays out of the accessibility tree, since
 * the label beside it already says what is happening. */
function WorkingRow({
  label,
  startedAt,
}: {
  label: string;
  startedAt: number;
}) {
  const elapsed = useElapsed(startedAt);
  return (
    <div className={styles.working} data-slot="run-working">
      <Spinner label="" />
      <span className={styles.workingLabel}>
        <ShimmerLabel>{label}</ShimmerLabel>
      </span>
      <span className={cx(styles.elapsed, 'num')}>{elapsed}</span>
    </div>
  );
}

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
      className={styles.openThread}
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
  readsAllThreads,
}: {
  entry: NormalizedEntry;
  me: string | null;
  onOpenMessage: ((messageId: string) => void) | null;
  readsAllThreads: boolean;
}) {
  const text = entry.text ?? '';
  // Below decide a window reads only threads it took part in, and all the chat
  // knows of a message is who sent it.
  const link = (
    messageId: string | undefined,
    sender: string | undefined,
    about?: string
  ) =>
    messageId !== undefined &&
    onOpenMessage !== null &&
    (readsAllThreads || (me !== null && sender === me)) ? (
      <OpenThread messageId={messageId} about={about} onOpen={onOpenMessage} />
    ) : null;

  if (entry.digest === true) {
    const digest = parseDigestLine(text);
    const line =
      digest === null
        ? text
        : `${digest.channel === null ? '' : `#${digest.channel} · `}${digest.kind} from ${digest.from}: ${digest.summary}`;
    return (
      <div className={styles.digest}>
        <Mail className={styles.digestIcon} {...ICON} size={12} />
        <span className={styles.digestLine} title={line}>
          {line}
        </span>
        {link(
          entry.messageId ?? digest?.messageId,
          digest?.from,
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
      <div className={styles.toYou}>
        <div className={styles.heading}>
          <Megaphone {...ICON} size={12} />
          To you
          <span className={styles.from}>from {sender}</span>
          {link(entry.messageId, sender, `to you from ${sender}`)}
        </div>
        <Markdown content={text} className={styles.messageText} />
      </div>
    );
  }

  // A pushed bus message is stored as the agent saw it; show its body, not the framing.
  const delivered =
    entry.messageId === undefined ? null : parseDeliveredText(text);
  const notes =
    delivered?.notes.filter((line) => !line.startsWith(WAITING_NOTE)) ?? [];
  const kind = delivered?.kind;
  const badge = kind === undefined ? undefined : kindLabel(kind);
  const sender = entry.fromLabel ?? delivered?.from;
  // An A2A or external sender's body shows as typed, so it cannot load an image or link out.
  const plain =
    delivered?.external === true ||
    isFromA2A({ from: delivered?.from ?? sender ?? '' });
  // Only the viewer's own line, or composer text with no sender, reads as "You" on the
  // right; a teammate's sits on the left with the other senders.
  const own = fromUser && (sender === undefined || sender === me);
  const heading = own
    ? 'You'
    : fromUser
      ? sender
      : `↳ ${sender ?? 'another agent'}`;
  return (
    <div className={styles.bubble} data-align={own ? 'end' : 'start'}>
      <div className={styles.heading}>
        {heading}
        {badge !== undefined && <Chip>{badge}</Chip>}
        {delivered?.urgent === true && <Chip>Urgent</Chip>}
        {link(
          entry.messageId,
          sender,
          `${kind ?? 'message'} from ${sender ?? 'another agent'}`
        )}
      </div>
      {plain ? (
        <p className={styles.plainText}>{delivered?.body ?? text}</p>
      ) : (
        <Markdown
          content={delivered?.body ?? text}
          className={styles.messageText}
        />
      )}
      {notes.length > 0 && (
        <div className={styles.notes}>
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
  /** The text the agent is writing right now and `entries` does not hold yet, one segment
   * per text block (useRunLive); none once the run has ended. */
  live?: readonly LiveSegment[];
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
  /** Uploads files dropped, pasted or picked in the composer, which then lists
   * their paths in the next message (live or "Request changes"). Omitted, the
   * composer takes no files. */
  onUploadAttachments?: (files: File[]) => Promise<RunAttachment[]>;
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
  /** Opens the Threads view on a delivered message's thread; null in a window that
   * cannot open threads, which then shows no links. */
  onOpenMessage: ((messageId: string) => void) | null;
  /** The viewer's address (`human:<handle>`): a human sender matching it reads as "You".
   * While it is unknown, every addressed human sender shows its address. */
  me: string | null;
  /** Whether this window can read every thread (the decide tier); below it, only a
   * message the viewer sent links to its thread. */
  readsAllThreads: boolean;
}

/**
 * Whether `node` holds more than it shows (its content taller than its box), kept current as
 * its box and the cards in it change size or come and go. The pinned asks region uses it to
 * be a Tab stop only while a keyboard has hidden text in it to scroll to: where the body has
 * no definite height (the task page's Run mode scrolls as one page) its cap never applies and
 * it never scrolls, so it is no stop at all.
 */
function useOverflowsY(node: HTMLElement | null): boolean {
  const [overflows, setOverflows] = useState(false);
  useEffect(() => {
    if (node === null || typeof ResizeObserver === 'undefined') {
      return undefined;
    }
    // Rounded box sizes can differ by a pixel with nothing hidden.
    const measure = (): void =>
      setOverflows(node.scrollHeight - node.clientHeight > 1);
    // The box is capped, so a card growing past the cap changes the content's height and not
    // the box's: each card is watched too, re-listed as cards are added or removed.
    const sizes = new ResizeObserver(measure);
    const watch = (): void => {
      sizes.disconnect();
      sizes.observe(node);
      for (const child of Array.from(node.children)) sizes.observe(child);
      measure();
    };
    const cards = new MutationObserver(watch);
    cards.observe(node, { childList: true });
    watch();
    return () => {
      cards.disconnect();
      sizes.disconnect();
    };
  }, [node]);
  return node !== null && overflows;
}

/** The run's transcript: chat-style normalized log, the approval gate when one is pending, and
 * a message composer whose action switches with the run's own state — "Send" while an agent
 * is actually listening (running/awaiting-approval), "Request changes" once the run is done
 * (resumes it with feedback). Always shown in the task view's Chat tab, live or terminal, so the
 * user can see and talk to the agent regardless of which tab they're on. */
export function RunLogView({
  meta,
  entries,
  live = NO_LIVE,
  pendingApprovals,
  onApprove,
  onLoadApprovalInput,
  onSendMessage,
  onUploadAttachments,
  openQuestions,
  onAnswerQuestion,
  pendingScopeRequest,
  onDecideScopeRequest,
  scopeDecide,
  onRestartDaemon,
  onRequestChanges,
  onOpenMessage,
  me,
  readsAllThreads,
}: RunLogViewProps) {
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const files = useRunAttachments(onUploadAttachments, setError);
  const canAttach = onUploadAttachments !== undefined && !sending;
  // The finished run's composer is a plain text box, not PromptBar, so it
  // takes drops, pastes and picks itself; the live one gets them from PromptBar.
  const [dragging, setDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const pendingFiles = files.pending.map((p) => ({
    id: p.attachment.path,
    name: p.attachment.name,
    previewUrl: p.previewUrl,
  }));
  // Keyed on the run id because this view is reused (not remounted) when the user picks a
  // different run on the left, and each run should open at its latest output.
  const { scrollRef, contentRef, scrollToBottom } = useStickToBottom(meta.id);
  // The pinned asks region, and whether it scrolls (so whether it takes focus).
  const [asksNode, setAsksNode] = useState<HTMLDivElement | null>(null);
  const asksScroll = useOverflowsY(asksNode);

  const groups = useMemo(() => groupLogEntries(entries), [entries]);
  const settlesCalls = useMemo(() => reportsToolResults(entries), [entries]);
  // The sub-agents this run fanned out into, folded from the same entries the
  // transcript renders — so the tree ticks with each `run.log` event.
  const subagents = useMemo(() => foldSubagents(entries), [entries]);
  const changedFiles = useMemo(() => changedFilesFromLog(entries), [entries]);
  const terminal = isTerminalRunState(meta.state);
  const canSend = SENDABLE_STATES.has(meta.state);
  // The transcript's genuinely live entries, only ever while the run is actually producing
  // output: its last *rendered* entry (unless the agent is already writing past it, in the
  // live text below), and in a run whose executor reports how its calls end, each call of
  // the agent's own still waiting for its result (several can run at once).
  // Drives `TranscriptRow`'s `live` prop (StreamingText's reveal, Thinking's shimmer,
  // ToolChip's running state); never true for a paused or finished run, so history never
  // fakes still being written. A sub-agent's calls never get a result, so they follow the
  // last-entry rule. Derived from `groups` (post `groupLogEntries`), not the raw `entries`
  // array — `groupLogEntries` drops `usage`-kind entries, which never render a `TranscriptRow`
  // at all, so a `usage` entry arriving after the last visible one would otherwise make
  // `entries.at(-1)` point at something nothing on screen matches, killing every live
  // indicator.
  const lastGroup = groups.length > 0 ? groups[groups.length - 1] : undefined;
  const lastEntry =
    lastGroup !== undefined
      ? lastGroup.entries[lastGroup.entries.length - 1]
      : undefined;
  const writing = live.length > 0;
  const isLive = (entry: NormalizedEntry) =>
    meta.state === 'running' &&
    ((entry === lastEntry && !writing) ||
      (settlesCalls &&
        entry.kind === 'tool' &&
        entry.status === 'running' &&
        entry.toolUseId !== undefined &&
        entry.parentToolUseId === undefined));
  // Only a run that stopped short of finishing has something to *continue* —
  // and only one with a session id, which is the same thing the server's own
  // resume gate checks, so the button never offers what would 400.
  const canContinue = deriveRunDisposition(meta) === 'stopped-short';
  const orphanWork = postFailWorkLabel(meta);
  // Why the run stopped, when it failed; a const so the fix's closure keeps the narrowing.
  const stopError =
    meta.state === 'failed' || meta.state === 'interrupted-dirty'
      ? meta.error
      : undefined;
  // A scope request still waiting on its answer pins its card above the composer.
  const scopeOpen =
    pendingScopeRequest !== null && pendingScopeRequest.granted === null;

  // Sends `text` with the pending files listed after it, so the agent knows
  // where on disk to read them; they clear only once the message is out.
  async function send(text: string, resume: boolean) {
    if (files.attaching) return;
    setSending(true);
    setError(null);
    try {
      const body = withRunAttachmentNote(
        text,
        files.pending.map((p) => p.attachment)
      );
      if (resume) await onRequestChanges(body);
      else await onSendMessage(body);
      setDraft('');
      files.clear();
      // Sending is an explicit "I'm caught up" signal, so re-pin even if the user had
      // scrolled back through history to write the message.
      scrollToBottom();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  // A dropped screenshot with no words is a whole message, as in the overseer.
  async function submit() {
    if (draft.trim() === '' && files.pending.length === 0) return;
    await send(draft.trim(), terminal);
  }

  // Drag, drop and paste handlers for the terminal composer. Only a drag that
  // carries files lights it up, so dragging selected text still drops text.
  function filesFrom(dt: DataTransfer | null): File[] {
    if (dt === null) return [];
    const picked: File[] = [];
    for (const item of Array.from(dt.items ?? [])) {
      const file = item.kind === 'file' ? item.getAsFile() : null;
      if (file !== null) picked.push(file);
    }
    return picked.length > 0 ? picked : Array.from(dt.files ?? []);
  }

  function handleDragOver(event: DragEvent<HTMLDivElement>) {
    if (!canAttach || !event.dataTransfer.types.includes('Files')) return;
    event.preventDefault();
    setDragging(true);
  }

  // dragleave fires on every move into a child, so only clear once the
  // pointer has left the composer itself.
  function handleDragLeave(event: DragEvent<HTMLDivElement>) {
    const next = event.relatedTarget;
    if (next instanceof Node && event.currentTarget.contains(next)) return;
    setDragging(false);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    setDragging(false);
    if (!canAttach) return;
    const dropped = filesFrom(event.dataTransfer);
    if (dropped.length === 0) return;
    event.preventDefault();
    void files.attach(dropped);
  }

  function handlePaste(event: ClipboardEvent<HTMLTextAreaElement>) {
    if (!canAttach) return;
    const pasted = filesFrom(event.clipboardData);
    if (pasted.length === 0) return;
    event.preventDefault();
    void files.attach(pasted);
  }

  // Deliberately not gated on a non-empty draft, unlike submit(): a run that was
  // cut off mid-task needs no feedback written to be worth resuming.
  async function continueRun() {
    await send(continueMessage(draft), true);
  }

  return (
    <div className={styles.root}>
      {/* The fan-out, above the transcript rather than in it: a run with thirty sub-agents is
          one event in its own story, but each of the thirty is a thing you want to watch, and
          a list of them scrolling by inside the log would be unreadable. Outside the scroller
          so it never covers the log; it caps its own height and scrolls within itself. */}
      {subagents.length > 0 && (
        <SubagentTree nodes={subagents} className={styles.subagents} />
      )}
      {/* The transcript and the asks pinned under it share this body; the composer stays
          below it at its own height. */}
      <div className={styles.body}>
        <div
          ref={scrollRef}
          role="region"
          aria-label="Run log"
          className={styles.scroller}
        >
          <div ref={contentRef} className={styles.lane}>
            {meta.resumedFrom !== undefined && (
              <div className={styles.resumed}>
                <span className={styles.rule} />
                <span className={styles.resumedNote}>
                  <Info {...ICON} size={12} />
                  Resumed from run {meta.resumedFrom} — earlier conversation
                  lives there.
                </span>
                <span className={styles.rule} />
              </div>
            )}
            {groups.length === 0 &&
              !writing &&
              (meta.state === 'provisioning' || meta.state === 'running' ? (
                <div className={styles.centre}>
                  <WorkingRow
                    label={
                      meta.state === 'provisioning'
                        ? 'Waiting for the run to start…'
                        : 'Working…'
                    }
                    startedAt={Date.parse(meta.createdAt)}
                  />
                </div>
              ) : (
                <div className={cx(styles.centre, styles.empty)}>
                  <MessageSquare size={20} strokeWidth={1.8} aria-hidden />
                  <p className={styles.emptyText}>No log entries yet.</p>
                </div>
              ))}
            {/* Three levels of emphasis. What the agent SAID is the transcript's spine and gets
              full weight. What it DID is subordinate — a run of tool calls folds behind one
              "Worked for 12s" line, so twelve file reads read as one event rather than twelve.
              What YOU said is a bubble, because finding your own interjections is a different
              job from reading along. */}
            {groups.map((group, i) =>
              group.kind === 'tools' ? (
                <WorkFold
                  key={i}
                  entries={group.entries}
                  live={group.entries.some(isLive)}
                >
                  {group.entries.map((entry, j) => (
                    <TranscriptRow key={j} entry={entry} live={isLive(entry)} />
                  ))}
                </WorkFold>
              ) : group.entries[0].kind === 'message' ? (
                <ChatMessageBubble
                  key={i}
                  entry={group.entries[0]}
                  me={me}
                  onOpenMessage={onOpenMessage}
                  readsAllThreads={readsAllThreads}
                />
              ) : (
                <TranscriptRow
                  key={i}
                  entry={group.entries[0]}
                  live={isLive(group.entries[0])}
                />
              )
            )}

            {/* What the agent is writing right now, after everything it has finished: each text
              block it has not ended yet, revealed as it grows through the same Markdown its
              settled row uses. A block leaves here in the render its entry lands in. */}
            {live.map((segment) => (
              <TranscriptRow
                key={`live:${segment.id}`}
                entry={{ ts: '', kind: 'assistant', text: segment.text }}
                live
              />
            ))}

            {/* What the run edited, once it has settled: T3 Code's end-of-turn card. */}
            {terminal && <ChangedFilesCard files={changedFiles} />}

            {/* Why the run stopped, in the run itself — without this a force-failed run (a
              daemon restart, not the agent's doing) reads as "failed, $0" with zero
              explanation. Rendered at the end of the transcript because the failure is
              chronologically the run's last event. */}
            {stopError !== undefined && (
              <FailureNotice
                error={stopError}
                providerId={providerById(meta.executor)?.id}
                // Continue (below) already retries; this hands the error itself to the agent.
                onAskAgent={
                  meta.sessionId === undefined
                    ? undefined
                    : () => onRequestChanges(askAgentToFix(stopError))
                }
              />
            )}

            {/* A merge or discard that threw partway (a squash conflict, say) leaves the
              run unreviewed and resumable — but the operator has to be told why, or a
              run that failed to merge looks identical to one nobody has reviewed yet.
              Cleared by the server the moment a later review completes. */}
            {meta.reviewedAt === undefined &&
              meta.reviewFailure !== undefined && (
                <Notice tone="danger" data-slot="review-failure">
                  <span className={styles.preWrap}>
                    {meta.reviewFailure.action} failed:{' '}
                    {meta.reviewFailure.reason}
                  </span>
                </Notice>
              )}

            {/* The run failed but its branch kept moving — the orphaned agent process
              survived and committed. Distinguishes "dead $0 run" from "the work actually
              landed, go look at the branch". Info, not success: it always sits right under
              the red failure notice and tells the person to go and look, so it is never a
              green box beside a red one. */}
            {orphanWork !== null && (
              <Notice tone="info" data-slot="orphan-work">
                {orphanWork}
              </Notice>
            )}

            {/* A live run that has not printed anything for a moment is indistinguishable from a
              wedged one without this. Only while genuinely running — never on a paused or
              finished run, where a spinner would be a lie. Suppressed when the empty-state
              WorkingRow above is already showing the same "Working…" label, and while the
              agent's words are arriving, which say it is working better than a spinner. */}
            {meta.state === 'running' && groups.length > 0 && !writing && (
              <WorkingRow
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
                <Notice tone="default" data-slot="approval-pending">
                  {/* A window that cannot decide cannot read open gates, so it says why. */}
                  {scopeDecide.explanation ??
                    'This run is waiting on an approval that has not reached this window yet; it will appear here shortly.'}
                </Notice>
              ))}
          </div>
        </div>

        {/* Pinned above the composer, not left in the scroller like the approval gate: the agent
          is frozen inside a tool call, so it must not be possible to scroll past this. The
          pinned area takes at most half of the body and scrolls within itself (a named
          region, focusable while it scrolls, so a keyboard can scroll it too): a question and
          a scope request together would otherwise squeeze the transcript, and the approval
          card in it, to nothing. Named for both kinds of card it holds. */}
        {(openQuestions.length > 0 || scopeOpen) && (
          <div
            ref={setAsksNode}
            role="region"
            aria-label="Waiting on you"
            // A Tab stop only while it hides text to scroll to: the cards' own controls
            // scroll into view on focus, but the text between them would not.
            tabIndex={asksScroll ? 0 : undefined}
            className={styles.asks}
            data-slot="run-asks"
          >
            {openQuestions.map((question) => (
              <QuestionCard
                key={question.id}
                question={question.question}
                options={question.options}
                askedAt={question.askedAt}
                onAnswer={(answer) => onAnswerQuestion(question.id, answer)}
              />
            ))}

            {scopeOpen && (
              <ScopeRequestCard
                paths={pendingScopeRequest.paths}
                reason={pendingScopeRequest.reason}
                onDecide={onDecideScopeRequest}
                availability={scopeDecide}
                onRestartDaemon={onRestartDaemon}
              />
            )}
          </div>
        )}
      </div>

      {error !== null && (
        <Notice tone="danger" role="alert" data-slot="send-error">
          {error}
        </Notice>
      )}

      {(canSend || terminal) && (
        <div className={styles.composer}>
          <span className={styles.hint}>
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
            <div
              className={styles.terminalBox}
              data-dragging={dragging ? 'true' : undefined}
              onDragOver={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {pendingFiles.length > 0 && (
                <ul aria-label="Attachments" className={styles.chips}>
                  {pendingFiles.map((file) => (
                    <li key={file.id}>
                      <Chip
                        title={file.name}
                        removeLabel={`Remove ${file.name}`}
                        onRemove={() => files.remove(file.id)}
                      >
                        {file.previewUrl !== undefined ? (
                          <img
                            src={file.previewUrl}
                            alt={file.name}
                            className={styles.thumb}
                          />
                        ) : (
                          <span className={styles.file}>
                            <FileText {...ICON} size={12} />
                            {file.name}
                          </span>
                        )}
                      </Chip>
                    </li>
                  ))}
                </ul>
              )}
              <div className={styles.terminal}>
                <textarea
                  className={cx('textarea', styles.draft)}
                  rows={2}
                  aria-label="Describe what should change"
                  placeholder="Describe what should change…"
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onPaste={handlePaste}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void submit();
                    }
                  }}
                  disabled={sending}
                />
                {onUploadAttachments !== undefined && (
                  <>
                    <input
                      ref={fileInputRef}
                      type="file"
                      multiple
                      hidden
                      onChange={(event) => {
                        const picked = Array.from(event.target.files ?? []);
                        // Cleared so picking the same file again still fires.
                        event.target.value = '';
                        if (picked.length > 0) void files.attach(picked);
                      }}
                    />
                    <Button
                      variant="quiet"
                      aria-label="Attach files"
                      busy={files.attaching}
                      disabled={!canAttach}
                      className={styles.action}
                      icon={
                        files.attaching ? (
                          <Spinner size="sm" label="" />
                        ) : (
                          <Paperclip {...ICON} />
                        )
                      }
                      onClick={() => fileInputRef.current?.click()}
                    />
                  </>
                )}
                {canContinue && (
                  <Button
                    variant="secondary"
                    disabled={sending || files.attaching}
                    onClick={() => void continueRun()}
                    className={styles.action}
                    icon={<Play {...ICON} />}
                  >
                    Continue
                  </Button>
                )}
                <Button
                  variant="primary"
                  disabled={sending || files.attaching}
                  onClick={() => void submit()}
                  className={styles.action}
                  icon={<MessageSquarePlus {...ICON} />}
                >
                  Request changes
                </Button>
              </div>
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
              {...(onUploadAttachments !== undefined
                ? {
                    onAttachFiles: (picked: File[]) =>
                      void files.attach(picked),
                    attachments: pendingFiles,
                    onRemoveAttachment: files.remove,
                    attaching: files.attaching,
                  }
                : {})}
            />
          )}
        </div>
      )}
    </div>
  );
}
