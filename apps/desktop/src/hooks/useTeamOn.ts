import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

// Whether team sync is on for this project. Routes under /api/team other than
// status answer 409 until it is, so their queries wait on this. Same key as
// Settings' team panel, so the two share one fetch.
export function useTeamOn(client: ApiClient | null, enabled = true): boolean {
  const status = useQuery({
    queryKey: ['team-status', client?.baseUrl],
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getTeamStatus();
    },
    enabled: client !== null && enabled,
    retry: false,
  });
  return status.data !== undefined && status.data.state !== 'off';
}
