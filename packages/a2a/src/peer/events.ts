import type { JsonValue, Message, SendInput } from '@dispatch/protocol';
import { createHash } from 'node:crypto';

import {
  isLinkUrl,
  isTextMediaType,
  linkLine,
  MAX_URL_PARTS,
} from '../codec.js';
import { matchChoice } from '../policy.js';
import { sanitizeExternal } from '../sanitize.js';
import type { SanitizedContent } from '../sanitize.js';
import { stateFromWire } from '../states.js';
import type { TaskStateName } from '../states.js';
import { ENVELOPE_URI } from '../uris.js';
import type { MessageJson, TaskJson } from '../wire.js';

export interface PeerText {
  messageId: string | null;
  body: string;
  data: JsonValue[];
  links: string[];
  choices?: string[];
}
export type PeerEvent =
  | {
      kind: 'message';
      remoteMessageId: string;
      contextId: string | null;
      text: PeerText;
    }
  | {
      kind: 'task';
      taskId: string;
      contextId: string;
      state: TaskStateName;
      status: PeerText | null;
      timestamp: string | null;
      artifacts: PeerText[];
    };
export interface PeerEventContext {
  alias: string;
  original: Message;
  via: 'direct' | 'channel';
  originalAnswered: boolean;
  lastWorkingNoticeAt: string | null;
  now: Date;
}
export type PeerAction =
  | { kind: 'send'; input: SendInput }
  | { kind: 'close'; reason: string };

const OUTCOME: Partial<Record<TaskStateName, string>> = {
  WORKING: 'accepted',
  COMPLETED: 'completed',
  REJECTED: 'declined',
  FAILED: 'failed',
  CANCELED: 'canceled',
};
const WORKING_NOTICE_MS = 60_000;
const MAX_REASON_CHARS = 200;

const record = (v: unknown): Record<string, unknown> | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : null;
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const text = (v: unknown): string | null => (typeof v === 'string' ? v : null);

// A peer's parts as text, data and links; anything not in those shapes, text
// in another media type, and urls that are not http(s) (or past 20) are
// skipped, since a peer's JSON is untrusted whatever its declared type.
function textOf(
  parts: unknown,
  messageId: string | null,
  metadata?: unknown
): PeerText {
  const texts: string[] = [];
  const data: JsonValue[] = [];
  const links: string[] = [];
  for (const raw of list(parts)) {
    const p = record(raw);
    if (p === null) continue;
    const t = text(p.text);
    const url = text(p.url);
    if (t !== null) {
      if (isTextMediaType(text(p.mediaType) ?? '')) texts.push(t);
    } else if (p.data !== undefined) data.push(p.data as JsonValue);
    else if (url !== null && links.length < MAX_URL_PARTS && isLinkUrl(url))
      links.push(linkLine(text(p.filename) ?? '', url));
  }
  const envelope = record(record(metadata)?.[ENVELOPE_URI]);
  const choices = Array.isArray(envelope?.choices)
    ? envelope.choices.filter((c): c is string => typeof c === 'string')
    : undefined;
  return {
    messageId,
    body: texts.join('\n\n'),
    data,
    links,
    ...(choices === undefined ? {} : { choices }),
  };
}

// The event a peer task snapshot stands for; null for TASK_STATE_UNSPECIFIED,
// an unknown state, or a task without a status.
export function peerEventFromTask(task: TaskJson): PeerEvent | null {
  const status = record((task as unknown as Record<string, unknown>).status);
  const wire = text(status?.state);
  if (status === null || wire === null) return null;
  const state = stateFromWire(wire);
  if (state === null) return null;
  const m = record(status.message);
  return {
    kind: 'task',
    taskId: String(task.id),
    contextId: String(task.contextId),
    state,
    status: m === null ? null : textOf(m.parts, text(m.messageId), m.metadata),
    timestamp: text(status.timestamp),
    artifacts: list(task.artifacts).flatMap((a) => {
      const artifact = record(a);
      return artifact === null ? [] : [textOf(artifact.parts, null)];
    }),
  };
}

export function peerEventFromMessage(message: MessageJson): PeerEvent {
  return {
    kind: 'message',
    remoteMessageId: String(message.messageId),
    contextId: text(message.contextId) ?? null,
    text: textOf(message.parts, text(message.messageId), message.metadata),
  };
}

// One key per (task, state, status message), hashed so any peer id fits the
// 200-byte idempotency key (spec:1484-1496).
export function peerEventKey(alias: string, event: PeerEvent): string {
  const tuple =
    event.kind === 'message'
      ? ['', 'MESSAGE', event.remoteMessageId]
      : [
          event.taskId,
          event.state,
          event.status?.messageId ?? event.timestamp ?? '',
        ];
  const digest = createHash('sha256')
    .update(JSON.stringify(tuple))
    .digest('base64url');
  return `a2a:${alias}:${digest}`;
}

// Status text, then artifact text, then links, each trimmed; data wrapped
// (spec:1501). A prefix goes on before the size rules, so it counts too.
export function peerContent(
  texts: readonly PeerText[],
  choices?: readonly string[],
  prefix?: string
): SanitizedContent {
  const joined = [...texts.map((t) => t.body), ...texts.flatMap((t) => t.links)]
    .map((s) => s.trim())
    .filter((s) => s !== '')
    .join('\n\n');
  const body =
    prefix === undefined
      ? joined
      : `${prefix}${joined === '' ? '(no text)' : joined}`;
  return sanitizeExternal(
    {
      body,
      data: texts.flatMap((t) => t.data),
      ...(choices === undefined ? {} : { choices: [...choices] }),
    },
    'peer'
  );
}

function firstLine(body: string): string {
  return body.split(/\r?\n/)[0].slice(0, MAX_REASON_CHARS);
}

// What one peer event records in the thread (spec:1498-1531): at most one send
// from the peer, and for an outbound handoff or a direct question a system
// close first. A peer never authors a handoff's answer (Q6).
export function mapPeerEvent(
  event: PeerEvent,
  ctx: PeerEventContext
): PeerAction[] {
  const o = ctx.original;
  const peer = `a2a:${ctx.alias}`;
  const open = !ctx.originalAnswered;
  const directQuestion = o.kind === 'question' && ctx.via === 'direct';
  const handoff = o.kind === 'handoff';
  const key = peerEventKey(ctx.alias, event);
  const send = (
    kind: 'answer' | 'message' | 'notice' | 'question',
    c: SanitizedContent,
    extra: Partial<SendInput> = {}
  ): PeerAction => ({
    kind: 'send',
    input: {
      to: [o.from],
      kind,
      replyTo: o.id,
      body: c.body,
      refs: [],
      idempotencyKey: key,
      ...(c.data === undefined ? {} : { data: c.data }),
      ...extra,
    },
  });
  const answer = (c: SanitizedContent): PeerAction => {
    const choice = matchChoice(o.choices, c.body);
    return send('answer', c, typeof choice === 'string' ? { choice } : {});
  };
  if (event.kind === 'message') {
    const c = peerContent([event.text]);
    if (directQuestion && open) return [answer(c)];
    if (handoff && open)
      return [{ kind: 'close', reason: `${peer} replied` }, send('notice', c)];
    return [send('message', c)];
  }
  const texts = [
    ...(event.status === null ? [] : [event.status]),
    ...event.artifacts,
  ];
  switch (event.state) {
    case 'SUBMITTED':
      return [];
    case 'INPUT_REQUIRED': {
      const c = peerContent(
        event.status === null ? [] : [event.status],
        event.status?.choices
      );
      return [
        send('question', c, {
          blocking: true,
          ...(c.choices === undefined ? {} : { choices: c.choices }),
        }),
      ];
    }
    case 'AUTH_REQUIRED':
      return [
        send(
          'notice',
          peerContent(
            texts,
            undefined,
            `${peer} is waiting on its own authorization: `
          )
        ),
      ];
    case 'WORKING': {
      const acts: PeerAction[] = [];
      if (handoff && open)
        acts.push({ kind: 'close', reason: `${peer} accepted (WORKING)` });
      const throttled =
        ctx.lastWorkingNoticeAt !== null &&
        ctx.now.getTime() - Date.parse(ctx.lastWorkingNoticeAt) <
          WORKING_NOTICE_MS;
      if (event.status !== null && !throttled)
        acts.push(send('notice', peerContent([event.status])));
      return acts;
    }
    case 'COMPLETED': {
      const c = peerContent(texts);
      if (directQuestion && open) return [answer(c)];
      if (handoff && open)
        return [
          { kind: 'close', reason: `${peer} completed (COMPLETED)` },
          send('notice', c),
        ];
      return [
        send(
          o.kind === 'question' && ctx.via === 'channel' ? 'message' : 'notice',
          c
        ),
      ];
    }
    default: {
      const c = peerContent(texts);
      const why = c.body === '(no text)' ? '' : `: ${firstLine(c.body)}`;
      if ((directQuestion || handoff) && open)
        return [
          {
            kind: 'close',
            reason: `${peer} ${OUTCOME[event.state]} (${event.state})${why}`,
          },
        ];
      return [send('notice', c)];
    }
  }
}
