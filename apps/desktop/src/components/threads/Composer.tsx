import type { SendResult } from '@dispatch/client';
import type { KeyboardEvent } from 'react';
import { useMemo, useState } from 'react';

import type {
  ComposeKind,
  ComposeProblem,
  ComposeState,
} from '../../lib/composer';
import {
  composeProblem,
  dropTrailingMention,
  problemText,
  resolveMention,
  sendProblem,
  trailingMention,
  wakeDefault,
} from '../../lib/composer';
import type { KnownAddresses } from '../../lib/threads';
import { completeAddress } from '../../lib/threads';
import { cn } from '@/lib/utils';
import { PromptBar } from '@/ui/ai/prompt-bar';
import { SegmentedControl } from '@/ui/ai/segmented';
import { Switch } from '@/ui/ai/switch';

const KINDS: { id: ComposeKind; label: string }[] = [
  { id: 'message', label: 'Message' },
  { id: 'question', label: 'Question' },
  { id: 'notice', label: 'Notice' },
];
const NONE: readonly string[] = [];

export interface ComposerProps {
  known: KnownAddresses;
  /** Recipients a fresh draft starts with. */
  initialTo?: readonly string[];
  /** Recipients that cannot be removed, such as a task tab's own task. */
  locked?: readonly string[];
  disabledReason: string | null;
  label: (address: string) => string;
  onSend: (state: ComposeState) => Promise<SendResult>;
  onSent?: (result: SendResult) => void;
}

/** A new message: `@` completes recipients, and every problem shows inline with its field. */
export function Composer({
  known,
  initialTo = NONE,
  locked = NONE,
  disabledReason,
  label,
  onSend,
  onSent,
}: ComposerProps) {
  const [to, setTo] = useState<string[]>(() => [...initialTo]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<ComposeKind>('message');
  const [urgent, setUrgent] = useState(false);
  const [wakeChoice, setWakeChoice] = useState<boolean | null>(null);
  const [highlight, setHighlight] = useState(0);
  const [problem, setProblem] = useState<ComposeProblem | null>(null);
  const [sending, setSending] = useState(false);

  const mention = trailingMention(body);
  const query = mention?.query ?? null;
  const matches = useMemo(
    () => (query === null ? [] : completeAddress(`@${query}`, known)),
    [query, known]
  );
  const wake = wakeChoice ?? wakeDefault(to);

  const pick = (index: number) => {
    if (query === null) return;
    const outcome = resolveMention(query, matches, index);
    if (outcome.kind === 'problem') {
      setProblem(outcome.problem);
      return;
    }
    setTo((prev) =>
      prev.includes(outcome.address) ? prev : [...prev, outcome.address]
    );
    setBody(dropTrailingMention(body));
    setHighlight(0);
    setProblem(null);
  };

  // Runs before the PromptBar's own Enter handling, so Enter picks a recipient while completing.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (query === null) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight((h) =>
        matches.length === 0 ? 0 : (h + step + matches.length) % matches.length
      );
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault();
      event.stopPropagation();
      pick(highlight);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setBody(dropTrailingMention(body));
    }
  };

  const submit = async () => {
    const state: ComposeState = { to, body, kind, urgent, wake };
    const local = composeProblem(state);
    if (local !== null) {
      setProblem(local);
      return;
    }
    setSending(true);
    setProblem(null);
    try {
      const result = await onSend(state);
      setBody('');
      setTo([...initialTo]);
      setWakeChoice(null);
      onSent?.(result);
    } catch (err) {
      setProblem(sendProblem(err));
    } finally {
      setSending(false);
    }
  };

  return (
    <div
      role="group"
      aria-label="Compose"
      className="flex flex-col gap-1.5"
      onKeyDownCapture={onKeyDownCapture}
    >
      {query !== null && (
        <ul
          role="listbox"
          aria-label="Recipients"
          className="bg-surface-quaternary rounded-card border-border-strong max-h-48 overflow-y-auto border-[0.5px] p-1 text-[13px]"
        >
          {matches.length === 0 ? (
            <li className="text-muted-foreground px-2 py-1">
              No match. Type kind:id, then Enter.
            </li>
          ) : (
            matches.map((match, i) => (
              <li
                key={match.address}
                role="option"
                aria-selected={i === highlight}
                className={cn(
                  'rounded-control cursor-pointer px-2 py-1',
                  i === highlight && 'bg-surface-hover'
                )}
                onMouseDown={(event) => {
                  event.preventDefault();
                  pick(i);
                }}
              >
                {match.label}
              </li>
            ))
          )}
        </ul>
      )}
      <PromptBar
        value={body}
        onChange={(value) => {
          setBody(value);
          setProblem(null);
          setHighlight(0);
        }}
        onSubmit={() => void submit()}
        references={to.map((address) => ({
          id: address,
          label: label(address),
        }))}
        onRemoveReference={(id) => {
          if (!locked.includes(id))
            setTo((prev) => prev.filter((a) => a !== id));
        }}
        disabled={disabledReason !== null || sending}
        placeholder="Write a message… type @ to add a recipient"
        ariaLabel="New message"
      />
      <div className="flex flex-wrap items-center gap-3">
        <SegmentedControl
          label="Kind"
          options={KINDS}
          value={kind}
          onChange={(id) =>
            setKind(KINDS.find((k) => k.id === id)?.id ?? 'message')
          }
        />
        <Switch label="Urgent" checked={urgent} onCheckedChange={setUrgent} />
        <Switch
          label="Wake if asleep"
          checked={wake}
          onCheckedChange={setWakeChoice}
        />
      </div>
      {problem !== null && (
        <p role="alert" className="text-destructive text-[12px]">
          {problemText(problem)}
        </p>
      )}
      {disabledReason !== null && (
        <p className="text-muted-foreground text-[12px]">{disabledReason}</p>
      )}
    </div>
  );
}
