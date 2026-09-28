import type { A2AStore } from '@dispatch/a2a';
import { checkReachClient, isClientAddress, replyChain } from '@dispatch/a2a';
import type { DeliveryEngine, Message } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';

import type { ExternalPolicy } from '../messaging/host.js';

// Whether `replyTarget`'s reply chain reaches one of `client`'s A2A task roots.
function inClientScope(
  engine: DeliveryEngine,
  store: A2AStore,
  client: string,
  replyTarget: Message
): boolean {
  return replyChain(replyTarget, (id) => engine.getMessage(id)).some(
    (id) => store.getTask(id)?.client === client
  );
}

// Who counts as external, and what may reach them. With the store down (null),
// clients are still external and nothing reaches them.
export function bridgeExternalPolicy(
  deps: { engine: DeliveryEngine; store: A2AStore } | null
): ExternalPolicy {
  return {
    external: (address) => (isClientAddress(address) ? 'client' : null),
    admitExternal: (target, _sender, replyTarget, message) => {
      if (!isClientAddress(target.recipient)) return 'deliver';
      if (deps === null) {
        throw new MessagingError(
          'invalid',
          'the A2A bridge is unavailable',
          target.field
        );
      }
      checkReachClient(
        message,
        replyTarget,
        {
          inClientScope:
            replyTarget !== null &&
            inClientScope(
              deps.engine,
              deps.store,
              target.recipient,
              replyTarget
            ),
          fromApprovedLinkedTask: false,
        },
        target.field
      );
      return 'deliver';
    },
  };
}
