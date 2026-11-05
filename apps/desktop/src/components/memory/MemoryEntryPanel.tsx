import type { ApiClient, MemoryEntryView } from '@dispatch/client';
import { Button, cx, TextField } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { MemoryViewer } from '../../lib/memory';
import {
  entryActions,
  entryProvenance,
  memoryQueryKey,
  memoryQueryRootKey,
} from '../../lib/memory';
import styles from './MemoryEntryPanel.module.css';

type EntryClient = Pick<
  ApiClient,
  | 'getMemory'
  | 'pinMemory'
  | 'retireMemory'
  | 'confirmMemory'
  | 'promoteMemory'
  | 'deleteMemory'
>;

/** One entry: where it came from, its revisions and recalls, and the actions
 *  the Lifecycle table allows this viewer (lib/memory's entryActions). */
export function MemoryEntryPanel({
  entry,
  client,
  port,
  viewer,
}: {
  entry: MemoryEntryView;
  client: EntryClient;
  port: number | undefined;
  viewer: MemoryViewer;
}) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [deleting, setDeleting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const read = useQuery({
    queryKey: memoryQueryKey(port, `entry:${entry.id}`),
    queryFn: () => client.getMemory(entry.id),
  });
  const actions = entryActions(entry, viewer);
  async function act(change: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await change();
      await queryClient.invalidateQueries({
        queryKey: memoryQueryRootKey(port),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }
  const revisions = read.data?.revisions ?? [];
  return (
    <section aria-label="Memory entry" className={styles.root}>
      <div className={styles.head}>
        {/* Titles and bodies are agent- or teammate-written: plain text only. */}
        <h2 className={styles.title}>{entry.title}</h2>
        <span className={styles.meta}>
          <span className={styles.mono}>{entry.handle}</span>
          {` · ${entryProvenance(entry)}`}
        </span>
      </div>
      <p className={styles.body}>{entry.body}</p>
      {read.data !== undefined && (
        <span className={cx(styles.meta, styles.num)}>
          {`Recalled ${read.data.recallCount} ${read.data.recallCount === 1 ? 'time' : 'times'}`}
        </span>
      )}
      {revisions.length > 0 && (
        <ol aria-label="Revisions" className={styles.revisions}>
          {revisions.map((r) => (
            <li key={r.rev} className={styles.meta}>
              {`rev ${r.rev}: ${r.cause} by ${r.by}, ${r.at.slice(0, 10)}`}
            </li>
          ))}
        </ol>
      )}
      <div className={styles.actions}>
        {actions.pin && (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() =>
              void act(() => client.pinMemory(entry.id, !entry.pinned))
            }
          >
            {entry.pinned ? 'Unpin' : 'Pin'}
          </Button>
        )}
        {actions.confirm && (
          <Button
            size="sm"
            variant="quiet"
            disabled={busy}
            onClick={() => void act(() => client.confirmMemory(entry.id))}
          >
            Confirm
          </Button>
        )}
        {actions.promote &&
          (['project', 'team'] as const).map((scope) => (
            <Button
              key={scope}
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() =>
                void act(() => client.promoteMemory(entry.id, scope))
              }
            >
              {`Promote to ${scope}`}
            </Button>
          ))}
        {actions.delete &&
          (deleting ? (
            <Button
              size="sm"
              variant="danger"
              disabled={busy}
              onClick={() => void act(() => client.deleteMemory(entry.id))}
            >
              Delete for good
            </Button>
          ) : (
            <Button
              size="sm"
              variant="quiet"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          ))}
      </div>
      {actions.retire && (
        <div className={styles.retire}>
          <TextField
            size="sm"
            aria-label="Why retire it"
            placeholder="Why it no longer holds"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className={styles.reason}
          />
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || reason.trim() === ''}
            onClick={() =>
              void act(() => client.retireMemory(entry.id, reason.trim()))
            }
          >
            Retire
          </Button>
        </div>
      )}
      {error !== null && (
        <span
          role="alert"
          className={cx('toneText', styles.error)}
          data-tone="danger"
        >
          {error}
        </span>
      )}
    </section>
  );
}
