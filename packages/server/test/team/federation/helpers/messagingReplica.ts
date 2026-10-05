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

import type { ApiContext } from '../../../../src/api.js';
import { createTeamMemoryPort } from '../../../../src/memory/teamPort.js';
import { AgentSync } from '../../../../src/team/federation/agents.js';
import { BUILD_CAPS } from '../../../../src/team/federation/caps.js';
import { ChannelSync } from '../../../../src/team/federation/channels.js';
import { Homes } from '../../../../src/team/federation/homes.js';
import { DaemonFederationHooks } from '../../../../src/team/federation/hooks.js';
import { Inbound } from '../../../../src/team/federation/inbound.js';
import type { StateHooks } from '../../../../src/team/federation/inbound.js';
import { MailOut } from '../../../../src/team/federation/mail.js';
import { MemorySync } from '../../../../src/team/federation/memory.js';
import { DocSync } from '../../../../src/team/federation/ops.js';
import type { DocsPort } from '../../../../src/team/federation/ops.js';
import { Presence } from '../../../../src/team/federation/presence.js';
import { trackWaiting } from '../../../../src/team/federation/presence.js';
import type { RunInfo } from '../../../../src/team/federation/presence.js';
import { RelayFederationTransport } from '../../../../src/team/federation/relay.js';
import { handleFederationRoute } from '../../../../src/team/federation/routes.js';
import { HeldMail, StateOut } from '../../../../src/team/federation/state.js';
import { testEngine } from '../../../memory/fixtures.js';
import type { TestMemoryHost } from '../../../memory/fixtures.js';
import { MemoryRemote } from './memoryTransport.js';
import { MemoryV1, serviceReplica } from './serviceReplica.js';
import type { ServiceReplica } from './serviceReplica.js';

// What the docs side saw and says back; implements the whole DocsPort
// (cross-plan edit XD1). Bodies carry a test number `n`.
export class RecordingDocsPort implements DocsPort {
  seen: {
    n: number;
    replica: string;
    seq: number;
    forBob: boolean;
    forAda: boolean;
  }[] = [];
  answer: 'applied' | 'parked' | 'dropped' = 'applied';
  pending: { doc: string; kind: 'put'; n: number }[] = [];
  publishedBatches: number[][] = [];
  publishedClocks: string[][] = [];
  /** Leaves what was published in `pending` minus the batch, as a real port does. */
  keepUnpublished = false;
  dropped: {
    replica: string;
    seq: number;
    reason: 'overflow' | 'revoked';
    n: number;
  }[] = [];
  passes = 0;

  applyDocOp(
    op: Parameters<DocsPort['applyDocOp']>[0],
    ctx: Parameters<DocsPort['applyDocOp']>[1]
  ): 'applied' | 'parked' | 'dropped' {
    this.seen.push({
      n: Number(op.body['n']),
      replica: op.replica,
      seq: op.seq,
      forBob: ctx.speaksFor(op.replica, 'human:bob'),
      forAda: ctx.speaksFor(op.replica, 'human:ada'),
    });
    return this.answer;
  }
  pendingDocOps(): { doc: string; kind: 'put'; n: number }[] {
    return this.pending;
  }
  published(
    bodies: readonly { [key: string]: unknown }[],
    clocks: readonly string[] = []
  ): void {
    this.publishedBatches.push(bodies.map((b) => Number(b['n'])));
    this.publishedClocks.push([...clocks]);
    this.pending = this.keepUnpublished
      ? this.pending.slice(bodies.length)
      : [];
  }
  parkedDropped(
    meta: { replica: string; seq: number; reason: 'overflow' | 'revoked' },
    body: unknown
  ): void {
    this.dropped.push({
      ...meta,
      n: Number((body as { n?: unknown } | null)?.n),
    });
  }
  passComplete(): void {
    this.passes += 1;
  }
}

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
  /** This build now speaks `caps`, as after an upgrade (FW-R39). */
  setCaps(caps: readonly string[]): void;
  /** POSTs to an /api/team route as this machine's operator. */
  teamRoute(
    path: string,
    body: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }>;
  /** A relay transport for this replica; `signFor` signs for another URL. */
  relayTransport(
    url: string,
    opts?: {
      signFor?: string;
      wake?: () => void;
      teamId?: string;
      opsPerFrame?: number;
    }
  ): RelayFederationTransport;
  /** A recording docs port and its DocSync, when the team asked for docs. */
  docs?: { port: RecordingDocsPort; sync: DocSync };
  /** Team memory over an in-memory memory.db, when the team asked for it. */
  memory?: {
    engine: ReturnType<typeof testEngine>['engine'];
    host: TestMemoryHost;
    shared: ReturnType<typeof testEngine>['shared'];
    sync: MemorySync;
  };
}

export interface TeamOpts {
  /** Handles admitted as observers. */
  observers?: readonly string[];
  /** Handles admitted as admins. */
  admins?: readonly string[];
  remoteMailPerReplicaPerHour?: number;
  maxWaitingPerPublisher?: number;
  stateOpsPerHour?: number;
  /** Each replica gets a memory engine and a registered MemorySync. */
  withMemory?: boolean;
  /** How many of each replica's op hashes fed_seen_ops keeps. */
  seenOpsKept?: number;
  /** What a handle's build speaks (FW-R39), in place of BUILD_CAPS. */
  capsFor?: Record<string, readonly string[]>;
  /** A bare repo every replica syncs through over git instead of memory. */
  gitRemote?: string;
  /** Set by foundedTeamWith on the founder, which installs `license`. */
  installLicense?: boolean;
  /** Each replica gets a recording DocsPort and a registered DocSync. */
  docs?: boolean;
  /** A license: its key installed on the founder, its public key on all. */
  license?: { key: string; publicKey: string };
  /** Sync proposals one publisher may have open (FW-R37(3)). */
  memoryOpenProposals?: number;
  /** New team entries one publisher may start per hour (FW-R37(3)). */
  memoryNewPerHour?: number;
  /** Handles that save a team entry before the team is founded. */
  memoryFirst?: readonly string[];
  maxParkedPerPublisher?: number;
  restagePerPublisher?: number;
}

// One daemon's board sync plus its messages.db, engine and the federation
// pieces messaging needs, wired as index.ts wires them.
export function messagingReplica(
  handle: string,
  remote: MemoryRemote = new MemoryRemote(),
  v1: MemoryV1 = new MemoryV1(),
  opts: TeamOpts = {}
): MessagingReplica {
  const capsRef: { current: readonly string[] | null } = {
    current: opts.capsFor?.[handle] ?? null,
  };
  const caps = (): readonly string[] => capsRef.current ?? BUILD_CAPS;
  const base = serviceReplica(handle, remote, v1, {
    caps,
    ...(opts.gitRemote === undefined ? {} : { gitRemote: opts.gitRemote }),
    ...(opts.seenOpsKept === undefined
      ? {}
      : { seenOpsKept: opts.seenOpsKept }),
    ...(opts.license === undefined
      ? {}
      : {
          licensePublicKey: opts.license.publicKey,
          ...(opts.installLicense === true
            ? { licenseKey: opts.license.key }
            : {}),
        }),
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
    caps,
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
    homes,
    now: () => base.clock.now,
    state,
  });
  base.service.register(inbound);
  base.service.register(inbound.stateHandler(stateOut));
  base.service.setInbox(inbound);
  const relays: RelayFederationTransport[] = [];
  const relayTransport: MessagingReplica['relayTransport'] = (url, o = {}) => {
    const invite = base.fed.meta('pending_invite');
    const teamId =
      base.fed.meta('team_id') ??
      (invite === null
        ? ''
        : (JSON.parse(invite) as { teamId: string }).teamId);
    const t = new RelayFederationTransport({
      url,
      teamId: o.teamId ?? teamId,
      replica: base.fed.replica,
      signPriv: base.fed.keys.signPriv,
      keyOp: () => base.fed.ownLog()[0] ?? null,
      wake: o.wake ?? (() => {}),
      now: () => base.clock.now,
      ...(o.signFor === undefined ? {} : { signFor: o.signFor }),
      ...(o.opsPerFrame === undefined ? {} : { opsPerFrame: o.opsPerFrame }),
    });
    relays.push(t);
    return t;
  };
  let docs: MessagingReplica['docs'];
  if (opts.docs === true) {
    const port = new RecordingDocsPort();
    const sync = new DocSync({
      fed: base.fed,
      roster: base.roster,
      service: base.service,
      port,
    });
    base.service.register(sync);
    base.service.addCollector(sync);
    docs = { port, sync };
  }
  let memory: MessagingReplica['memory'];
  if (opts.withMemory === true) {
    const m = testEngine();
    m.host.clock = () => base.clock.now;
    const sync = new MemorySync({
      fed: base.fed,
      roster: base.roster,
      port: createTeamMemoryPort({
        engine: m.engine,
        shared: m.shared,
        host: m.host,
        ...(opts.memoryOpenProposals === undefined
          ? {}
          : { maxOpenPerPublisher: opts.memoryOpenProposals }),
      }),
      ...(opts.memoryNewPerHour === undefined
        ? {}
        : { newPerHour: opts.memoryNewPerHour }),
    });
    base.service.register(sync);
    base.service.addCollector(sync);
    memory = { engine: m.engine, host: m.host, shared: m.shared, sync };
  }
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
    relayTransport,
    setCaps: (next) => {
      capsRef.current = next;
    },
    teamRoute: async (path, body) => {
      const ctx = {
        caller: { tier: 'operator' },
        boardSync: base.service,
        federation: {
          roster: base.roster,
          fed: base.fed,
          now: () => base.clock.now,
          label: (r: string) => base.roster.label(r),
          passWaitMs: 5000,
          allowLoopbackRelay: true,
        },
      } as unknown as ApiContext;
      const res = await handleFederationRoute(
        new Request(`http://127.0.0.1${path}`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
        ctx,
        path.split('/').slice(2),
        'POST'
      );
      return {
        status: res.status,
        body: (await res.json()) as Record<string, unknown>,
      };
    },
    close: () => {
      for (const t of relays) t.close();
      db.close();
      memory?.shared.close();
      base.close();
    },
    ...(memory === undefined ? {} : { memory }),
    ...(docs === undefined ? {} : { docs }),
  };
  return replica;
}

const fp = (r: MessagingReplica) =>
  fingerprint(r.fed.keys.signPub, r.fed.keys.sealPub);

// Runs a pass on each replica in turn, three times.
export async function settleAll(
  rs: readonly MessagingReplica[]
): Promise<void> {
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
  const rs = handles.map((h, i) =>
    messagingReplica(h, remote, v1, { ...opts, installLicense: i === 0 })
  );
  for (const [i, r] of rs.entries())
    if ((opts.memoryFirst ?? []).includes(handles[i] ?? ''))
      await r.memory?.engine.save(
        { address: `human:${handles[i]}`, canDecide: true, kind: 'human' },
        {
          scope: 'team',
          kind: 'fact',
          title: 'from before the team',
          body: 'b',
        }
      );
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
