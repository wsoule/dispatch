import type { ApiClient } from '@dispatch/client';
import { Button, Notice, SegmentedControl, TextArea } from '@dispatch/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';

import { threadListsKey } from '../../hooks/useThreads';
import {
  type ComposeKind,
  problemText,
  sendProblem,
  toSendInput,
} from '../../lib/composer';
import styles from './HomeComposer.module.css';

/** How long a send waits for Undo: a sent message cannot be recalled. */
export const UNDO_MS = 4000;

type HomeKind = ComposeKind | 'comment';

const KIND_LABEL: Record<HomeKind, string> = {
  message: 'Message',
  question: 'Question',
  notice: 'Notice',
  comment: 'Comment',
};

// A first send to someone outside the team is confirmed once per address.
function confirmedOutside(address: string): boolean {
  try {
    return localStorage.getItem(`dispatch:a2a-confirmed:${address}`) === '1';
  } catch {
    return false;
  }
}

function confirmOutside(address: string): void {
  try {
    localStorage.setItem(`dispatch:a2a-confirmed:${address}`, '1');
  } catch {
    // Asked again next time.
  }
}

export interface HomeComposerProps {
  client: Pick<ApiClient, 'sendMessage'> | null;
  port: number | undefined;
  /** The home's address: `task:t-1`, `channel:release`, `human:sam`, `a2a:acme`. */
  to: string;
  /** How the send button names it: "t-203", "# release", "Sam". */
  label: string;
  /** Task homes also take a durable comment, synced to the team and Linear. */
  onComment?: (body: string) => Promise<unknown>;
  disabled?: boolean;
  disabledReason?: string;
  onSent?: () => void;
  /** How long Undo is offered; tests shorten it. */
  holdMs?: number;
}

/** A home's composer: locked to its address, every send held for Undo. */
export function HomeComposer({
  client,
  port,
  to,
  label,
  onComment,
  disabled = false,
  disabledReason,
  onSent,
  holdMs = UNDO_MS,
}: HomeComposerProps) {
  const queryClient = useQueryClient();
  const [body, setBody] = useState('');
  const [kind, setKind] = useState<HomeKind>('message');
  const [held, setHeld] = useState<{ body: string; kind: HomeKind } | null>(
    null
  );
  const [askOutside, setAskOutside] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const keyRef = useRef(crypto.randomUUID());
  const outside = to.startsWith('a2a:');
  const kinds: HomeKind[] = onComment
    ? ['message', 'question', 'notice', 'comment']
    : ['message', 'question', 'notice'];

  async function deliver(draft: { body: string; kind: HomeKind }) {
    setError(null);
    try {
      if (draft.kind === 'comment') {
        await onComment?.(draft.body);
      } else {
        if (client === null) throw new Error('dispatchd client not ready');
        await client.sendMessage(
          toSendInput({
            to: [to],
            body: draft.body,
            kind: draft.kind,
            urgent: false,
            wake: draft.kind === 'question',
          }),
          { idempotencyKey: keyRef.current, continueThread: true }
        );
        keyRef.current = crypto.randomUUID();
        void queryClient.invalidateQueries({ queryKey: threadListsKey(port) });
      }
      onSent?.();
    } catch (err) {
      setError(problemText(sendProblem(err)));
      setBody((current) => (current === '' ? draft.body : current));
    }
  }

  // The held send goes out when its Undo window closes, with the latest props.
  const deliverRef = useRef(deliver);
  useEffect(() => {
    deliverRef.current = deliver;
  });
  useEffect(() => {
    if (held === null) return;
    const timer = setTimeout(() => {
      setHeld(null);
      void deliverRef.current(held);
    }, holdMs);
    return () => clearTimeout(timer);
  }, [held, holdMs]);

  const hold = () => {
    const text = body.trim();
    if (text === '' || disabled) return;
    if (outside && kind !== 'comment' && !confirmedOutside(to)) {
      setAskOutside(true);
      return;
    }
    setHeld({ body: text, kind });
    setBody('');
  };

  return (
    <div data-testid="home-composer" className={styles.root}>
      {held !== null && (
        <Notice
          tone="info"
          role="status"
          data-testid="undo-send"
          action={
            <Button
              size="sm"
              variant="secondary"
              onClick={() => {
                setBody(held.body);
                setKind(held.kind);
                setHeld(null);
              }}
            >
              Undo
            </Button>
          }
        >
          {held.kind === 'comment' ? 'Commenting on' : 'Sending to'} {label}…
        </Notice>
      )}
      {askOutside && (
        <Notice
          tone="warning"
          role="alert"
          action={
            <span className={styles.actions}>
              <Button
                size="sm"
                variant="primary"
                onClick={() => {
                  confirmOutside(to);
                  setAskOutside(false);
                  setHeld({ body: body.trim(), kind });
                  setBody('');
                }}
              >
                Send to {label}
              </Button>
              <Button
                size="sm"
                variant="quiet"
                onClick={() => setAskOutside(false)}
              >
                Cancel
              </Button>
            </span>
          }
        >
          Someone outside your team will see this. Plain text only.
        </Notice>
      )}
      {error !== null && (
        <Notice tone="danger" role="alert">
          {error}
        </Notice>
      )}
      <TextArea
        rows={2}
        className={styles.text}
        aria-label={`Write to ${label}`}
        editing="markdown"
        placeholder={disabled ? disabledReason : `Write to ${label}…`}
        value={body}
        disabled={disabled}
        onChange={(e) => setBody(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            hold();
          }
        }}
      />
      {/* Wraps in a peek's narrow drawer rather than clipping the send button. */}
      <div className={styles.controls}>
        <SegmentedControl
          label="Kind"
          size="sm"
          options={kinds.map((k) => ({ id: k, label: KIND_LABEL[k] }))}
          value={kind}
          onChange={(id) => {
            const next = kinds.find((k) => k === id);
            if (next !== undefined) setKind(next);
          }}
        />
        <span className={styles.hint}>
          {kind === 'comment'
            ? 'Synced to the team and Linear · wakes no agent'
            : kind === 'notice'
              ? 'Wakes no agent'
              : 'Reaches agents at their next turn'}
        </span>
        <Button
          size="sm"
          variant="primary"
          className={styles.send}
          disabled={disabled || body.trim() === '' || held !== null}
          onClick={hold}
        >
          {kind === 'comment' ? `Comment on ${label}` : `Send to ${label}`} ↑
        </Button>
      </div>
    </div>
  );
}
