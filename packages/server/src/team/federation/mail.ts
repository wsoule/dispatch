import { localOnlyReason } from '@dispatch/protocol';
import type { Address, Message, MessageStore } from '@dispatch/protocol';
import {
  b64u,
  MAX_SEALED_RECIPIENTS,
  openWithKey,
  sealPayload,
  unwrapContentKey,
} from '@dispatch/protocol/federation';
import type {
  FederatedOp,
  ForwardPayload,
  MailPayload,
  MailTarget,
} from '@dispatch/protocol/federation';

import type { Homes } from './homes.js';
import type { RosterService } from './roster.js';
import type { Collector } from './service.js';
import type { FedStore } from './store.js';

const MAIL_SCAN_BATCH = 200;

// A message as its payload carries it: `origin` is the receiver's to set.
function withoutOrigin(message: Message): Message {
  const { origin: _origin, ...rest } = message;
  return rest;
}

/** One target per recipient: a local delivery's homes are this replica (and
 *  a remote row's, when it has one too), a remote row's are its homes. */
function targetsOf(
  messages: MessageStore,
  me: string,
  message: Message
): MailTarget[] {
  const remote = new Map(
    messages
      .remoteDeliveries({ messageId: message.id })
      .map((r) => [r.recipient, r])
  );
  const targets = new Map<Address, MailTarget>();
  for (const d of messages.deliveries({ messageId: message.id })) {
    if (targets.has(d.recipient)) continue;
    const row = remote.get(d.recipient);
    const homes = [...new Set([me, ...(row?.homes ?? [])])].sort();
    targets.set(d.recipient, { recipient: d.recipient, via: d.via, homes });
  }
  for (const [recipient, row] of remote) {
    if (targets.has(recipient)) continue;
    targets.set(recipient, {
      recipient,
      via: row.via,
      homes: [...row.homes].sort(),
      ...(row.wakeAt === null ? {} : { wakeAt: row.wakeAt }),
    });
  }
  return [...targets.values()].sort((a, b) =>
    a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0
  );
}

/** Who gets a copy: every target's homes and a human sender's other
 *  devices, minus this replica; with any copy leaving, every admitted
 *  observer too (spec "Observers"). Sorted. */
function mailRecipients(input: {
  me: string;
  message: Message;
  targets: readonly MailTarget[];
  homes: Homes;
  roster: RosterService;
}): string[] {
  const { me, message, targets, homes, roster } = input;
  const out = new Set<string>();
  for (const t of targets) for (const h of t.homes) out.add(h);
  if (message.from.startsWith('human:'))
    for (const h of homes.of(message.from)) out.add(h);
  out.delete(me);
  if (out.size > 0)
    for (const m of roster.view()?.members.values() ?? [])
      if (m.observer && roster.isCovered(m.replica) && m.replica !== me)
        out.add(m.replica);
  return [...out].sort();
}

// Every message this replica created since the watermark, sealed to the homes
// of its targets and the sender's other devices; history before this machine
// joined and messages whose participants all live here never leave.
export class MailOut implements Collector {
  readonly order = 3;

  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      homes: Homes;
      messages: MessageStore;
    }
  ) {
    // The watermark starts where this machine joined the team.
    deps.roster.onTeamJoined(() => {
      if (deps.fed.meta('mail_rowid') === null)
        deps.fed.setMeta('mail_rowid', String(deps.messages.maxRowid()));
    });
  }

  collect(): void {
    const { fed, roster, messages, homes } = this.deps;
    if (!roster.mailReady()) return;
    const me = fed.replica;
    let watermark = Number(fed.meta('mail_rowid') ?? messages.maxRowid());
    for (;;) {
      const batch = messages.messagesAfter(watermark, MAIL_SCAN_BATCH);
      if (batch.length === 0) break;
      for (const { rowid, message } of batch) {
        const root =
          message.thread === message.id
            ? null
            : messages.getMessage(message.thread);
        const replyTarget =
          message.replyTo === null
            ? null
            : messages.getMessage(message.replyTo);
        const local = localOnlyReason(message, replyTarget, root) !== null;
        const targets = targetsOf(messages, me, message);
        const recipients = local
          ? []
          : mailRecipients({ me, message, targets, homes, roster });
        fed.atomically(() => {
          if (recipients.length > 0) this.publish(message, targets, recipients);
          fed.setMeta('mail_rowid', String(rowid));
        });
        watermark = rowid;
      }
    }
  }

  /** Seals the message to `recipients`, one op per MAX_SEALED_RECIPIENTS;
   *  FW-R31(2): only to keys the roster decided, never a waiting claim. */
  publish(
    message: Message,
    targets: MailTarget[],
    recipients: readonly string[]
  ): FederatedOp[] {
    const { fed, roster } = this.deps;
    const keys = new Map<string, string>();
    for (const r of recipients) {
      const pin = fed.pinned(r);
      if (pin === null)
        fed.problem(
          `mail:${r}`,
          `${message.id} was not sent to ${roster.label(r)}: the roster has decided no key for that machine`
        );
      else keys.set(r, pin.sealPub);
    }
    const to = [...keys.keys()].sort();
    const payload: MailPayload = { message: withoutOrigin(message), targets };
    const ops: FederatedOp[] = [];
    for (let at = 0; at < to.length; at += MAX_SEALED_RECIPIENTS) {
      const chunk = new Map(
        to
          .slice(at, at + MAX_SEALED_RECIPIENTS)
          .map((r): [string, string] => [r, keys.get(r) ?? ''])
      );
      ops.push(
        fed.append({
          type: 'mail',
          seal: (stamp) => {
            const { to: sealedTo, sealed } = sealPayload({
              replica: fed.replica,
              seq: stamp.seq,
              type: 'mail',
              payload: payload as never,
              recipients: chunk,
            });
            return { to: sealedTo, sealed };
          },
        })
      );
    }
    return ops;
  }

  /** A holder that is not the origin hands the original op on, its content
   *  key re-wrapped for `to`; null unless `target` is one of its targets. */
  forward(
    original: FederatedOp,
    target: Address,
    to: string
  ): FederatedOp | null {
    const { fed } = this.deps;
    const key = unwrapContentKey(original, fed.replica, fed.keys.sealPriv);
    if (key === null) return null;
    const payload = openWithKey(original, key) as MailPayload | null;
    if (!(payload?.targets ?? []).some((t) => t.recipient === target))
      return null;
    const pin = fed.pinned(to);
    if (pin === null) return null;
    const forward: ForwardPayload = { target, key: b64u(key) };
    return fed.append({
      type: 'mail',
      body: { forward: original as never },
      seal: (stamp) => {
        const { to: sealedTo, sealed } = sealPayload({
          replica: fed.replica,
          seq: stamp.seq,
          type: 'mail',
          payload: forward as never,
          recipients: new Map([[to, pin.sealPub]]),
        });
        return { to: sealedTo, sealed };
      },
    });
  }
}
