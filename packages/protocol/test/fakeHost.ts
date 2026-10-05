import type { Address } from '../src/address.js';
import type { Sender } from '../src/engine.js';
import type { Message } from '../src/envelope.js';
import type {
  ExternalAdmission,
  ExternalKind,
  ExternalTarget,
  FederationHooks,
  MessagingHost,
  Placement,
  PolicyRequest,
  PolicyRuling,
  WakeResult,
} from '../src/host.js';

// Federation hooks whose answers a test sets; hlc() ticks a counter.
export class FakeFederation implements FederationHooks {
  placements = new Map<Address, Placement>();
  remoteRuns = new Map<string, string>(); // runId -> taskId, as presence would say
  labels = new Map<string, string>();
  placed: { recipient: Address; replyTarget: string | null }[] = [];
  problems: { subject: string; message: string }[] = [];
  private ticks = 0;
  constructor(readonly replica = 'wyat-0000000a') {}
  problem(subject: string, message: string): void {
    this.problems.push({ subject, message });
  }
  hlc(): string {
    this.ticks += 1;
    return `1758880000000.${String(this.ticks).padStart(4, '0')}.${this.replica}`;
  }
  placement(
    target: { recipient: Address },
    _message: Message,
    replyTarget: Message | null
  ): Placement {
    this.placed.push({
      recipient: target.recipient,
      replyTarget: replyTarget?.id ?? null,
    });
    return this.placements.get(target.recipient) ?? { kind: 'local' };
  }
  remoteRunTask(runId: string): string | null {
    return this.remoteRuns.get(runId) ?? null;
  }
  label(replica: string): string {
    return this.labels.get(replica) ?? replica;
  }
}

// A host whose world is plain maps; every hook call is recorded in `calls`.
export class FakeHost implements MessagingHost {
  liveRuns = new Map<string, string>(); // taskId -> runId
  runTasks = new Map<string, string>(); // runId -> taskId (live or dead)
  auxRuns = new Set<string>(); // live runs that stand for no task, like a review
  implicit = new Map<string, Address[]>();
  ruling: PolicyRuling = 'deny';
  wakeResult: WakeResult = { ok: true, runId: 'r-00000f' };
  failPushFor = new Set<string>();
  failOnAnswered = false;
  quotaGroups = new Map<Address, Address[]>(); // sender -> who shares its quota
  // When set, push() waits on it — lets a test act while a push is in flight.
  pushBarrier: Promise<void> | null = null;
  ownerAddress: Address = 'human:wyat';
  clock = new Date('2026-09-23T10:00:00.000Z');
  calls: { hook: string; args: unknown[] }[] = [];
  requests: PolicyRequest[] = [];
  externals = new Map<Address, ExternalKind>();
  federation?: FederationHooks;
  admit:
    | ((
        target: ExternalTarget,
        sender: Sender,
        replyTarget: Message | null,
        message: Message
      ) => ExternalAdmission)
    | null = null;

  startRun(taskId: string, runId: string): void {
    this.liveRuns.set(taskId, runId);
    this.runTasks.set(runId, taskId);
  }
  endRun(taskId: string): void {
    this.liveRuns.delete(taskId);
  }
  hooks(name: string): unknown[][] {
    return this.calls.filter((c) => c.hook === name).map((c) => c.args);
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
  async push(runId: string, rendered: string): Promise<void> {
    this.calls.push({ hook: 'push', args: [runId, rendered] });
    if (this.pushBarrier !== null) await this.pushBarrier;
    if (this.failPushFor.has(runId)) throw new Error('run went away');
  }
  async notify(runId: string, digest: string): Promise<void> {
    this.calls.push({ hook: 'notify', args: [runId, digest] });
    if (this.failPushFor.has(runId)) throw new Error('run went away');
  }
  notifyHuman(actor: Address, message: Message): void {
    this.calls.push({ hook: 'notifyHuman', args: [actor, message.id] });
  }
  async wake(target: Address, message: Message): Promise<WakeResult> {
    this.calls.push({ hook: 'wake', args: [target, message.id] });
    return this.wakeResult;
  }
  decide(request: PolicyRequest): PolicyRuling {
    this.calls.push({ hook: 'decide', args: [request.type, request.target] });
    this.requests.push(request);
    return this.ruling;
  }
  quotaGroup(sender: Address): Address[] {
    return this.quotaGroups.get(sender) ?? [sender];
  }
  // Every owner() question, as [target, sender]: who the engine asked about.
  readonly ownerAsks: [Address, Address | null][] = [];
  owner(target: Address, sender?: Address): Address {
    this.ownerAsks.push([target, sender ?? null]);
    return this.ownerAddress;
  }
  implicitMembers(channel: string): Address[] {
    return this.implicit.get(channel) ?? [];
  }
  async onAnswered(question: Message, answer: Message): Promise<void> {
    this.calls.push({
      hook: 'onAnswered',
      args: [question.id, answer.choice ?? null],
    });
    if (this.failOnAnswered) throw new Error('onAnswered blew up');
  }
  now(): Date {
    return this.clock;
  }
  external(address: Address): ExternalKind | null {
    return this.externals.get(address) ?? null;
  }
  admitExternal(
    target: ExternalTarget,
    sender: Sender,
    replyTarget: Message | null,
    message: Message
  ): ExternalAdmission {
    this.calls.push({
      hook: 'admitExternal',
      args: [target.recipient, target.via, target.field],
    });
    return this.admit === null
      ? 'deliver'
      : this.admit(target, sender, replyTarget, message);
  }
}
