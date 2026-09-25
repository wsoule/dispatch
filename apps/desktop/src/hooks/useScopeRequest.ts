import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

import type { RunScopeRequest } from '../lib/gates';
import { openGatesKey, toScopeRequest } from '../lib/gates';

/** The full record (paths/reason) for a run's open scope gate, read from the
 *  open-gates query the hook already keeps fresh. */
export function useScopeRequest(
  client: ApiClient | null,
  port: number | undefined,
  runId: string | undefined,
  requestId: string | undefined
): { request: RunScopeRequest | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: openGatesKey(port),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.openDecisions();
    },
    enabled: client !== null && requestId !== undefined,
    select: (d) => {
      const message = d.items.find((m) => m.id === requestId);
      const request = message === undefined ? null : toScopeRequest(message);
      return request !== null && request.runId === runId ? request : null;
    },
  });
  return { request: data ?? null, loading: isLoading };
}
