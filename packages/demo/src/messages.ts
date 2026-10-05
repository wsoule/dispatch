// Seeds the demo's message bus beside its run history, so Threads opens on a
// granted scope gate, open questions, an accepted handoff and an epic notice.
import {
  createUlidFactory,
  openMessagesDb,
  SqliteMessageStore,
} from '@dispatch-foo/protocol';
import type {
  Address,
  Delivery,
  DeliveryState,
  Message,
} from '@dispatch-foo/protocol';
import { mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { TASKS } from './board.js';
import { runsDir } from './paths.js';
import { assertSafeToDelete } from './repo.js';

// Same fixed instant runs.ts and records.ts anchor on, so a reseed is repeatable.
const BASE_MS = Date.parse('2026-07-28T14:00:00.000Z');

function ago(hours: number, minutes = 0): string {
  return new Date(BASE_MS - hours * 3_600_000 - minutes * 60_000).toISOString();
}

const EPIC = 'e-4a19c2';
const SCOPE_REASON =
  'The client-trusted check being retired is inlined in the route handler, not just discount.ts — moving it server-side means touching both files together.';

type MessageFields = Partial<Message> &
  Pick<Message, 'from' | 'to' | 'kind' | 'body' | 'createdAt'>;

// Ids in the daemon's shape with zeroed randomness, so a reseed repeats them;
// build each kind in time order, since the ulid factory never goes backwards.
function seedIds(): (prefix: 'm' | 'd', at: string) => string {
  const zeros = (n: number): Uint8Array => new Uint8Array(n);
  const next = { m: createUlidFactory(zeros), d: createUlidFactory(zeros) };
  return (prefix, at) =>
    `${prefix}-${next[prefix](Date.parse(at)).toLowerCase()}`;
}

/** The seeded threads by role, each message sent inside its run in runs.ts. */
export interface SeededMessages {
  question: Message;
  keyQuestion: Message;
  scope: Message;
  granted: Message;
  notice: Message;
  handoff: Message;
  accepted: Message;
  deliveries: Delivery[];
}

/** Builds the seeded threads for `human:<handle>`; the same ids every call. */
export function seedMessages(handle: string): SeededMessages {
  const human = `human:${handle}`;
  const id = seedIds();
  const message = (fields: MessageFields): Message => {
    const mid = id('m', fields.createdAt);
    return {
      id: mid,
      thread: mid,
      replyTo: null,
      refs: [],
      urgent: false,
      blocking: false,
      wake: 'none',
      ...fields,
    };
  };
  const answer = (
    to: Message,
    choice: string,
    body: string,
    createdAt: string
  ): Message =>
    message({
      thread: to.thread,
      replyTo: to.id,
      from: human,
      to: [to.from],
      kind: 'answer',
      choice,
      body,
      createdAt,
    });
  const delivery = (
    m: Message,
    recipient: Address,
    state: DeliveryState,
    over: Partial<Delivery> = {}
  ): Delivery => ({
    id: id('d', m.createdAt),
    messageId: m.id,
    recipient,
    runId: null,
    via: 'direct',
    state,
    updatedAt: m.createdAt,
    ...over,
  });

  // Oldest first, so both id sequences follow createdAt.
  const question = message({
    from: 'run:r-88bf02',
    to: [human],
    kind: 'question',
    blocking: true,
    choices: ['Google Places', 'Mapbox'],
    body: 'Which geocoding provider should this use — no default is specified in the task?',
    createdAt: ago(120, 30),
  });
  const keyQuestion = message({
    from: 'run:r-88bf02',
    to: [human],
    kind: 'question',
    blocking: true,
    choices: ['Reuse an existing key', 'Add a new one'],
    body: 'Should the API key live in an env var already used elsewhere, or a new one?',
    createdAt: ago(120, 20),
  });
  const scope = message({
    from: 'run:r-1e6a4f',
    to: [human],
    kind: 'question',
    blocking: true,
    choices: ['grant', 'deny'],
    body: `Requesting to edit outside my scope: src/server/routes.ts\n\n${SCOPE_REASON}`,
    data: {
      type: 'scope',
      paths: ['src/server/routes.ts'],
      reason: SCOPE_REASON,
    },
    createdAt: ago(26, 40),
  });
  const granted = answer(
    scope,
    'grant',
    'The discount check and its route belong together.',
    ago(26, 30)
  );
  const notice = message({
    from: 'run:r-1e6a4f',
    to: [`channel:epic/${EPIC}`],
    kind: 'notice',
    body: 'Discount validation moved server-side; the cart reads `applied` from the session now.',
    createdAt: ago(26, 5),
  });
  const handoff = message({
    from: 'run:r-f30c76',
    to: [human],
    kind: 'handoff',
    blocking: true,
    choices: ['accept', 'decline'],
    body: "Redis isn't provisioned in staging. Can you take the infra side?",
    createdAt: ago(3, 30),
  });
  const accepted = answer(handoff, 'accept', 'Taking it.', ago(3, 20));

  const deliveries = [
    delivery(question, human, 'notified'),
    delivery(keyQuestion, human, 'notified'),
    delivery(scope, human, 'answered', { updatedAt: granted.createdAt }),
    // Each answer reached its run while it was live.
    delivery(granted, 'run:r-1e6a4f', 'pushed', { runId: 'r-1e6a4f' }),
    // The epic's other tasks, already read so no later run gets a stale digest.
    ...TASKS.filter((t) => t.parent === EPIC && t.id !== 't-3f8a21').map((t) =>
      delivery(notice, `task:${t.id}`, 'read', { via: 'channel' })
    ),
    delivery(handoff, human, 'answered', { updatedAt: accepted.createdAt }),
    delivery(accepted, 'run:r-f30c76', 'pushed', { runId: 'r-f30c76' }),
  ];
  return {
    question,
    keyQuestion,
    scope,
    granted,
    notice,
    handoff,
    accepted,
    deliveries,
  };
}

/** Replaces `<runsDir>/messages.db` with seedMessages' threads; nothing is left
 *  `held` or `sending`, so the daemon never pushes this history into a run. */
export function writeMessages(
  rootDir: string,
  home: string,
  handle: string
): void {
  const dir = runsDir(rootDir, home);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, 'messages.db');
  assertSafeToDelete(path);
  for (const file of [path, `${path}-wal`, `${path}-shm`])
    rmSync(file, { force: true });

  const seeded = seedMessages(handle);
  const { deliveries, scope, granted } = seeded;
  const messages = [
    seeded.question,
    seeded.keyQuestion,
    scope,
    granted,
    seeded.notice,
    seeded.handoff,
    seeded.accepted,
  ];
  const db = openMessagesDb(path);
  try {
    const store = new SqliteMessageStore(db);
    store.transaction(() => {
      for (const m of messages) store.insertMessage(m);
      for (const d of deliveries) store.insertDelivery(d);
      // The grant's effect is history: without this row, recover() would replay it at boot.
      store.markGateApplied(scope.id, granted.createdAt);
    });
  } finally {
    db.close();
  }
}
