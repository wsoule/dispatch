import { TriangleAlert } from 'lucide-react';
import { useState } from 'react';

import { Button } from '@/ui/button';

interface ApprovalCardProps {
  toolName: string;
  /** The pending tool call's input, when this window saw the `approval.requested` WS event
   * and could still find the matching log entry — see RunLogView's doc comment on
   * `pendingApproval` for why this can legitimately be `null` (e.g. after a reload). */
  toolInput: unknown;
  onDecide: (allow: boolean) => Promise<void>;
}

// Renders `toolInput` the same compact way `toolEntryPreview` does for a
// collapsed tool-log entry, so the approval card and the log line for the
// same tool call always look consistent.
function formatInput(toolInput: unknown): string {
  if (toolInput === undefined) return '(no input preview available)';
  try {
    return JSON.stringify(toolInput, null, 2);
  } catch {
    return String(toolInput);
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
  onDecide,
}: ApprovalCardProps) {
  const [deciding, setDeciding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function decide(allow: boolean) {
    setDeciding(true);
    setError(null);
    try {
      await onDecide(allow);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setDeciding(false);
    }
  }

  return (
    <div className="animate-in fade-in-0 flex flex-col gap-2 rounded-md border border-amber-500/30 bg-amber-500/[0.06] px-3 py-2.5 duration-150">
      <div className="flex items-center gap-2">
        <TriangleAlert className="size-3.5 shrink-0 text-amber-500" />
        <span className="text-[11px] font-medium tracking-wide text-amber-600 uppercase dark:text-amber-400">
          Waiting on approval
        </span>
        <span className="text-foreground truncate font-mono text-[12px]">
          {toolName}
        </span>
      </div>
      <pre className="border-border bg-card text-muted-foreground max-h-40 overflow-auto rounded-md border p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
        {formatInput(toolInput)}
      </pre>
      {error !== null && (
        <div className="text-destructive text-[12px]">{error}</div>
      )}
      <div className="flex justify-end gap-2">
        <Button
          variant="ghost"
          size="sm"
          disabled={deciding}
          onClick={() => void decide(false)}
        >
          Deny
        </Button>
        <Button size="sm" disabled={deciding} onClick={() => void decide(true)}>
          Approve
        </Button>
      </div>
    </div>
  );
}
