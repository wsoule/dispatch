import type { ApiClient, MemoryEntryView } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { MemoryViewer } from '../../lib/memory';
import {
  entryActions,
  entryProvenance,
  memoryQueryKey,
  memoryQueryRootKey,
} from '../../lib/memory';
import { Button } from '@/ui/button';
import { Input } from '@/ui/input';

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
    <section
      aria-label="Memory entry"
      className="flex min-h-0 flex-col gap-3 overflow-auto p-4"
    >
      <div className="flex flex-col gap-1">
        {/* Titles and bodies are agent- or teammate-written: plain text only. */}
        <h2 className="text-foreground text-[15px] font-medium break-words">
          {entry.title}
        </h2>
        <span className="text-muted-foreground text-[12px]">
          {`${entry.handle} · ${entryProvenance(entry)}`}
        </span>
      </div>
      <p className="text-foreground text-[13px] whitespace-pre-wrap">
        {entry.body}
      </p>
      {read.data !== undefined && (
        <span className="text-muted-foreground text-[12px]">
          {`Recalled ${read.data.recallCount} ${read.data.recallCount === 1 ? 'time' : 'times'}`}
        </span>
      )}
      {revisions.length > 0 && (
        <ol aria-label="Revisions" className="flex flex-col gap-0.5">
          {revisions.map((r) => (
            <li key={r.rev} className="text-muted-foreground text-[12px]">
              {`rev ${r.rev}: ${r.cause} by ${r.by}, ${r.at.slice(0, 10)}`}
            </li>
          ))}
        </ol>
      )}
      <div className="flex flex-wrap items-center gap-2">
        {actions.pin && (
          <Button
            size="sm"
            variant="ghost"
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
            variant="ghost"
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
              variant="ghost"
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
              variant="destructive"
              disabled={busy}
              onClick={() => void act(() => client.deleteMemory(entry.id))}
            >
              Delete for good
            </Button>
          ) : (
            <Button
              size="sm"
              variant="ghost"
              disabled={busy}
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          ))}
      </div>
      {actions.retire && (
        <div className="flex items-center gap-2">
          <Input
            aria-label="Why retire it"
            placeholder="Why it no longer holds"
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            className="h-7 flex-1"
          />
          <Button
            size="sm"
            variant="outline"
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
        <span role="alert" className="text-red text-[12px]">
          {error}
        </span>
      )}
    </section>
  );
}
