import type { NormalizedEntry, RunMeta } from '@dispatch/client';
import {
  ChevronDown,
  ChevronRight,
  CircleCheck,
  CircleX,
  Info,
  Loader2,
  MessageSquare,
  MessageSquarePlus,
  Send,
} from 'lucide-react';
import type { ReactNode } from 'react';
import { useState } from 'react';

import { groupLogEntries, toolEntryPreview } from '../../lib/runLog';
import { isTerminalRunState } from '../../lib/runState';
import { ApprovalCard } from './ApprovalCard';
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

const ROLE_LABEL: Record<'assistant' | 'thinking' | 'system', string> = {
  assistant: 'Agent',
  thinking: 'Thinking',
  system: 'System',
};

// One assistant/thinking/system entry as its own chat-style row. `kind`
// picks the label and lean (thinking reads as a quieter aside, system as a
// centered note rather than a message from either side) — per the redesign
// brief, roles get subtle/muted styling distinctions, not loud colored
// chat bubbles.
function MessageBubble({ entry }: { entry: NormalizedEntry }) {
  const kind = entry.kind as 'assistant' | 'thinking' | 'system';

  if (kind === 'system') {
    return (
      <div className="text-muted-foreground flex items-center justify-center gap-1.5 py-1 text-center text-[11px]">
        <Info className="size-3 shrink-0" />
        {entry.text ?? ''}
      </div>
    );
  }

  return (
    <div
      className={cn(
        'flex max-w-[90%] flex-col gap-0.5 self-start rounded-md px-3 py-2',
        kind === 'assistant'
          ? 'border border-border bg-muted/50'
          : 'text-muted-foreground italic'
      )}
    >
      <div className="text-muted-foreground text-[11px] font-medium tracking-wide uppercase">
        {ROLE_LABEL[kind]}
      </div>
      <div className="text-foreground text-[13px] break-words whitespace-pre-wrap">
        {entry.text ?? ''}
      </div>
    </div>
  );
}

const TOOL_STATUS_ICON: Record<
  NonNullable<NormalizedEntry['status']>,
  ReactNode
> = {
  running: <Loader2 className="size-3 shrink-0 animate-spin" />,
  done: <CircleCheck className="size-3 shrink-0 text-emerald-500" />,
  error: <CircleX className="text-destructive size-3 shrink-0" />,
};

// A cluster of consecutive tool-call entries (see groupLogEntries) rendered
// as one collapsible block — collapsed by default so a turn with several
// tool calls doesn't dominate the log; expanding shows every call's full
// input and status. Uses lucide chevrons for the disclosure affordance per
// the redesign brief.
function ToolCluster({ entries }: { entries: NormalizedEntry[] }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="flex max-w-[90%] flex-col gap-1 self-start">
      <button
        type="button"
        onClick={() => setExpanded((e) => !e)}
        aria-expanded={expanded}
        className="border-border bg-muted/40 text-muted-foreground hover:border-border hover:bg-muted flex items-center gap-1.5 rounded-md border px-2 py-1.5 text-left font-mono text-[12px] transition-colors duration-150"
      >
        {expanded ? (
          <ChevronDown className="size-3.5 shrink-0" />
        ) : (
          <ChevronRight className="size-3.5 shrink-0" />
        )}
        <span className="truncate">
          {entries.length === 1
            ? toolEntryPreview(entries[0])
            : `${entries.length} tool calls`}
        </span>
      </button>
      {expanded && (
        <ul className="animate-in fade-in-0 border-border bg-card flex flex-col gap-2 rounded-md border p-2 duration-150">
          {entries.map((entry, i) => (
            <li key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5">
                {entry.status !== undefined && TOOL_STATUS_ICON[entry.status]}
                <span className="text-foreground font-mono text-[12px]">
                  {entry.toolName ?? 'tool'}
                </span>
              </div>
              <pre className="text-muted-foreground max-h-32 overflow-auto font-mono text-[11px] break-words whitespace-pre-wrap">
                {entry.toolInput !== undefined
                  ? JSON.stringify(entry.toolInput, null, 2)
                  : '(no input)'}
              </pre>
            </li>
          ))}
        </ul>
      )}
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
  onApprove: (requestId: string, allow: boolean) => Promise<void>;
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
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSending(false);
    }
  }

  return (
    <div className="flex h-full min-h-0 flex-col gap-3">
      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto px-1">
        {groups.length === 0 && (
          <div className="text-muted-foreground flex h-full flex-col items-center justify-center gap-2 text-center">
            <MessageSquare className="size-5" />
            <p className="text-[13px]">
              {meta.state === 'provisioning'
                ? 'Waiting for the run to start…'
                : 'No log entries yet.'}
            </p>
          </div>
        )}
        {groups.map((group, i) =>
          group.kind === 'tools' ? (
            <ToolCluster key={i} entries={group.entries} />
          ) : (
            <MessageBubble key={i} entry={group.entries[0]} />
          )
        )}
      </div>

      {meta.state === 'awaiting-approval' &&
        (pendingApproval !== null ? (
          <ApprovalCard
            toolName={pendingApproval.toolName}
            toolInput={pendingApprovalInput}
            onDecide={(allow) => onApprove(pendingApproval.requestId, allow)}
          />
        ) : (
          <div className="border-border bg-muted/40 text-muted-foreground flex items-start gap-2 rounded-md border px-3 py-2 text-[12px]">
            <Info className="size-3.5 shrink-0 translate-y-0.5" />
            This run is waiting on an approval this window didn&rsquo;t see live
            — reopen it from a session that was connected when the approval was
            requested, or check the run&rsquo;s process directly.
          </div>
        ))}

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
