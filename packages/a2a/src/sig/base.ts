import { serializeInnerList, serializeItem } from './sf.js';
import type { InnerList, Item } from './sf.js';

// The signature base of RFC 9421 §2.5: one line per covered component, then
// the @signature-params line. Any component it cannot resolve is an error.

export class SigBaseError extends Error {
  constructor(message: string) {
    super(`signature base: ${message}`);
    this.name = 'SigBaseError';
  }
}

export interface RequestParts {
  method: string;
  // Absolute; @authority, @path and @query are derived from it.
  targetUri: string;
  headers: Headers;
}

interface ResponseParts {
  status: number;
  headers: Headers;
}

export interface MessageParts {
  request?: RequestParts;
  response?: ResponseParts;
}

const PRINTABLE = /^[\x20-\x7e]*$/;

function uriOf(request: RequestParts): URL {
  try {
    return new URL(request.targetUri);
  } catch {
    throw new SigBaseError('bad target URI');
  }
}

// The target URI as RFC 9421 §2.2.2 reads it: no fragment, host lowercase,
// default port dropped (URL normalizes both).
function targetUri(u: URL): string {
  return `${u.protocol}//${u.host}${u.pathname}${u.search}`;
}

function derived(name: string, msg: RequestParts | ResponseParts): string {
  if (name === '@status') {
    if (!('status' in msg)) throw new SigBaseError('@status on a request');
    return String(msg.status);
  }
  if (!('targetUri' in msg))
    throw new SigBaseError(`${name} needs the request`);
  const u = uriOf(msg);
  switch (name) {
    case '@method':
      return msg.method;
    case '@target-uri':
      return targetUri(u);
    case '@authority':
      return u.host;
    case '@path':
      return u.pathname === '' ? '/' : u.pathname;
    case '@query':
      return u.search === '' ? '?' : u.search;
    default:
      throw new SigBaseError(`unknown component ${name}`);
  }
}

function componentValue(item: Item, msg: MessageParts): string {
  if (typeof item.value !== 'string')
    throw new SigBaseError('a component name must be a string');
  const name = item.value;
  for (const [param, value] of item.params)
    if (param !== 'req' || value !== true)
      throw new SigBaseError(`parameter ${param} is not understood`);
  const req = item.params.has('req');
  if (req && msg.response === undefined)
    throw new SigBaseError('req on a request');
  const context = req ? msg.request : (msg.response ?? msg.request);
  if (context === undefined) throw new SigBaseError(`no message for ${name}`);
  if (name === '@signature-params')
    throw new SigBaseError('@signature-params is never a covered component');
  if (name.startsWith('@')) return derived(name, context);
  if (name !== name.toLowerCase())
    throw new SigBaseError('field names are lowercase');
  const value = context.headers.get(name);
  if (value === null) throw new SigBaseError(`no ${name} field`);
  const trimmed = value.trim();
  if (!PRINTABLE.test(trimmed))
    throw new SigBaseError(`${name} is not printable ASCII`);
  return trimmed;
}

/** The signature base for `covered` over a request, or a response (with its request). */
export function signatureBase(covered: InnerList, msg: MessageParts): string {
  const seen = new Set<string>();
  const lines: string[] = [];
  for (const item of covered.items) {
    const id = serializeItem(item);
    if (seen.has(id)) throw new SigBaseError(`${id} is covered twice`);
    seen.add(id);
    lines.push(`${id}: ${componentValue(item, msg)}`);
  }
  lines.push(`"@signature-params": ${serializeInnerList(covered)}`);
  const base = lines.join('\n');
  for (let i = 0; i < base.length; i += 1)
    if (base.charCodeAt(i) > 0x7f) throw new SigBaseError('not ASCII');
  return base;
}
