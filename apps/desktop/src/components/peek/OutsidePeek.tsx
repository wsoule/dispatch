import { Chip } from '@dispatch/ui';
import { useQuery } from '@tanstack/react-query';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { a2aQueryKey } from '../../lib/a2a';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { RefAction } from '../../lib/threadSources';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import {
  PeekChip,
  PeekSlideOver,
  PeekTitle,
  PresenceLine,
} from './PeekSlideOver';
import styles from './PeekSlideOver.module.css';

const STATUS: Record<string, string> = {
  active: 'active',
  disabled: 'disabled',
  'auth-failed': 'credential refused',
};

/** An outside (A2A) agent: its card, plain text only, this machine only. */
export function OutsidePeek({
  data,
  address,
  onOpenRef,
  onOpenA2ASettings,
  onClose,
}: {
  data: DispatchProjectData;
  /** `a2a:<alias>`. */
  address: string;
  onOpenRef: (action: RefAction) => void;
  onOpenA2ASettings: () => void;
  onClose: () => void;
}) {
  const { client } = data;
  const alias = address.replace(/^a2a:/, '');
  // The same query Settings › A2A reads.
  const peers = useQuery({
    queryKey: a2aQueryKey(client?.baseUrl, 'peers'),
    queryFn: () => {
      if (client === null) throw new Error('dispatchd client not ready');
      return client.a2aPeers();
    },
    enabled: client !== null,
    retry: false,
  });
  const peer = peers.data?.peers.find((p) => p.alias === alias);

  const name = peer?.name ?? alias;
  return (
    <PeekSlideOver
      testId="outside-peek"
      contentKey={address}
      title={<PeekTitle name={name} note={<Chip tone="muted">Outside</Chip>} />}
      subtitle={`${address} · outside agent`}
      onClose={onClose}
      summary={
        <>
          <PresenceLine live={peer?.status === 'active'} tone="success">
            {peer === undefined
              ? 'Not a known peer on this daemon'
              : [
                  STATUS[peer.status] ?? peer.status,
                  peer.auth === 'signature' || peer.fingerprint !== null
                    ? 'card pinned'
                    : `${peer.auth} auth`,
                  `card fetched ${formatRelativeTimeFromIso(peer.fetchedAt)}`,
                ].join(' · ')}
          </PresenceLine>
          {peer !== undefined && (
            <span className={`mono ${styles.fact}`}>{peer.interfaceUrl}</span>
          )}
          <span className={styles.caution}>
            plain text only · this machine only
          </span>
          <div className={styles.chips}>
            <PeekChip onClick={onOpenA2ASettings}>Settings › A2A</PeekChip>
          </div>
        </>
      }
    >
      <ConversationTimeline
        data={data}
        query={{ with: address }}
        composerTo={address}
        composerLabel={name}
        onOpenRef={onOpenRef}
        emptyText={`Nothing between you and ${alias} yet.`}
      />
    </PeekSlideOver>
  );
}
