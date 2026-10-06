import { useQuery } from '@tanstack/react-query';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { a2aQueryKey } from '../../lib/a2a';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { RefAction } from '../../lib/threadSources';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import { PeekDrawer } from './PeekDrawer';

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

  return (
    <PeekDrawer
      label={`Conversation with ${alias}`}
      testId="outside-peek"
      title={
        <span>
          {peer?.name ?? alias}{' '}
          <span className="rounded-chip bg-(--state-landing-surface) px-1.5 text-[11px] font-normal text-(--state-landing-fg)">
            Outside
          </span>
        </span>
      }
      onClose={onClose}
    >
      <div className="border-border flex flex-col gap-1 border-b-[0.5px] px-3 py-2 text-[12px]">
        <span className="text-muted-foreground">
          {peer === undefined
            ? 'Not a known peer on this daemon'
            : [
                STATUS[peer.status] ?? peer.status,
                peer.auth === 'signature' || peer.fingerprint !== null
                  ? 'card pinned'
                  : `${peer.auth} auth`,
                `card fetched ${formatRelativeTimeFromIso(peer.fetchedAt)}`,
              ].join(' · ')}
        </span>
        <span className="text-muted-foreground">
          {address}
          {peer !== undefined && ` · ${peer.interfaceUrl}`}
        </span>
        <span className="text-(--state-landing-fg)">
          plain text only · this machine only
        </span>
        <button
          type="button"
          onClick={onOpenA2ASettings}
          className="self-start text-(--accent) hover:underline"
        >
          Settings › A2A
        </button>
      </div>
      <div className="min-h-0 flex-1">
        <ConversationTimeline
          data={data}
          query={{ with: address }}
          composerTo={address}
          composerLabel={peer?.name ?? alias}
          onOpenRef={onOpenRef}
          emptyText={`Nothing between you and ${alias} yet.`}
        />
      </div>
    </PeekDrawer>
  );
}
