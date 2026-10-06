import type { ApiClient, OverseerGrant } from '@dispatch/client';
import { useQuery, useQueryClient } from '@tanstack/react-query';

import { overseerKeyPrefix } from '../../hooks/useOverseerSession';
import { SettingsGroup, SettingsRow } from './SettingsGroup';
import { Button } from '@/ui/button';

// When a grant lapses, as a wall-clock time.
function lapsesAt(grant: OverseerGrant): string {
  const iso = grant.expiresAt;
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString(undefined, {
        hour: '2-digit',
        minute: '2-digit',
      });
}

/** What "Allow for this conversation" still covers, each revocable. */
export function OverseerGrantsGroup({
  client,
  port,
  conversationId,
}: {
  client: Pick<ApiClient, 'listOverseerGrants' | 'revokeOverseerGrant'>;
  port: number | undefined;
  conversationId: string | null;
}) {
  const queryClient = useQueryClient();
  const key = [...overseerKeyPrefix(port), conversationId, 'grants'];
  const grants = useQuery({
    queryKey: key,
    queryFn: () => client.listOverseerGrants(conversationId ?? ''),
    enabled: conversationId !== null,
    retry: false,
  });
  const rows = grants.data?.grants ?? [];
  return (
    <SettingsGroup
      title="Your agent’s grants"
      hint="What “Allow for this conversation” still covers. Each ends after four hours or when the conversation starts over. Irreversible commands and changes to Dispatch itself always ask."
      keywords="overseer assistant allow session permission revoke"
      requires="none"
    >
      {rows.length === 0 ? (
        <SettingsRow
          title={conversationId === null ? 'No conversation open' : 'None'}
          control={null}
        />
      ) : (
        rows.map((grant) => (
          <SettingsRow
            key={grant.key}
            title={grant.key}
            subtitle={`until ${lapsesAt(grant)}`}
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  if (conversationId === null) return;
                  void client
                    .revokeOverseerGrant(conversationId, grant.key)
                    .then(() =>
                      queryClient.invalidateQueries({ queryKey: key })
                    );
                }}
              >
                Revoke
              </Button>
            }
          />
        ))
      )}
    </SettingsGroup>
  );
}
