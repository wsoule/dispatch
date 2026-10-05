import type {
  CallRecord,
  Given,
  Json,
  JsonObject,
} from '@dispatch/protocol-spec';

import type { Address } from '../address.js';
import type { Sender } from '../engine.js';
import { gateOf } from '../envelope.js';
import type { Message } from '../envelope.js';
import type {
  ExternalAdmission,
  ExternalKind,
  ExternalTarget,
  MessagingHost,
  PolicyRequest,
  PolicyRuling,
  WakeResult,
} from '../host.js';
import { UnsupportedOp } from './errors.js';
import { asObject, bare, malformed, text, texts } from './fields.js';

const DEFAULT_CLOCK = '2026-09-23T10:00:00.000Z';
const RULINGS: readonly PolicyRuling[] = ['allow', 'ask', 'deny'];

export interface World {
  clockMs: number;
  // Work item id -> its live session's bare run id.
  liveRuns: Map<string, string>;
  // Bare run id -> the work item it serves, live or ended.
  runTasks: Map<string, string>;
  auxRuns: Set<string>;
  implicit: Map<string, Address[]>;
  owner: Address;
  rulings: Map<Address, PolicyRuling>;
  wakeResults: Map<Address, WakeResult>;
  failPush: Set<string>;
  failOnAnswered: boolean;
  external: Map<Address, 'client' | 'peer'>;
}

// The scripted world a vector's `given` describes, mutable by `world` steps.
export function worldFrom(given: Given): World {
  const world: World = {
    clockMs: Date.parse(given.clock ?? DEFAULT_CLOCK),
    liveRuns: new Map(),
    runTasks: new Map(),
    auxRuns: new Set((given.auxSessions ?? []).map(bare)),
    implicit: new Map(Object.entries(given.implicit ?? {})),
    owner: given.owner ?? 'human:owner',
    rulings: new Map(Object.entries(given.rulings ?? {})),
    wakeResults: new Map(
      Object.entries(given.wakeResults ?? {}).map(
        ([target, r]): [Address, WakeResult] => [
          target,
          r.ok ? { ok: true, runId: bare(r.session) } : r,
        ]
      )
    ),
    failPush: new Set((given.failPush ?? []).map(bare)),
    failOnAnswered: given.failOnAnswered === true,
    external: new Map(Object.entries(given.external ?? {})),
  };
  for (const item of given.workItems ?? []) {
    for (const s of item.sessions ?? []) world.runTasks.set(bare(s), item.id);
    if (item.liveSession !== undefined) {
      world.liveRuns.set(item.id, bare(item.liveSession));
      world.runTasks.set(bare(item.liveSession), item.id);
    }
  }
  return world;
}

function rulingOf(value: Json | undefined, where: string): PolicyRuling {
  const found = RULINGS.find((r) => r === value);
  return found ?? malformed(where, `expected one of ${RULINGS.join(', ')}`);
}

function wakeResultOf(value: Json | undefined, where: string): WakeResult {
  const r = asObject(value, where);
  if (r['ok'] === true)
    return { ok: true, runId: bare(text(r, 'session', where)) };
  if (r['ok'] === false) return { ok: false, reason: text(r, 'reason', where) };
  return malformed(`${where}.ok`, 'expected a boolean');
}

// Applies one `world` step, which names exactly one change; a change this
// adapter does not know is unsupported.
export function applyWorld(world: World, change: JsonObject): void {
  const keys = Object.keys(change);
  const key = keys[0];
  if (keys.length !== 1 || key === undefined)
    throw new UnsupportedOp(
      `a world change names exactly one key, not ${keys.length}`
    );
  const value = change[key];
  const where = `world.${key}`;
  switch (key) {
    case 'startSession': {
      const s = asObject(value, where);
      const item = text(s, 'workItem', where);
      const run = bare(text(s, 'session', where));
      world.liveRuns.set(item, run);
      world.runTasks.set(run, item);
      return;
    }
    case 'endSession':
      world.liveRuns.delete(text(asObject(value, where), 'workItem', where));
      return;
    case 'ruling': {
      const r = asObject(value, where);
      world.rulings.set(
        text(r, 'target', where),
        rulingOf(r['ruling'], `${where}.ruling`)
      );
      return;
    }
    case 'wakeResult': {
      const r = asObject(value, where);
      world.wakeResults.set(
        text(r, 'target', where),
        wakeResultOf(r['result'], `${where}.result`)
      );
      return;
    }
    case 'failPush':
      world.failPush = new Set(texts(value, where).map(bare));
      return;
    case 'failOnAnswered':
      if (typeof value !== 'boolean') malformed(where, 'expected a boolean');
      world.failOnAnswered = value;
      return;
    case 'advanceMs':
      if (typeof value !== 'number' || !Number.isFinite(value))
        malformed(where, 'expected a number');
      world.clockMs += value;
      return;
    default:
      throw new UnsupportedOp(`world change ${key} is not implemented`);
  }
}

// A MessagingHost scripted from `given` that records hook calls in the kit's
// vocabulary; Core's `wake` gate effect is implemented here.
export class ConformanceHost implements MessagingHost {
  readonly calls: CallRecord[] = [];
  constructor(readonly world: World) {}

  liveRunFor(taskId: string): string | null {
    return this.world.liveRuns.get(taskId) ?? null;
  }
  isLiveRun(runId: string): boolean {
    return (
      this.world.auxRuns.has(runId) ||
      [...this.world.liveRuns.values()].includes(runId)
    );
  }
  taskOfRun(runId: string): string | null {
    return this.world.runTasks.get(runId) ?? null;
  }
  push(runId: string, _rendered: string, message: Message): Promise<void> {
    this.calls.push({
      hook: 'push',
      session: `run:${runId}`,
      message: message.id,
    });
    return this.settle(runId, 'push failed');
  }
  notify(runId: string, _digest: string, message: Message): Promise<void> {
    this.calls.push({
      hook: 'notify',
      session: `run:${runId}`,
      message: message.id,
    });
    return this.settle(runId, 'notify failed');
  }
  notifyHuman(actor: Address, message: Message): void {
    this.calls.push({ hook: 'notifyHuman', actor, message: message.id });
  }
  wake(target: Address, message: Message): Promise<WakeResult> {
    this.calls.push({ hook: 'wake', target, message: message.id });
    return Promise.resolve(
      this.world.wakeResults.get(target) ?? { ok: true, runId: 'r-00000f' }
    );
  }
  decide(request: PolicyRequest): PolicyRuling {
    this.calls.push({
      hook: 'decide',
      target: request.target,
      message: request.message.id,
    });
    return this.world.rulings.get(request.target) ?? 'deny';
  }
  owner(): Address {
    return this.world.owner;
  }
  implicitMembers(channel: string): Address[] {
    return this.world.implicit.get(channel) ?? [];
  }
  onAnswered(question: Message, answer: Message): Promise<void> {
    this.calls.push({
      hook: 'onAnswered',
      question: question.id,
      answer: answer.id,
    });
    if (this.world.failOnAnswered)
      return Promise.reject(new Error('effect failed'));
    // Core's wake effect: an approved wake gate wakes its target for the
    // message the gate names.
    const gate = gateOf(question);
    if (gate?.type === 'wake' && answer.choice === 'approve')
      this.calls.push({
        hook: 'wake',
        target: gate.target,
        message: gate.message,
      });
    return Promise.resolve();
  }
  now(): Date {
    return new Date(this.world.clockMs);
  }
  // An address `given.external` names is outside the host, as a client or a peer.
  external(address: Address): ExternalKind | null {
    return this.world.external.get(address) ?? null;
  }
  // Every external recipient is admitted; the call is recorded for `calls`.
  admitExternal(
    target: ExternalTarget,
    _sender: Sender,
    _replyTarget: Message | null,
    message: Message
  ): ExternalAdmission {
    this.calls.push({
      hook: 'admitExternal',
      recipient: target.recipient,
      message: message.id,
    });
    return 'deliver';
  }

  // A push or notify to a session the vector lists in `failPush` rejects.
  private settle(runId: string, why: string): Promise<void> {
    return this.world.failPush.has(runId)
      ? Promise.reject(new Error(why))
      : Promise.resolve();
  }
}
