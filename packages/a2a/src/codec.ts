import type { Message as A2AMessage } from '@a2a-js/sdk';
import { isSystemMarker, MessagingError } from '@dispatch/protocol';
import type { Address, JsonValue, Message, Ref } from '@dispatch/protocol';

import { A2AError } from './errors.js';
import {
  checkMetadataBudget,
  parseEnvelopeExt,
  parseWorkExt,
  utf8Bytes,
} from './ext.js';
import type { EnvelopeExtV1, WorkRequestV1 } from './ext.js';
import { isGateTraffic } from './policy.js';
import type { ContinueInput, OpenInput, OpenKind } from './port.js';
import { sanitizeExternal, unwrapExternalData } from './sanitize.js';
import { ENVELOPE_URI, WORK_URI } from './uris.js';
import type { ExtensionUri } from './uris.js';
import type { MessageJson, PartJson } from './wire.js';

export type TextMediaType = 'text/markdown' | 'text/plain';

// An A2A message read into Dispatch terms, before the external-content rules.
export interface DecodedMessage {
  clientMessageId: string;
  contextId: string | null;
  taskId: string | null;
  body: string;
  data: JsonValue[];
  envelope: EnvelopeExtV1;
  work: WorkRequestV1 | null;
}

export type Inbound =
  | { kind: 'open'; input: OpenInput }
  | { kind: 'continue'; input: ContinueInput };

// Who is reading a message and how: the client's address, its output mode,
// its active extensions and the messageIds it sent.
export interface MessageView {
  client: Address;
  textMediaType: TextMediaType;
  extensions: ReadonlySet<ExtensionUri>;
  clientIds: Readonly<Record<string, string>>;
  // Resolves a replyTo, so an answer to a gate keeps its data home.
  lookup: (id: string) => Message | null;
  taskId?: string;
}

const TEXT_TYPES = new Set(['', 'text/plain', 'text/markdown']);
const MAX_URL_PARTS = 20;
const MAX_URL_BYTES = 2048;
const MAX_MESSAGE_ID_BYTES = 200;
const LINE_BREAK = /[\r\n\v\f\u0085\u2028\u2029]/;

function invalid(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

// A url part as one markdown link line; Dispatch never fetches it.
function linkLine(filename: string, url: string): string {
  const label = (filename === '' ? url : filename)
    .replace(/[[\]\r\n]/g, ' ')
    .trim();
  const href = url.replace(
    /[()\s]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')}`
  );
  return `[${label}](${href})`;
}

// Reads an A2A message's parts and extension metadata; raw file parts and
// non-text text media types are CONTENT_TYPE_NOT_SUPPORTED.
export function decodeMessage(message: A2AMessage): DecodedMessage {
  const id = message.messageId;
  if (
    id === '' ||
    LINE_BREAK.test(id) ||
    utf8Bytes(id) > MAX_MESSAGE_ID_BYTES
  ) {
    invalid(
      'message.messageId',
      `required: one line, at most ${MAX_MESSAGE_ID_BYTES} bytes (UTF-8)`
    );
  }
  checkMetadataBudget(message.metadata);
  const texts: string[] = [];
  const data: JsonValue[] = [];
  const links: string[] = [];
  message.parts.forEach((part, i) => {
    const content = part.content;
    if (content === undefined) invalid(`message.parts[${i}]`, 'empty part');
    switch (content.$case) {
      case 'raw':
        throw new A2AError(
          'CONTENT_TYPE_NOT_SUPPORTED',
          'raw file parts are not accepted; send a url part instead'
        );
      case 'text':
        if (!TEXT_TYPES.has(part.mediaType)) {
          throw new A2AError(
            'CONTENT_TYPE_NOT_SUPPORTED',
            `text parts must be text/plain or text/markdown, not ${part.mediaType}`
          );
        }
        texts.push(content.value);
        break;
      case 'data':
        data.push(content.value as JsonValue);
        break;
      case 'url':
        if (links.length === MAX_URL_PARTS)
          invalid('message.parts', `at most ${MAX_URL_PARTS} url parts`);
        if (utf8Bytes(content.value) > MAX_URL_BYTES)
          invalid(`message.parts[${i}].url`, `at most ${MAX_URL_BYTES} bytes`);
        links.push(linkLine(part.filename, content.value));
        break;
    }
  });
  const metadata = message.metadata ?? {};
  return {
    clientMessageId: id,
    contextId: message.contextId === '' ? null : message.contextId,
    taskId: message.taskId === '' ? null : message.taskId,
    body: [texts.join('\n\n'), links.join('\n')]
      .filter((s) => s !== '')
      .join('\n\n'),
    data,
    envelope: parseEnvelopeExt(metadata[ENVELOPE_URI]),
    work: parseWorkExt(metadata[WORK_URI]),
  };
}

function openKind(d: DecodedMessage): OpenKind {
  if (d.work?.skill === 'handoff') return 'handoff';
  if (d.work?.skill === 'status') return 'status';
  const kind = d.envelope.kind;
  if (kind === undefined || kind === 'question') return 'ask';
  if (kind === 'message' || kind === 'notice') return kind;
  if (kind === 'answer')
    invalid(
      'kind',
      'an answer goes with the taskId of the question it answers'
    );
  return invalid(
    'kind',
    'hand off work with the work extension (skill: handoff)'
  );
}

// A client's send: a message with a taskId continues that task, any other opens one.
export function decodeInbound(message: A2AMessage): Inbound {
  const d = decodeMessage(message);
  const content = sanitizeExternal(
    {
      body: d.body,
      data: d.data,
      choices: d.envelope.choices,
      // parseEnvelopeExt admits only task and message refs.
      refs: d.envelope.refs as Ref[] | undefined,
    },
    'client'
  );
  const data = content.data === undefined ? {} : { data: content.data };
  if (d.taskId !== null) {
    return {
      kind: 'continue',
      input: {
        clientMessageId: d.clientMessageId,
        taskId: d.taskId,
        contextId: d.contextId,
        body: content.body,
        ...data,
        refs: content.refs,
        ...(d.envelope.choice === undefined
          ? {}
          : { choice: d.envelope.choice }),
      },
    };
  }
  return {
    kind: 'open',
    input: {
      clientMessageId: d.clientMessageId,
      contextId: d.contextId,
      kind: openKind(d),
      to: d.envelope.to ?? null,
      replyTo: d.envelope.replyTo ?? null,
      body: content.body,
      ...data,
      refs: content.refs,
      ...(content.choices === undefined ? {} : { choices: content.choices }),
      ...(d.work === null ? {} : { work: d.work }),
    },
  };
}

// One Dispatch message as the client sees it: its own sends come back under
// its messageId and data; data on gate traffic or a system marker never leaves.
export function encodeMessage(m: Message, view: MessageView): MessageJson {
  const own = m.from === view.client;
  const parts: PartJson[] = [{ text: m.body, mediaType: view.textMediaType }];
  if (
    m.data !== undefined &&
    !isGateTraffic(m, view.lookup) &&
    !isSystemMarker(m, 'x-closed') &&
    !isSystemMarker(m, 'x-breaker')
  ) {
    parts.push({
      data: own ? unwrapExternalData(m.data) : m.data,
      mediaType: 'application/json',
    });
  }
  const out: MessageJson = {
    messageId: own ? (view.clientIds[m.id] ?? m.id) : m.id,
    contextId: m.thread,
    role: own ? 'ROLE_USER' : 'ROLE_AGENT',
    parts,
  };
  if (view.taskId !== undefined) out.taskId = view.taskId;
  if (view.extensions.has(ENVELOPE_URI)) {
    const env: EnvelopeExtV1 = {
      id: m.id,
      thread: m.thread,
      from: m.from,
      kind: m.kind as NonNullable<EnvelopeExtV1['kind']>,
    };
    if (m.replyTo !== null) env.replyTo = m.replyTo;
    if (m.blocking) env.blocking = true;
    if (m.choices !== undefined) env.choices = m.choices;
    if (m.choice !== undefined) env.choice = m.choice;
    env.refs = m.refs.map(({ type, id }) => ({ type, id }));
    out.metadata = { [ENVELOPE_URI]: env as unknown as JsonValue };
    out.extensions = [ENVELOPE_URI];
  }
  return out;
}

// The text media type to answer in, from the client's acceptedOutputModes.
export function outputTextType(accepted: readonly string[]): TextMediaType {
  if (accepted.length === 0) return 'text/markdown';
  const modes = new Set(
    accepted.map((m) => m.toLowerCase().split(';')[0].trim())
  );
  if (modes.has('text/markdown') || modes.has('text/*') || modes.has('*/*'))
    return 'text/markdown';
  if (modes.has('text/plain')) return 'text/plain';
  throw new A2AError(
    'CONTENT_TYPE_NOT_SUPPORTED',
    'this agent answers in text/markdown or text/plain'
  );
}
