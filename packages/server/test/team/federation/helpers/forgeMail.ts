import type { Message } from '@dispatch-foo/protocol';
import { b64u, buildOp, sealPayload } from '@dispatch-foo/protocol/federation';
import type {
  FederatedOp,
  MailTarget,
} from '@dispatch-foo/protocol/federation';

import type { MessagingReplica } from './messagingReplica.js';

// A mail op signed with `as`'s key at any seq and prev, as a revoked replica
// can still make one: sealed to `to`, its content key kept for a forward.
export function forgeInner(
  as: MessagingReplica,
  seq: number,
  message: Message,
  targets: MailTarget[],
  to: MessagingReplica
): { op: FederatedOp; key: Buffer } {
  const {
    to: sealedTo,
    sealed,
    key,
  } = sealPayload({
    replica: as.fed.replica,
    seq,
    type: 'mail',
    payload: { message, targets } as never,
    recipients: new Map([[to.fed.replica, to.fed.keys.sealPub]]),
  });
  const op = buildOp(
    {
      replica: as.fed.replica,
      seq,
      prev: 'f'.repeat(64),
      hlc: message.hlc ?? '',
      type: 'mail',
      to: sealedTo,
      sealed,
    },
    as.fed.keys.signPriv
  );
  return { op, key };
}

// `by` forwards `inner` (whose key it holds) to `to` for `forTarget`.
export function forward(
  by: MessagingReplica,
  inner: { op: FederatedOp; key: Buffer },
  forTarget: string,
  to: MessagingReplica
): void {
  by.fed.append({
    type: 'mail',
    body: { forward: inner.op as never },
    seal: (stamp) => {
      const { to: sealedTo, sealed } = sealPayload({
        replica: by.fed.replica,
        seq: stamp.seq,
        type: 'mail',
        payload: { target: forTarget, key: b64u(inner.key) },
        recipients: new Map([[to.fed.replica, to.fed.keys.sealPub]]),
      });
      return { to: sealedTo, sealed };
    },
  });
}
