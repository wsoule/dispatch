import type { ApiClient } from '@dispatch/client';
import { useQuery } from '@tanstack/react-query';

import { a2aQueryKey } from '../lib/a2a';
import { type AdminItem, adminItems } from '../lib/adminItems';
import { memoryQueryKey } from '../lib/memory';

// The same keys and fetches the Settings pages use, so both read one cache.
export function useAdminItems(
  client: ApiClient | null,
  port: number | undefined,
  enabled: boolean
): AdminItem[] {
  const on = client !== null && enabled;
  const machines = useQuery({
    queryKey: ['team-keys', client?.baseUrl],
    queryFn: () => ready(client).getTeamKeys(),
    enabled: on,
    retry: false,
    refetchInterval: 30_000,
  });
  const peers = useQuery({
    queryKey: a2aQueryKey(client?.baseUrl, 'peers'),
    queryFn: () => ready(client).a2aPeers(),
    enabled: on,
  });
  const clients = useQuery({
    queryKey: a2aQueryKey(client?.baseUrl, 'clients'),
    queryFn: () => ready(client).a2aClients(),
    enabled: on,
  });
  const problems = useQuery({
    queryKey: memoryQueryKey(port, 'ingest-problems'),
    queryFn: () => ready(client).listIngestProblems(),
    enabled: on,
    retry: false,
  });
  return adminItems({
    waitingMachines: machines.data?.waiting.length,
    refusedPeers: peers.data?.peers.filter((p) => p.status === 'auth-failed')
      .length,
    pendingClients: clients.data?.clients.filter((c) => c.status === 'pending')
      .length,
    skippedFiles: problems.data?.problems.length,
  });
}

function ready(client: ApiClient | null): ApiClient {
  if (client === null) throw new Error('dispatchd client not ready');
  return client;
}
