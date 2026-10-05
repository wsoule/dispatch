import {
  DeliveryEngine,
  openMessagesDb,
  SqliteMessageStore,
} from '@dispatch/protocol';
import type {
  Address,
  FederationHooks,
  Message,
  MessagingHost,
  PolicyRuling,
  WakeResult,
} from '@dispatch/protocol';
import { fingerprint, sealPayload } from '@dispatch/protocol/federation';
import type { StatePayload } from '@dispatch/protocol/federation';
import { join } from 'node:path';

import { AgentSync } from '../../../../src/team/federation/agents.js';
import { ChannelSync } from '../../../../src/team/federation/channels.js';
import { Homes } from '../../../../src/team/federation/homes.js';
import { DaemonFederationHooks } from '../../../../src/team/federation/hooks.js';
import { Inbound } from '../../../../src/team/federation/inbound.js';
import type { StateHooks } from '../../../../src/team/federation/inbound.js';
import { MailOut } from '../../../../src/team/federation/mail.js';
import { Presence } from '../../../../src/team/federation/presence.js';
import { trackWaiting } from '../../../../src/team/federation/presence.js';
import type { RunInfo } from '../../../../src/team/federation/presence.js';
import { HeldMail, StateOut } from '../../../../src/team/federation/state.js';
import { MemoryRemote } from './memoryTransport.js';
import { MemoryV1, serviceReplica } from './serviceReplica.js';
import type { ServiceReplica } from './serviceReplica.js';

// A MessagingHost over plain maps: live runs by task, and every push, notify
// and wake recorded.
class TestMessagingHost implements MessagingHost {
  readonly liveRuns = new Map<string, string>(); // taskId -> runId
  readonly runTasks = new Map<string, string>(); // runId -> taskId
  readonly auxRuns = new Set<string>(); // live runs with no task
  readonly pushed: { runId: string; messageId: string }[] = [];
  readonly notified: { runId: string; messageId: string }[] = [];
  readonly woken: { target: Address; messageId: string }[] = [];
  readonly humans: { actor: Address; messageId: string }[] = [];
  ruling: PolicyRuling = 'allow';
  federation?: FederationHooks;

  constructor(
    private readonly human: Address,
    private readonly clock: { now: Date }
  ) {}

  startRun(taskId: string | null, runId: string): void {
    if (taskId === null) this.auxRuns.add(runId);
    else {
      this.liveRuns.set(taskId, runId);
      this.runTasks.set(runId, taskId);
    }
  }
  endRun(taskId: string): void {
    this.liveRuns.delete(taskId);
  }
  liveRunFor(taskId: string): string | null {
    return this.liveRuns.get(taskId) ?? null;
  }
  isLiveRun(runId: string): boolean {
    return (
      this.auxRuns.has(runId) || [...this.liveRuns.values()].includes(runId)
    );
  }
  taskOfRun(runId: string): string | null {
    return this.runTasks.get(runId) ?? null;
  }
  push(runId: string, _rendered: string, message: Message): Promise<void> {
    this.pushed.push({ runId, messageId: message.id });
    return Promise.resolve();
  }
  notify(runId: string, _digest: string, message: Message): Promise<void> {
    this.notified.push({ runId, messageId: message.id });
    return Promise.resolve();
  }
  notifyHuman(actor: Address, message: Message): void {
    this.humans.push({ actor, messageId: message.id });
  }
  wake(target: Address, message: Message): Promise<WakeResult> {
    this.woken.push({ target, messageId: message.id });
    return Promise.resolve({ ok: false, reason: 'no runs in this test' });
  }
  decide(): PolicyRuling {
    return this.ruling;
  }
  owner(): Address {
    return this.human;
  }
  implicitMembers(): Address[] {
    return [];
  }
  onAnswered(): Promise<void> {
    return Promise.resolve();
  }
  now(): Date {
    return this.clock.now;
  }
}

export interface MessagingReplica extends ServiceReplica {
  remote: MemoryRemote;
  messages: SqliteMessageStore;
  engine: DeliveryEngine;
  host: TestMessagingHost;
  homes: Homes;
  hooks: DaemonFederationHooks;
  presence: Presence;
  agents: AgentSync;
  channels: ChannelSync;
  mailOut: MailOut;
  inbound: Inbound;
  /** What the StateHooks were told, until Task 16 supplies them. */
  stateCalls: {
    refused: [string, string, string][];
    received: [string, string][];
  };
  stateOut: StateOut;
  heldMail: HeldMail;
  /** An execute run starts here as the daemon starts one: presence first,
   *  then remote task mail claimed and held mail delivered. */
  startExecute(taskId: string, runId: string): Promise<void>;
  /** The engine's next `n` receives throw a store error. */
  failReceives(n: number): void;
  /** A run starts here: live on the host, and its presence queued. */
  startRun(meta: RunInfo): void;
  /** `other`'s pass, then this replica's. */
  settleWith(other: MessagingReplica): Promise<void>;
}

export interface TeamOpts {
  /** Handles admitted as observers. */
  observers?: readonly string[];
  /** Handles admitted as admins. */
  admins?: readonly string[];
  remoteMailPerReplicaPerHour?: number;
  maxWaitingPerPublisher?: number;
  stateOpsPerHour?: number;
  maxParkedPerPublisher?: number;
  restagePerPublisher?: number;
  mailSeenKept?: number;
}

// One daemon's board sync plus its messages.db, engine and the federation
// pieces messaging needs, wired as index.ts wires them.
export function messagingReplica(
  handle: string,
  remote: MemoryRemote = new MemoryRemote(),
  v1: MemoryV1 = new MemoryV1(),
  opts: TeamOpts = {}
): MessagingReplica {
  const base = serviceReplica(handle, remote, v1, {
    ...(opts.maxParkedPerPublisher === undefined
      ? {}
      : { maxParkedPerPublisher: opts.maxParkedPerPublisher }),
    ...(opts.restagePerPublisher === undefined
      ? {}
      : { restagePerPublisher: opts.restagePerPublisher }),
  });
  const db = openMessagesDb(join(base.dir, 'messages.db'));
  const messages = new SqliteMessageStore(db);
  const host = new TestMessagingHost(`human:${handle}`, base.clock);
  const homes = new Homes({
    fed: base.fed,
    roster: base.roster,
    tasks: base.store,
  });
  const heldRef: { current: HeldMail | null } = { current: null };
  const knowsRun = (run: string) =>
    host.runTasks.has(run) || host.auxRuns.has(run);
  const presence = new Presence({
    fed: base.fed,
    roster: base.roster,
    build: '0.40.0',
    device: `${handle}-laptop`,
    knowsRun,
    isLive: (run) => host.isLiveRun(run),
    now: () => base.clock.now,
    onLiveRun: (task, replica) => {
      heldRef.current?.onLiveRun(task, replica);
    },
  });
  base.service.register(presence);
  base.service.addCollector(presence);
  const hooks = new DaemonFederationHooks({
    ledger: base.ledger,
    fed: base.fed,
    roster: base.roster,
    homes,
    messages: () => messages,
    knowsRun,
  });
  host.federation = hooks;
  const engine = new DeliveryEngine({ store: messages, host });
  trackWaiting(engine, messages, presence);
  const agents = new AgentSync({
    fed: base.fed,
    roster: base.roster,
    messages,
  });
  const channels = new ChannelSync({
    fed: base.fed,
    roster: base.roster,
    messages,
    engine,
    implicit: () => [],
  });
  for (const sync of [agents, channels]) {
    base.service.register(sync);
    base.service.addCollector(sync);
  }
  const mailOut = new MailOut({
    fed: base.fed,
    roster: base.roster,
    homes,
    messages,
  });
  base.service.addCollector(mailOut);
  const stateCalls: MessagingReplica['stateCalls'] = {
    refused: [],
    received: [],
  };
  const stateOut = new StateOut({
    fed: base.fed,
    roster: base.roster,
    homes,
    engine,
    messages,
    now: () => base.clock.now,
  });
  base.service.addCollector(stateOut);
  const heldMail = new HeldMail({
    fed: base.fed,
    engine,
    messages,
    mailOut,
    homes,
  });
  heldRef.current = heldMail;
  base.service.addCollector(heldMail);
  const state: StateHooks = {
    refused: (id, reason, origin) => {
      stateCalls.refused.push([id, reason, origin]);
      stateOut.refused(id, reason, origin);
    },
    received: (message, origin, deliveries) => {
      stateCalls.received.push([message.id, origin]);
      stateOut.received(message, origin, deliveries);
    },
  };
  let failing = 0;
  const receive = engine.receive.bind(engine);
  engine.receive = (message, origin) => {
    if (failing > 0) {
      failing -= 1;
      return Promise.reject(new Error('disk I/O error'));
    }
    return receive(message, origin);
  };
  const inbound = new Inbound({
    fed: base.fed,
    roster: base.roster,
    engine,
    perReplicaPerHour: opts.remoteMailPerReplicaPerHour ?? 600,
    ...(opts.stateOpsPerHour === undefined
      ? {}
      : { stateOpsPerHour: opts.stateOpsPerHour }),
    ...(opts.maxWaitingPerPublisher === undefined
      ? {}
      : { maxWaiting: opts.maxWaitingPerPublisher }),
    ...(opts.mailSeenKept === undefined
      ? {}
      : { mailSeenKept: opts.mailSeenKept }),
    homes,
    now: () => base.clock.now,
    state,
  });
  base.service.register(inbound);
  base.service.register(inbound.stateHandler(stateOut));
  base.service.setInbox(inbound);
  const replica: MessagingReplica = {
    ...base,
    remote,
    messages,
    engine,
    host,
    homes,
    hooks,
    presence,
    agents,
    channels,
    mailOut,
    inbound,
    stateOut,
    heldMail,
    stateCalls,
    startExecute: async (taskId, runId) => {
      host.startRun(taskId, runId);
      presence.runStarted({ id: runId, taskId, kind: 'execute' });
      engine.claimRemote(taskId);
      await engine.deliverHeld(runId, taskId);
    },
    failReceives: (n) => {
      failing = n;
    },
    startRun: (meta) => {
      host.startRun(meta.taskId, meta.id);
      presence.runStarted(meta);
    },
    settleWith: async (other) => {
      await other.service.syncNow();
      await base.service.syncNow();
    },
    close: () => {
      db.close();
      base.close();
    },
  };
  return replica;
}

const fp = (r: MessagingReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);

// Runs a pass on each replica in turn, three times.
async function settleAll(rs: readonly MessagingReplica[]): Promise<void> {
  for (let round = 0; round < 3; round++)
    for (const r of rs) await r.service.syncNow();
}

/** A team on one remote: founded by the first handle, the rest admitted. */
export function foundedTeam(...handles: string[]): Promise<MessagingReplica[]> {
  return foundedTeamWith({}, ...handles);
}

export async function foundedTeamWith(
  opts: TeamOpts,
  ...handles: string[]
): Promise<MessagingReplica[]> {
  const remote = new MemoryRemote();
  const v1 = new MemoryV1();
  const rs = handles.map((h) => messagingReplica(h, remote, v1, opts));
  const [founder, ...rest] = rs;
  if (founder === undefined) return rs;
  founder.roster.found('acme');
  await settleAll(rs);
  rest.forEach((r, i) => {
    founder.roster.admit(r.fed.replica, {
      fingerprint: fp(r),
      observer: (opts.observers ?? []).includes(handles[i + 1] ?? ''),
      ...((opts.admins ?? []).includes(handles[i + 1] ?? '')
        ? { role: 'admin' as const }
        : {}),
    });
  });
  await settleAll(rs);
  return rs;
}

/** A state op sealed to `to`, straight through `replica`'s log: a replica
 *  publishing entries it may have no right to. */
export function sealStateForTest(
  replica: MessagingReplica,
  entries: StatePayload['entries'],
  to: readonly MessagingReplica[]
): void {
  replica.fed.append({
    type: 'state',
    seal: (stamp) => {
      const { to: sealedTo, sealed } = sealPayload({
        replica: replica.fed.replica,
        seq: stamp.seq,
        type: 'state',
        payload: { entries } as never,
        recipients: new Map(to.map((r) => [r.fed.replica, r.fed.keys.sealPub])),
      });
      return { to: sealedTo, sealed };
    },
  });
}
