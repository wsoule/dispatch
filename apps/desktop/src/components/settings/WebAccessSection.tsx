import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { SwitchSetting } from './fields';
import { SettingsGroup, SettingsHint } from './SettingsGroup';

interface WebAccessSectionProps {
  data: DispatchProjectData;
}

/**
 * Settings → This machine → Web access: whether the person who signed this
 * machine in to app.dispatch.foo may open its projects from a browser there.
 * One switch for the whole machine, kept by the machine hub; on by default.
 * Only its owner ever reaches it, and only at the decide tier: no shells, no
 * file writes, none of the daemon's own controls.
 */
export function WebAccessSection({ data }: WebAccessSectionProps) {
  const { client, myTier } = data;
  const queryClient = useQueryClient();
  const key = ['machine-web-access', client?.baseUrl];
  const state = useQuery({
    queryKey: key,
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.getWebAccess();
    },
    enabled: client !== null,
    retry: false,
  });
  const [error, setError] = useState<string | null>(null);

  async function save(enabled: boolean) {
    if (client === null) return;
    setError(null);
    try {
      const next = await client.setWebAccess(enabled);
      queryClient.setQueryData(key, next);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <SettingsGroup
      title="Web access"
      hint="Open this machine's projects from app.dispatch.foo, signed in as you. Nobody else can see this machine there."
      keywords="browser app.dispatch.foo remote web hub"
    >
      {state.isError ? (
        <SettingsHint>
          No Dispatch hub is running on this machine. Sign it in with{' '}
          <code>dispatch-mcp login</code> to reach it from the web.
        </SettingsHint>
      ) : state.data === undefined ? null : (
        <SwitchSetting
          id="machine-web-access"
          title="Reach this machine from the web"
          subtitle="Requests from the web act at the decide tier: they can review and decide, never open a shell or change files."
          checked={state.data.enabled}
          {...(myTier === 'operator'
            ? {}
            : { locked: 'Only the person at this machine can change this.' })}
          onSave={(enabled) => void save(enabled)}
        />
      )}
      {error !== null && <SettingsHint tone="danger">{error}</SettingsHint>}
    </SettingsGroup>
  );
}
