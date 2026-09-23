import type { MessagingConfig, TaskStorePort } from '@dispatch/core';
import { loadConfig } from '@dispatch/core';
import {
  DeliveryEngine,
  gateOf,
  openMessagesDb,
  SqliteMessageStore,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir } from '../orchestrator/paths.js';
import { GateHandlers } from './gates.js';
import { DaemonMessagingHost } from './host.js';
import type { RunTokens } from './runTokens.js';
import { createRunTokens } from './runTokens.js';

export interface Messaging {
  engine: DeliveryEngine;
  store: SqliteMessageStore;
  runTokens: RunTokens;
  gates: GateHandlers;
  config: () => MessagingConfig;
  close(): void;
}

// Boots dispatchd's messaging engine: opens messages.db, wires the daemon
// host and gate handlers, bridges engine events onto the server's EventBus,
// and recovers crash-interrupted deliveries and gate effects before the
// caller may dispatch anything (so recover() never races a fresh send).
export async function openMessaging(deps: {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStorePort;
  events: EventBus;
  ownerRef: string;
  dbPath?: string;
}): Promise<Messaging> {
  const db = openMessagesDb(
    deps.dbPath ?? join(runsDir(deps.rootDir), 'messages.db')
  );
  const store = new SqliteMessageStore(db);

  const runTokens = createRunTokens(randomBytes(32));
  deps.orchestrator.setRunTokenMinter(runTokens.mint);

  const gates = new GateHandlers();
  const host = new DaemonMessagingHost({
    rootDir: deps.rootDir,
    orchestrator: deps.orchestrator,
    store: deps.store,
    ownerRef: deps.ownerRef,
    gates,
    onHumanMessage: () => {
      // message.new already reaches the desktop over the EventBus; Phase 3
      // adds the notification-kind mapping for a human's OS notification.
    },
  });

  // Read once at boot: a config edit to the messaging limits takes effect on
  // the next daemon start, same as every other boot-resolved dependency here.
  const config = (): MessagingConfig => loadConfig(deps.rootDir).messaging;

  const engine = new DeliveryEngine({ store, host, limits: config() });

  // A human approved/denied waking a held task. Idempotent for recover()'s
  // replay: if the task already has a live run (this wake already landed, or
  // something else started it), there is nothing left to do.
  gates.register('wake', async (question, answer) => {
    if (answer.choice !== 'approve') return;
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'wake') return;
    const original = store.getMessage(gate.message);
    if (original === null) return;
    if (gate.target.startsWith('task:')) {
      const taskId = gate.target.slice('task:'.length);
      if (host.liveRunFor(taskId) !== null) return;
    }
    const result = await host.wake(gate.target, original);
    if (!result.ok) {
      await engine.send(
        {
          to: [original.from],
          kind: 'notice',
          body: `Could not wake ${gate.target}: ${result.reason}. Your message is waiting for it.`,
          refs: [{ type: 'message', id: original.id }],
        },
        { address: SYSTEM_ADDRESS, canDecide: true }
      );
    }
  });

  // A deciding human approved/denied an agent client's registration.
  // Idempotent: setting a status the agent already has is a no-op, so a
  // replayed answer after a crash never double-applies.
  gates.register('agent-registration', async (question, answer) => {
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'agent-registration') return;
    const agent = store.getAgent(gate.agent);
    if (agent === null) return;
    const status = answer.choice === 'approve' ? 'approved' : 'revoked';
    if (agent.status === status) return;
    store.putAgent({ ...agent, status, approvedBy: answer.from });
  });

  // Must finish before any run can start: retries/reverts stranded
  // deliveries and replays unapplied gate effects left by a crash.
  await engine.recover();

  engine.subscribe((e) =>
    e.type === 'message'
      ? deps.events.broadcast({ type: 'message.new', message: e.message })
      : deps.events.broadcast({
          type: 'delivery.changed',
          deliveryId: e.delivery.id,
          messageId: e.delivery.messageId,
        })
  );

  // A run coming up may have held mail waiting on its task.
  deps.orchestrator.onRunStarted((meta) => {
    void engine.deliverHeld(meta.id, meta.taskId);
  });

  return {
    engine,
    store,
    runTokens,
    gates,
    config,
    close() {
      db.close();
    },
  };
}
