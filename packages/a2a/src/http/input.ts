import { MessagingError } from '@dispatch/protocol';
import type { JsonValue } from '@dispatch/protocol';

import { parseEnvelopeExt, parseWorkExt, utf8Bytes } from '../ext.js';
import type { ContinueInput, OpenInput, OpenKind } from '../port.js';
import { sanitizeExternal, unwrapExternalData } from '../sanitize.js';

// What /api/a2a/port/open and /continue accept from a standalone host, checked
// as the in-daemon listener checks a client's send: a host is trusted to
// authenticate, not to shape input.

const KINDS: readonly OpenKind[] = [
  'ask',
  'message',
  'notice',
  'handoff',
  'status',
];

function invalid(field: string, why: string): never {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
}

function record(raw: unknown): Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
    invalid('body', 'expected a JSON object');
  return raw as Record<string, unknown>;
}

function id(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.trim() === '' ||
    /[\r\n]/.test(value) ||
    utf8Bytes(value) > 512
  )
    invalid(field, 'expected one line of text, at most 512 bytes');
  return value;
}

function nullableId(value: unknown, field: string): string | null {
  return value === null || value === undefined ? null : id(value, field);
}

// The body, data and refs through the client rules; data is unwrapped and
// wrapped again, so whatever the host sent sits under the envelope URI.
function content(
  r: Record<string, unknown>,
  envelope: { refs?: unknown; choices?: unknown; choice?: unknown }
) {
  if (typeof r.body !== 'string') invalid('body', 'expected text');
  if (!Array.isArray(r.refs)) invalid('refs', 'expected a list');
  const parsed = parseEnvelopeExt(envelope);
  const sanitized = sanitizeExternal(
    {
      body: r.body,
      data:
        r.data === undefined ? [] : [unwrapExternalData(r.data as JsonValue)],
      ...(parsed.choices === undefined ? {} : { choices: parsed.choices }),
      refs: parsed.refs ?? [],
    },
    'client'
  );
  return { parsed, sanitized };
}

/** A host's open, checked: kind, work, recipients, refs, body and data. */
export function parsePortOpen(raw: unknown): OpenInput {
  const r = record(raw);
  const clientMessageId = id(r.clientMessageId, 'clientMessageId');
  const contextId = nullableId(r.contextId, 'contextId');
  if (!(KINDS as readonly unknown[]).includes(r.kind))
    invalid('kind', 'expected ask, message, notice, handoff or status');
  const kind = r.kind as OpenKind;
  // handoff and status come only from the work extension, with its skill.
  const work = parseWorkExt(r.work);
  const needsWork = kind === 'handoff' || kind === 'status';
  if (needsWork !== (work !== null) || (work !== null && work.skill !== kind))
    invalid('work', 'only a handoff or status send carries its work request');
  const { parsed, sanitized } = content(r, {
    ...(r.to === null || r.to === undefined ? {} : { to: r.to }),
    ...(r.replyTo === null || r.replyTo === undefined
      ? {}
      : { replyTo: r.replyTo }),
    refs: r.refs,
    choices: r.choices,
  });
  return {
    clientMessageId,
    contextId,
    kind,
    to: parsed.to ?? null,
    replyTo: parsed.replyTo ?? null,
    body: sanitized.body,
    ...(sanitized.data === undefined ? {} : { data: sanitized.data }),
    refs: sanitized.refs,
    ...(sanitized.choices === undefined ? {} : { choices: sanitized.choices }),
    ...(work === null ? {} : { work }),
  };
}

/** A host's continue, checked the same way. */
export function parsePortContinue(raw: unknown): ContinueInput {
  const r = record(raw);
  const clientMessageId = id(r.clientMessageId, 'clientMessageId');
  const taskId = id(r.taskId, 'taskId');
  const contextId = nullableId(r.contextId, 'contextId');
  const { parsed, sanitized } = content(r, {
    refs: r.refs,
    choice: r.choice,
  });
  return {
    clientMessageId,
    taskId,
    contextId,
    body: sanitized.body,
    ...(sanitized.data === undefined ? {} : { data: sanitized.data }),
    refs: sanitized.refs,
    ...(parsed.choice === undefined ? {} : { choice: parsed.choice }),
  };
}
