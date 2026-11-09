import type { AuthTier, PairingOffer } from '@dispatch/client';
import { formatPairingLink } from '@dispatch/client';
import { Button, CopyValue, Select } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Smartphone, Unlink } from 'lucide-react';
import { useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import type { RemoteConnection } from '../../lib/remoteConnections';
import {
  forgetRemoteConnection,
  listRemoteConnections,
} from '../../lib/remoteConnections';
import styles from './DevicesSection.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';
import { grantableTiers } from './TeamSection';

interface DevicesSectionProps {
  data: DispatchProjectData;
  /** Injectable for tests; defaults to this app's saved remotes. */
  savedRemotes?: () => RemoteConnection[];
  forgetRemote?: (id: string) => void;
}

const TIER_LABEL: Record<AuthTier, string> = {
  request: 'Request',
  decide: 'Decide',
  operator: 'Operator',
};

function day(iso: string | null): string {
  return iso === null
    ? 'never used'
    : new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
}

/**
 * Your other devices on this daemon (packages/server/src/devices.ts): pair
 * one with a code, see which are paired, unpair one. Then the remote daemons
 * this app itself has paired with, which it can forget.
 *
 * Only the operator in person pairs devices — this app holding the daemon's
 * app token, or a device already paired with it. A teammate is refused by the
 * daemon, so the page says why instead of offering a 403.
 */
export function DevicesSection({
  data,
  savedRemotes = listRemoteConnections,
  forgetRemote = forgetRemoteConnection,
}: DevicesSectionProps) {
  const { client, port, myTier } = data;
  const queryClient = useQueryClient();
  const isOperator = data.ownerCredential || data.remoteOrigin !== null;
  const devicesKey = ['dispatch-devices', port];
  const devices = useQuery({
    queryKey: devicesKey,
    queryFn: () => client.fetchDevices(),
    enabled: client !== null && isOperator,
  });
  const grantable = grantableTiers(myTier);
  const [tier, setTier] = useState<AuthTier>('operator');
  const [offer, setOffer] = useState<PairingOffer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remotes, setRemotes] = useState(savedRemotes);

  async function pair() {
    if (client === null) return;
    setError(null);
    try {
      setOffer(await client.offerPairing({ tier }));
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function unpair(id: string) {
    if (client === null) return;
    setError(null);
    try {
      await client.revokeDevice(id);
      await queryClient.invalidateQueries({ queryKey: devicesKey });
    } catch (err) {
      setError(describeError(err));
    }
  }

  // Where the other device reaches this daemon: its https origins, else the
  // one it already reaches it at (a remote's URL, or loopback for an SSH
  // forward of this daemon's port).
  const httpsOrigins = (offer?.origins ?? []).filter((o) =>
    o.startsWith('https://')
  );
  const reachAt =
    httpsOrigins.length > 0
      ? httpsOrigins
      : [data.remoteOrigin ?? `http://127.0.0.1:${port ?? ''}`];

  return (
    <>
      <SettingsGroup
        title="Pair a device"
        hint="The Dispatch app on another machine, or a phone. It gets its own token, acting as you at the tier you pick."
        keywords="pair device phone remote code"
        requires="none"
      >
        {!isOperator ? (
          <SettingsRow
            title="Only the person running this daemon pairs devices"
            subtitle="Run `dispatch pair` on its machine, or restart Dispatch from this app to hold its app token."
          />
        ) : (
          <SettingsRow
            title="Pairing code"
            subtitle="Works once, for 10 minutes."
            stacked={offer !== null}
            control={
              <div className={styles.pairControl}>
                <Select
                  label="Tier"
                  value={tier}
                  options={grantable.map((t) => ({
                    value: t,
                    label: TIER_LABEL[t],
                  }))}
                  className={styles.tier}
                  onChange={(v) => {
                    const picked = grantable.find((t) => t === v);
                    if (picked !== undefined) setTier(picked);
                  }}
                />
                <Button
                  variant="primary"
                  icon={<Smartphone size={14} strokeWidth={1.8} />}
                  onClick={() => void pair()}
                  disabled={client === null}
                >
                  {offer === null ? 'Get a code' : 'New code'}
                </Button>
              </div>
            }
          >
            {offer !== null && (
              <div className={styles.offer} data-testid="pairing-offer">
                <CopyValue value={offer.code} label="code" />
                {reachAt.map((origin) => (
                  <CopyValue
                    key={origin}
                    value={formatPairingLink(origin, offer.code)}
                    label="pairing link"
                    truncate
                  />
                ))}
                {httpsOrigins.length === 0 && data.remoteOrigin === null && (
                  <SettingsHint>
                    This daemon is reachable on this machine only. From the
                    other machine, forward its port over SSH (`ssh -N -L
                    127.0.0.1:{port}:127.0.0.1:{port} this-machine`), or run it
                    with `--host 0.0.0.0` and TLS.
                  </SettingsHint>
                )}
              </div>
            )}
          </SettingsRow>
        )}
        {error !== null && (
          <SettingsRow
            title="Something went wrong"
            subtitle={<SettingsHint tone="danger">{error}</SettingsHint>}
          />
        )}
      </SettingsGroup>

      {isOperator && (
        <SettingsGroup
          title="Paired devices"
          keywords="devices unpair revoke"
          requires="none"
        >
          {(devices.data ?? []).length === 0 ? (
            <SettingsRow
              title="No paired devices"
              subtitle="A device you pair shows here."
            />
          ) : (
            (devices.data ?? []).map((d) => (
              <SettingsRow
                key={d.id}
                title={d.name}
                subtitle={`${TIER_LABEL[d.tier]} · paired ${day(d.pairedAt)} · ${d.lastUsedAt === null ? 'never used' : `last used ${day(d.lastUsedAt)}`}`}
                control={
                  <Button
                    variant="quiet"
                    size="sm"
                    icon={<Unlink size={14} strokeWidth={1.8} />}
                    aria-label={`Unpair ${d.name}`}
                    onClick={() => void unpair(d.id)}
                  >
                    Unpair
                  </Button>
                }
              />
            ))
          )}
        </SettingsGroup>
      )}

      <SettingsGroup
        title="Remote daemons in this app"
        hint="Daemons on other machines this app has paired with. Forgetting one only removes it here; unpair it on its own machine with `dispatch pair revoke`."
        keywords="remote daemons forget"
        requires="none"
      >
        {remotes.length === 0 ? (
          <SettingsRow
            title="None yet"
            subtitle="Add project → Remote dispatchd… pairs this app with one."
          />
        ) : (
          remotes.map((r) => (
            <SettingsRow
              key={r.id}
              title={r.name}
              subtitle={`${r.baseUrl} · ${TIER_LABEL[r.tier]}`}
              control={
                <Button
                  variant="quiet"
                  size="sm"
                  aria-label={`Forget ${r.name}`}
                  onClick={() => {
                    forgetRemote(r.id);
                    setRemotes(savedRemotes());
                  }}
                >
                  Forget
                </Button>
              }
            />
          ))
        )}
      </SettingsGroup>
    </>
  );
}
