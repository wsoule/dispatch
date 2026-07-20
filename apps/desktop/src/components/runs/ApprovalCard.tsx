import { useState } from 'react';

import { Button } from '../ui/Button';
import './ApprovalCard.css';

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
    <div className="approval-card">
      <div className="approval-card-header">
        <span className="approval-card-label">Waiting on approval</span>
        <span className="approval-card-tool">{toolName}</span>
      </div>
      <pre className="approval-card-input">{formatInput(toolInput)}</pre>
      {error !== null && <div className="approval-card-error">{error}</div>}
      <div className="approval-card-actions">
        <Button
          variant="secondary"
          disabled={deciding}
          onClick={() => void decide(false)}
        >
          Deny
        </Button>
        <Button disabled={deciding} onClick={() => void decide(true)}>
          Allow
        </Button>
      </div>
    </div>
  );
}
