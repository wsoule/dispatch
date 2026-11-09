import { providerById } from '@dispatch-foo/core/browser';
import type {
  OverseerAction,
  OverseerApproval,
  OverseerAttachment,
  OverseerFieldChange,
  OverseerRecordView,
  RunMeta,
} from '@dispatch/client';
import {
  Button,
  ChipButton,
  cx,
  Disclosure,
  Notice,
  ProgressPie,
  SearchField,
  Spinner,
  Tooltip,
} from '@dispatch/ui';
import {
  Check,
  CheckCheck,
  CircleAlert,
  FileIcon,
  Shield,
  Wrench,
  X,
} from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useRef, useState } from 'react';

import type {
  OverseerApprovalDecision,
  OverseerSession,
} from '../../hooks/useOverseerSession';
import { cardRaw } from '../../lib/cardContent';
import { formatRelativeTimeFromIso } from '../../lib/format';
import { DEFAULT_EFFORT_ID, effortOptions, MODELS } from '../../lib/models';
import {
  appliedTaskCard,
  isTaskTool,
  proposedTaskCard,
  type TaskCardModel,
} from '../../lib/overseerTaskCard';
import {
  buildOverseerThread,
  doorLabel,
  findInThread,
  groupConfirmRows,
  groupToolRows,
  type OverseerDoor,
  type OverseerStreamItem,
  type ToolCallState,
} from '../../lib/overseerThread';
import { slashSuggestions } from '../../lib/slashCommands';
import { askAgentToFix, FailureNotice } from '../failure/FailureNotice';
import { DecisionCard } from '../gates/DecisionCard';
import { ToolApprovalCard } from '../gates/ToolApprovalCard';
import { Markdown } from '../runs/Markdown';
import { CardErrorBoundary } from '../shell/CardErrorBoundary';
import { StreamingText } from '../transcript/StreamingText';
import { ToolChip, ToolChipGroup } from '../transcript/ToolChip';
import styles from './OverseerChat.module.css';
import { OverseerTaskCard } from './OverseerTaskCard';
import { PromptBar } from './PromptBar';

// Ways into an empty Overseer: each fills the composer, so the question can be
// edited before it goes.
const STARTERS: readonly { label: string; text: string }[] = [
  { label: 'What needs me?', text: 'What needs me right now?' },
  { label: 'Plan a milestone', text: 'Plan a milestone: ' },
  {
    label: 'What blocks the release?',
    text: 'What is blocking the next release?',
  },
  { label: 'What landed today?', text: 'What did the agents land today?' },
];

/** The models the opening composer offers, in `PromptBar`'s shape. */
const COMPOSER_MODELS = MODELS.map((m) => ({ id: m.id, label: m.label }));

// Object URLs for attached images, by upload path. A path names exactly one
// upload, so a URL made once serves every bubble and composer that shows it.
const previewUrls = new Map<string, Promise<string>>();

function isImage(attachment: OverseerAttachment): boolean {
  return attachment.mimeType.startsWith('image/');
}

/**
 * Preview URLs for the images among `attachments`, keyed by path; a file that
 * is not an image, or whose bytes have not arrived, has none. Shared by the
 * composer's pending row and the transcript's bubbles.
 */
export function useAttachmentPreviews(
  attachments: readonly OverseerAttachment[],
  fetchAttachment: (attachment: OverseerAttachment) => Promise<Blob>
): Record<string, string> {
  const [urls, setUrls] = useState<Record<string, string>>({});
  const paths = attachments.filter(isImage).map((a) => a.path);
  // One string for the effect to key on: the same paths need no new fetch.
  const key = paths.join('|');
  useEffect(() => {
    let live = true;
    for (const attachment of attachments.filter(isImage)) {
      let url = previewUrls.get(attachment.path);
      if (url === undefined) {
        url = fetchAttachment(attachment).then((blob) =>
          URL.createObjectURL(blob)
        );
        // A failed fetch may work later (a daemon restart), so it is not kept.
        url.catch(() => previewUrls.delete(attachment.path));
        previewUrls.set(attachment.path, url);
      }
      void url.then(
        (resolved) => {
          if (!live) return;
          setUrls((current) =>
            current[attachment.path] === resolved
              ? current
              : { ...current, [attachment.path]: resolved }
          );
        },
        () => {}
      );
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, fetchAttachment]);
  return urls;
}

/** The files on a line you sent: images as thumbnails that open full size, the rest as chips. */
function SentAttachments({
  attachments,
  fetchAttachment,
}: {
  attachments: OverseerAttachment[];
  fetchAttachment: (attachment: OverseerAttachment) => Promise<Blob>;
}) {
  const urls = useAttachmentPreviews(attachments, fetchAttachment);
  return (
    <ul aria-label="Attachments" className={styles.sentFiles}>
      {attachments.map((attachment) => {
        const url = urls[attachment.path];
        return (
          <li key={attachment.path}>
            {isImage(attachment) && url !== undefined ? (
              <a href={url} target="_blank" rel="noreferrer">
                <img
                  src={url}
                  alt={attachment.name}
                  title={attachment.name}
                  className={styles.sentImage}
                />
              </a>
            ) : (
              <span className={styles.sentFile}>
                <FileIcon size={14} strokeWidth={1.8} aria-hidden />
                <span className={styles.sentFileName}>{attachment.name}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An inline failure line — a send that dispatchd refused, a decision that threw:
 * a danger Notice with an alert mark, so the colour is never the only cue. */
function ErrorLine({
  children,
  role,
}: {
  children: ReactNode;
  role?: 'alert';
}) {
  return (
    <Notice tone="danger" role={role}>
      <span className={styles.errorLine}>
        <CircleAlert
          className={styles.errorIcon}
          size={14}
          strokeWidth={1.8}
          aria-hidden
        />
        <span>{children}</span>
      </span>
    </Notice>
  );
}

/** The agent's own prose, as Markdown. While `streaming`, what the text grows
 * by is revealed as it arrives, through the same Markdown, so the row looks the
 * same once the record holds it. */
function AgentProse({
  text,
  streaming = false,
  className,
}: {
  text: string;
  streaming?: boolean;
  className?: string;
}) {
  const draw = (shown: string) => (
    <Markdown content={shown} className={cx(styles.prose, className)} />
  );
  return streaming ? (
    <StreamingText text={text} streaming render={draw} />
  ) : (
    draw(text)
  );
}

/** One turn of the overseer conversation: your words verbatim in a bubble on
 * the right, the agent's reply as bare Markdown across the column (it's an agent
 * transcript), the time on hover. A `streaming` reply is the running turn's
 * text still arriving: it has no time yet. */
function OverseerMessageBubble({
  speaker,
  text,
  at,
  streaming = false,
  attachments = [],
  fetchAttachment,
}: {
  speaker: 'user' | 'assistant';
  text: string;
  at?: string;
  streaming?: boolean;
  attachments?: OverseerAttachment[];
  fetchAttachment: (attachment: OverseerAttachment) => Promise<Blob>;
}) {
  const when = at === undefined ? undefined : new Date(at).toLocaleString();
  if (speaker === 'assistant') {
    return (
      <div
        title={when}
        data-testid={streaming ? 'overseer-live' : undefined}
        data-speaker="assistant"
        className={styles.reply}
      >
        <AgentProse text={text} streaming={streaming} />
      </div>
    );
  }
  return (
    <>
      {attachments.length > 0 && (
        <SentAttachments
          attachments={attachments}
          fetchAttachment={fetchAttachment}
        />
      )}
      {text.trim() !== '' && (
        <p title={when} data-speaker="user" className={styles.userBubble}>
          {text}
        </p>
      )}
    </>
  );
}

/** Prose the agent wrote between tool calls (or before a Stop): the agent's
 * own voice, so Markdown in its column with no speaker line of its own, and
 * quiet (the secondary ink), so the reply stays what the eye lands on. */
function OverseerNarration({ text, at }: { text: string; at: string }) {
  return (
    <div
      title={new Date(at).toLocaleString()}
      data-testid="overseer-narration"
      data-speaker="narration"
      className={styles.reply}
    >
      <AgentProse text={text} className={styles.narration} />
    </div>
  );
}

interface OverseerConfirmCardProps {
  action: OverseerAction;
  /** A decision for *this* action is currently in flight — this card owns the
   * spinner. */
  deciding: boolean;
  /** Some decision is in flight, this card's or another card's. One model turn
   * can queue several actions, and the session holds a single lock: without
   * disabling the others, their buttons stay live and eat the click. */
  locked: boolean;
  /** `scope: 'session'` also allows the tool for the rest of the conversation. */
  onDecide: (approve: boolean, scope?: 'once' | 'session') => void;
  /** The tasks a create_plan, create_task or dispatch_task proposes, listed in
   * place of the summary sentence. */
  card?: TaskCardModel | null;
  onOpenTask?: (taskId: string) => void;
}

/** The shield every approval card leads with, in the card's warning ink. */
const APPROVAL_ICON = <Shield size={14} strokeWidth={1.8} aria-hidden />;

/**
 * A queued mutating action awaiting the human — deliberately not a chat
 * bubble: this is the one row in the transcript that's a control, not a
 * record, so it is a warning-toned DecisionCard with the action's
 * human-readable summary and the approve/deny pair as plain buttons (named
 * "Approve: <summary>" and "Deny: <summary>"), not radio answers. Denying
 * never runs the underlying mutation; approving runs it server-side before
 * the call resolves.
 */
function OverseerConfirmCard({
  action,
  deciding,
  locked,
  onDecide,
  card = null,
  onOpenTask,
}: OverseerConfirmCardProps) {
  return (
    <DecisionCard
      tone="warning"
      icon={APPROVAL_ICON}
      question="Needs your approval"
      // A tool id is machine-read, so it keeps the mono face (Q5).
      detail={<span className="mono">{action.tool}</span>}
      className={styles.card}
      data-slot="overseer-confirm"
      actions={
        <>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => onDecide(true)}
            aria-label={`Approve: ${action.summary}`}
            icon={
              deciding ? (
                <Spinner size="xs" label="" />
              ) : (
                <Check size={14} strokeWidth={1.8} />
              )
            }
          >
            Approve
          </Button>
          {/* A medium-tier tool: approving it can also stop the asking. */}
          {action.grantable === true && (
            <Button
              size="sm"
              variant="quiet"
              disabled={locked}
              onClick={() => onDecide(true, 'session')}
              aria-label={`Allow ${action.tool} for this conversation`}
            >
              Allow for this conversation
            </Button>
          )}
          <Button
            size="sm"
            variant="quiet"
            disabled={locked}
            onClick={() => onDecide(false)}
            aria-label={`Deny: ${action.summary}`}
            icon={<X size={14} strokeWidth={1.8} />}
          >
            Deny
          </Button>
        </>
      }
    >
      {card === null ? (
        <p className={styles.summary}>{action.summary}</p>
      ) : (
        <OverseerTaskCard card={card} onOpenTask={onOpenTask} />
      )}
    </DecisionCard>
  );
}

/** An icon button with its short name in a tooltip, for the batch card's per-row answers. */
function TipIconButton({
  tip,
  label,
  icon,
  disabled,
  onClick,
}: {
  tip: string;
  /** The button's accessible name ("Approve: <summary>"). */
  label: string;
  icon: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip content={tip}>
      <Button
        variant="quiet"
        size="sm"
        aria-label={label}
        icon={icon}
        disabled={disabled}
        onClick={onClick}
      />
    </Tooltip>
  );
}

/** Several actions queued in one turn: one card, a row each, and both answers for all. */
function OverseerConfirmBatch({
  actions,
  decidingId,
  locked,
  onDecide,
  onDecideAll,
  cardFor,
  onOpenTask,
}: {
  actions: OverseerAction[];
  decidingId: string | null;
  locked: boolean;
  onDecide: (
    actionId: string,
    approve: boolean,
    scope?: 'once' | 'session'
  ) => void;
  onDecideAll: (approve: boolean) => void;
  /** A task action's tasks, listed in its row in place of the summary. */
  cardFor?: (action: OverseerAction) => TaskCardModel | null;
  onOpenTask?: (taskId: string) => void;
}) {
  const tools = new Set(actions.map((a) => a.tool));
  const label =
    tools.size === 1 ? (
      <>
        <span className="mono">{actions[0].tool}</span>
        {` ×${actions.length}`}
      </>
    ) : (
      `${actions.length} actions`
    );
  return (
    <DecisionCard
      tone="warning"
      icon={APPROVAL_ICON}
      question="Needs your approval"
      detail={label}
      className={styles.card}
      data-testid="overseer-confirm-batch"
      actions={
        <>
          <Button
            size="sm"
            disabled={locked}
            onClick={() => onDecideAll(true)}
            icon={<Check size={14} strokeWidth={1.8} />}
          >
            {actions.length === 2
              ? 'Approve both'
              : `Approve all ${actions.length}`}
          </Button>
          <Button
            size="sm"
            variant="quiet"
            disabled={locked}
            onClick={() => onDecideAll(false)}
            icon={<X size={14} strokeWidth={1.8} />}
          >
            Deny all
          </Button>
        </>
      }
    >
      <ul className={styles.batchRows}>
        {actions.map((action) => {
          const card = cardFor?.(action) ?? null;
          return (
            <li key={action.id} className={styles.batchRow}>
              <div className={styles.batchLine}>
                {card === null ? (
                  <p className={styles.batchSummary}>{action.summary}</p>
                ) : (
                  <div className={styles.batchSummary}>
                    <OverseerTaskCard card={card} onOpenTask={onOpenTask} />
                  </div>
                )}
                <TipIconButton
                  tip="Approve"
                  label={`Approve: ${action.summary}`}
                  disabled={locked}
                  onClick={() => onDecide(action.id, true)}
                  icon={
                    decidingId === action.id ? (
                      <Spinner size="xs" label="" />
                    ) : (
                      <Check size={14} strokeWidth={1.8} />
                    )
                  }
                />
                {action.grantable === true && (
                  <TipIconButton
                    tip="Allow for this conversation"
                    label={`Allow ${action.tool} for this conversation`}
                    disabled={locked}
                    onClick={() => onDecide(action.id, true, 'session')}
                    icon={<CheckCheck size={14} strokeWidth={1.8} />}
                  />
                )}
                <TipIconButton
                  tip="Deny"
                  label={`Deny: ${action.summary}`}
                  disabled={locked}
                  onClick={() => onDecide(action.id, false)}
                  icon={<X size={14} strokeWidth={1.8} />}
                />
              </div>
            </li>
          );
        })}
      </ul>
    </DecisionCard>
  );
}

interface OverseerApproveCardProps {
  approval: OverseerApproval;
  /** Some approval decision is in flight; every approve card locks. */
  locked: boolean;
  onDecide: (decision: OverseerApprovalDecision) => Promise<void>;
}

/**
 * A built-in tool call the overseer's turn is parked on — Bash, Edit, a
 * project MCP tool — which is a different question from the confirm card
 * above: nothing is queued for later, the session is blocked right now and
 * allowing runs the call at once. It is the same card a run's parked call
 * gets: allow once, allow the tool for the rest of the conversation, or deny
 * with an optional reason the model gets as its refusal. A held call (the
 * floor, or Dispatch's own surfaces) is allowed once only.
 */
function OverseerApproveCard({
  approval,
  locked,
  onDecide,
}: OverseerApproveCardProps) {
  return (
    <ToolApprovalCard
      toolName={approval.toolName}
      // Several parked calls can be on screen: the call names its card's
      // group, so "Approve once" says what it approves.
      question={
        <>
          Wants to run
          <span className="srOnly"> {approval.summary}</span>
        </>
      }
      // The call itself, a command line, so it keeps the code face.
      preview={approval.summary}
      sessionScope={approval.held === true ? undefined : 'this conversation'}
      sessionDescription="Ends after four hours, or when the conversation starts over."
      onDecide={onDecide}
      busy={locked}
    />
  );
}

/**
 * A message typed mid-turn and still waiting to go out. Edit swaps the text for
 * an inline textarea (Enter or Save commits, Shift+Enter is a newline, Esc
 * cancels); Remove drops it. Neither reaches the agent: only what is left on
 * the queue when the turn ends is sent. A refused change (the turn already
 * sent the line) is reported on the session's error line, and the bubble
 * itself disappears with the queue entry.
 */
function OverseerQueuedBubble({
  text,
  waiting,
  onEdit,
  onRemove,
}: {
  text: string;
  waiting: boolean;
  onEdit: (text: string) => Promise<boolean>;
  onRemove: () => Promise<boolean>;
}) {
  // The text being edited, or null while the bubble shows the queued line.
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const boxRef = useRef<HTMLTextAreaElement>(null);

  // Opening the editor puts the caret in it, ready to fix the typo.
  const open = editing !== null;
  useEffect(() => {
    if (open) boxRef.current?.focus();
  }, [open]);

  async function save() {
    const next = editing?.trim() ?? '';
    if (next === '' || busy) return;
    if (next === text) {
      setEditing(null);
      return;
    }
    setBusy(true);
    const ok = await onEdit(next);
    setBusy(false);
    if (ok) setEditing(null);
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    await onRemove();
    setBusy(false);
  }

  return (
    <div data-testid="overseer-queued" className={styles.queued}>
      {editing === null ? (
        <span className={styles.queuedText}>{text}</span>
      ) : (
        <textarea
          ref={boxRef}
          value={editing}
          disabled={busy}
          rows={2}
          aria-label="Queued message"
          className={cx('textarea', styles.queuedEdit)}
          onChange={(event) => setEditing(event.target.value)}
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key === 'Escape') {
              event.preventDefault();
              setEditing(null);
            } else if (event.key === 'Enter' && !event.shiftKey) {
              event.preventDefault();
              void save();
            }
          }}
        />
      )}
      <div className={styles.queuedFoot}>
        <span className={styles.queuedNote}>
          {waiting
            ? 'Queued · goes with your next message'
            : 'Queued · goes out when this turn ends'}
        </span>
        {editing === null ? (
          <>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(text)}
              aria-label="Edit queued message"
            >
              Edit
            </Button>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => void remove()}
              aria-label="Remove queued message"
            >
              Remove
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="quiet"
              size="sm"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            {/* A save shows its words, never a spinner. */}
            <Button
              size="sm"
              disabled={editing.trim() === ''}
              busy={busy}
              onClick={() => void save()}
            >
              Save
            </Button>
          </>
        )}
      </div>
    </div>
  );
}

/** The tone each decided action's audit line is drawn in: applied and allowed
 * succeeded, denied is inactive, failed is a failure. */
const OUTCOME_TONE = {
  applied: 'success',
  allowed: 'success',
  denied: 'muted',
  failed: 'danger',
} as const;

/** A decided action's audit line — kept in the transcript so "what actually
 * happened" survives the card it replaced. Its tint and mark come from the
 * outcome's tone (data-tone); the words ("Applied: …", "Denied: …") say it,
 * and each outcome has its own mark, so colour is never the only cue. */
function OverseerOutcomeRow({
  outcome,
  text,
  at,
  auto = false,
  changes,
  onOpenTask,
}: {
  outcome: 'applied' | 'allowed' | 'denied' | 'failed';
  text: string;
  at: string;
  /** The action ran with no card: this row is its receipt. */
  auto?: boolean;
  /** What an update changed, before → after. */
  changes?: OverseerFieldChange[];
  /** Opens the action's task in Tasks; absent when it has none to open. */
  onOpenTask?: () => void;
}) {
  const Mark =
    outcome === 'applied' || outcome === 'allowed'
      ? Check
      : outcome === 'denied'
        ? X
        : CircleAlert;
  return (
    <div
      className={styles.outcome}
      data-tone={OUTCOME_TONE[outcome]}
      data-outcome={outcome}
      data-testid={auto ? 'overseer-receipt' : undefined}
    >
      <Mark
        className={styles.outcomeMark}
        size={14}
        strokeWidth={1.8}
        aria-hidden
      />
      <div className={styles.receiptBody}>
        <span>
          {text}
          <span className={styles.outcomeTime}>
            {auto ? ' · ran without a card' : ''} ·{' '}
            {formatRelativeTimeFromIso(at)}
          </span>
        </span>
        {changes !== undefined && changes.length > 0 && (
          <ul
            data-testid="overseer-receipt-diff"
            className={styles.receiptDiff}
          >
            {changes.map((change) => (
              <li key={change.field}>
                <span className={styles.outcomeTime}>{change.field}</span>{' '}
                <span className={styles.receiptBefore}>{change.before}</span> →{' '}
                {change.after}
              </li>
            ))}
          </ul>
        )}
        {onOpenTask !== undefined && (
          <Button size="sm" variant="quiet" onClick={onOpenTask}>
            Open in Tasks →
          </Button>
        )}
      </div>
    </div>
  );
}

// How many chips a tool run shows before "+N".
const SHOWN_TOOLS = 6;

// How close to the bottom (px) the transcript counts as "at the bottom", so new
// rows keep following a reader who is a few pixels short of the end.
const FOLLOW_SLACK_PX = 48;

/** One turn's tool calls as a chip row; the raw results stay behind a
 * Disclosure ("Details"), in the mono face since they are machine output. */
function ToolRun({
  calls,
}: {
  calls: { tool: string; text: string; state: ToolCallState }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Disclosure
      open={open}
      onOpenChange={setOpen}
      variant="plain"
      data-testid="overseer-tools"
      trigger={({ props }) => (
        <div className={styles.toolsHead}>
          <ToolChipGroup
            overflowCount={Math.max(0, calls.length - SHOWN_TOOLS)}
          >
            {calls.slice(0, SHOWN_TOOLS).map((call, i) => (
              <ToolChip
                key={`${call.tool}-${i}`}
                icon={Wrench}
                label={call.tool}
                state={call.state}
                mono
              />
            ))}
          </ToolChipGroup>
          <Button variant="quiet" size="sm" {...props}>
            {open ? 'Hide details' : 'Details'}
          </Button>
        </div>
      )}
    >
      <ul className={styles.toolDetails}>
        {calls.map((call, i) => (
          <li key={`${call.tool}-${i}`}>
            <span className={styles.toolDetailName}>{call.tool}</span>{' '}
            {call.text}
          </li>
        ))}
      </ul>
    </Disclosure>
  );
}

/** How full the conversation's context is, as a whole percent of the context
 *  its next turn starts over from a recap at; null until the daemon says both
 *  (a daemon older than `contextLimit`, or no turn has reported yet). */
function contextPercent(record: OverseerRecordView | undefined): number | null {
  const used = record?.contextTokens;
  const limit = record?.contextLimit;
  if (used === undefined || used <= 0 || limit === undefined || limit <= 0) {
    return null;
  }
  return Math.min(100, Math.round((used / limit) * 100));
}

/** The status line's context meter: a pie and its percent, the rule on hover. */
function ContextMeter({ percent }: { percent: number }) {
  return (
    <Tooltip content="How full the agent's context is. When it is full, the agent's next turn starts afresh from a recap of the latest lines.">
      <span data-testid="overseer-context" className={styles.context}>
        {/* Decorative: the percent beside it says the same. */}
        <ProgressPie done={percent} total={100} label="" />
        {percent}% context
      </span>
    </Tooltip>
  );
}

interface OverseerChatProps {
  overseer: OverseerSession;
  /** Replaces both composers' placeholders (the Overseer page says "say something"). */
  placeholder?: string;
  /** Sits between the transcript and the composer: the Overseer page puts its posts
   * and docked asks here on a narrow window. */
  aboveComposer?: ReactNode;
  /** Locks the composer, as for a revoked Overseer. */
  disabled?: boolean;
  /** Opens a show_tasks door; without it a door reads as a plain line. */
  onOpenDoor?: (door: OverseerDoor) => void;
  /** The board and its runs, so the tasks an action proposes or sends out
   * list as a card with each run's state; without it they stay sentences. */
  work?: OverseerWork;
}

/** What the chat's task cards read: task titles, runs, and where a row opens. */
interface OverseerWork {
  tasks: readonly { meta: { id: string; title: string } }[];
  runs: readonly RunMeta[];
  /** Opens a task beside the talk; without it the rows do not open. */
  onOpenTask?: (taskId: string) => void;
}

/**
 * The overseer conversation itself — transcript, composer, and the approve/deny
 * confirm cards — rendering the one `useOverseerSession` the App mounts. Status
 * questions are answered directly; anything mutating shows up as a confirm
 * card in the transcript and runs only once approved there. It is the Overseer
 * page's one conversation: typing during a turn queues, Stop ends the turn,
 * the status line shows its spend, and ⌘F searches it.
 */
export function OverseerChat({
  overseer,
  placeholder,
  aboveComposer,
  disabled = false,
  onOpenDoor,
  work,
}: OverseerChatProps) {
  // The composer's text is the session's, not this component's: leaving the
  // Overseer page unmounts this chat, and the session outlives it. Only one of
  // the two textareas below is ever on screen (which one depends on
  // `conversationId`), so a single draft is unambiguous.
  const { draft, setDraft } = overseer;

  // Sending state is the session's too, and for the same reason as the draft:
  // a `setState` from a call that fails after the chat unmounted would report
  // the failure to nobody. One flag and one error cover both composers — only
  // one of them is ever on screen, and `conversationId` decides which.
  const { sending, sendError } = overseer;

  // Pasted, dropped or picked files waiting on the next send — the session's,
  // like the draft, and shown in whichever composer is on screen.
  const pendingPreviews = useAttachmentPreviews(
    overseer.attachments,
    overseer.fetchAttachment
  );
  const attachProps = {
    onAttachFiles: (files: File[]) => void overseer.attachFiles(files),
    attachments: overseer.attachments.map((a) => ({
      id: a.path,
      name: a.name,
      previewUrl: pendingPreviews[a.path],
    })),
    onRemoveAttachment: overseer.removeAttachment,
    attaching: overseer.attaching,
  };

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

  // A task's title by id, for the task cards; a task the board dropped keeps its id.
  const titles = useMemo(
    () => new Map(work?.tasks.map((t) => [t.meta.id, t.meta.title]) ?? []),
    [work?.tasks]
  );
  const taskTitle = (taskId: string) => titles.get(taskId);
  const runs = work?.runs ?? [];
  // The tasks a pending task action proposes, or null for any other action.
  const taskCardFor = (action: OverseerAction): TaskCardModel | null =>
    work !== undefined && isTaskTool(action.tool)
      ? proposedTaskCard(action, taskTitle, runs)
      : null;

  const fullThread = useMemo(
    () => buildOverseerThread(overseer.record, overseer.live),
    [overseer.record, overseer.live]
  );
  const [query, setQuery] = useState<string | null>(null);
  const thread = useMemo(
    () => (query === null ? fullThread : findInThread(fullThread, query)),
    [fullThread, query]
  );
  const rootRef = useRef<HTMLDivElement>(null);
  const findRef = useRef<HTMLInputElement>(null);

  // ⌘F searches the stream while it is on screen; a view kept mounted but
  // hidden has no layout box, so it never takes the key.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!(event.metaKey || event.ctrlKey) || event.key.toLowerCase() !== 'f')
        return;
      if (rootRef.current?.offsetParent === null) return;
      event.preventDefault();
      setQuery((current) => current ?? '');
      requestAnimationFrame(() => findRef.current?.select());
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // Pin the transcript to the newest row — keyed on the last row's identity as
  // well as the count, since a turn settling in place (pending spinner → reply)
  // can change what's at the bottom without changing how many rows there are.
  // Mount counts as a change: every surface that renders this chat mounts it
  // with a real layout box, so there is no zero-scrollHeight case to skip.
  //
  // The pin only follows a reader who is at (or within FOLLOW_SLACK_PX of) the
  // bottom; `followRef` is that answer as of the last scroll event. It is read
  // from `onScroll` rather than measured in the effect because by the time the
  // effect runs the new row is already in `scrollHeight`, so a reader who was
  // at the bottom would look scrolled up. Scrolling back down re-attaches, and
  // so does sending a message (see `submitDraft`).
  const scrollRef = useRef<HTMLDivElement>(null);
  const followRef = useRef(true);
  const lastKey = thread.length > 0 ? thread[thread.length - 1].key : '';
  useEffect(() => {
    const el = scrollRef.current;
    if (el !== null && followRef.current) el.scrollTop = el.scrollHeight;
  }, [thread.length, lastKey]);

  // A row growing in place (live text revealing, its Markdown reflowing)
  // changes neither the row count nor the last key, so the log's own DOM is
  // watched too, and followed for a reader at the bottom. Only the open
  // conversation renders the log.
  const hasLog = overseer.conversationId !== null;
  useEffect(() => {
    const el = scrollRef.current;
    if (!hasLog || el === null) return;
    const observer = new MutationObserver(() => {
      if (followRef.current) el.scrollTop = el.scrollHeight;
    });
    observer.observe(el, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    return () => observer.disconnect();
  }, [hasLog]);

  function onLogScroll() {
    const el = scrollRef.current;
    if (el === null) return;
    followRef.current =
      el.scrollHeight - el.scrollTop - el.clientHeight <= FOLLOW_SLACK_PX;
  }

  // A turn is in flight: the status line says so and offers Stop, and what is
  // sent now waits behind it. Confirm cards stay live on purpose: the server
  // accepts a decision mid-turn. `recordError` only decides the no-record case
  // (fetch never succeeded → broken conversation showing its 404 banner, not
  // the overseer answering); with a record cached, one failed *background*
  // refetch mid-turn must not read as the turn having ended.
  const busy =
    overseer.conversationId !== null &&
    (overseer.record === undefined
      ? overseer.recordError === null
      : overseer.record.state === 'running');

  /**
   * Both composers' submit. Everything past the guard — clearing the draft,
   * putting it back on failure, the in-flight flag, the error — belongs to
   * `overseer.submit`, which picks `start` or `sendMessage` off `conversationId`
   * exactly as the branch below picks which composer to render.
   *
   * A message sent mid-turn is fine: the daemon queues it behind the turn.
   */
  function submitDraft() {
    const text = draft.trim();
    // A pasted screenshot alone is a message; an upload still running is not.
    const empty = text === '' && overseer.attachments.length === 0;
    if (empty || sending || overseer.attaching) return;
    // The reader asked for a reply, so their message and the answer should be
    // in view even if they had scrolled up to read.
    followRef.current = true;
    void overseer.submit(text);
  }

  // The session owns the whole decide cycle — the re-entrancy guard, the lock
  // and the failure — so this is a plain forward rather than a wrapper.
  function decide(
    actionId: string,
    approve: boolean,
    scope?: 'once' | 'session'
  ) {
    void overseer.confirmAction(actionId, approve, scope);
  }

  // The card keeps its reason box only when its decision rejects; the session
  // reports the failure on decideError and resolves false, so say so here.
  async function decideApproval(
    requestId: string,
    decision: OverseerApprovalDecision
  ): Promise<void> {
    if (!(await overseer.decideApproval(requestId, decision))) {
      throw new Error('the decision did not go through');
    }
  }

  // A failed turn's fixes: re-send the last ask, or hand the error to the agent.
  const overseerProvider = providerById(overseer.record?.backendName ?? '')?.id;
  const lastAsk = overseer.record?.messages
    .filter((m) => m.role === 'user')
    .at(-1)?.text;

  // Each row draws inside its own boundary, so one malformed message or tool
  // card shows as a fallback row instead of blanking the conversation.
  function renderRow(item: OverseerStreamItem) {
    return (
      <CardErrorBoundary key={item.key} raw={cardRaw(item)}>
        {renderRowContent(item)}
      </CardErrorBoundary>
    );
  }

  function renderRowContent(item: OverseerStreamItem) {
    switch (item.kind) {
      case 'message':
        return (
          <OverseerMessageBubble
            key={item.key}
            speaker={item.role}
            text={item.text}
            at={item.at}
            attachments={item.attachments}
            fetchAttachment={overseer.fetchAttachment}
          />
        );
      case 'narration':
        return (
          <OverseerNarration key={item.key} text={item.text} at={item.at} />
        );
      case 'live':
        return (
          <OverseerMessageBubble
            key={item.key}
            speaker="assistant"
            text={item.text}
            streaming
            fetchAttachment={overseer.fetchAttachment}
          />
        );
      case 'tools':
        return <ToolRun key={item.key} calls={item.calls} />;
      case 'confirms':
        return (
          <OverseerConfirmBatch
            key={item.key}
            actions={item.actions}
            decidingId={decidingId}
            locked={decidingId !== null}
            onDecide={decide}
            cardFor={taskCardFor}
            onOpenTask={work?.onOpenTask}
            onDecideAll={(approve) => {
              // One at a time, stopping at the first that fails: the rest
              // likely fail the same way, and one error is enough to read.
              void (async () => {
                for (const action of item.actions) {
                  if (!(await overseer.confirmAction(action.id, approve))) {
                    return;
                  }
                }
              })();
            }}
          />
        );
      case 'confirm':
        return (
          <OverseerConfirmCard
            key={item.key}
            action={item.action}
            deciding={decidingId === item.action.id}
            locked={decidingId !== null}
            onDecide={(approve, scope) =>
              decide(item.action.id, approve, scope)
            }
            card={taskCardFor(item.action)}
            onOpenTask={work?.onOpenTask}
          />
        );
      case 'approve':
        return (
          <OverseerApproveCard
            key={item.key}
            approval={item.approval}
            locked={decidingRequestId !== null}
            onDecide={(decision) =>
              decideApproval(item.approval.requestId, decision)
            }
          />
        );
      case 'outcome':
        // A receipt keeps its own row (it says the action ran unasked and
        // shows what changed); a card-approved action lists its tasks.
        if (
          work !== undefined &&
          item.auto !== true &&
          item.taskIds !== undefined &&
          item.taskIds.length > 0
        ) {
          return (
            <OverseerTaskCard
              key={item.key}
              className={styles.card}
              card={appliedTaskCard(item.taskIds, taskTitle, runs)}
              onOpenTask={work.onOpenTask}
            />
          );
        }
        return (
          <OverseerOutcomeRow
            key={item.key}
            outcome={item.outcome}
            text={item.text}
            at={item.at}
            auto={item.auto}
            changes={item.changes}
            onOpenTask={
              item.auto !== true ||
              item.taskIds?.[0] === undefined ||
              onOpenDoor === undefined
                ? undefined
                : () => onOpenDoor({ taskId: item.taskIds?.[0] })
            }
          />
        );
      case 'pending':
        return (
          <div key={item.key} className={styles.pending}>
            {/* Live agent work: the info spinner; the words beside it name it. */}
            <Spinner tone="info" label="" />
            The overseer is working…
          </div>
        );
      case 'failed':
        return (
          <div key={item.key} className={styles.start}>
            <FailureNotice
              error={item.error}
              providerId={overseerProvider}
              onRetry={
                lastAsk === undefined
                  ? undefined
                  : () => overseer.reply(lastAsk)
              }
              onAskAgent={() => overseer.reply(askAgentToFix(item.error))}
            />
          </div>
        );
      case 'notice':
        return (
          <div
            key={item.key}
            role="separator"
            data-testid={`overseer-notice-${item.notice}`}
            className={styles.notice}
          >
            <span className={styles.noticeRule} aria-hidden="true" />
            <span className={styles.noticeText}>
              {item.text} · {formatRelativeTimeFromIso(item.at)}
            </span>
            <span className={styles.noticeRule} aria-hidden="true" />
          </div>
        );
      case 'door':
        return onOpenDoor === undefined ? (
          <div key={item.key} className={styles.doorLine}>
            {doorLabel(item.door)}
          </div>
        ) : (
          <div key={item.key} className={styles.start}>
            <ChipButton
              data-testid="overseer-door"
              onClick={() => onOpenDoor(item.door)}
            >
              {doorLabel(item.door)}
            </ChipButton>
          </div>
        );
      case 'queued':
        return (
          <OverseerQueuedBubble
            key={item.key}
            text={item.text}
            waiting={item.waiting}
            onEdit={(text) => overseer.editQueued(item.id, text)}
            onRemove={() => overseer.removeQueued(item.id)}
          />
        );
    }
  }

  if (overseer.conversationId === null) {
    return (
      <div className={styles.opening}>
        <div className={styles.openingHead}>
          <p className={styles.openingTitle}>What should we work on?</p>
          <p className={styles.openingLede}>
            Ask about runs, tasks or the code. Anything that changes the project
            waits for your approval.
          </p>
        </div>
        <div
          className={styles.starters}
          aria-label="Starter questions"
          role="group"
        >
          {STARTERS.map((starter) => (
            <ChipButton
              key={starter.label}
              onClick={() => setDraft(starter.text)}
            >
              {starter.label}
            </ChipButton>
          ))}
        </div>
        {sendError !== null && <ErrorLine role="alert">{sendError}</ErrorLine>}
        {aboveComposer}
        {/* Which model the conversation opens on — remembered per device, so
            "always Fable" sticks. An open conversation keeps its model. */}
        <PromptBar
          value={draft}
          onChange={setDraft}
          onSubmit={submitDraft}
          disabled={disabled || sending}
          placeholder={placeholder ?? "What's going on with my agents?"}
          ariaLabel="Overseer opening question"
          {...attachProps}
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

  const spend = overseer.record?.spendUsd ?? 0;
  const context = contextPercent(overseer.record);
  const suggestions = slashSuggestions(draft, overseer.record?.commands ?? []);

  return (
    <div ref={rootRef} className={styles.chat}>
      {query !== null && (
        // Escape closes the bar at once, text or not, as it always has: it is
        // caught on the way down (capture), before SearchField's own Escape
        // would only clear the field, and stopped here so nothing behind the
        // chat (a focus, the app's keyboard) takes the same Escape.
        <div
          className={styles.find}
          onKeyDownCapture={(event) => {
            if (event.key !== 'Escape' || event.defaultPrevented) return;
            event.preventDefault();
            event.stopPropagation();
            setQuery(null);
          }}
        >
          <div className={styles.findField}>
            <SearchField
              value={query}
              onChange={setQuery}
              label="Find in this conversation"
              placeholder="Find in this conversation"
              inputRef={findRef}
              size="sm"
            />
          </div>
          <span className={styles.findCount}>
            {query.trim() === ''
              ? ''
              : `${thread.length} ${thread.length === 1 ? 'match' : 'matches'}`}
          </span>
          <Button
            variant="quiet"
            size="sm"
            aria-label="Close find"
            onClick={() => setQuery(null)}
          >
            Done
          </Button>
        </div>
      )}
      {overseer.recordError !== null && overseer.record === undefined && (
        <ErrorLine role="alert">{overseer.recordError}</ErrorLine>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Overseer conversation"
        onScroll={onLogScroll}
        className={styles.log}
      >
        {groupConfirmRows(groupToolRows(thread)).map(renderRow)}
      </div>

      {aboveComposer}
      <div className={styles.composer}>
        {(sendError ?? decideError) !== null && (
          <ErrorLine role="alert">{sendError ?? decideError}</ErrorLine>
        )}
        <div className={styles.statusRow}>
          <span className={styles.status}>
            {busy && 'Working · what you send now goes when it finishes'}
            {/* The model is named by the composer's picker, not here. */}
            {spend > 0 && (
              <span data-testid="overseer-spend">
                {busy ? ' · ' : ''}${spend.toFixed(2)} so far
              </span>
            )}
            {context !== null && (
              <>
                {busy || spend > 0 ? ' · ' : ''}
                <ContextMeter percent={context} />
              </>
            )}
          </span>
          {busy && (
            <Button
              size="sm"
              onClick={() => void overseer.stop()}
              data-testid="overseer-stop"
              className={styles.stop}
            >
              Stop
            </Button>
          )}
        </div>
        {/* Open mid-turn: what is sent then waits for the turn to end. */}
        <PromptBar
          value={draft}
          onChange={setDraft}
          onSubmit={submitDraft}
          disabled={disabled || sending}
          placeholder={
            placeholder ??
            'Ask about runs, tasks, the queue — or ask it to act…'
          }
          ariaLabel="Follow-up message"
          {...attachProps}
          // Only what the draft is typing, so a picked command closes the list.
          commands={suggestions.map((command) => ({
            id: command.name,
            label: command.name,
            hint:
              command.argumentHint === '' ? undefined : command.argumentHint,
            description: command.description,
          }))}
          // The open conversation's own model and effort; a change applies from its next turn.
          models={COMPOSER_MODELS}
          modelId={overseer.record?.model ?? overseer.model}
          onModelChange={(id) =>
            void overseer.setConversationOptions({ model: id })
          }
          efforts={effortOptions(overseer.configuredEffort)}
          effortId={overseer.record?.effort ?? DEFAULT_EFFORT_ID}
          onEffortChange={(id) =>
            void overseer.setConversationOptions({ effortId: id })
          }
        />
      </div>
    </div>
  );
}
