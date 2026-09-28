import { Message as A2AMessage } from '@a2a-js/sdk';
import { MessagingError } from '@dispatch/protocol';
import type { Address, Message, SendInput } from '@dispatch/protocol';
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
import { decodeInbound } from '../codec.js';
import { checkMetadataBudget, parseEnvelopeExt, parseWorkExt } from '../ext.js';
import { checkInboundRecipients } from '../policy.js';
import type { ContinueInput, OpenInput, TaskFacts } from '../port.js';
import { decideState, project } from '../projection.js';
import { ENVELOPE_URI, GATE_URI, WORK_URI } from '../uris.js';

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

function partsOf(step: Step): Json[] {
  const parts = step['parts'];
  if (parts === undefined) return [];
  return Array.isArray(parts)
    ? parts
    : malformed(`${step.op}.parts`, 'expected a list');
}

// The A2A message an `a2a.inbound` step stands for; `answers` becomes the
// taskId, so decodeInbound takes the continuation path it names.
function a2aMessageOf(step: Step): A2AMessage {
  const envelope = step['envelope'];
  const answers = step['answers'];
  return A2AMessage.fromJSON({
    role: 'ROLE_USER',
    messageId: 'kit-inbound',
    ...(answers === undefined ? {} : { taskId: textOf(step, 'answers') }),
    parts: [
      { text: textOf(step, 'body') },
      ...partsOf(step).map((data) => ({ data })),
    ],
    ...(envelope === null || envelope === undefined
      ? {}
      : { metadata: { [ENVELOPE_URI]: envelope } }),
  });
}

// A message that opens a task, as the host opens one: the scripted host's
// client reaches the owner alone and has no approved handoffs.
function openingInput(input: OpenInput, owner: Address): SendInput {
  if (input.kind === 'handoff' || input.kind === 'status')
    throw new MessagingError(
      'invalid',
      'this host takes no handoffs',
      'work.skill'
    );
  const to = input.to ?? [owner];
  checkInboundRecipients(to, {
    allowedHumans: [owner],
    approvedTasks: new Set(),
  });
  const common = {
    to,
    body: input.body,
    refs: input.refs,
    replyTo: input.replyTo,
    ...(input.data === undefined ? {} : { data: input.data }),
  };
  if (input.kind !== 'ask') return { ...common, kind: input.kind };
  return {
    ...common,
    kind: 'question',
    blocking: true,
    ...(input.choices === undefined ? {} : { choices: input.choices }),
  };
}

// A continuation answers the open question its task waits on; `answers`
// names that question directly.
function answerInput(input: ContinueInput, ctx: OpContext): SendInput {
  const question = ctx.store.getMessage(input.taskId);
  if (question === null)
    throw new MessagingError('not-found', 'task not found', 'taskId');
  return {
    to: [question.from],
    kind: 'answer',
    replyTo: question.id,
    body: input.body,
    refs: input.refs,
    ...(input.data === undefined ? {} : { data: input.data }),
    ...(input.choice === undefined ? {} : { choice: input.choice }),
  };
}

// A client's message through the binding's inbound mapping (decodeInbound),
// sent as the client with no decide power.
async function inbound(step: Step, ctx: OpContext): Promise<Json> {
  const decoded = decodeInbound(a2aMessageOf(step));
  const input =
    decoded.kind === 'continue'
      ? answerInput(decoded.input, ctx)
      : openingInput(decoded.input, ctx.host.world.owner);
  const { message, downgraded } = await ctx.engine.send(input, {
    address: textOf(step, 'as'),
    canDecide: false,
  });
  return { message: message.id, downgraded };
}

// An extension's metadata as one message's metadata: the budget, then its rules.
function validateExtension(step: Step): Json {
  const extension = step['extension'];
  const uri =
    extension === 'envelope'
      ? ENVELOPE_URI
      : extension === 'work'
        ? WORK_URI
        : null;
  if (uri === null)
    throw new UnsupportedOp(`no extension ${JSON.stringify(extension)}`);
  checkMetadataBudget({ [uri]: step['raw'] });
  if (uri === ENVELOPE_URI) parseEnvelopeExt(step['raw']);
  else parseWorkExt(step['raw']);
  return {};
}

// The decided state and stage, and in AUTH_REQUIRED the gate/v1 list the
// host writes on status.message when the client activated it.
function projectFacts(step: Step): Json {
  const facts = withDefaults(step['facts']);
  const decision = decideState(facts);
  const result: JsonObject = { state: decision.state };
  if (decision.stage !== undefined) result['stage'] = decision.stage;
  if (decision.state === 'AUTH_REQUIRED') {
    const task = project(facts, {
      client: facts.client,
      extensions: new Set([GATE_URI]),
      textMediaType: 'text/markdown',
      historyLength: 0,
      includeArtifacts: false,
    });
    const gate = task.status.message?.metadata?.[GATE_URI];
    if (isObject(gate) && gate['gates'] !== undefined)
      result['gates'] = gate['gates'];
  }
  return result;
}

// The binding's pure pieces as vector ops; everything else is the reference engine.
const OPS: Record<string, OpHandler> = {
  'a2a.validate': validateExtension,
  'a2a.project': projectFacts,
  'a2a.inbound': inbound,
};

// Runs one vector through the reference engine with the binding's ops.
export function runA2AVector(vector: RunnableVector): Promise<Observation> {
  return runVector(vector, { ops: OPS });
}
