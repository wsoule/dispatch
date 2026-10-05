import type { A2AStore } from '@dispatch/a2a';
import {
  checkReachClient,
  isClientAddress,
  replyChain,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { Address, DeliveryEngine, Message } from '@dispatch/protocol';
import { isPeerAddress, MessagingError } from '@dispatch/protocol';

import type { ExternalPolicy } from '../messaging/host.js';
import { approvedTasksOf } from './handoff.js';
import type { PeerNotices } from './peers.js';
import { admitPeer } from './peers.js';
import type { BridgeDeps } from './port.js';

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

// Whether `sender` is `task:<t>` or an execute run of <t> (never a review or
// verify run), where <t> is the task of `client`'s approved, unfinished handoff.
function fromApprovedLinkedTask(
  deps: BridgeDeps,
  client: Address,
  sender: Address
): boolean {
  const task = sender.startsWith('task:')
    ? sender.slice('task:'.length)
    : sender.startsWith('run:')
      ? deps.runs.taskIdOfRun(sender.slice('run:'.length))
      : null;
  if (task === null) return false;
  const open = deps.store
    .tasksOf(client)
    .some(
      (row) => row.dispatchTask === task && !TERMINAL_STATES.has(row.state)
    );
  return open && approvedTasksOf(deps, client).has(task);
}

// Who counts as external, and what may reach them. With the store down (null),
// clients and peers are still external and nothing reaches them.
export function bridgeExternalPolicy(
  deps: BridgeDeps | null,
  notices: PeerNotices | null
): ExternalPolicy {
  return {
    external: (address) =>
      isClientAddress(address)
        ? 'client'
        : isPeerAddress(address)
          ? 'peer'
          : null,
    admitExternal: (target, sender, replyTarget, message) => {
      if (isPeerAddress(target.recipient)) {
        if (deps === null || notices === null)
          throw new MessagingError(
            'not-found',
            'the A2A bridge is unavailable',
            target.field
          );
        return admitPeer(deps, notices, target);
      }
      if (!isClientAddress(target.recipient)) return 'deliver';
      if (deps === null) {
        throw new MessagingError(
          'invalid',
          'the A2A bridge is unavailable',
          target.field
        );
      }
      const inScope =
        replyTarget !== null &&
        inClientScope(deps.engine, deps.store, target.recipient, replyTarget);
      checkReachClient(
        message,
        replyTarget,
        {
          inClientScope: inScope,
          fromApprovedLinkedTask:
            !inScope &&
            fromApprovedLinkedTask(deps, target.recipient, sender.address),
        },
        target.field
      );
      return 'deliver';
    },
  };
}
