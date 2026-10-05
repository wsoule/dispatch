import { queryAll } from '@dispatch-foo/core';
import type { SqliteDatabase } from '@dispatch-foo/core';
import type {
  Hello,
  Json,
  JsonObject,
  Observation,
  ObservedDelivery,
  ObservedMessage,
  RunnableVector,
  Step,
  StepResult,
} from '@dispatch-foo/protocol-spec';

import { parseAddress, SYSTEM_ADDRESS } from '../address.js';
import { GATE_TYPES } from '../constants.js';
import { DeliveryEngine } from '../engine.js';
import type { Sender, SendOptions, SendResult } from '../engine.js';
import { validateSendInput } from '../envelope.js';
import type { Message, SendInput } from '../envelope.js';
import { MessagingError } from '../errors.js';
import { renderDigestLine, renderForAgent } from '../render.js';
import { openMessagesDb, SqliteMessageStore } from '../sqliteStore.js';
import { DELIVERY_STATES } from '../store.js';
import type { AgentStatus, Delivery, DeliveryState } from '../store.js';
import { createUlidFactory } from '../ulid.js';
import { PROTOCOL_VERSION } from '../version.js';
import { UnsupportedOp } from './errors.js';
import {
  asObject,
  bare,
  isObject,
  malformed,
  optionalText,
  text,
  texts,
} from './fields.js';
import { applyWorld, ConformanceHost, worldFrom } from './host.js';
import { seededBytes } from './seed.js';
import { seedStore } from './seedStore.js';

export { UnsupportedOp } from './errors.js';

export interface OpContext {
  engine: DeliveryEngine;
  store: SqliteMessageStore;
  host: ConformanceHost;
}
export type OpHandler = (
  step: Step,
  ctx: OpContext
) => Promise<Json | undefined> | Json | undefined;
export interface AdapterOptions {
  // Ops a binding adds (the a2a adapter's `a2a.*`), tried before the core ops.
  ops?: Record<string, OpHandler>;
  // Gate types the engine and `validate` implement; default every GATE_TYPES entry.
  gateTypes?: readonly string[];
}

// The kit's CREATING_OPS, copied: the built adapter imports nothing from the
// kit at runtime. `a2a.inbound` runs only through the a2a adapter's ops.
const CREATES: ReadonlySet<string> = new Set([
  'send',
  'reply',
  'close',
  'a2a.inbound',
]);
const ROLE = /\$(?:s|gate|notice)[0-9]+\b/g;
const ORIGINS: readonly NonNullable<SendOptions['origin']>[] = [
  'local',
  'received',
];
const AGENT_STATUSES: readonly AgentStatus[] = [
  'pending',
  'approved',
  'revoked',
];

// What the reference declares: both profiles, every gate type the engine
// raises and applies, and the forms renderForAgent and renderDigestLine write.
export const REFERENCE_HELLO: Hello = {
  dmp: 'hello',
  implementation: { name: 'dispatch-reference', version: PROTOCOL_VERSION },
  classes: ['envelope', 'host-core'],
  profiles: ['core', 'dispatch'],
  capabilities: ['implicit-members', 'muted-senders'],
  systemAddress: SYSTEM_ADDRESS,
  gateTypes: [...GATE_TYPES],
  render: {
    quotePrefix: '│ ',
    header: '^\\[message from ',
    hostLines: [
      '^\\(in reply to ',
      '^choices: ',
      '^choice: ',
      '^refs: ',
      '^The sender is waiting\\. ',
    ],
    digestLead: '^📬(?: #[^ ]+ ·)? [^ ]+ from [^ ]+(?: \\(external\\))?: ',
  },
};

// Replaces every string inside a JSON value, deep.
function mapStrings(value: Json, f: (s: string) => string): Json {
  if (typeof value === 'string') return f(value);
  if (Array.isArray(value)) return value.map((v) => mapStrings(v, f));
  if (isObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, mapStrings(v, f)])
    );
  return value;
}

// Keeps the role symbols a step may name: `$sN` for the message step N
// created, `$gateN`/`$noticeN` for the questions and notices the host raised
// on its own (from the system address, made by no step, seeded by no row).
class RoleBinder {
  private readonly bound = new Map<string, string>();
  private readonly created = new Set<string>();
  private readonly seeded: Set<string>;

  constructor(
    private readonly db: SqliteDatabase,
    vector: RunnableVector
  ) {
    this.seeded = new Set(
      (vector.given.store?.messages ?? []).flatMap((r) =>
        typeof r['id'] === 'string' ? [r['id']] : []
      )
    );
  }

  bindStep(step: number, id: string): void {
    this.bound.set(`$s${step}`, id);
    this.created.add(id);
  }

  resolve(step: Step): Step {
    this.bindRaised();
    return mapStrings(step, (s) =>
      s.replace(ROLE, (token) => this.bound.get(token) ?? token)
    ) as Step;
  }

  private bindRaised(): void {
    let gates = 0;
    let notices = 0;
    const rows = queryAll<{ id: string; kind: string }>(
      this.db,
      'SELECT id, kind FROM messages WHERE from_addr = ? ORDER BY rowid',
      [SYSTEM_ADDRESS]
    );
    for (const { id, kind } of rows) {
      if (this.created.has(id) || this.seeded.has(id)) continue;
      if (kind === 'question') this.bound.set(`$gate${++gates}`, id);
      else if (kind === 'notice') this.bound.set(`$notice${++notices}`, id);
    }
  }
}

function gateTypesOf(options: AdapterOptions): readonly string[] {
  return options.gateTypes ?? GATE_TYPES;
}

function senderOf(step: Step): Sender {
  const as = asObject(step['as'], 'as');
  const canDecide = as['canDecide'];
  if (typeof canDecide !== 'boolean')
    malformed('as.canDecide', 'expected a boolean');
  return { address: text(as, 'address', 'as'), canDecide };
}

// The step's input as the engine takes it. Only its outer shape is checked
// here: vectors send malformed envelopes on purpose, and the engine judges.
function inputOf(step: Step): SendInput {
  return asObject(step['input'], 'input') as unknown as SendInput;
}

// A send or validate step's `origin`: `received` for a message a binding
// delivered, `local` (the default) otherwise.
function originOf(step: Step): NonNullable<SendOptions['origin']> {
  const origin = step['origin'] ?? 'local';
  return (
    ORIGINS.find((o) => o === origin) ??
    malformed('origin', `expected one of ${ORIGINS.join(', ')}`)
  );
}

function sendResult(r: SendResult): Json {
  const result: JsonObject = {
    message: r.message.id,
    downgraded: r.downgraded,
  };
  if (r.replayed === true) result['replayed'] = true;
  return result;
}

// The `agentStatus` world change: a registered agent's status changes, which
// needs the store, so the adapter applies it rather than applyWorld.
function setAgentStatus(
  store: SqliteMessageStore,
  value: Json | undefined
): void {
  const where = 'world.agentStatus';
  const change = asObject(value, where);
  const address = text(change, 'address', where);
  const status =
    AGENT_STATUSES.find((s) => s === change['status']) ??
    malformed(
      `${where}.status`,
      `expected one of ${AGENT_STATUSES.join(', ')}`
    );
  const agent =
    store.getAgent(address) ?? malformed(`${where}.address`, 'no such agent');
  store.putAgent({ ...agent, status });
}

function statesOf(step: Step): DeliveryState[] | undefined {
  if (step['states'] === undefined) return undefined;
  return texts(step['states'], 'states').map(
    (s) =>
      DELIVERY_STATES.find((d) => d === s) ??
      malformed('states', `unknown delivery state ${s}`)
  );
}

// The id a creating step's result names, if any.
function createdId(result: Json | undefined): string | null {
  if (result === undefined || !isObject(result)) return null;
  const id = result['message'];
  return typeof id === 'string' ? id : null;
}

// Runs one step through the engine and returns its result in the kit's
// shapes; an op this adapter does not implement is unsupported.
async function runStep(
  step: Step,
  ctx: OpContext,
  options: AdapterOptions,
  record: (rendered: string) => void
): Promise<Json | undefined> {
  const custom = options.ops?.[step.op];
  if (custom !== undefined) return custom(step, ctx);
  const { engine, store, host } = ctx;
  switch (step.op) {
    case 'send':
      return sendResult(
        await engine.send(inputOf(step), senderOf(step), {
          origin: originOf(step),
        })
      );
    case 'reply':
      return sendResult(
        await engine.reply(
          text(step, 'message', 'reply'),
          inputOf(step),
          senderOf(step)
        )
      );
    case 'close':
      return {
        message: engine.close(
          text(step, 'question', 'close'),
          text(step, 'reason', 'close')
        ).id,
      };
    case 'markRead': {
      const recipient = text(step, 'recipient', 'markRead');
      const found = store
        .deliveries({ messageId: text(step, 'message', 'markRead') })
        .find((d) => d.recipient === recipient);
      if (found === undefined)
        throw new MessagingError(
          'not-found',
          `no delivery to ${recipient}`,
          'recipient'
        );
      return { state: engine.markRead(found.id).state };
    }
    case 'inbox':
      return {
        messages: engine
          .inbox(text(step, 'recipient', 'inbox'), statesOf(step))
          .map((x) => x.message.id),
      };
    case 'thread':
      return {
        messages: engine
          .thread(text(step, 'thread', 'thread'))
          .messages.map((m) => m.id),
      };
    case 'canRead':
      return {
        readable: engine.canRead(
          text(step, 'message', 'canRead'),
          senderOf(step)
        ),
      };
    case 'openBlocking':
      return { messages: engine.openBlocking().map((m) => m.id) };
    case 'join':
      engine.join(text(step, 'channel', 'join'), text(step, 'member', 'join'));
      return {};
    case 'leave':
      return {
        removed: engine.leave(
          text(step, 'channel', 'leave'),
          text(step, 'member', 'leave')
        ),
      };
    case 'deliverHeld': {
      const delivered = await engine.deliverHeld(
        bare(text(step, 'session', 'deliverHeld')),
        text(step, 'workItem', 'deliverHeld')
      );
      return {
        deliveries: delivered.map((d) => ({
          message: d.messageId,
          recipient: d.recipient,
          state: d.state,
        })),
      };
    }
    case 'recover': {
      const { retried, reverted, replayed, voided } = await engine.recover();
      return { retried, reverted, replayed, voided };
    }
    case 'parseAddress':
      return { ...parseAddress(text(step, 'input', 'parseAddress')) };
    case 'validate': {
      const as = senderOf(step);
      const target = optionalText(step, 'replyTarget', 'validate');
      validateSendInput(
        inputOf(step),
        as.address,
        as.canDecide,
        target === undefined ? null : store.getMessage(target),
        { gateTypes: new Set(gateTypesOf(options)), origin: originOf(step) }
      );
      return {};
    }
    case 'render': {
      const id = text(step, 'message', 'render');
      const message = store.getMessage(id);
      if (message === null)
        throw new MessagingError('not-found', `no message ${id}`, 'message');
      const external = step['external'] === true;
      const rendered =
        step['form'] === 'digest'
          ? renderDigestLine(message, external)
          : renderForAgent(message, external);
      record(rendered);
      return { text: rendered };
    }
    case 'world': {
      const change = asObject(step['change'], 'change');
      const keys = Object.keys(change);
      if (keys.length === 1 && keys[0] === 'agentStatus')
        setAgentStatus(store, change['agentStatus']);
      else applyWorld(host.world, change);
      return undefined;
    }
    default:
      throw new UnsupportedOp(`op ${step.op} is not implemented`);
  }
}

function observedMessage(m: Message): ObservedMessage {
  return {
    id: m.id,
    thread: m.thread,
    replyTo: m.replyTo,
    from: m.from,
    to: m.to,
    kind: m.kind,
    body: m.body,
    refs: m.refs.map(
      (r): JsonObject =>
        r.at === undefined
          ? { type: r.type, id: r.id }
          : { type: r.type, id: r.id, at: r.at }
    ),
    ...(m.data === undefined ? {} : { data: m.data }),
    urgent: m.urgent,
    blocking: m.blocking,
    ...(m.choices === undefined ? {} : { choices: m.choices }),
    ...(m.choice === undefined ? {} : { choice: m.choice }),
    wake: m.wake,
    createdAt: m.createdAt,
  };
}

function observedDelivery(d: Delivery): ObservedDelivery {
  return {
    id: d.id,
    message: d.messageId,
    recipient: d.recipient,
    session: d.runId === null ? null : `run:${d.runId}`,
    via: d.via,
    state: d.state,
  };
}

// Everything the kit compares after the last step: messages in creation
// order, every delivery, the hook calls, applied gates and channels.
function observe(
  id: string,
  db: SqliteDatabase,
  store: SqliteMessageStore,
  host: ConformanceHost,
  steps: StepResult[],
  render: { step: number; text: string }[]
): Observation {
  const messages = queryAll<{ id: string }>(
    db,
    'SELECT id FROM messages ORDER BY rowid'
  ).flatMap((row) => {
    const m = store.getMessage(row.id);
    return m === null ? [] : [observedMessage(m)];
  });
  const gateEffects = queryAll<{ question_id: string }>(
    db,
    'SELECT question_id FROM gate_effects ORDER BY question_id'
  ).map((row) => row.question_id);
  return {
    dmp: 'observation',
    id,
    steps,
    messages,
    deliveries: store.deliveries({}).map(observedDelivery),
    calls: host.calls,
    gateEffects,
    voided: queryAll<{ answer_id: string }>(
      db,
      'SELECT answer_id FROM voided_answers ORDER BY answer_id'
    ).map((row) => row.answer_id),
    channels: store
      .channels()
      .map((c) => ({ name: c.name, members: store.members(c.name) })),
    render,
  };
}

// Runs one vector against a fresh in-memory store and scripted host, and
// returns what the kit compares. A MessagingError fails only its step.
export async function runVector(
  vector: RunnableVector,
  options: AdapterOptions = {}
): Promise<Observation> {
  const db = openMessagesDb(':memory:');
  try {
    const store = new SqliteMessageStore(db);
    const host = new ConformanceHost(worldFrom(vector.given));
    seedStore(store, vector.given, host.world);
    const engine = new DeliveryEngine({
      store,
      host,
      limits: vector.given.limits,
      newUlid: createUlidFactory(seededBytes(vector.given.seed ?? 1)),
      gateTypes: gateTypesOf(options),
    });
    engine.subscribe((e) => {
      if (e.type === 'message')
        host.calls.push({ hook: 'published', message: e.message.id });
    });
    const roles = new RoleBinder(db, vector);
    const steps: StepResult[] = [];
    const render: { step: number; text: string }[] = [];
    for (const [i, raw] of vector.when.entries()) {
      const step = roles.resolve(raw);
      try {
        const result = await runStep(
          step,
          { engine, store, host },
          options,
          (rendered) => render.push({ step: i + 1, text: rendered })
        );
        steps.push(result === undefined ? { ok: true } : { ok: true, result });
        const created = createdId(result);
        if (CREATES.has(step.op) && created !== null)
          roles.bindStep(i + 1, created);
      } catch (err) {
        if (!(err instanceof MessagingError)) throw err;
        steps.push({
          ok: false,
          error:
            err.field === undefined
              ? { code: err.code }
              : { code: err.code, field: err.field },
        });
      }
    }
    return observe(vector.id, db, store, host, steps, render);
  } finally {
    db.close();
  }
}
