import type { MessagingConfig, TaskStorePort } from '@dispatch/core';
import { DEFAULT_MESSAGING, loadConfig } from '@dispatch/core';
import type { Message } from '@dispatch/protocol';
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
import type { RunMeta } from '../orchestrator/types.js';
import { runKind, TERMINAL_RUN_STATES } from '../orchestrator/types.js';
import { GateHandlers } from './gates.js';
import { DaemonMessagingHost, wakeRefusal } from './host.js';
import type { RunTokens } from './runTokens.js';
import { createRunTokens } from './runTokens.js';

export interface Messaging {
  engine: DeliveryEngine;
  store: SqliteMessageStore;
  runTokens: RunTokens;
  gates: GateHandlers;
  config: () => MessagingConfig;
  // Replays crash-interrupted deliveries and gate effects. The caller (see
  // index.ts) must run this AFTER orchestrator.reconcileOnBoot() — recover()
  // may replay a wake, which dispatches a run, and reconcileOnBoot() force-
  // fails anything non-terminal it finds that its own registry didn't already
  // know about; running recover() first would hand it the very run it just
  // started.
  recover(): Promise<{ retried: number; reverted: number; replayed: number }>;
  close(): void;
}

// True when `taskId` already has a run moving toward or already live —
// including one still `provisioning`, not only `running`/`awaiting-approval`
// — so a replayed wake (recover() after a crash, or two approvals racing)
// never dispatches a second run for the same task. Exported for direct
// testing of the boundary (provisioning counts, terminal states don't).
export function hasNonTerminalRun(runs: RunMeta[], taskId: string): boolean {
  return runs.some(
    (r) => r.taskId === taskId && !TERMINAL_RUN_STATES.has(r.state)
  );
}

// Boots dispatchd's messaging engine: opens messages.db, wires the daemon
// host and gate handlers, and bridges engine events onto the server's
// EventBus. Callers must call the returned handle's recover() themselves,
// after orchestrator.reconcileOnBoot() (see the Messaging.recover() doc) and
// before serving HTTP or letting anything else dispatch.
export function openMessaging(deps: {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStorePort;
  events: EventBus;
  ownerRef: string;
  dbPath?: string;
}): Messaging {
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

  // `config()` re-reads .dispatch/config.yml on every call — routes that
  // surface live limits see an edit immediately. The DeliveryEngine below
  // only calls it once, at construction, so ITS rate limits are fixed for
  // this boot; a changed messaging.* value takes effect on the next restart.
  const config = (): MessagingConfig => loadConfig(deps.rootDir).messaging;

  // Boot must survive a malformed config.yml (same as carto's read in
  // index.ts); live config() calls still surface the real error.
  let limits: MessagingConfig;
  try {
    limits = config();
  } catch (err) {
    console.error(
      `dispatchd: could not read messaging config, using default limits: ${(err as Error).message}`
    );
    limits = { ...DEFAULT_MESSAGING };
  }
  const engine = new DeliveryEngine({ store, host, limits });

  // Tells the sender of `about` why its wake did not happen, through its task
  // if its run has ended. Never throws: the gate's effect is already decided.
  const noticeWakeSender = async (about: Message, body: string) => {
    try {
      await engine.send(
        {
          to: [engine.deliverableAddress(about.from)],
          kind: 'notice',
          body,
          refs: [{ type: 'message', id: about.id }],
        },
        { address: SYSTEM_ADDRESS, canDecide: true }
      );
    } catch (err) {
      console.error('messaging: wake notice failed', err);
    }
  };

  // A human approved waking a held task. A replay is a no-op once the task has
  // any non-terminal run; a task closed out since the gate was raised stays asleep.
  gates.register('wake', async (question, answer) => {
    if (answer.choice !== 'approve') return;
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'wake') return;
    const original = store.getMessage(gate.message);
    if (original === null) return;
    if (gate.target.startsWith('task:')) {
      const taskId = gate.target.slice('task:'.length);
      if (hasNonTerminalRun(deps.orchestrator.list(), taskId)) return;
      const task = deps.store.get(taskId);
      const state = task === null ? 'missing' : wakeRefusal(task);
      if (state !== null) {
        await noticeWakeSender(
          original,
          `Not woken: task ${taskId} is ${state}.`
        );
        return;
      }
    }
    const result = await host.wake(gate.target, original);
    if (!result.ok) {
      await noticeWakeSender(
        original,
        `Could not wake ${gate.target}: ${result.reason}. Your message is waiting for it.`
      );
    }
  });

  // A deciding human approved/denied an agent client's registration.
  // Idempotent: setting a status the agent already has is a no-op, so a
  // replayed answer after a crash never double-applies. `approvedBy` is only
  // ever set on approval — a denial's answerer isn't the agent's approver.
  gates.register('agent-registration', async (question, answer) => {
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'agent-registration') return;
    const agent = store.getAgent(gate.agent);
    if (agent === null) return;
    if (answer.choice === 'approve') {
      if (agent.status === 'approved') return;
      store.putAgent({ ...agent, status: 'approved', approvedBy: answer.from });
    } else {
      if (agent.status === 'revoked') return;
      store.putAgent({ ...agent, status: 'revoked', approvedBy: null });
    }
  });

  // Bridging must be live before recover() runs, so a notice recover()
  // produces while replaying (e.g. a wake failure) still reaches the bus.
  const unsubscribeEngine = engine.subscribe((e) =>
    e.type === 'message'
      ? deps.events.broadcast({ type: 'message.new', message: e.message })
      : deps.events.broadcast({
          type: 'delivery.changed',
          deliveryId: e.delivery.id,
          messageId: e.delivery.messageId,
        })
  );

  // Held task mail waits for the task's next execute run; a review or verify
  // run only gets mail addressed to its own run.
  const unsubscribeRunStarted = deps.orchestrator.onRunStarted((meta) => {
    if (runKind(meta) !== 'execute') return;
    engine
      .deliverHeld(meta.id, meta.taskId)
      .catch((err) => console.error('messaging: deliverHeld failed', err));
  });

  return {
    engine,
    store,
    runTokens,
    gates,
    config,
    recover: () => engine.recover(),
    close() {
      unsubscribeRunStarted();
      unsubscribeEngine();
      db.close();
    },
  };
}
