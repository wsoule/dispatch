import { type ApiClient, ApiError } from '@dispatch/client';
import {
  Button,
  ChipButton,
  cx,
  ListItem,
  Spinner,
  Tooltip,
} from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';
import { MessageSquare, X } from 'lucide-react';
import { useEffect } from 'react';

import { overseerKey } from '../../hooks/useOverseerSession';
import styles from './DockedConversation.module.css';

const ICON = { size: 14, strokeWidth: 1.8, 'aria-hidden': true } as const;

/** One set-aside Overseer conversation: what it is, where it stands, and a way back. */
export function DockedConversation({
  client,
  port,
  conversationId,
  compact = false,
  onRestore,
  onClose,
}: {
  client: Pick<ApiClient, 'getOverseer'>;
  port: number | undefined;
  conversationId: string;
  /** A one-line chip, for windows too narrow for the side column. */
  compact?: boolean;
  onRestore: () => void;
  onClose: () => void;
}) {
  const { data: record, error } = useQuery({
    queryKey: overseerKey(port, conversationId),
    queryFn: () => client.getOverseer(conversationId),
    retry: false,
  });
  // A conversation the daemon no longer has leaves the dock.
  const gone = error instanceof ApiError && error.status === 404;
  useEffect(() => {
    if (gone) onClose();
  }, [gone, onClose]);
  if (record === undefined) return null;

  const waiting =
    record.pendingApprovals.length > 0 || record.pendingActions.length > 0;
  // Waiting on you is a missing input (amber), failed is red; the words beside
  // the glyph say it too, so the colour is never the only cue.
  const glyph = waiting ? (
    <span aria-hidden className={styles.dot} data-tone="warning" />
  ) : record.state === 'running' ? (
    <Spinner size="xs" label="" />
  ) : record.state === 'failed' ? (
    <X {...ICON} className="toneText" data-tone="danger" />
  ) : (
    <MessageSquare {...ICON} />
  );
  const status = waiting
    ? 'waiting on you'
    : record.state === 'running'
      ? 'working'
      : record.state === 'failed'
        ? 'failed'
        : undefined;
  const reply = record.messages.findLast((m) => m.role === 'assistant')?.text;
  const tip = (
    <span className={styles.tip}>
      <span className={styles.tipTitle}>{record.prompt}</span>
      <span className={styles.tipReply}>
        {reply ?? 'Bring this conversation back'}
      </span>
    </span>
  );
  const trigger = compact ? (
    <ChipButton data-testid="overseer-docked" onClick={onRestore}>
      <span className={styles.chipBody}>
        {glyph}
        <span className={styles.prompt}>{record.prompt}</span>
        {status !== undefined && (
          <span className={styles.chipStatus}>{status}</span>
        )}
      </span>
    </ChipButton>
  ) : (
    // A native button row (restore); the list item is the wrapper below, so
    // the row and its close button belong to the same item.
    <ListItem
      as="button"
      data-testid="overseer-docked"
      onClick={onRestore}
      leading={glyph}
      title={record.prompt}
      date={status}
      className={styles.row}
    />
  );

  // The close button sits beside the row, never inside it: no button within a
  // button. Wide, the wrapper is the Set aside list's item (Going out's
  // role="list"), holding both; compact, the chips over the composer are no list.
  return (
    <div
      role={compact ? undefined : 'listitem'}
      className={cx(styles.root, compact ? styles.compact : styles.wide)}
    >
      <Tooltip side={compact ? 'top' : 'left'} content={tip}>
        {trigger}
      </Tooltip>
      <Button
        variant="quiet"
        size="sm"
        aria-label="Close this set-aside conversation"
        icon={<X {...ICON} />}
        onClick={onClose}
        className={styles.close}
      />
    </div>
  );
}
