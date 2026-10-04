import type { MessagingConfig, TaskStorePort } from '@dispatch/core';
import { DEFAULT_MESSAGING, loadConfig } from '@dispatch/core';
import type { Message, MessageStore } from '@dispatch/protocol';
import {
  DeliveryEngine,
  gateOf,
  openMessagesDb,
  SqliteMessageStore,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';

import type { EventBus, SocketAudience } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import { LedgerStore } from '../ledger.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir } from '../orchestrator/paths.js';
import type {
  ApprovalDecision,
  ApprovalGateRequest,
} from '../orchestrator/types.js';
import {
  OrchestratorNotFoundError,
  runKind,
  TERMINAL_RUN_STATES,
} from '../orchestrator/types.js';
import { statusModelFor } from '../statuses.js';
import { tierAllows } from '../tiers.js';
import {
  answeredWithOwnerCredential,
  closeGate,
  closeRunGates,
  GateHandlers,
  openToolApprovalGate,
  SYSTEM_SENDER,
} from './gates.js';
import type { ExternalPolicy, WakeActor } from './host.js';
import { DaemonMessagingHost, settle, wakeRefusal } from './host.js';
import type { RunTokens } from './runTokens.js';
import { createRunTokens } from './runTokens.js';
import {
  applyScopeAnswer,
  installScopePolicy,
  SCOPE_EXPIRY_SWEEP_MS,
  sweepScopeGates,
} from './scopePolicy.js';
import {
  isStaleApproval,
  raiseToolApproval,
  toolApprovalDecision,
} from './toolApproval.js';

// Gate types dispatchd implements a handler for; a sub-project adds its type
// here with its handler (task-proposal's is the A2A bridge's).
const DISPATCH_GATE_TYPES = [
  'tool-approval',
  'scope',
  'wake',
  'agent-registration',
  'overseer-action',
  'memory',
  'task-proposal',
  'doc',
] as const;

// What overseer gate answers apply to: the OverseerManager, once it exists.
// A wake a live run blocked, kept with who caused it for the retry.
interface BlockedWake {
  message: Message;
  acting: WakeActor;
}

interface OverseerGateTarget {
  confirmAction(
    conversationId: string,
    actionId: string,
    approve: boolean,
    actor: string,
    ownerCredential: boolean
  ): Promise<unknown>;
  decideApproval(
    conversationId: string,
    requestId: string,
    decision: ApprovalDecision
  ): unknown;
  list(): { id: string }[];
}

export interface Messaging {
  engine: DeliveryEngine;
  store: SqliteMessageStore;
  runTokens: RunTokens;
  gates: GateHandlers;
  // Lets overseer-action and overseer tool-approval answers apply; until then
  // they are logged and the answerer told.
  bindOverseer(target: OverseerGateTarget): void;
  // Replays crash-interrupted deliveries and gate effects; must run after
  // orchestrator.reconcileOnBoot() (index.ts says why).
  recover(): Promise<{ retried: number; reverted: number; replayed: number }>;
  // Installs (or with null removes) the A2A bridge's say on external recipients.
  setExternalPolicy(policy: ExternalPolicy | null): void;
  close(): void;
}

// Who hears a message's events over /ws: deciding humans and participants
// (sender, `to` addresses, delivery recipients), never the shared agent token.
function messageAudience(
  store: MessageStore,
  message: Message
): (who: SocketAudience | undefined) => boolean {
  const participants = new Set<string>([message.from, ...message.to]);
  for (const d of store.deliveries({ messageId: message.id }))
    participants.add(d.recipient);
  return (who) => {
    if (who === undefined || who.agentToken) return false;
    if (
      who.tier !== null &&
      who.ref !== null &&
      who.ref.startsWith('human:') &&
      tierAllows(who.tier, 'decide')
    )
      return true;
    return who.ref !== null && participants.has(who.ref);
  };
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
  // How often the scope-gate sweep runs, and its clock; tests shorten both.
  scopeExpiry?: { sweepMs?: number; now?: () => number };
}): Messaging {
  const db = openMessagesDb(
    deps.dbPath ?? join(runsDir(deps.rootDir), 'messages.db')
  );
  const store = new SqliteMessageStore(db);

  const runTokens = createRunTokens(randomBytes(32));
  deps.orchestrator.setRunTokenMinter(runTokens.mint);

  // Whether any run of the task is still going, winding down included.
  const hasActiveRun = (taskId: string) =>
    deps.orchestrator
      .list()
      .some((r) => r.taskId === taskId && !TERMINAL_RUN_STATES.has(r.state));
  // Wake messages, by task, whose wake failed while the task still had a run
  // (one winding down, say); retried when a run of that task ends.
  const blockedWakes = new Map<string, BlockedWake[]>();

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
    onWakeFailed: (target, message, acting) => {
      const taskId = target.slice('task:'.length);
      if (!hasActiveRun(taskId)) return;
      const waiting = blockedWakes.get(taskId) ?? [];
      if (!waiting.some((w) => w.message.id === message.id))
        waiting.push({ message, acting });
      blockedWakes.set(taskId, waiting);
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
  const engine = new DeliveryEngine({
    store,
    host,
    limits: {
      ...limits,
      // M4: fresh agent-to-agent threads count against the breaker's number
      // too, and repeated wake asks for one target share a single gate.
      agentThreadsPerHour: limits.agentTurnsPerThreadPerHour,
      openWakeGatesPerTarget: 1,
    },
    gateTypes: DISPATCH_GATE_TYPES,
  });

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
      const state = wakeRefusal(task, statusModelFor(deps.rootDir));
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
    // The approver caused this wake, so the run acts for them.
    const result = await host.wake(gate.target, original, {
      actor: answer.from,
      ownerCredential: answeredWithOwnerCredential(),
    });
    if (!result.ok) {
      await noticeWakeSender(
        original,
        `Could not wake ${gate.target}: ${result.reason}. Your message is waiting for it.`
      );
    }
  });

  // Re-runs the wakes a run blocked, for messages still held on the task. One
  // wake, a human's first (it may continue the run), serves them all.
  const retryBlockedWakes = async (taskId: string): Promise<void> => {
    const target = `task:${taskId}`;
    const held = (blockedWakes.get(taskId) ?? []).filter(
      (w) =>
        store.deliveries({
          messageId: w.message.id,
          recipient: target,
          states: ['held'],
        }).length > 0
    );
    blockedWakes.delete(taskId);
    if (held.length === 0) return;
    const denial = wakeDenial(taskId);
    if (denial !== null) {
      for (const w of held)
        await noticeWakeSender(
          w.message,
          `Not woken: task ${taskId} ${denial}.`
        );
      return;
    }
    const first =
      held.find((w) => w.message.from.startsWith('human:')) ?? held[0];
    // Retried as whoever caused the first wake, on the credential they used.
    const result = await host.wake(target, first.message, first.acting);
    if (result.ok) return;
    if (hasActiveRun(taskId)) {
      // Kept beside, never over, wakes that blocked during the await.
      const waiting = blockedWakes.get(taskId) ?? [];
      const newer = waiting.filter(
        (w) => !held.some((h) => h.message.id === w.message.id)
      );
      blockedWakes.set(taskId, [...held, ...newer]);
      return;
    }
    for (const w of held)
      await noticeWakeSender(
        w.message,
        `Could not wake ${target}: ${result.reason}. Your message is waiting for it.`
      );
  };

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
          // The run ended, or this call was settled, while the gate was being written.
          if (!deps.orchestrator.isRunLive(request.runId))
            closeGate(engine, gate.id, 'the run ended');
          else if (
            deps.orchestrator.pendingApprovalFor(
              request.runId,
              request.requestId
            ) === undefined
          )
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

  let overseer: OverseerGateTarget | null = null;

  // Applies an answer to an overseer conversation: one gone with a restart is
  // logged and the answerer told; a replay of a settled one is a no-op.
  const applyToConversation = async (
    question: Message,
    answer: Message,
    conversation: string,
    apply: (target: OverseerGateTarget) => unknown
  ): Promise<void> => {
    const gone = async () => {
      console.error(
        `messaging: overseer conversation ${conversation} is gone; answer ${answer.id} not applied`
      );
      await noticeAnswerer(
        question,
        answer,
        `Not applied: overseer conversation ${conversation} is gone (the daemon restarted).`
      );
    };
    const target = overseer;
    if (target === null) return gone();
    try {
      await apply(target);
    } catch (err) {
      if (err instanceof OrchestratorNotFoundError) {
        if (!target.list().some((r) => r.id === conversation)) await gone();
        return;
      }
      // A failed apply re-raises its gate with the error, which is the notice.
      console.error(`messaging: overseer gate ${question.id} failed`, err);
    }
  };

  // A human confirmed or cancelled an action the overseer queued.
  gates.register('overseer-action', async (question, answer) => {
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'overseer-action') return;
    await applyToConversation(question, answer, gate.conversation, (target) =>
      target.confirmAction(
        gate.conversation,
        gate.actionId,
        answer.choice === 'confirm',
        answer.from,
        answeredWithOwnerCredential()
      )
    );
  });

  // A human (or policy) answered a parked tool call: a run's, or an overseer
  // conversation's. A stale run is logged and the answerer told, not retried.
  gates.register('tool-approval', async (question, answer) => {
    const gate = gateOf(question);
    if (gate === null || gate.type !== 'tool-approval') return;
    const { conversation, requestId } = gate;
    if (conversation !== undefined) {
      await applyToConversation(question, answer, conversation, (target) =>
        target.decideApproval(
          conversation,
          requestId,
          toolApprovalDecision(answer)
        )
      );
      return;
    }
    if (gate.runId === undefined) return;
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
  // Grants what policy covers before expiring, so a covered gate is never denied.
  const scopeSweep = setInterval(() => {
    void sweepScopeGates(
      engine,
      scopeDeps,
      () => deps.scopeExpiry?.now?.() ?? Date.now()
    );
  }, deps.scopeExpiry?.sweepMs ?? SCOPE_EXPIRY_SWEEP_MS);
  scopeSweep.unref();

  // A run's end closes the gates nobody can act on any more, and retries (a
  // tick later, after its other end-of-run hooks) the wakes it blocked.
  const unsubscribeRunTerminal = deps.orchestrator.onRunTerminal((meta) => {
    closeRunGates(
      engine,
      { id: meta.id, hasTask: runKind(meta) === 'execute' },
      'the run ended'
    );
    if (!blockedWakes.has(meta.taskId)) return;
    void Promise.resolve()
      .then(() => retryBlockedWakes(meta.taskId))
      .catch((err: unknown) =>
        console.error('messaging: wake retry failed', err)
      );
  });

  // Bridging must be live before recover() runs, so a notice recover()
  // produces while replaying (e.g. a wake failure) still reaches the bus.
  const unsubscribeEngine = engine.subscribe((e) => {
    if (e.type === 'message') {
      deps.events.broadcast(
        { type: 'message.new', message: e.message },
        messageAudience(store, e.message)
      );
      return;
    }
    // Channel membership reaches no socket; only the federation router reads it.
    if (e.type === 'membership') return;
    const messageId = e.type === 'remote' ? e.messageId : e.delivery.messageId;
    const deliveryId =
      e.type === 'remote' ? `remote:${e.recipient}` : e.delivery.id;
    const message = store.getMessage(messageId);
    deps.events.broadcast(
      { type: 'delivery.changed', deliveryId, messageId },
      message === null ? () => false : messageAudience(store, message)
    );
  });

  // A run's message to a human lands on the run's transcript.
  const unsubscribeOutgoing = engine.subscribe((e) => {
    if (e.type !== 'message' || !e.message.from.startsWith('run:')) return;
    if (!e.message.to.some((addr) => addr.startsWith('human:'))) return;
    deps.orchestrator.logOutgoing(
      e.message.from.slice('run:'.length),
      e.message,
      messageAudience(store, e.message)
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
    bindOverseer(target) {
      overseer = target;
    },
    recover: () => engine.recover(),
    setExternalPolicy(policy) {
      host.setExternalPolicy(policy);
    },
    close() {
      overseer = null;
      host.setExternalPolicy(null);
      clearInterval(scopeSweep);
      uninstallScopePolicy();
      unsubscribeRunStarted();
      unsubscribeRunTerminal();
      blockedWakes.clear();
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
