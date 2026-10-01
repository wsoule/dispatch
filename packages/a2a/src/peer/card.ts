import type { JsonValue } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';

import type { GuardOptions } from './guard.js';
import {
  isLoopbackHost,
  peerFetch,
  PeerHttpError,
  readCapped,
} from './http.js';

export interface PeerInterface {
  url: string;
  binding: 'HTTP+JSON' | 'JSONRPC';
}
export type PeerAuth =
  | { kind: 'none' }
  | { kind: 'bearer' }
  | { kind: 'api-key'; header: string };
/** A peer's credential as the daemon hands it over; the shape of core's PeerCredential. */
export interface PeerSecret {
  scheme: 'bearer' | 'api-key';
  token: string;
  header?: string;
}
export interface PeerCardSummary {
  name: string;
  description: string;
  skills: { id: string; name: string; description: string }[];
  streaming: boolean;
}
export interface FetchedCard {
  json: Record<string, JsonValue>;
  etag: string | null;
  notModified: boolean;
}

export const CARD_MAX_BYTES = 262_144;
const BINDINGS = new Set(['HTTP+JSON', 'JSONRPC']);
// An RFC 9110 field name, and the fields a credential must never replace.
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const RESERVED_HEADERS = new Set([
  'host',
  'content-length',
  'transfer-encoding',
  'connection',
]);

// A token as one header value: visible ASCII only (RFC 9110 visible characters, no space).
const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

type Json = Record<string, JsonValue>;
const obj = (v: JsonValue | undefined): Json | null =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? v : null;
const str = (v: JsonValue | undefined): string =>
  typeof v === 'string' ? v : '';
const invalid = (field: string, why: string): never => {
  throw new MessagingError('invalid', `${field}: ${why}`, field);
};

// https only, except loopback or an operator's --allow-http; no redirects,
// 10 s, 256 KiB (spec:1403-1405). A `guard` pins the fetch to a public address.
export async function fetchPeerCard(
  cardUrl: string,
  o: {
    allowHttp: boolean;
    etag?: string | null;
    fetchImpl?: typeof fetch;
    timeoutMs?: number;
    guard?: GuardOptions;
  }
): Promise<FetchedCard> {
  let url: URL;
  try {
    url = new URL(cardUrl);
  } catch {
    return invalid('cardUrl', 'not a URL');
  }
  const plainOk =
    url.protocol === 'http:' && (o.allowHttp || isLoopbackHost(url.hostname));
  if (url.protocol !== 'https:' && !plainOk)
    invalid(
      'cardUrl',
      'must be https (http only for loopback or with --allow-http)'
    );
  const headers: Record<string, string> = { accept: 'application/json' };
  if (o.etag !== undefined && o.etag !== null && o.etag !== '')
    headers['if-none-match'] = o.etag;
  let res: Response;
  try {
    res = await peerFetch({
      headers,
      fetchImpl: o.fetchImpl,
      timeoutMs: o.timeoutMs ?? 10_000,
      maxBodyBytes: CARD_MAX_BYTES,
      guard:
        o.guard === undefined ? undefined : { field: 'cardUrl', ...o.guard },
    })(url);
  } catch (err) {
    if (err instanceof PeerHttpError && err.reason === 'ADDRESS_REFUSED')
      return invalid('cardUrl', err.message.replace(/^cardUrl: /, ''));
    throw err;
  }
  if (res.status === 304)
    return { json: {}, etag: o.etag ?? null, notModified: true };
  if (!res.ok) {
    await res.body?.cancel().catch(() => undefined);
    throw new PeerHttpError(
      res.status,
      `the card URL answered HTTP ${res.status}`
    );
  }
  const text = await readCapped(res, CARD_MAX_BYTES, 'cardUrl');
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return invalid('cardUrl', 'the card is not JSON');
  }
  const json = obj(parsed as JsonValue);
  if (json === null) return invalid('cardUrl', 'the card is not a JSON object');
  return { json, etag: res.headers.get('etag'), notModified: false };
}

// The first 1.0 interface in a binding the daemon speaks (spec:1406-1409, §8.3.2).
export function pickInterface(card: Json): PeerInterface | null {
  const list = Array.isArray(card.supportedInterfaces)
    ? card.supportedInterfaces
    : [];
  for (const entry of list) {
    const i = obj(entry);
    if (i === null) continue;
    const [major, minor] = str(i.protocolVersion).split('.');
    if (
      major === '1' &&
      minor === '0' &&
      BINDINGS.has(str(i.protocolBinding)) &&
      str(i.url) !== ''
    ) {
      return {
        url: str(i.url),
        binding: str(i.protocolBinding) as PeerInterface['binding'],
      };
    }
  }
  return null;
}

function schemeAuth(
  scheme: Json | null,
  apiKeyHeader?: string
): PeerAuth | null {
  if (scheme === null) return null;
  const http = obj(scheme.httpAuthSecurityScheme);
  if (http !== null && str(http.scheme).toLowerCase() === 'bearer')
    return { kind: 'bearer' };
  const key = obj(scheme.apiKeySecurityScheme);
  const header = apiKeyHeader ?? str(key?.name);
  if (
    key !== null &&
    str(key.location).toLowerCase() === 'header' &&
    header !== ''
  )
    return { kind: 'api-key', header };
  return null;
}

// A bearer or a header API key satisfies v1; OAuth2, OIDC and mTLS do not (spec:1414-1416).
export function peerAuthFor(card: Json, apiKeyHeader?: string): PeerAuth {
  const requirements = Array.isArray(card.securityRequirements)
    ? card.securityRequirements
    : [];
  if (requirements.length === 0) return { kind: 'none' };
  const schemes = obj(card.securitySchemes) ?? {};
  for (const requirement of requirements) {
    const names = Object.keys(obj(obj(requirement)?.schemes) ?? {});
    if (names.length !== 1 || !Object.hasOwn(schemes, names[0])) continue;
    const auth = schemeAuth(obj(schemes[names[0]]), apiKeyHeader);
    if (auth !== null) return auth;
  }
  return invalid(
    'cardUrl',
    'the peer needs OAuth2, OpenID Connect or mTLS, which Dispatch does not support yet'
  );
}

// The credential as request headers; refuses a value or name a request cannot
// carry safely (a line break, a bad field name, Host and friends).
export function authHeaders(
  auth: PeerAuth,
  secret: PeerSecret | null
): Record<string, string> {
  if (auth.kind === 'none') return {};
  if (secret === null)
    return invalid(
      'token',
      'this peer needs a credential; pass one with --token-stdin'
    );
  // Never echoes the value: an error message may reach logs or a client.
  if (!VISIBLE_ASCII.test(secret.token))
    invalid(
      'token',
      'the credential must be visible ASCII (0x21-0x7E), with no spaces'
    );
  if (auth.kind === 'bearer')
    return { authorization: `Bearer ${secret.token}` };
  const header = secret.header ?? auth.header;
  if (!HEADER_NAME.test(header) || RESERVED_HEADERS.has(header.toLowerCase()))
    invalid('token', `cannot send an API key in ${JSON.stringify(header)}`);
  return { [header]: secret.token };
}

export function summarizeCard(card: Json): PeerCardSummary {
  const skills = (Array.isArray(card.skills) ? card.skills : []).flatMap(
    (s) => {
      const skill = obj(s);
      return skill === null
        ? []
        : [
            {
              id: str(skill.id),
              name: str(skill.name),
              description: str(skill.description),
            },
          ];
    }
  );
  return {
    name: str(card.name),
    description: str(card.description),
    skills,
    streaming: obj(card.capabilities)?.streaming === true,
  };
}

// The interface URL a card names: http(s) with no userinfo, and https unless
// it is loopback or the operator allowed http.
function interfaceUrl(raw: string, allowHttp: boolean): URL {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return invalid('cardUrl', 'the peer interface URL is not a URL');
  }
  if (url.username !== '' || url.password !== '')
    invalid('cardUrl', 'the peer interface URL carries a user or password');
  const plainOk =
    url.protocol === 'http:' && (allowHttp || isLoopbackHost(url.hostname));
  if (url.protocol !== 'https:' && !plainOk)
    invalid('cardUrl', `the peer interface must be https, not ${url.protocol}`);
  return url;
}

// Interface, origin pin and auth, the checks an add and every refresh run (spec:1406-1416).
export function checkPeerCard(i: {
  cardUrl: string;
  card: Json;
  allowOrigin: boolean;
  allowHttp?: boolean;
  apiKeyHeader?: string;
}): { iface: PeerInterface; auth: PeerAuth; summary: PeerCardSummary } {
  const iface =
    pickInterface(i.card) ??
    invalid(
      'cardUrl',
      'the peer offers no A2A 1.0 HTTP+JSON or JSON-RPC interface'
    );
  const cardOrigin = new URL(i.cardUrl).origin;
  const ifaceOrigin = interfaceUrl(iface.url, i.allowHttp === true).origin;
  if (cardOrigin !== ifaceOrigin && !i.allowOrigin) {
    invalid(
      'allowOrigin',
      `the card at ${cardOrigin} points at ${ifaceOrigin}; confirm with --allow-origin`
    );
  }
  return {
    iface,
    auth: peerAuthFor(i.card, i.apiKeyHeader),
    summary: summarizeCard(i.card),
  };
}
