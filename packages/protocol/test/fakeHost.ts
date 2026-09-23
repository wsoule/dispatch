import type { Address } from '../src/address.js';
import type { Message } from '../src/envelope.js';
import type {
  MessagingHost,
  PolicyRequest,
  PolicyRuling,
  WakeResult,
} from '../src/host.js';

// A host whose world is plain maps; every hook call is recorded in `calls`.
export class FakeHost implements MessagingHost {
  liveRuns = new Map<string, string>(); // taskId -> runId
  runTasks = new Map<string, string>(); // runId -> taskId (live or dead)
  implicit = new Map<string, Address[]>();
  ruling: PolicyRuling = 'deny';
  wakeResult: WakeResult = { ok: true, runId: 'r-00000f' };
  failPushFor = new Set<string>();
  failOnAnswered = false;
  ownerAddress: Address = 'human:wyat';
  clock = new Date('2026-09-23T10:00:00.000Z');
  calls: { hook: string; args: unknown[] }[] = [];

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
    return [...this.liveRuns.values()].includes(runId);
  }
  taskOfRun(runId: string): string | null {
    return this.runTasks.get(runId) ?? null;
  }
  async push(runId: string, rendered: string): Promise<void> {
    this.calls.push({ hook: 'push', args: [runId, rendered] });
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
    return this.ruling;
  }
  owner(): Address {
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
}
