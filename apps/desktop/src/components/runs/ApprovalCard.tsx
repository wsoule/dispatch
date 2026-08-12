import { useState } from 'react';

import { formatRelativeTimeFromIso } from '@/lib/format';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard as AiApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent } from '@/ui/collapsible';
import { ScrollArea } from '@/ui/scroll-area';
import { Textarea } from '@/ui/textarea';

interface ApprovalCardProps {
  toolName: string;
  /** The pending tool call's input, when this window saw the `approval.requested` WS event
   * and could still find the matching log entry — see RunLogView's doc comment on
   * `pendingApproval` for why this can legitimately be `null` (e.g. after a reload). */
  toolInput: unknown;
  /** When the run went into `awaiting-approval`, so the header can say how long it has been
   * stuck. A frozen run looks identical to a busy one without it. */
  frozenSince?: string;
  onDecide: (
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
}

// Renders `toolInput` the same compact way `toolEntryPreview` does for a
// collapsed tool-log entry, so the approval card and the log line for the
// same tool call always look consistent.
function formatInput(toolInput: unknown): string {
  if (toolInput === undefined) return '(no input preview available)';
  try {
    return JSON.stringify(toolInput, null, 2);
  } catch {
    // Only a cyclic input lands here, and it has no useful text form.
    return '(input could not be displayed)';
  }
}

const DENY_ID = 'deny';
const SESSION_ID = 'session';
const ONCE_ID = 'once';

/**
 * The human-in-the-loop gate for a run that's paused on `canUseTool` (real executor) or a
 * scripted approval gate (FakeExecutor): shows which tool wants to run and with what input,
 * then lets the user allow or deny it. Built on the `ui/ai/approval-card` primitive for the
 * question/options chrome; "Deny" doesn't fire through the primitive's immediate-select
 * semantics because it needs a reason first, so it opens a reason box below instead of
 * deciding right away. Both callback shape and payloads (`onDecide(allow, opts)`) are
 * unchanged from before this reskin.
 */
export function ApprovalCard({
  toolName,
  toolInput,
  frozenSince,
  onDecide,
}: ApprovalCardProps) {
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  // Denying opens a reason box rather than firing immediately. The button says "tell it why",
  // so denying silently would make that a lie — and a bare refusal leaves the agent guessing at
  // what it did wrong, which usually means it guesses again.
  const [denying, setDenying] = useState(false);
  const [reason, setReason] = useState('');

  async function decide(
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) {
    setDeciding(true);
    setError(null);
    try {
      await onDecide(allow, opts);
      setDenying(false);
      setReason('');
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  function handleSelect(id: string) {
    if (deciding) return;
    setSelectedId(id);
    if (id === DENY_ID) {
      setDenying(true);
      return;
    }
    void decide(true, { scope: id === SESSION_ID ? 'session' : 'once' });
  }

  const options: ApprovalCardOption[] = [
    { id: DENY_ID, label: 'Deny and tell it why' },
    {
      id: SESSION_ID,
      label: `Allow ${toolName} for this run`,
      description: 'Scoped to this run — never carries into the next one.',
    },
    { id: ONCE_ID, label: 'Approve once', recommended: true },
  ];

  return (
    <div className="animate-in fade-in-0 flex flex-col gap-2 duration-150">
      <AiApprovalCard
        // Full-width in the transcript — the primitive's gallery default is `max-w-sm`. The
        // detail stays a plain string: a tool name isn't agent-authored markdown.
        className="max-w-none"
        question="Waiting on approval"
        detail={
          frozenSince !== undefined
            ? `${toolName} — frozen ${formatRelativeTimeFromIso(frozenSince)}`
            : toolName
        }
        options={options}
        onSelect={handleSelect}
        selectedId={selectedId}
        // Disabled while composing a deny reason too, not just while deciding: the reason box
        // asks "why not?" before anything fires, so the other two options staying clickable
        // underneath it would let a stray click approve the very thing being denied. The
        // pre-reskin version removed the option row outright for the same reason.
        disabled={deciding || denying}
      />
      <ScrollArea className="border-border bg-card max-h-40 rounded-md border">
        <pre className="text-muted-foreground p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {formatInput(toolInput)}
        </pre>
      </ScrollArea>
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      {/* `denying` drives a real Collapsible rather than a plain conditional — no chevron
          here, just the reveal/animate-in behavior for the reason box. */}
      <Collapsible open={denying}>
        <CollapsibleContent className="flex flex-col gap-2">
          <Textarea
            autoFocus
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why not? The agent gets this as the reason it was refused."
            className="min-h-[52px] w-full resize-y text-[12.5px]"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              disabled={deciding}
              onClick={() => {
                setDenying(false);
                setSelectedId(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              disabled={deciding}
              onClick={() => void decide(false, { reason })}
            >
              Deny{reason.trim() === '' ? '' : ' and tell it why'}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
