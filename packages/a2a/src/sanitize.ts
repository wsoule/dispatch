import { MessagingError } from '@dispatch/protocol';
import type { JsonValue, Ref } from '@dispatch/protocol';

import { utf8Bytes } from './ext.js';
import { ENVELOPE_URI } from './uris.js';

// What a client or peer sent, before the size, choice and data rules.
export interface ExternalContent {
  body: string;
  data: JsonValue[];
  choices?: string[];
  refs?: Ref[];
}

export interface SanitizedContent {
  body: string;
  data?: JsonValue;
  choices?: string[];
  refs: Ref[];
}

const MAX_BODY_BYTES = 64 * 1024;
const MAX_DATA_BYTES = 64 * 1024;
const MAX_CHOICES = 20;
const MAX_CHOICE_BYTES = 200;
const TRUNCATED = '\n\n[… truncated by Dispatch]';
const LINE_BREAKS = /[\r\n\v\f\u0085\u2028\u2029]+/g;

// External data lives under the envelope URI, so it has no top-level `type`
// and can never read as a gate, x-closed or x-breaker.
export function wrapExternalData(
  parts: readonly JsonValue[]
): JsonValue | undefined {
  if (parts.length === 0) return undefined;
  return { [ENVELOPE_URI]: parts.length === 1 ? parts[0] : [...parts] };
}

// The data a client or peer sent, as it sent it.
export function unwrapExternalData(data: JsonValue): JsonValue {
  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const keys = Object.keys(data);
    if (keys.length === 1 && keys[0] === ENVELOPE_URI)
      return data[ENVELOPE_URI];
  }
  return data;
}

// Cuts `text` to at most `maxBytes` of UTF-8 without splitting a character.
function truncateUtf8(text: string, maxBytes: number): string {
  const bytes = new TextEncoder().encode(text);
  if (bytes.byteLength <= maxBytes) return text;
  return new TextDecoder()
    .decode(bytes.slice(0, maxBytes))
    .replace(/\uFFFD$/, '');
}

// A peer's offered answers: trimmed, one line, deduplicated, at most 200 bytes, the first 20.
function peerChoices(
  choices: readonly string[] | undefined
): string[] | undefined {
  if (choices === undefined) return undefined;
  const out: string[] = [];
  for (const raw of choices) {
    const c = raw.replace(LINE_BREAKS, ' ').trim();
    if (c === '' || utf8Bytes(c) > MAX_CHOICE_BYTES || out.includes(c))
      continue;
    out.push(c);
    if (out.length === MAX_CHOICES) break;
  }
  return out.length === 0 ? undefined : out;
}

// Size, choice and data rules for anything a client or peer sends: a client
// over a limit is refused, a peer's content is cut to fit.
export function sanitizeExternal(
  content: ExternalContent,
  origin: 'client' | 'peer'
): SanitizedContent {
  let body = content.body;
  let data = wrapExternalData(content.data);
  if (data !== undefined && utf8Bytes(JSON.stringify(data)) > MAX_DATA_BYTES) {
    data = undefined;
    body = `${body}\n\n(data part over 64 KiB omitted)`.trim();
  }
  if (body.trim() === '') {
    if (origin === 'client' && content.data.length === 0) {
      throw new MessagingError(
        'invalid',
        'body: send at least one text, url or data part',
        'body'
      );
    }
    body = '(no text)';
  }
  if (utf8Bytes(body) > MAX_BODY_BYTES) {
    if (origin === 'client') {
      throw new MessagingError(
        'invalid',
        `body: at most ${MAX_BODY_BYTES} bytes (UTF-8)`,
        'body'
      );
    }
    body =
      truncateUtf8(body, MAX_BODY_BYTES - utf8Bytes(TRUNCATED)) + TRUNCATED;
  }
  const out: SanitizedContent = {
    body,
    refs: origin === 'peer' ? [] : [...(content.refs ?? [])],
  };
  if (data !== undefined) out.data = data;
  const choices =
    origin === 'peer' ? peerChoices(content.choices) : content.choices;
  if (choices !== undefined) out.choices = [...choices];
  return out;
}
