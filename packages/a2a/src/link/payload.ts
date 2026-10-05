import { Message, SendMessageRequest, StreamResponse } from '@a2a-js/sdk';
import type { JsonValue } from '@dispatch-foo/protocol';
import { canonicalize, MAX_OP_BYTES } from '@dispatch-foo/protocol/federation';

import type { MessageJson, StreamResponseJson } from '../wire.js';

// What a teammate link carries (P5 piece 4): A2A semantics in A2A's own wire
// shapes, a Message in and StreamResponses back, as push carries them.

type LinkStatement = Record<string, JsonValue>;

export type LinkPayload =
  | {
      kind: 'send';
      message: MessageJson;
      configuration?: { returnImmediately: true };
    }
  // `for`: the messageId of the send this task came from, so the sender can
  // tie its own record to the receiver's task id.
  | { kind: 'event'; taskId: string; for?: string; event: StreamResponseJson }
  | { kind: 'cancel'; taskId: string }
  // OD-10: ask the receiver to re-publish a task's current snapshot.
  | { kind: 'resync'; taskId: string }
  | { kind: 'key-change'; statement: LinkStatement }
  // Names the pairing it ends, so it binds to this link (relay re-review N4).
  | { kind: 'unpair'; id: string; at: string };

/**
 * The largest payload a link op can seal: sealing adds a 16-byte tag, base64url
 * grows it by 4/3, and the op's own fields take the rest of MAX_OP_BYTES.
 */
export const MAX_LINK_PAYLOAD_BYTES = Math.floor(
  ((MAX_OP_BYTES - 64 * 1024) * 3) / 4
);

const TASK_ID_BYTES = 512;
const EVENT_KEYS = [
  'task',
  'message',
  'statusUpdate',
  'artifactUpdate',
] as const;

type Check =
  | { ok: true; payload: LinkPayload }
  | { ok: false; problem: string };

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function onlyKeys(
  r: Record<string, unknown>,
  allowed: readonly string[]
): string | null {
  const extra = Object.keys(r).filter((k) => !allowed.includes(k));
  return extra.length === 0 ? null : `unexpected field ${extra[0]}`;
}

function taskId(v: unknown): boolean {
  return (
    typeof v === 'string' &&
    v !== '' &&
    !/[\r\n]/.test(v) &&
    Buffer.byteLength(v, 'utf8') <= TASK_ID_BYTES
  );
}

const validAt = (v: unknown): v is string =>
  typeof v === 'string' && !Number.isNaN(Date.parse(v));

// A key-change or revocation statement's shape; its signature is checked
// against the pinned key where it applies.
function statementShape(v: unknown): boolean {
  if (!isRecord(v) || v.v !== 1 || !validAt(v.at) || typeof v.sig !== 'string')
    return false;
  if (typeof v.revoked === 'string')
    return onlyKeys(v, ['v', 'revoked', 'at', 'sig']) === null;
  return (
    typeof v.old === 'string' &&
    isRecord(v.new) &&
    Object.values(v.new).every((x) => typeof x === 'string') &&
    onlyKeys(v, ['v', 'old', 'new', 'at', 'sig']) === null
  );
}

/**
 * A link payload checked field by field (FW-R32(3)); never throws. The A2A
 * message and stream response are checked with the SDK's own decoders, as
 * the listener checks them.
 */
export function checkLinkPayload(raw: unknown): Check {
  const no = (problem: string): Check => ({ ok: false, problem });
  if (!isRecord(raw)) return no('not an object');
  switch (raw.kind) {
    case 'send': {
      const extra = onlyKeys(raw, ['kind', 'message', 'configuration']);
      if (extra !== null) return no(extra);
      if (!isRecord(raw.message)) return no('message is not an object');
      if (raw.configuration !== undefined) {
        const c = raw.configuration;
        if (
          !isRecord(c) ||
          c.returnImmediately !== true ||
          onlyKeys(c, ['returnImmediately']) !== null
        )
          return no('configuration may only set returnImmediately: true');
      }
      // The decoded form is what passes on, never the raw object (N3).
      let message: MessageJson;
      try {
        const req = SendMessageRequest.fromJSON({ message: raw.message });
        const m = req.message;
        if (m === undefined || m.messageId === '' || m.parts.length === 0)
          return no('message needs a messageId and parts');
        message = Message.toJSON(m) as MessageJson;
      } catch {
        return no('message is not an A2A Message');
      }
      return {
        ok: true,
        payload: {
          kind: 'send',
          message,
          ...(raw.configuration === undefined
            ? {}
            : { configuration: { returnImmediately: true as const } }),
        },
      };
    }
    case 'event': {
      const extra = onlyKeys(raw, ['kind', 'taskId', 'for', 'event']);
      if (extra !== null) return no(extra);
      if (!taskId(raw.taskId)) return no('taskId');
      if (raw.for !== undefined && !taskId(raw.for)) return no('for');
      const e = raw.event;
      if (!isRecord(e)) return no('event is not an object');
      const keys = Object.keys(e);
      if (
        keys.length !== 1 ||
        !(EVENT_KEYS as readonly string[]).includes(keys[0]) ||
        !isRecord(e[keys[0]])
      )
        return no('event is not one StreamResponse');
      let event: StreamResponseJson;
      try {
        event = StreamResponse.toJSON(
          StreamResponse.fromJSON(e)
        ) as StreamResponseJson;
      } catch {
        return no('event is not an A2A StreamResponse');
      }
      return {
        ok: true,
        payload: {
          kind: 'event',
          taskId: raw.taskId as string,
          ...(raw.for === undefined ? {} : { for: raw.for as string }),
          event,
        },
      };
    }
    case 'cancel':
    case 'resync': {
      const extra = onlyKeys(raw, ['kind', 'taskId']);
      if (extra !== null) return no(extra);
      if (!taskId(raw.taskId)) return no('taskId');
      return { ok: true, payload: raw as LinkPayload };
    }
    case 'key-change': {
      const extra = onlyKeys(raw, ['kind', 'statement']);
      if (extra !== null) return no(extra);
      if (!statementShape(raw.statement)) return no('statement');
      return { ok: true, payload: raw as LinkPayload };
    }
    case 'unpair': {
      const extra = onlyKeys(raw, ['kind', 'id', 'at']);
      if (extra !== null) return no(extra);
      if (typeof raw.id !== 'string' || !/^[A-Za-z0-9_-]{16,64}$/.test(raw.id))
        return no('id');
      if (!validAt(raw.at)) return no('at');
      return { ok: true, payload: raw as LinkPayload };
    }
    default:
      return no('unknown kind');
  }
}

/** Whether a payload fits a sealed link op (FW-R32(4)), checked before sealing. */
export function sealableLinkPayload(p: LinkPayload): 'ok' | 'oversize' {
  let bytes: number;
  try {
    bytes = Buffer.byteLength(canonicalize(p as unknown as JsonValue), 'utf8');
  } catch {
    return 'oversize';
  }
  return bytes > MAX_LINK_PAYLOAD_BYTES ? 'oversize' : 'ok';
}
