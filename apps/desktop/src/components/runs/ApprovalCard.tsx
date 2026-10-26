import { useEffect, useRef, useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { DecideUnavailableNotice } from './DecideUnavailableNotice';
import { formatRelativeTimeFromIso } from '@/lib/format';
import {
  ToolApprovalCard,
  type ToolApprovalDecision,
} from '@/ui/ai/tool-approval-card';
import { Button } from '@/ui/button';

interface ApprovalCardProps {
  toolName: string;
  /** The pending tool call's input, as its gate previews it. */
  toolInput: unknown;
  /** True when `toolInput` was cut short of the full call; the card says so. */
  truncated?: boolean;
  /** Reads a truncated call's full input, which a deciding window shows instead. */
  loadFullInput?: () => Promise<unknown>;
  /** When the run went into `awaiting-approval`, so the header can say how long it has been
   * stuck. A frozen run looks identical to a busy one without it. */
  frozenSince?: string;
  onDecide: (
    allow: boolean,
    opts?: { scope?: 'once' | 'session'; reason?: string }
  ) => Promise<void>;
  /** Whether this window holds the app token approving requires — see
   *  `decideAvailability`. Every option is inert without it, and the card says why. Optional
   *  only so a caller that has not wired daemon auth still renders a working card. */
  availability?: DecideAvailability;
  onRestartDaemon?: () => Promise<void>;
  /** Whether the gate offers a grant past this call; a held call's never does. */
  sessionAllowed?: boolean;
}

const ALWAYS_AVAILABLE: DecideAvailability = {
  enabled: true,
  notice: null,
  explanation: null,
  restart: null,
};

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

// A truncated preview is the cut JSON text itself, so it reads best unquoted.
function formatPreview(toolInput: unknown, truncated: boolean): string {
  return truncated && typeof toolInput === 'string'
    ? `${toolInput}…`
    : formatInput(toolInput);
}

// Loads a truncated call's full input once per mount (each card is keyed by
// its request), and again on `retry`, so the human judges the whole call.
function useFullInput(load: (() => Promise<unknown>) | undefined): {
  full: { input: unknown } | null;
  error: string | null;
  retry: () => void;
} {
  const loadRef = useRef(load);
  loadRef.current = load;
  const shouldLoad = load !== undefined;
  const [full, setFull] = useState<{ input: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    const current = loadRef.current;
    if (!shouldLoad || current === undefined) return;
    let cancelled = false;
    void (async () => {
      try {
        const input = await current();
        if (!cancelled) setFull({ input });
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err));
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shouldLoad, attempt]);
  const retry = () => {
    setError(null);
    setAttempt((n) => n + 1);
  };
  return { full, error, retry };
}

/**
 * The human-in-the-loop gate for a run that's paused on `canUseTool` (real executor) or a
 * scripted approval gate (FakeExecutor): the shared `ToolApprovalCard` (which tool wants to
 * run and with what, allow once or for the run, or deny with a reason), plus what only a run
 * gate has: how long the run has been frozen, a truncated preview that a deciding window
 * swaps for the full call, why an attached window cannot decide, and the error a failed
 * answer left. The callback shape (`onDecide(allow, opts)`) is unchanged from before the
 * card was shared.
 */
export function ApprovalCard({
  toolName,
  toolInput,
  truncated = false,
  loadFullInput,
  frozenSince,
  onDecide,
  availability = ALWAYS_AVAILABLE,
  onRestartDaemon,
  sessionAllowed = true,
}: ApprovalCardProps) {
  // Only a deciding window may read the full call; any other keeps the preview.
  const {
    full,
    error: fullInputError,
    retry: retryFullInput,
  } = useFullInput(
    truncated && availability.enabled ? loadFullInput : undefined
  );
  const showsPreview = truncated && full === null;
  const [error, setError] = useState<string | null>(null);

  // The shared card keeps its reason box open when this rejects, so the error is shown
  // here and passed on.
  async function decide(decision: ToolApprovalDecision) {
    setError(null);
    try {
      await onDecide(
        decision.allow,
        decision.allow
          ? { scope: decision.scope }
          : decision.reason === undefined
            ? undefined
            : { reason: decision.reason }
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      throw err;
    }
  }

  return (
    <ToolApprovalCard
      toolName={toolName}
      // The detail stays a plain string: a tool name isn't agent-authored markdown.
      detail={
        frozenSince !== undefined
          ? `${toolName} — frozen ${formatRelativeTimeFromIso(frozenSince)}`
          : toolName
      }
      preview={
        full !== null
          ? formatInput(full.input)
          : formatPreview(toolInput, truncated)
      }
      sessionScope={sessionAllowed ? 'this run' : undefined}
      sessionDescription="Scoped to this run — never carries into the next one."
      onDecide={decide}
      disabled={!availability.enabled}
    >
      {showsPreview && (
        <div
          data-slot="approval-input-truncated"
          className="text-state-waiting font-book text-[12px]"
        >
          Preview truncated: the full call is longer than shown.
          {fullInputError !== null && (
            <>
              {` The full call could not be loaded (${fullInputError}). `}
              <Button
                variant="link"
                size="xs"
                className="h-auto px-0 text-[12px]"
                onClick={retryFullInput}
              >
                Load the full call
              </Button>
            </>
          )}
        </div>
      )}
      <DecideUnavailableNotice
        availability={availability}
        onRestartDaemon={onRestartDaemon}
      />
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
    </ToolApprovalCard>
  );
}
