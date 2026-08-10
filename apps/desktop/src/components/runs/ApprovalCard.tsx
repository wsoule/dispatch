import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { formatRelativeTimeFromIso } from '@/lib/format';
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

/**
 * The human-in-the-loop gate for a run that's paused on `canUseTool` (real executor) or a
 * scripted approval gate (FakeExecutor): shows which tool wants to run and with what input,
 * then lets the user allow or deny it. Both buttons disable together while a decision is in
 * flight so a slow network can't double-submit two different answers to the same request.
 * Per the redesign brief, Approve is the single filled/primary action on this surface; Deny
 * is a ghost button so the two aren't weighted equally.
 */
export function ApprovalCard({
  toolName,
  toolInput,
  frozenSince,
  onDecide,
}: ApprovalCardProps) {
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);
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

  return (
    <div className="animate-in fade-in-0 bg-state-waiting-surface border-state-waiting-edge flex flex-col gap-2 rounded-md border px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <TriangleAlert className="text-state-waiting size-3.5 shrink-0" />
        <span className="dense-label text-state-waiting font-medium">
          Waiting on approval
        </span>
        {frozenSince !== undefined && (
          <span className="dense-meta text-state-waiting">
            frozen {formatRelativeTimeFromIso(frozenSince)}
          </span>
        )}
        <span className="text-foreground truncate font-mono text-[12px]">
          {toolName}
        </span>
      </div>
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
              onClick={() => setDenying(false)}
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
      {!denying && (
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={deciding}
            onClick={() => setDenying(true)}
          >
            Deny and tell it why
          </Button>
          {/* Scoped to this run by construction — the grant lives in the executor run's own
              closure, so it cannot leak into the next run. */}
          <Button
            variant="secondary"
            size="sm"
            disabled={deciding}
            onClick={() => void decide(true, { scope: 'session' })}
          >
            Allow {toolName} for this run
          </Button>
          <Button
            size="sm"
            disabled={deciding}
            onClick={() => void decide(true, { scope: 'once' })}
          >
            Approve once
          </Button>
        </div>
      )}
    </div>
  );
}
