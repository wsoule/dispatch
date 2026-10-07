import { useQuery } from '@tanstack/react-query';

import type { DispatchProjectData } from '../../hooks/useDispatchProject';
import { a2aQueryKey } from '../../lib/a2a';
import { formatRelativeTimeFromIso } from '../../lib/format';
import type { RefAction } from '../../lib/threadSources';
import { ConversationTimeline } from '../conversation/ConversationTimeline';
import { PeekChip, PeekDrawer, PresenceLine } from './PeekDrawer';
import { InitialsAvatar } from '@/ui/ai/initials-avatar';
import { Badge } from '@/ui/badge';

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
    <PeekDrawer
      label={`Conversation with ${alias}`}
      testId="outside-peek"
      title={
        <span className="flex items-center gap-1.5">
          <span className="truncate">{name}</span>
          <Badge
            variant="ghost"
            className="h-5 bg-(--state-landing-surface) px-1.5 text-[11px] font-normal text-(--state-landing-fg)"
          >
            Outside
          </Badge>
        </span>
      }
      leading={
        <InitialsAvatar
          name={name}
          color="var(--state-landing-fg)"
          className="size-7 text-[11px]"
        />
      }
      subtitle={`${address} · outside agent`}
      onClose={onClose}
      summary={
        <>
          <PresenceLine live={peer?.status === 'active'} tone="green">
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
            <span className="text-muted-foreground truncate font-mono text-[11px]">
              {peer.interfaceUrl}
            </span>
          )}
          <span className="text-(--state-landing-fg)">
            plain text only · this machine only
          </span>
          <div className="flex flex-wrap items-center gap-1">
            <PeekChip onClick={onOpenA2ASettings}>Settings › A2A</PeekChip>
          </div>
        </>
      }
    >
      <div className="min-h-0 flex-1">
        <ConversationTimeline
          data={data}
          query={{ with: address }}
          composerTo={address}
          composerLabel={name}
          onOpenRef={onOpenRef}
          emptyText={`Nothing between you and ${alias} yet.`}
        />
      </div>
    </PeekDrawer>
  );
}
