import type { JsonValue, Message, Ref, SendInput } from '@dispatch/protocol';
import type {
  Hello,
  Json,
  JsonObject,
  Observation,
  RunnableVector,
  Step,
} from '@dispatch/protocol-spec';
import {
  REFERENCE_HELLO,
  runVector,
  UnsupportedOp,
} from '@dispatch/protocol/conformance';
import type { OpContext, OpHandler } from '@dispatch/protocol/conformance';

import packageJson from '../../package.json';
import { parseEnvelopeExt, parseWorkExt } from '../ext.js';
import type { TaskFacts } from '../port.js';
import { decideState } from '../projection.js';
import { sanitizeExternal } from '../sanitize.js';

// The reference engine's declarations plus the A2A binding's vector class.
export const A2A_HELLO: Hello = {
  ...REFERENCE_HELLO,
  implementation: {
    name: 'dispatch-a2a-reference',
    version: packageJson.version,
  },
  classes: ['envelope', 'host-core', 'a2a-binding'],
};

const CREATED_AT = '2026-09-23T10:00:00.000Z';
const CLIENT = 'agent:wyat/a2a.acme';
const SYNTHETIC_ROOT: Message = {
  id: 'm-root',
  thread: 'm-root',
  replyTo: null,
  from: CLIENT,
  to: ['human:wyat'],
  kind: 'question',
  body: 'q',
  refs: [],
  urgent: false,
  blocking: true,
  wake: 'none',
  createdAt: CREATED_AT,
};

// Every TaskFacts field, so an `a2a.project` step names only what its row reads.
const DEFAULT_FACTS: TaskFacts = {
  id: 'a2a-task-1',
  contextId: 'ctx-1',
  skill: 'ask',
  client: CLIENT,
  createdAt: CREATED_AT,
  canceledAt: null,
  declinedAt: null,
  root: SYNTHETIC_ROOT,
  scope: [],
  rootDeliveries: [],
  answer: null,
  openQuestions: [],
  openGates: [],
  task: null,
  dropped: null,
  recipientTaskDropped: false,
  work: {},
  clientIds: {},
};

// A vector field this adapter cannot read fails the vector as an adapter error.
function malformed(where: string, why: string): never {
  throw new Error(`malformed vector field ${where}: ${why}`);
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function messageOf(value: Json | undefined, where: string): Message {
  if (!isObject(value)) return malformed(where, 'expected an object');
  return { ...SYNTHETIC_ROOT, ...(value as unknown as Partial<Message>) };
}

function messagesOf(value: Json | undefined, where: string): Message[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return malformed(where, 'expected a list');
  return value.map((m, i) => messageOf(m, `${where}[${i}]`));
}

// A step's partial facts over DEFAULT_FACTS; each message fact is partial
// JSON over the synthetic root.
function withDefaults(value: Json | undefined): TaskFacts {
  if (!isObject(value)) return malformed('facts', 'expected an object');
  const facts = {
    ...DEFAULT_FACTS,
    ...(value as unknown as Partial<TaskFacts>),
  };
  return {
    ...facts,
    root:
      value['root'] === undefined
        ? SYNTHETIC_ROOT
        : messageOf(value['root'], 'facts.root'),
    answer:
      value['answer'] === undefined || value['answer'] === null
        ? null
        : messageOf(value['answer'], 'facts.answer'),
    scope: messagesOf(value['scope'], 'facts.scope'),
    openQuestions: messagesOf(value['openQuestions'], 'facts.openQuestions'),
  };
}

function textOf(step: Step, key: string): string {
  const value = step[key];
  return typeof value === 'string'
    ? value
    : malformed(`${step.op}.${key}`, 'expected a string');
}

function partsOf(step: Step): JsonValue[] {
  const parts = step['parts'];
  if (parts === undefined) return [];
  return Array.isArray(parts)
    ? parts
    : malformed(`${step.op}.parts`, 'expected a list');
}

// A client's message through the binding's inbound mapping: the envelope's
// from, id and thread are ignored (the bearer decides), its content passes the
// external-content rules, and it is sent as the client with no decide power.
async function inbound(step: Step, ctx: OpContext): Promise<Json> {
  const as = textOf(step, 'as');
  const ext = parseEnvelopeExt(step['envelope']);
  const content = sanitizeExternal(
    {
      body: textOf(step, 'body'),
      data: partsOf(step),
      ...(ext.choices === undefined ? {} : { choices: ext.choices }),
      // parseEnvelopeExt admits only task and message refs.
      ...(ext.refs === undefined ? {} : { refs: ext.refs as Ref[] }),
    },
    ctx.host.world.external.get(as) ?? 'client'
  );
  // An absent kind is the ask skill's question, and a client's question blocks.
  const kind = ext.kind ?? 'question';
  const input: SendInput = {
    to: ext.to ?? [ctx.host.world.owner],
    kind,
    body: content.body,
    refs: content.refs,
    ...(content.data === undefined ? {} : { data: content.data }),
    ...(ext.replyTo === undefined ? {} : { replyTo: ext.replyTo }),
    ...(kind === 'question' ? { blocking: true } : {}),
    ...(content.choices === undefined ? {} : { choices: content.choices }),
    ...(ext.choice === undefined ? {} : { choice: ext.choice }),
  };
  const { message, downgraded } = await ctx.engine.send(input, {
    address: as,
    canDecide: false,
  });
  return { message: message.id, downgraded };
}

// The binding's pure pieces as vector ops; everything else is the reference engine.
const OPS: Record<string, OpHandler> = {
  'a2a.validate': (step) => {
    const extension = step['extension'];
    if (extension === 'envelope') parseEnvelopeExt(step['raw']);
    else if (extension === 'work') parseWorkExt(step['raw']);
    else throw new UnsupportedOp(`no extension ${JSON.stringify(extension)}`);
    return {};
  },
  'a2a.project': (step) => {
    const decision = decideState(withDefaults(step['facts']));
    const result: JsonObject = { state: decision.state };
    if (decision.stage !== undefined) result['stage'] = decision.stage;
    return result;
  },
  'a2a.inbound': inbound,
};

// Runs one vector through the reference engine with the binding's ops.
export function runA2AVector(vector: RunnableVector): Promise<Observation> {
  return runVector(vector, { ops: OPS });
}
