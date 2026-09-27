import { RotateCw } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { DecideAvailability } from '../../lib/daemonAuth';
import { formatRelativeTimeFromIso } from '@/lib/format';
import type { ApprovalCardOption } from '@/ui/ai/approval-card';
import { ApprovalCard as AiApprovalCard } from '@/ui/ai/approval-card';
import { Button } from '@/ui/button';
import { Collapsible, CollapsibleContent } from '@/ui/collapsible';
import { ScrollArea } from '@/ui/scroll-area';
import { Textarea } from '@/ui/textarea';

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
// its request), so the human judges the whole call rather than its preview.
function useFullInput(load: (() => Promise<unknown>) | undefined): {
  full: { input: unknown } | null;
  error: string | null;
} {
  const loadRef = useRef(load);
  loadRef.current = load;
  const shouldLoad = load !== undefined;
  const [full, setFull] = useState<{ input: unknown } | null>(null);
  const [error, setError] = useState<string | null>(null);
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
  }, [shouldLoad]);
  return { full, error };
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
  truncated = false,
  loadFullInput,
  frozenSince,
  onDecide,
  availability = ALWAYS_AVAILABLE,
  onRestartDaemon,
}: ApprovalCardProps) {
  // Only a deciding window may read the full call; any other keeps the preview.
  const { full, error: fullInputError } = useFullInput(
    truncated && availability.enabled ? loadFullInput : undefined
  );
  const showsPreview = truncated && full === null;
  const [deciding, setDeciding] = useState(false);
  const [restarting, setRestarting] = useState(false);
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

  async function restart() {
    if (onRestartDaemon === undefined) return;
    setRestarting(true);
    setError(null);
    try {
      await onRestartDaemon();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setRestarting(false);
    }
  }

  function handleSelect(id: string) {
    if (deciding || !availability.enabled) return;
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
    <div
      data-slot="tool-approval-card"
      className="animate-in fade-in-0 flex flex-col gap-2 duration-100 motion-reduce:animate-none"
    >
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
        disabled={deciding || denying || !availability.enabled}
      />
      <ScrollArea className="rounded-control border-border-chip bg-surface-quaternary max-h-40 border-[0.5px]">
        <pre className="text-muted-foreground p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {full !== null
            ? formatInput(full.input)
            : formatPreview(toolInput, truncated)}
        </pre>
      </ScrollArea>
      {showsPreview && (
        <div
          data-slot="approval-input-truncated"
          className="text-state-waiting font-book text-[12px]"
        >
          Preview truncated: the full call is longer than shown.
          {fullInputError !== null &&
            ` The full call could not be loaded (${fullInputError}).`}
        </div>
      )}
      {/* Same block the scope card shows: this window attached to a daemon it did not start,
          so it never saw the app token approving needs. */}
      {!availability.enabled && (
        <div className="rounded-control border-border-chip bg-surface-quaternary flex flex-col gap-1.5 border-[0.5px] px-2.5 py-2">
          <span className="text-[13px] font-medium">{availability.notice}</span>
          <span className="font-book text-muted-foreground text-[12px]">
            {availability.explanation}
          </span>
          {availability.restart?.safe === true &&
          onRestartDaemon !== undefined ? (
            <Button
              variant="secondary"
              className="self-start"
              disabled={restarting}
              onClick={() => void restart()}
            >
              <RotateCw className="size-3" />
              {restarting ? 'Restarting…' : 'Restart daemon'}
            </Button>
          ) : (
            <span className="font-book text-muted-foreground text-[12px]">
              {availability.restart?.blockedReason}
            </span>
          )}
        </div>
      )}
      {error !== null && <div className="text-red text-[12px]">{error}</div>}
      {/* `denying` drives a real Collapsible rather than a plain conditional — no chevron
          here, just the reveal/animate-in behavior for the reason box. */}
      <Collapsible open={denying}>
        <CollapsibleContent className="flex flex-col gap-2">
          <Textarea
            autoFocus
            aria-label="Reason for denying"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Why not? The agent gets this as the reason it was refused."
            className="font-book min-h-[52px] w-full resize-y text-[13px]"
          />
          <div className="flex justify-end gap-2">
            <Button
              variant="ghost"
              disabled={deciding}
              onClick={() => {
                setDenying(false);
                setSelectedId(undefined);
              }}
            >
              Cancel
            </Button>
            <Button
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
