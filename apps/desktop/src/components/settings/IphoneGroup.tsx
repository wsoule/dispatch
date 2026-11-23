import type { RemoteAccessStatus } from '@dispatch/client';
import { Button, Chip, CopyValue, QrCode, type UiTone } from '@dispatch/ui';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { QrCode as QrIcon, Unlink } from 'lucide-react';
import { useEffect, useState } from 'react';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { describeError } from '../../lib/actionFeedback';
import styles from './IphoneGroup.module.css';
import { SettingsGroup, SettingsHint, SettingsRow } from './SettingsGroup';

interface IphoneGroupProps {
  data: DispatchProjectData;
}

/** The relay link as a chip: green while connected, blue while dialing,
 *  red on an error, muted when nothing is paired so nothing dials. */
export function relayChip(link: RemoteAccessStatus['link']): {
  label: string;
  tone: UiTone;
} {
  switch (link.kind) {
    case 'connected':
      return { label: 'Connected', tone: 'success' };
    case 'connecting':
      return { label: 'Connecting', tone: 'info' };
    case 'error':
      return { label: 'Relay error', tone: 'danger' };
    case 'stopped':
      return { label: 'Idle', tone: 'muted' };
  }
}

function day(iso: string | null): string {
  return iso === null
    ? 'not seen yet'
    : new Date(iso).toLocaleDateString([], { dateStyle: 'medium' });
}

/**
 * The Dispatch iPhone app, paired through the hosted relay
 * (packages/server/src/remoteAccess): a QR code to scan, the phones paired
 * that way, and Unpair. What `dispatch phone pair|list|unpair` does in the
 * terminal, for someone who never opens one. Operator only, like the routes.
 */
export function IphoneGroup({ data }: IphoneGroupProps) {
  const { client, port } = data;
  const queryClient = useQueryClient();
  const isOperator = data.ownerCredential || data.remoteOrigin !== null;
  const [offer, setOffer] = useState<{
    url: string;
    expiresAt: string;
    /** The phones already paired when the code went up. */
    before: ReadonlySet<string>;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const key = ['dispatch-remote-access', port];
  // While a code is up, poll so the phone appears as soon as it pairs.
  const status = useQuery({
    queryKey: key,
    queryFn: () =>
      client === null
        ? Promise.reject(new Error('not connected'))
        : client.fetchRemoteAccess(),
    enabled: client !== null && isOperator,
    refetchInterval: offer === null ? false : 3000,
  });
  const phones = status.data?.devices ?? [];
  // A phone that paired while the code was up takes the code down.
  const newPhone =
    offer !== null && phones.some((p) => !offer.before.has(p.id));
  useEffect(() => {
    if (newPhone) setOffer(null);
  }, [newPhone]);

  async function pair() {
    if (client === null) return;
    setError(null);
    try {
      const before = new Set(phones.map((p) => p.id));
      setOffer({ ...(await client.offerPhonePairing()), before });
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  }

  async function unpair(id: string) {
    if (client === null) return;
    setError(null);
    try {
      await client.unpairPhone(id);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(describeError(err));
    }
  }

  if (!isOperator) {
    return (
      <SettingsGroup
        title="iPhone"
        keywords="iphone phone mobile pair qr relay"
        requires="none"
      >
        <SettingsRow
          title="Only the person running this daemon pairs a phone"
          subtitle="Run `dispatch phone pair` on its machine."
        />
      </SettingsGroup>
    );
  }

  const disabled = status.data?.enabled === false;
  const chip = status.data === undefined ? null : relayChip(status.data.link);
  const minutes =
    offer === null
      ? 0
      : Math.max(
          1,
          Math.round((Date.parse(offer.expiresAt) - Date.now()) / 60_000)
        );

  return (
    <SettingsGroup
      title="iPhone"
      hint="Answer agents, watch runs and talk to the Overseer from the Dispatch iPhone app. It reaches this Mac through the relay, encrypted end to end: no VPN, no open port, and the relay never reads what passes."
      keywords="iphone phone mobile pair qr relay"
      requires="none"
    >
      <SettingsRow
        title="Pair an iPhone"
        subtitle={
          disabled
            ? 'Remote access is off on this daemon (DISPATCH_REMOTE=off).'
            : 'Scan the code with the Dispatch app. It works once, for 10 minutes.'
        }
        stacked={offer !== null}
        control={
          <div className={styles.control}>
            {chip === null ? null : <Chip tone={chip.tone}>{chip.label}</Chip>}
            <Button
              variant={offer === null ? 'primary' : 'secondary'}
              icon={<QrIcon size={14} strokeWidth={1.8} />}
              onClick={() => void pair()}
              disabled={client === null || disabled}
            >
              {offer === null ? 'Show code' : 'New code'}
            </Button>
          </div>
        }
      >
        {offer !== null && (
          <div className={styles.offer} data-testid="iphone-offer">
            <QrCode value={offer.url} label="Pairing code for your iPhone" />
            <div className={styles.side}>
              <SettingsHint>
                Open Dispatch on your iPhone and scan this code, or open the
                link on the phone. Expires in about {minutes} min.
              </SettingsHint>
              <CopyValue value={offer.url} label="pairing link" truncate />
            </div>
          </div>
        )}
      </SettingsRow>
      {phones.map((phone) => (
        <SettingsRow
          key={phone.id}
          title={phone.name}
          subtitle={`Paired ${day(phone.pairedAt)} · last seen ${day(phone.lastSeenAt)}`}
          control={
            <Button
              variant="quiet"
              size="sm"
              icon={<Unlink size={14} strokeWidth={1.8} />}
              aria-label={`Unpair ${phone.name}`}
              onClick={() => void unpair(phone.id)}
            >
              Unpair
            </Button>
          }
        />
      ))}
      {status.data?.link.kind === 'error' && (
        <SettingsRow
          title="The relay is unreachable"
          subtitle={
            <SettingsHint tone="danger">
              {status.data.link.message}
            </SettingsHint>
          }
        />
      )}
      {error !== null && (
        <SettingsRow
          title="Something went wrong"
          subtitle={<SettingsHint tone="danger">{error}</SettingsHint>}
        />
      )}
    </SettingsGroup>
  );
}
