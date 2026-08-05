import type { ApiClient, RunScopeRequest } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

function scopeRequestKey(
  port: number | undefined,
  runId: string | undefined,
  requestId: string | undefined
) {
  return ['dispatch-scope-request', port, runId, requestId] as const;
}

/** The full record (paths/reason) for a pending scope request — the
 *  `scope.requested` WS event only carries its id, so this fetches the rest. */
export function useScopeRequest(
  client: ApiClient | null,
  port: number | undefined,
  runId: string | undefined,
  requestId: string | undefined
): { request: RunScopeRequest | null; loading: boolean } {
  const { data, isLoading } = useQuery({
    queryKey: scopeRequestKey(port, runId, requestId),
    queryFn: () => {
      if (client === null || runId === undefined || requestId === undefined) {
        throw new Error('dispatchd client not ready');
      }
      return client.fetchScopeRequest(runId, requestId);
    },
    enabled: client !== null && runId !== undefined && requestId !== undefined,
  });
  return { request: data ?? null, loading: isLoading };
}
