import type { SendResult } from '@dispatch/client';
import { Button, cx, SegmentedControl, Switch } from '@dispatch/ui';
import type { KeyboardEvent } from 'react';
import { useId, useMemo, useState } from 'react';

import { useDraftKey } from '../../hooks/useThreads';
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
  withoutRecipient,
} from '../../lib/composer';
import type { KnownAddresses } from '../../lib/threads';
import { completeAddress } from '../../lib/threads';
import { PromptBar } from '../chat/PromptBar';
import styles from './Composer.module.css';

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
  label: (address: string) => string;
  /** Sends the draft under its idempotency key, kept until a send or an edit. */
  onSend: (state: ComposeState, idempotencyKey: string) => Promise<SendResult>;
  onSent?: (result: SendResult) => void;
  /** Closes the draft: a Cancel button, and Escape with no @token to drop. */
  onCancel?: () => void;
  /** Puts the caret in the message box on mount. */
  focusOnMount?: boolean;
}

/** A new message: `@` completes recipients, and every problem shows inline with its field. */
export function Composer({
  known,
  initialTo = NONE,
  locked = NONE,
  label,
  onSend,
  onSent,
  onCancel,
  focusOnMount = false,
}: ComposerProps) {
  const [to, setTo] = useState<string[]>(() => [...initialTo]);
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<ComposeKind>('message');
  const [urgent, setUrgent] = useState(false);
  const [wakeChoice, setWakeChoice] = useState<boolean | null>(null);
  // Null until arrow keys move it: Enter then takes an address typed in full.
  const [highlight, setHighlight] = useState<number | null>(null);
  const [problem, setProblem] = useState<ComposeProblem | null>(null);
  const [sending, setSending] = useState(false);
  const [draftKey, renewKey] = useDraftKey();

  const mention = trailingMention(body);
  const query = mention?.query ?? null;
  const matches = useMemo(
    () => (query === null ? [] : completeAddress(`@${query}`, known)),
    [query, known]
  );
  const wake = wakeChoice ?? wakeDefault(to);
  const listId = useId();
  const optionId = (index: number) => `${listId}-option-${index}`;
  const listed = query !== null && matches.length > 0;
  const noMatch = query !== null && !listed;
  // The list can shrink under the highlight when the known addresses change.
  const active = Math.min(highlight ?? 0, Math.max(matches.length - 1, 0));

  const pick = (index: number | null) => {
    if (query === null) return;
    const outcome = resolveMention(query, matches, index);
    if (outcome.kind === 'problem') {
      setProblem(outcome.problem);
      return;
    }
    setTo((prev) =>
      prev.includes(outcome.address) ? prev : [...prev, outcome.address]
    );
    renewKey();
    setBody(dropTrailingMention(body));
    setHighlight(null);
    setProblem(null);
  };

  // Runs before the PromptBar's own Enter handling, so Enter picks a recipient while completing.
  const onKeyDownCapture = (event: KeyboardEvent<HTMLDivElement>) => {
    if (query === null) {
      if (event.key === 'Escape' && onCancel !== undefined) {
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setHighlight(
        matches.length === 0
          ? null
          : (active + step + matches.length) % matches.length
      );
    } else if (
      event.key === 'Enter' ||
      // Tab picks a listed match; with none, or with Shift, it moves focus as usual.
      (event.key === 'Tab' && !event.shiftKey && matches.length > 0)
    ) {
      event.preventDefault();
      event.stopPropagation();
      pick(highlight === null ? null : active);
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
      const result = await onSend(state, draftKey);
      renewKey();
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
      className={styles.compose}
      onKeyDownCapture={onKeyDownCapture}
    >
      {listed && (
        <ul
          id={listId}
          role="listbox"
          aria-label="Recipients"
          className={styles.recipients}
        >
          {matches.map((match, i) => (
            <li
              key={match.address}
              id={optionId(i)}
              role="option"
              aria-selected={i === active}
              className={styles.recipient}
              onMouseDown={(event) => {
                event.preventDefault();
                pick(i);
              }}
            >
              <span className={styles.recipientLabel}>{match.label}</span>
              {match.label !== match.address && (
                <span className={styles.address}>{match.address}</span>
              )}
            </li>
          ))}
        </ul>
      )}
      {/* Always mounted, since screen readers skip a live region's first text. */}
      <p role="status" className={noMatch ? styles.hint : 'srOnly'}>
        {noMatch ? 'No match. Type kind:id, then Enter.' : ''}
      </p>
      <PromptBar
        value={body}
        onChange={(value) => {
          setBody(value);
          renewKey();
          setProblem(null);
          setHighlight(null);
        }}
        onSubmit={() => void submit()}
        references={to.map((address) => ({
          id: address,
          label: label(address),
          locked: locked.includes(address),
        }))}
        onRemoveReference={(id) => {
          setTo((prev) => withoutRecipient(prev, id, locked));
          renewKey();
        }}
        disabled={sending}
        placeholder="Write a message… type @ to add a recipient"
        ariaLabel="New message"
        completion={
          listed ? { listId, activeOptionId: optionId(active) } : undefined
        }
        focusOnMount={focusOnMount}
      />
      <div className={styles.options}>
        <SegmentedControl
          label="Kind"
          size="sm"
          options={KINDS}
          value={kind}
          onChange={(id) => {
            setKind(KINDS.find((k) => k.id === id)?.id ?? 'message');
            renewKey();
          }}
        />
        <Switch
          label="Urgent"
          checked={urgent}
          onChange={(on) => {
            setUrgent(on);
            renewKey();
          }}
        />
        <Switch
          label="Wake if asleep"
          checked={wake}
          onChange={(on) => {
            setWakeChoice(on);
            renewKey();
          }}
        />
        {onCancel !== undefined && (
          <Button
            size="sm"
            variant="quiet"
            className={styles.cancel}
            onClick={onCancel}
          >
            Cancel
          </Button>
        )}
      </div>
      {problem !== null && (
        <p
          role="alert"
          className={cx('toneText', styles.problem)}
          data-tone="danger"
        >
          {problemText(problem)}
        </p>
      )}
    </div>
  );
}
