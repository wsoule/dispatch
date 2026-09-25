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
import type { LedgerStorePort } from '../ledger.js';
import { LedgerStore } from '../ledger.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir } from '../orchestrator/paths.js';
import type { ApprovalGateRequest } from '../orchestrator/types.js';
import { runKind } from '../orchestrator/types.js';
import {
  closeGate,
  closeRunGates,
  GateHandlers,
  openToolApprovalGate,
  SYSTEM_SENDER,
} from './gates.js';
import { DaemonMessagingHost, settle, wakeRefusal } from './host.js';
import type { RunTokens } from './runTokens.js';
import { createRunTokens } from './runTokens.js';
import {
  applyScopeAnswer,
  expireScopeGates,
  installScopePolicy,
  SCOPE_EXPIRY_SWEEP_MS,
} from './scopePolicy.js';
import {
  isStaleApproval,
  raiseToolApproval,
  toolApprovalDecision,
} from './toolApproval.js';

export interface Messaging {
  engine: DeliveryEngine;
  store: SqliteMessageStore;
  runTokens: RunTokens;
  gates: GateHandlers;
  // Replays crash-interrupted deliveries and gate effects; must run after
  // orchestrator.reconcileOnBoot() (index.ts says why).
  recover(): Promise<{ retried: number; reverted: number; replayed: number }>;
  close(): void;
}

// Opens messages.db, wires the daemon host and gate handlers, and bridges the
// engine's events to the EventBus. The caller runs recover() (see index.ts).
export function openMessaging(deps: {
  rootDir: string;
  orchestrator: Orchestrator;
  store: TaskStorePort;
  events: EventBus;
  ownerRef: string;
  dbPath?: string;
  // Where scope grants are recorded; defaults to the project's JSONL ledger.
  ledgerStore?: Pick<LedgerStorePort, 'add' | 'entriesFor'>;
  // The task Activity line a policy grant writes; defaults to none.
  appendPolicyActivity?: (taskId: string, text: string) => void;
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
      // message.new already reaches the desktop over the EventBus; no OS
      // notification is raised for a human's message yet.
    },
  });

  // Read once, so a messaging.* edit applies on the next restart. A malformed
  // config.yml falls back to the default limits rather than failing boot.
  let limits: MessagingConfig;
  try {
    limits = loadConfig(deps.rootDir).messaging;
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
        SYSTEM_SENDER
      );
    } catch (err) {
      console.error('messaging: wake notice failed', err);
    }
  };

  // Tells whoever answered `question` that its effect could not apply. A
  // policy answer (from the system itself) has no inbox, so it hears nothing.
  const noticeAnswerer = async (
    question: Message,
    answer: Message,
    body: string
  ) => {
    if (answer.from === SYSTEM_ADDRESS) return;
    try {
      await engine.send(
        {
          to: [engine.deliverableAddress(answer.from)],
          kind: 'notice',
          body,
          refs: [{ type: 'message', id: question.id }],
        },
        SYSTEM_SENDER
      );
    } catch (err) {
      console.error('messaging: answer notice failed', err);
    }
  };

  // Why `taskId` must stay asleep, phrased for a notice, or null. A store error
  // counts as a refusal, so the gate is still marked applied.
  const wakeDenial = (taskId: string): string | null => {
    try {
      const task = deps.store.get(taskId);
      if (task === null) return 'is missing';
      const state = wakeRefusal(task);
      return state === null ? null : `is ${state}`;
    } catch (err) {
      return `could not be read: ${err instanceof Error ? err.message : String(err)}`;
    }
  };

  // A human approved waking a held task. A no-op while a live execute run can
  // take the task's mail; any other live run makes the wake fail with a notice.
  gates.register('wake', async (question, answer) => {
    if (answer.choice !== 'approve') return;
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'wake') return;
    const original = store.getMessage(gate.message);
    if (original === null) return;
    if (gate.target.startsWith('task:')) {
      const taskId = gate.target.slice('task:'.length);
      const live = deps.orchestrator.liveRunIdForTask(taskId);
      if (live !== null && deps.orchestrator.runAcceptsMessages(live)) return;
      const denial = wakeDenial(taskId);
      if (denial !== null) {
        await noticeWakeSender(
          original,
          `Not woken: task ${taskId} ${denial}.`
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

  // A deciding human approved or denied an agent's registration. A replay is a
  // no-op, and only an approval records who approved it.
  gates.register('agent-registration', (question, answer) =>
    settle(() => {
      const gate = gateOf(question);
      if (gate === null || gate.type !== 'agent-registration') return;
      const agent = store.getAgent(gate.agent);
      if (agent === null) return;
      if (answer.choice === 'approve') {
        if (agent.status === 'approved') return;
        store.putAgent({
          ...agent,
          status: 'approved',
          approvedBy: answer.from,
        });
      } else {
        if (agent.status === 'revoked') return;
        store.putAgent({ ...agent, status: 'revoked', approvedBy: null });
      }
    })
  );

  // Refuses a parked call nobody can be asked about, a tick later: the
  // executor registers its resolver right after raising.
  const denyUngated = (request: ApprovalGateRequest, why: string) => {
    void Promise.resolve().then(() => {
      try {
        deps.orchestrator.approve(request.runId, request.requestId, {
          allow: false,
          reason: `Dispatch could not ask a human: ${why}`,
        });
      } catch (err) {
        console.error('messaging: could not release an ungated tool call', err);
      }
    });
  };

  // Tool approvals: the orchestrator parks the run; this asks the owner.
  deps.orchestrator.setApprovalGate({
    raise: (request) => {
      raiseToolApproval(engine, deps.ownerRef, request)
        .then((gate) => {
          // The run ended, or its call was settled, while the gate was being written.
          const pending = deps.orchestrator.pendingApprovalFor(request.runId);
          if (!deps.orchestrator.isRunLive(request.runId))
            closeGate(engine, gate.id, 'the run ended');
          else if (pending?.requestId !== request.requestId)
            closeGate(engine, gate.id, 'the call was already settled');
        })
        .catch((err: unknown) => {
          console.error('messaging: could not raise a tool-approval gate', err);
          denyUngated(
            request,
            err instanceof Error ? err.message : String(err)
          );
        });
    },
    settle: (runId, requestId, reason) => {
      const gate = openToolApprovalGate(engine, runId, requestId);
      if (gate !== null) closeGate(engine, gate.id, reason);
    },
  });

  // A human (or policy) answered a parked tool call; a stale run is logged and
  // the answerer told, not retried.
  gates.register('tool-approval', async (question, answer) => {
    const gate = gateOf(question);
    if (
      gate === null ||
      gate.type !== 'tool-approval' ||
      gate.runId === undefined
    )
      return;
    try {
      deps.orchestrator.approve(
        gate.runId,
        gate.requestId,
        toolApprovalDecision(answer)
      );
    } catch (err) {
      if (!isStaleApproval(err)) throw err;
      const why = err instanceof Error ? err.message : String(err);
      console.error(
        `messaging: approval for run ${gate.runId} arrived after it moved on: ${why}`
      );
      await noticeAnswerer(
        question,
        answer,
        `Not applied: run ${gate.runId} was no longer waiting on this approval (${why}).`
      );
    }
  });

  const scopeDeps = {
    rootDir: deps.rootDir,
    runOf: (id: string) =>
      deps.orchestrator.list().find((r) => r.id === id) ?? null,
    taskOf: (id: string) => deps.store.get(id),
  };
  const scopeEffects = {
    ...scopeDeps,
    owner: deps.ownerRef,
    ledgerStore: deps.ledgerStore ?? new LedgerStore(deps.rootDir),
    appendPolicyActivity: deps.appendPolicyActivity ?? (() => {}),
    broadcastLedgerChanged: () =>
      deps.events.broadcast({ type: 'ledger.changed' }),
  };
  // A grant is recorded; one whose run or task is gone is logged and the answerer told.
  gates.register('scope', async (question, answer) => {
    if (applyScopeAnswer(scopeEffects, question, answer) !== 'unresolved')
      return;
    const runId = question.from.slice('run:'.length);
    console.error(
      `messaging: scope grant for run ${runId} has no run or task to record against`
    );
    await noticeAnswerer(
      question,
      answer,
      `Not recorded: run ${runId} or its task no longer exists, so this grant has no ledger entry.`
    );
  });
  const uninstallScopePolicy = installScopePolicy(engine, scopeDeps);
  const expiry = setInterval(() => {
    expireScopeGates(engine, Date.now()).catch((err: unknown) =>
      console.error('messaging: scope expiry failed', err)
    );
  }, SCOPE_EXPIRY_SWEEP_MS);
  expiry.unref();

  // A run's end closes the gates nobody can act on any more.
  const unsubscribeRunTerminal = deps.orchestrator.onRunTerminal((meta) => {
    closeRunGates(
      engine,
      { id: meta.id, hasTask: runKind(meta) === 'execute' },
      'the run ended'
    );
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

  // A run's message to a human lands on the run's transcript.
  const unsubscribeOutgoing = engine.subscribe((e) => {
    if (e.type !== 'message' || !e.message.from.startsWith('run:')) return;
    if (!e.message.to.some((addr) => addr.startsWith('human:'))) return;
    deps.orchestrator.logOutgoing(
      e.message.from.slice('run:'.length),
      e.message
    );
  });

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
    recover: () => engine.recover(),
    close() {
      clearInterval(expiry);
      uninstallScopePolicy();
      unsubscribeRunStarted();
      unsubscribeRunTerminal();
      // A call that parks from here on is refused rather than left with no gate.
      deps.orchestrator.setApprovalGate({
        raise: (request) => denyUngated(request, 'messaging is closed'),
        settle: () => {},
      });
      unsubscribeOutgoing();
      unsubscribeEngine();
      db.close();
    },
  };
}
