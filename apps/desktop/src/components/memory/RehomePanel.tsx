import type { ApiClient } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { memoryQueryKey, memoryQueryRootKey } from '../../lib/memory';
import { Button } from '@/ui/button';

/**
 * Personal entries narrowed to another checkout's key reach nothing once the
 * checkout moved (D33). The daemon cannot tell a moved checkout from another
 * live project, so this names each other key and the human picks.
 */
export function RehomePanel({
  client,
  port,
}: {
  client: Pick<ApiClient, 'memoryProjectKeys' | 'rehomeMemory'>;
  port: number | undefined;
}) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = useQuery({
    queryKey: memoryQueryKey(port, 'rehome'),
    queryFn: () => client.memoryProjectKeys(),
  });
  const others = keys.data?.others ?? [];
  if (others.length === 0) return null;
  async function move(key: string) {
    setBusy(key);
    setError(null);
    try {
      await client.rehomeMemory(key);
      await queryClient.invalidateQueries({
        queryKey: memoryQueryRootKey(port),
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }
  return (
    <div
      data-slot="memory-rehome"
      className="rounded-control bg-surface-panel flex flex-col gap-2 p-3"
    >
      {others.map(({ key, count }) => (
        <div key={key} className="flex items-center gap-3">
          <span className="text-foreground flex-1 text-[13px]">
            {`${count} ${count === 1 ? 'entry is' : 'entries are'} narrowed to another checkout (key ${key})`}
          </span>
          <Button
            size="sm"
            variant="outline"
            disabled={busy !== null}
            onClick={() => void move(key)}
          >
            Move them to this project
          </Button>
        </div>
      ))}
      {error !== null && (
        <span role="alert" className="text-red text-[12px]">
          {error}
        </span>
      )}
    </div>
  );
}
