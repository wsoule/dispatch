import { providerById } from '@dispatch-foo/core/browser';
import type {
  OverseerAction,
  OverseerApproval,
  OverseerAttachment,
} from '@dispatch/client';
import {
  Check,
  CircleAlert,
  FileIcon,
  Plus,
  Search,
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
import {
  DEFAULT_EFFORT_ID,
  effortOptions,
  modelLabel,
  MODELS,
} from '../../lib/models';
import {
  buildOverseerThread,
  doorLabel,
  findInThread,
  groupConfirmRows,
  groupToolRows,
  type OverseerDoor,
  type OverseerStreamItem,
} from '../../lib/overseerThread';
import { slashSuggestions } from '../../lib/slashCommands';
import { askAgentToFix, FailureNotice } from '../failure/FailureNotice';
import { Markdown } from '../runs/Markdown';
import { CardErrorBoundary } from '../shell/CardErrorBoundary';
import { cn } from '@/lib/utils';
import { IconButton, type IconButtonProps } from '@/ui/ai/icon-button';
import { PillButton } from '@/ui/ai/pill';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { StreamingText } from '@/ui/ai/streaming-text';
import { ToolApprovalCard } from '@/ui/ai/tool-approval-card';
import { ToolChip, ToolChipGroup } from '@/ui/ai/tool-chips';
import { Button } from '@/ui/button';
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/ui/collapsible';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/ui/input-group';
import { Separator } from '@/ui/separator';
import { Spinner } from '@/ui/spinner';
import { Textarea } from '@/ui/textarea';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/ui/tooltip';

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
    <ul
      aria-label="Attachments"
      className="flex max-w-[85%] flex-wrap justify-end gap-1.5 self-end"
    >
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
                  className="rounded-card shadow-hairline max-h-48 max-w-64 object-contain"
                />
              </a>
            ) : (
              <span className="bg-surface-secondary shadow-hairline rounded-pill text-muted-foreground flex items-center gap-1 px-2 py-0.5 text-[12px]">
                <FileIcon aria-hidden className="size-3" />
                <span className="max-w-48 truncate">{attachment.name}</span>
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

/** An inline failure line — a send that dispatchd refused, a decision that threw. */
function ErrorLine({ children }: { children: ReactNode }) {
  return (
    <div className="bg-state-failed-surface text-state-failed rounded-control flex items-start gap-2 px-3 py-2 text-[13px]">
      <CircleAlert className="size-3.5 shrink-0 translate-y-0.5" />
      <span>{children}</span>
    </div>
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
    <Markdown content={shown} className={cn('text-[13px]', className)} />
  );
  return streaming ? (
    <StreamingText text={text} streaming render={draw} />
  ) : (
    draw(text)
  );
}

/** One turn of the overseer conversation — the same bubble treatment as the plan
 * thread: the assistant's replies are markdown (it's an agent transcript), the
 * user's own words render verbatim. A `streaming` reply is the running turn's
 * text still arriving: it has no time yet. */
function OverseerMessageBubble({
  speaker,
  text,
  at,
  streaming = false,
  plain = false,
  attachments = [],
  fetchAttachment,
}: {
  speaker: 'user' | 'assistant';
  text: string;
  at?: string;
  streaming?: boolean;
  /** Two views: a pill for you, bare text for the agent, the time on hover. */
  plain?: boolean;
  attachments?: OverseerAttachment[];
  fetchAttachment: (attachment: OverseerAttachment) => Promise<Blob>;
}) {
  const fromUser = speaker === 'user';
  const live = streaming ? 'overseer-live' : undefined;
  const files =
    attachments.length > 0 ? (
      <SentAttachments
        attachments={attachments}
        fetchAttachment={fetchAttachment}
      />
    ) : null;
  if (plain) {
    const when = at === undefined ? undefined : new Date(at).toLocaleString();
    return fromUser ? (
      <>
        {files}
        {text.trim() !== '' && (
          <p
            title={when}
            className="bg-surface-secondary shadow-hairline rounded-card font-book max-w-[85%] self-end px-3 py-1.5 text-[13px] whitespace-pre-wrap"
          >
            {text}
          </p>
        )}
      </>
    ) : (
      <div
        title={when}
        data-testid={live}
        className="max-w-full self-stretch px-1"
      >
        <AgentProse text={text} streaming={streaming} />
      </div>
    );
  }
  return (
    <div
      data-testid={live}
      className={cn(
        'rounded-card flex max-w-[85%] flex-col gap-1 px-3 py-2',
        fromUser
          ? 'bg-surface-secondary shadow-hairline self-end'
          : 'bg-surface-quaternary shadow-card self-start'
      )}
    >
      <div className="text-muted-foreground flex items-baseline gap-1.5 text-[12px] font-medium">
        {fromUser ? 'You' : 'Assistant'}
        {at !== undefined && (
          <span className="font-book">{formatRelativeTimeFromIso(at)}</span>
        )}
      </div>
      {fromUser ? (
        <>
          {files}
          {text.trim() !== '' && (
            <p className="font-book text-[13px] whitespace-pre-wrap">{text}</p>
          )}
        </>
      ) : (
        <AgentProse text={text} streaming={streaming} />
      )}
    </div>
  );
}

/** Prose the agent wrote between tool calls (or before a Stop): the agent's
 * own voice, so Markdown in its column with no speaker line of its own, and
 * muted, so the reply stays what the eye lands on. */
function OverseerNarration({
  text,
  at,
  plain,
}: {
  text: string;
  at: string;
  plain: boolean;
}) {
  return (
    <div
      title={new Date(at).toLocaleString()}
      data-testid="overseer-narration"
      className={
        plain ? 'max-w-full self-stretch px-1' : 'max-w-[85%] self-start px-3'
      }
    >
      <AgentProse text={text} className="text-muted-foreground" />
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

/** An icon button with its short name in a tooltip, for the batch card's per-row answers. */
function TipIconButton({ tip, ...props }: IconButtonProps & { tip: string }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<IconButton {...props} />} />
      <TooltipContent>{tip}</TooltipContent>
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
}: {
  actions: { action: OverseerAction; failure: string | null }[];
  decidingId: string | null;
  locked: boolean;
  onDecide: (actionId: string, approve: boolean) => void;
  onDecideAll: (approve: boolean) => void;
}) {
  const tools = new Set(actions.map((a) => a.action.tool));
  const label =
    tools.size === 1
      ? `${actions[0].action.tool} ×${actions.length}`
      : `${actions.length} actions`;
  return (
    <div
      data-testid="overseer-confirm-batch"
      className="bg-state-waiting-surface rounded-card flex flex-col self-stretch border-[0.5px] border-(--state-waiting-edge)"
    >
      <div className="text-state-waiting flex items-center gap-1.5 px-3 pt-2.5 pb-1.5 text-[12px] font-medium">
        <Shield className="size-3.5" />
        Needs your approval
        <span className="text-muted-foreground font-book">{label}</span>
      </div>
      {actions.map(({ action, failure }) => (
        <div
          key={action.id}
          className="flex flex-col gap-1 border-t-[0.5px] border-(--state-waiting-edge) px-3 py-1.5"
        >
          <div className="flex items-center gap-2">
            <p className="font-book min-w-0 flex-1 text-[13px]">
              {action.summary}
            </p>
            <TipIconButton
              tip="Approve"
              label={`Approve: ${action.summary}`}
              disabled={locked}
              onClick={() => onDecide(action.id, true)}
            >
              {decidingId === action.id ? <Spinner /> : <Check />}
            </TipIconButton>
            <TipIconButton
              tip="Deny"
              label={`Deny: ${action.summary}`}
              disabled={locked}
              onClick={() => onDecide(action.id, false)}
            >
              <X />
            </TipIconButton>
          </div>
          {failure !== null && <ErrorLine>{failure}</ErrorLine>}
        </div>
      ))}
      <div className="flex items-center gap-2 border-t-[0.5px] border-(--state-waiting-edge) px-3 py-2">
        <Button disabled={locked} onClick={() => onDecideAll(true)}>
          <Check className="size-3.5" />
          {actions.length === 2
            ? 'Approve both'
            : `Approve all ${actions.length}`}
        </Button>
        <PillButton disabled={locked} onClick={() => onDecideAll(false)}>
          <X className="size-3.5" />
          Deny all
        </PillButton>
      </div>
    </div>
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
          <span className="sr-only"> {approval.summary}</span>
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
    <div
      data-testid="overseer-queued"
      className="rounded-control bg-surface-quaternary/60 text-muted-foreground font-book flex max-w-[85%] flex-col gap-1 self-end border-[0.5px] border-dashed px-3 py-1.5 text-[13px]"
    >
      {editing === null ? (
        <span className="whitespace-pre-wrap">{text}</span>
      ) : (
        <Textarea
          ref={boxRef}
          value={editing}
          disabled={busy}
          aria-label="Queued message"
          className="min-h-0"
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
      <div className="flex items-center gap-1 text-[11px]">
        <span className="min-w-0 flex-1">
          {waiting
            ? 'Queued · goes with your next message'
            : 'Queued · goes out when this turn ends'}
        </span>
        {editing === null ? (
          <>
            <Button
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setEditing(text)}
              aria-label="Edit queued message"
            >
              Edit
            </Button>
            <Button
              variant="ghost"
              size="xs"
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
              variant="ghost"
              size="xs"
              disabled={busy}
              onClick={() => setEditing(null)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={busy || editing.trim() === ''}
              onClick={() => void save()}
            >
              {busy && <Spinner className="size-3" />}
              Save
            </Button>
          </>
        )}
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

// How many chips a tool run shows before "+N".
const SHOWN_TOOLS = 6;

// How close to the bottom (px) the transcript counts as "at the bottom", so new
// rows keep following a reader who is a few pixels short of the end.
const FOLLOW_SLACK_PX = 48;

/** One turn's tool calls as a chip row; the raw results stay behind "details". */
function ToolRun({
  calls,
}: {
  calls: { tool: string; text: string; failed: boolean }[];
}) {
  const [open, setOpen] = useState(false);
  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="flex min-w-0 flex-col gap-1 self-start"
      data-testid="overseer-tools"
    >
      <div className="flex min-w-0 items-center gap-2">
        <ToolChipGroup overflowCount={Math.max(0, calls.length - SHOWN_TOOLS)}>
          {calls.slice(0, SHOWN_TOOLS).map((call, i) => (
            <ToolChip
              key={`${call.tool}-${i}`}
              icon={Wrench}
              label={call.tool}
              state={call.failed ? 'failed' : 'done'}
            />
          ))}
        </ToolChipGroup>
        <CollapsibleTrigger render={<Button variant="ghost" size="xs" />}>
          {open ? 'hide details' : 'details'}
        </CollapsibleTrigger>
      </div>
      <CollapsibleContent
        render={
          <ul className="text-muted-foreground flex flex-col gap-1 px-1 font-mono text-[11px] break-all whitespace-pre-wrap" />
        }
      >
        {calls.map((call, i) => (
          <li key={`${call.tool}-${i}`}>
            <span className="text-foreground">{call.tool}</span> {call.text}
          </li>
        ))}
      </CollapsibleContent>
    </Collapsible>
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
  /** Replaces both composers' placeholders (Two views says "say something"). */
  placeholder?: string;
  /** Sits between the transcript and the composer: Two views' door to the asks. */
  aboveComposer?: ReactNode;
  /** Locks the composer, as for a revoked Overseer. */
  disabled?: boolean;
  /**
   * Two views' one conversation: typing during a turn queues, Stop ends the
   * turn, the stream shows its spend, and ⌘F searches it.
   */
  durable?: boolean;
  /** Opens a show_tasks door; without it a door reads as a plain line. */
  onOpenDoor?: (door: OverseerDoor) => void;
}

/**
 * The overseer conversation itself — transcript, composer, and the approve/deny
 * confirm cards — so every surface that shows it renders the one
 * `useOverseerSession` the App mounts. Status
 * questions are answered directly; anything mutating shows up as a confirm
 * card in the transcript and runs only once approved there.
 */
export function OverseerChat({
  overseer,
  compact = false,
  placeholder,
  aboveComposer,
  disabled = false,
  durable = false,
  onOpenDoor,
}: OverseerChatProps) {
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
    if (!durable) return;
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
  }, [durable]);

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
    // A pasted screenshot alone is a message; an upload still running is not.
    const empty = text === '' && overseer.attachments.length === 0;
    // A durable conversation takes a message mid-turn: the daemon queues it.
    if (empty || sending || overseer.attaching || (busy && !durable)) return;
    // The reader asked for a reply, so their message and the answer should be
    // in view even if they had scrolled up to read.
    followRef.current = true;
    void overseer.submit(text);
  }

  // The session owns the whole decide cycle — the re-entrancy guard, the lock
  // and the failure — so this is a plain forward rather than a wrapper.
  function decide(actionId: string, approve: boolean) {
    void overseer.confirmAction(actionId, approve);
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
            plain={durable}
            attachments={item.attachments}
            fetchAttachment={overseer.fetchAttachment}
          />
        );
      case 'narration':
        return (
          <OverseerNarration
            key={item.key}
            text={item.text}
            at={item.at}
            plain={durable}
          />
        );
      case 'live':
        return (
          <OverseerMessageBubble
            key={item.key}
            speaker="assistant"
            text={item.text}
            streaming
            plain={durable}
            fetchAttachment={overseer.fetchAttachment}
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
            onDecideAll={(approve) => {
              // One at a time: the session decides one action per call.
              void (async () => {
                for (const { action } of item.actions) {
                  await overseer.confirmAction(action.id, approve);
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
            className="text-muted-foreground font-book flex items-center gap-2 py-1 text-[11px]"
          >
            <Separator className="flex-1" />
            <span className="max-w-[80%] text-center">
              {item.text} · {formatRelativeTimeFromIso(item.at)}
            </span>
            <Separator className="flex-1" />
          </div>
        );
      case 'door':
        return onOpenDoor === undefined ? (
          <div
            key={item.key}
            className="text-muted-foreground font-book self-start px-1 text-[12px]"
          >
            {doorLabel(item.door)}
          </div>
        ) : (
          <PillButton
            key={item.key}
            data-testid="overseer-door"
            onClick={() => onOpenDoor(item.door)}
            className="self-start"
          >
            {doorLabel(item.door)}
          </PillButton>
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
      <div className="flex flex-col gap-3">
        <div className="flex flex-col gap-1">
          {!compact && (
            <p className="text-[15px] font-medium">What should we work on?</p>
          )}
          <p className="text-muted-foreground font-book text-[13px]">
            Ask about runs, tasks or the code. Anything that changes the project
            waits for your approval.
          </p>
        </div>
        {!compact && (
          <div
            className="flex flex-wrap gap-1.5"
            aria-label="Starter questions"
            role="group"
          >
            {STARTERS.map((starter) => (
              <PillButton
                key={starter.label}
                onClick={() => setDraft(starter.text)}
              >
                {starter.label}
              </PillButton>
            ))}
          </div>
        )}
        {sendError !== null && <ErrorLine>{sendError}</ErrorLine>}
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
  const suggestions = slashSuggestions(draft, overseer.record?.commands ?? []);

  return (
    <div
      ref={rootRef}
      className={cn(
        'flex min-h-0 flex-1 flex-col',
        compact ? 'gap-2' : 'gap-3'
      )}
    >
      {query !== null && (
        <InputGroup>
          <InputGroupAddon>
            <Search aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            ref={findRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') setQuery(null);
            }}
            placeholder="Find in this conversation"
            aria-label="Find in this conversation"
          />
          <InputGroupAddon align="inline-end">
            <span className="font-book tabular-nums">
              {query.trim() === ''
                ? ''
                : `${thread.length} ${thread.length === 1 ? 'match' : 'matches'}`}
            </span>
            <Button
              variant="ghost"
              size="xs"
              aria-label="Close find"
              onClick={() => setQuery(null)}
            >
              Done
            </Button>
          </InputGroupAddon>
        </InputGroup>
      )}
      {overseer.recordError !== null && overseer.record === undefined && (
        <ErrorLine>{overseer.recordError}</ErrorLine>
      )}

      <div
        ref={scrollRef}
        role="log"
        aria-label="Overseer conversation"
        onScroll={onLogScroll}
        className="flex min-h-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto [overflow-wrap:anywhere] [&>*]:shrink-0"
      >
        {(durable
          ? groupConfirmRows(groupToolRows(thread))
          : groupToolRows(thread)
        ).map(renderRow)}
      </div>

      {aboveComposer}
      <div className="flex flex-col gap-1.5">
        {(sendError ?? decideError) !== null && (
          <ErrorLine>{sendError ?? decideError}</ErrorLine>
        )}
        <div className="flex items-center gap-2">
          <span className="text-muted-foreground font-book min-w-0 flex-1 truncate text-[12px]">
            {busy
              ? durable
                ? 'Working · what you send now goes when it finishes'
                : 'The overseer is answering…'
              : durable
                ? null
                : compact
                  ? 'Actions wait for your approval.'
                  : 'Ask a follow-up. Actions always wait for your approval.'}
            {/* A durable conversation's picker names the model; otherwise it is named here. */}
            {!durable && overseer.record?.model !== undefined && (
              <> · {modelLabel(overseer.record.model)}</>
            )}
            {durable && spend > 0 && (
              <span data-testid="overseer-spend">
                {busy ? ' · ' : ''}${spend.toFixed(2)} so far
              </span>
            )}
          </span>
          {durable && busy && (
            <Button
              variant="outline"
              size="xs"
              onClick={() => void overseer.stop()}
              data-testid="overseer-stop"
              className="shrink-0"
            >
              Stop
            </Button>
          )}
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
          disabled={disabled || (busy && !durable) || sending}
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
