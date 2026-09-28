import type { A2AStore } from '@dispatch/a2a';
import {
  checkReachClient,
  isClientAddress,
  replyChain,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { Address, DeliveryEngine, Message } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';

import type { ExternalPolicy } from '../messaging/host.js';
import { approvedTasksOf } from './handoff.js';
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

// Whether `sender` is `task:<t>` or a run of <t>, where <t> is the Dispatch
// task of one of `client`'s approved handoffs that has not finished.
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
// clients are still external and nothing reaches them.
export function bridgeExternalPolicy(deps: BridgeDeps | null): ExternalPolicy {
  return {
    external: (address) => (isClientAddress(address) ? 'client' : null),
    admitExternal: (target, sender, replyTarget, message) => {
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
