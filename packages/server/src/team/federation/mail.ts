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

/** FW-R33(2): remembers the machines a message was sealed to, here or by
 *  the op that brought it, so only they may report its delivery. */
export function recordSealed(
  fed: FedStore,
  messageId: string,
  replicas: readonly string[]
): void {
  for (const r of replicas)
    fed.db
      .query(
        "INSERT OR IGNORE INTO fed_published (kind, ref, hash) VALUES ('sealed', ?, '')"
      )
      .run(`${messageId}\n${r}`);
}

export function wasSealedTo(
  fed: FedStore,
  messageId: string,
  replica: string
): boolean {
  return (
    fed.db
      .query<{ ref: string }, [string]>(
        "SELECT ref FROM fed_published WHERE kind = 'sealed' AND ref = ?"
      )
      .get(`${messageId}\n${replica}`) !== null
  );
}

// A message as its payload carries it: `origin` is the receiver's to set.
function withoutOrigin(message: Message): Message {
  const { origin: _origin, ...rest } = message;
  return rest;
}

/** FW-R32(4): one target per recipient homed elsewhere, its homes without
 *  this replica; a recipient only this replica holds never leaves. */
function targetsOf(
  messages: MessageStore,
  me: string,
  message: Message
): MailTarget[] {
  const targets: MailTarget[] = [];
  for (const row of messages.remoteDeliveries({ messageId: message.id })) {
    const homes = [...new Set(row.homes)].filter((h) => h !== me).sort();
    if (homes.length === 0) continue;
    targets.push({
      recipient: row.recipient,
      via: row.via,
      homes,
      ...(row.wakeAt === null ? {} : { wakeAt: row.wakeAt }),
    });
  }
  return targets.sort((a, b) =>
    a.recipient < b.recipient ? -1 : a.recipient > b.recipient ? 1 : 0
  );
}

/** Recipients grouped by the targets each needs: a home gets the targets it
 *  is a home of, a copy (the sender's devices, observers) gets them all. */
function splitByTarget(
  targets: readonly MailTarget[],
  recipients: readonly string[],
  full: ReadonlySet<string>
): { targets: MailTarget[]; recipients: string[] }[] {
  const groups = new Map<
    string,
    { targets: MailTarget[]; recipients: string[] }
  >();
  for (const r of recipients) {
    const mine = targets.filter((t) => t.homes.includes(r));
    // FW-R33: the sender's other devices keep the whole conversation.
    const chosen = mine.length > 0 && !full.has(r) ? mine : [...targets];
    const key = chosen.map((t) => t.recipient).join('\n');
    const g = groups.get(key) ?? { targets: chosen, recipients: [] };
    g.recipients.push(r);
    groups.set(key, g);
  }
  return [...groups.values()];
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
    // FW-R32(8): the watermark persists on first use.
    if (fed.meta('mail_rowid') === null)
      fed.setMeta('mail_rowid', String(messages.maxRowid()));
    let watermark = Number(fed.meta('mail_rowid'));
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
        const local =
          localOnlyReason(message, replyTarget, root) !== null ||
          this.runMovedAway(message);
        const targets = targetsOf(messages, me, message);
        const recipients = local
          ? []
          : mailRecipients({ me, message, targets, homes, roster });
        try {
          fed.atomically(() => {
            if (recipients.length > 0)
              this.publish(message, targets, recipients);
            fed.setMeta('mail_rowid', String(rowid));
          });
        } catch (err) {
          // FW-R32(4): one message that cannot be sealed never holds the rest.
          fed.atomically(() => {
            this.refuse(message, err);
            fed.setMeta('mail_rowid', String(rowid));
          });
        }
        if (local && this.runMovedAway(message))
          fed.atomically(() => {
            this.refuse(
              message,
              new Error('its run was resolved to another machine')
            );
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
    const ops: FederatedOp[] = [];
    const devices = new Set(
      message.from.startsWith('human:') ? this.deps.homes.of(message.from) : []
    );
    for (const group of splitByTarget(
      targets,
      [...keys.keys()].sort(),
      devices
    )) {
      const payload: MailPayload = {
        message: withoutOrigin(message),
        targets: group.targets,
      };
      for (
        let at = 0;
        at < group.recipients.length;
        at += MAX_SEALED_RECIPIENTS
      ) {
        const chunk = new Map(
          group.recipients
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
        recordSealed(fed, message.id, [...chunk.keys()]);
      }
    }
    return ops;
  }

  // A message from a run of this machine's that an admin resolved to
  // another machine: it no longer speaks as that run (T16).
  private runMovedAway(message: Message): boolean {
    if (!message.from.startsWith('run:')) return false;
    const row = this.deps.fed.db
      .query<{ replica: string }, [string]>(
        'SELECT replica FROM fed_runs WHERE run = ?'
      )
      .get(message.from.slice('run:'.length));
    return row !== null && row.replica !== this.deps.fed.replica;
  }

  // Every remote recipient row of a message that will not go out: refused.
  private refuse(message: Message, err: unknown): void {
    const { fed, messages } = this.deps;
    const at = new Date().toISOString();
    for (const row of messages.remoteDeliveries({ messageId: message.id }))
      messages.setRemote(
        message.id,
        row.recipient,
        { state: 'refused', refusedBy: [fed.replica] },
        at
      );
    fed.problem(
      `mail-out:${message.id}`,
      `${message.id} could not be sent to teammates: ${err instanceof Error ? err.message.slice(0, 200) : 'unknown error'}`
    );
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
    // Only to a machine standing in the team as a home.
    const { roster } = this.deps;
    if (
      !roster.isAdmitted(to) ||
      !roster.isCovered(to) ||
      roster.isObserver(to)
    )
      return null;
    const pin = fed.pinned(to);
    if (pin === null) return null;
    const forward: ForwardPayload = { target, key: b64u(key) };
    if (payload !== null) recordSealed(fed, payload.message.id, [to]);
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
