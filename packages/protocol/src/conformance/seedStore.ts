import type { Given, Json, JsonObject } from '@dispatch-foo/protocol-spec';

import type { Message, MessageKind, Ref } from '../envelope.js';
import { DELIVERY_STATES } from '../store.js';
import type { Delivery, DeliveryVia, MessageStore } from '../store.js';
import {
  asObject,
  bare,
  malformed,
  optionalText,
  text,
  texts,
} from './fields.js';
import type { World } from './host.js';

const VIAS: readonly DeliveryVia[] = ['direct', 'channel'];

function nullableText(
  obj: JsonObject,
  key: string,
  where: string
): string | null {
  return obj[key] === null ? null : (optionalText(obj, key, where) ?? null);
}

function refsOf(value: Json | undefined, where: string): Ref[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return malformed(where, 'expected a list');
  return value.map((raw, i) => {
    const at = `${where}[${i}]`;
    const r = asObject(raw, at);
    const ref: Ref = {
      type: text(r, 'type', at),
      id: text(r, 'id', at),
    };
    const commit = optionalText(r, 'at', at);
    if (commit !== undefined) ref.at = commit;
    return ref;
  });
}

// A seeded message row with the defaults the vector format gives omitted
// fields: its own thread, no reply, no refs, not urgent or blocking.
function seededMessage(row: JsonObject, at: string, where: string): Message {
  const id = text(row, 'id', where);
  const message: Message = {
    id,
    thread: optionalText(row, 'thread', where) ?? id,
    replyTo: nullableText(row, 'replyTo', where),
    from: text(row, 'from', where),
    to: texts(row['to'], `${where}.to`),
    kind: text(row, 'kind', where) as MessageKind,
    body: text(row, 'body', where),
    refs: refsOf(row['refs'], `${where}.refs`),
    urgent: row['urgent'] === true,
    blocking: row['blocking'] === true,
    wake: row['wake'] === 'request' ? 'request' : 'none',
    createdAt: optionalText(row, 'createdAt', where) ?? at,
  };
  const session = optionalText(row, 'session', where);
  if (session !== undefined) message.session = session;
  const data = row['data'];
  if (data !== undefined) message.data = data;
  if (row['choices'] !== undefined)
    message.choices = texts(row['choices'], `${where}.choices`);
  const choice = optionalText(row, 'choice', where);
  if (choice !== undefined) message.choice = choice;
  return message;
}

function seededDelivery(row: JsonObject, at: string, where: string): Delivery {
  const session = nullableText(row, 'session', where);
  const via = row['via'] === undefined ? 'direct' : row['via'];
  return {
    id: text(row, 'id', where),
    messageId: text(row, 'message', where),
    recipient: text(row, 'recipient', where),
    runId: session === null ? null : bare(session),
    via:
      VIAS.find((v) => v === via) ??
      malformed(`${where}.via`, `expected one of ${VIAS.join(', ')}`),
    state:
      DELIVERY_STATES.find((s) => s === row['state']) ??
      malformed(
        `${where}.state`,
        `expected one of ${DELIVERY_STATES.join(', ')}`
      ),
    updatedAt: at,
  };
}

// Writes a vector's seeded rows with their literal ids, in order: agents,
// channels and members, messages, deliveries, then applied gates.
export function seedStore(
  store: MessageStore,
  given: Given,
  world: World
): void {
  const at = new Date(world.clockMs).toISOString();
  store.transaction(() => {
    for (const agent of given.agents ?? []) {
      store.putAgent({
        address: agent.address,
        displayName: agent.address,
        client: 'conformance',
        tokenHash: `seed:${agent.address}`,
        status: agent.status,
        muted: agent.muted === true,
        approvedBy: world.owner,
        createdAt: at,
      });
    }
    for (const channel of given.channels ?? []) {
      store.ensureChannel(channel.name, at, false);
      for (const member of channel.members)
        store.addMember(channel.name, member, at);
    }
    const rows = given.store ?? {};
    (rows.messages ?? []).forEach((row, i) =>
      store.insertMessage(seededMessage(row, at, `given.store.messages[${i}]`))
    );
    (rows.deliveries ?? []).forEach((row, i) =>
      store.insertDelivery(
        seededDelivery(row, at, `given.store.deliveries[${i}]`)
      )
    );
    for (const id of rows.appliedGates ?? []) store.markGateApplied(id, at);
  });
}
