import { type ReactNode, useEffect, useRef, useState } from 'react';

import { Button } from '../button';
import { Collapsible, CollapsibleContent } from '../collapsible';
import { ScrollArea } from '../scroll-area';
import { Textarea } from '../textarea';
import { ApprovalCard, type ApprovalCardOption } from './approval-card';

/** A human's answer to a tool call an agent is parked on. */
export type ToolApprovalDecision = {
  allow: boolean;
  /** 'session' also allows the same tool for the rest of the card's scope. */
  scope?: 'once' | 'session';
  /** Why it was denied; the agent gets it as the reason it was refused. */
  reason?: string;
};

export type ToolApprovalCardProps = {
  toolName: string;
  /** The card's heading. */
  question?: ReactNode;
  /** The line under the heading; the tool's name by default. */
  detail?: ReactNode;
  /** The call as the human judges it (a command line, pretty JSON), in a mono box. */
  preview: string;
  /** What "allow for the rest" covers, e.g. "this run". Absent, the call can only be
   * allowed once (a held call never offers a grant past itself). */
  sessionScope?: string;
  /** One line under the session option: how far the grant reaches. */
  sessionDescription?: string;
  /** Answers the call. A rejection leaves the card ready for another try: a denial keeps
   * its reason box and what was typed, a failed allow is no longer shown as selected.
   * Showing why is the caller's (in `children`). */
  onDecide: (decision: ToolApprovalDecision) => Promise<void>;
  /** A decision is in flight on another card that shares this one's lock. */
  busy?: boolean;
  /** This window cannot decide at all; the caller says why in `children`. */
  disabled?: boolean;
  /** Notices under the preview: a truncated call, why deciding is unavailable, an error. */
  children?: ReactNode;
};

const DENY_ID = 'deny';
const SESSION_ID = 'session';
const ONCE_ID = 'once';

/**
 * The human-in-the-loop gate for a tool call an agent is parked on: which tool wants
 * to run and with what, then three answers, because "yes", "yes, and stop asking
 * about this tool" and "no" are different instructions. Built on `ApprovalCard`'s
 * option rows. Picking an allow decides at once; picking Deny opens a reason box
 * first, since a bare refusal leaves the agent guessing at what it did wrong, which
 * usually means it guesses again. The reason is optional, and the other options stay
 * disabled while it is being written, so a stray click cannot approve the very thing
 * being denied. One card for every surface that parks a call (a task run, the
 * Overseer); each says what its grant covers through `sessionScope`.
 */
export function ToolApprovalCard({
  toolName,
  question = 'Waiting on approval',
  detail = toolName,
  preview,
  sessionScope,
  sessionDescription,
  onDecide,
  busy = false,
  disabled = false,
  children,
}: ToolApprovalCardProps) {
  const [deciding, setDeciding] = useState(false);
  const [selectedId, setSelectedId] = useState<string | undefined>();
  const [denying, setDenying] = useState(false);
  // The option whose answer went out and was not refused: the card says "Answered"
  // only for it, never for a Deny whose reason box is still open.
  const [sentId, setSentId] = useState<string | undefined>();
  const [reason, setReason] = useState('');
  const reasonRef = useRef<HTMLTextAreaElement>(null);
  // Picking Deny reveals the reason box, so the caret follows that choice into it.
  useEffect(() => {
    if (denying) reasonRef.current?.focus();
  }, [denying]);

  async function decide(id: string, decision: ToolApprovalDecision) {
    setDeciding(true);
    setSentId(id);
    try {
      await onDecide(decision);
      setDenying(false);
      setReason('');
    } catch {
      // The caller reports the failure; the card stays ready for another try,
      // with no answer shown as picked unless the reason box is still open.
      setSentId(undefined);
      if (decision.allow) setSelectedId(undefined);
    } finally {
      setDeciding(false);
    }
  }

  const locked = deciding || busy || disabled;

  function handleSelect(id: string) {
    if (locked) return;
    setSelectedId(id);
    if (id === DENY_ID) {
      setDenying(true);
      return;
    }
    void decide(id, {
      allow: true,
      scope: id === SESSION_ID ? 'session' : 'once',
    });
  }

  const options: ApprovalCardOption[] = [
    { id: DENY_ID, label: 'Deny and tell it why' },
    ...(sessionScope !== undefined
      ? [
          {
            id: SESSION_ID,
            label: `Allow ${toolName} for ${sessionScope}`,
            description: sessionDescription,
          },
        ]
      : []),
    { id: ONCE_ID, label: 'Approve once', recommended: true },
  ];

  return (
    <div
      data-slot="tool-approval-card"
      className="animate-in fade-in-0 flex flex-col gap-2 duration-100 motion-reduce:animate-none"
    >
      <ApprovalCard
        // Full-width wherever it sits; the primitive's gallery default is `max-w-sm`.
        className="max-w-none"
        question={question}
        detail={detail}
        options={options}
        onSelect={handleSelect}
        selectedId={selectedId}
        disabled={locked || denying}
        answered={selectedId !== undefined && selectedId === sentId}
      />
      <ScrollArea className="rounded-control border-border-chip bg-surface-quaternary max-h-40 border-[0.5px]">
        <pre className="text-muted-foreground p-2 font-mono text-[11px] break-words whitespace-pre-wrap">
          {preview}
        </pre>
      </ScrollArea>
      {children}
      {/* A real Collapsible rather than a plain conditional: no chevron here, just the
          reveal behaviour for the reason box. */}
      <Collapsible open={denying}>
        <CollapsibleContent className="flex flex-col gap-2">
          <Textarea
            ref={reasonRef}
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
              disabled={deciding || busy}
              onClick={() => {
                const why = reason.trim();
                void decide(
                  DENY_ID,
                  why === '' ? { allow: false } : { allow: false, reason: why }
                );
              }}
            >
              Deny{reason.trim() === '' ? '' : ' and tell it why'}
            </Button>
          </div>
        </CollapsibleContent>
      </Collapsible>
    </div>
  );
}
