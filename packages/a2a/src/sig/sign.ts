import { randomBytes, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

import { signatureBase } from './base.js';
import type { RequestParts } from './base.js';
import { contentDigest } from './digest.js';
import { isInnerList, parseDictionary, serializeInnerList } from './sf.js';
import type { InnerList, Item, Params } from './sf.js';

export const SIG_TAG = 'dispatch-a2a-sig-v1';
export const SIG_ALG = 'ecdsa-p256-sha256';
export const SIG_EXTENSION_URI = 'https://dispatch.foo/a2a/ext/sig/v1';
// The label Dispatch signs under; verifiers find the signature by its tag.
const SIG_LABEL = 'a2a';
// The longest a signature may live (expires - created), in seconds.
export const SIG_LIFETIME_S = 300;

const plain = (name: string): Item => ({ value: name, params: new Map() });

/** What every Dispatch request signature covers. */
export function requestComponents(hasBody: boolean): string[] {
  return [
    '@method',
    '@target-uri',
    '@authority',
    ...(hasBody ? ['content-digest', 'content-type'] : []),
    'a2a-version',
  ];
}

// The request's own Dispatch signature: its label and covered components.
function taggedRequest(
  headers: Headers
): { label: string; items: Item[] } | null {
  const input = headers.get('signature-input');
  if (input === null) return null;
  try {
    for (const [label, member] of parseDictionary(input))
      if (isInnerList(member) && member.params.get('tag') === SIG_TAG)
        return { label, items: member.items };
  } catch {
    // An unreadable input names no signature.
  }
  return null;
}

function sigParams(keyid: string, now: Date, nonce: string): Params {
  const created = Math.floor(now.getTime() / 1000);
  return new Map<string, string | number>([
    ['created', created],
    ['expires', created + SIG_LIFETIME_S],
    ['nonce', nonce],
    ['keyid', keyid],
    ['alg', SIG_ALG],
    ['tag', SIG_TAG],
  ]);
}

function finish(
  covered: InnerList,
  base: string,
  privateKey: KeyObject,
  digest: string | undefined
): Record<string, string> {
  const signature = sign('sha256', Buffer.from(base), {
    key: privateKey,
    dsaEncoding: 'ieee-p1363',
  });
  return {
    ...(digest === undefined ? {} : { 'content-digest': digest }),
    'signature-input': `${SIG_LABEL}=${serializeInnerList(covered)}`,
    signature: `${SIG_LABEL}=:${signature.toString('base64')}:`,
  };
}

export interface SignRequestInput {
  method: string;
  targetUri: string;
  headers: Headers;
  body: Uint8Array | null;
  keyid: string;
  privateKey: KeyObject;
  now: Date;
  nonce?: string;
}

/** Signature headers (and Content-Digest) for a request; throws if a covered field is missing. */
export function signRequest(i: SignRequestInput): Record<string, string> {
  const headers = new Headers(i.headers);
  const digest = i.body === null ? undefined : contentDigest(i.body);
  if (digest !== undefined) headers.set('content-digest', digest);
  const covered: InnerList = {
    items: requestComponents(i.body !== null).map(plain),
    params: sigParams(
      i.keyid,
      i.now,
      i.nonce ?? randomBytes(16).toString('base64url')
    ),
  };
  const base = signatureBase(covered, {
    request: { method: i.method, targetUri: i.targetUri, headers },
  });
  return finish(covered, base, i.privateKey, digest);
}

export interface SignResponseInput {
  status: number;
  headers: Headers;
  body: Uint8Array | null;
  // The request answered, its own signature headers included.
  request: RequestParts;
  keyid: string;
  privateKey: KeyObject;
  now: Date;
}

/**
 * Response components: status and content, every request component under
 * req, and the request's own signature (RFC 9421 §2.4), so the response binds
 * to that one request and not to any identical one.
 */
export function responseItems(
  hasBody: boolean,
  requestHeaders: Headers,
  hasContentType = hasBody
): Item[] {
  const signed = taggedRequest(requestHeaders);
  const asReq = (item: Item): Item => ({
    value: item.value,
    params: new Map([...item.params, ['req', true]]) as Params,
  });
  return [
    plain('@status'),
    ...(hasBody ? [plain('content-digest')] : []),
    // Covered whenever present, so a JSON reply cannot be relabelled a stream.
    ...(hasContentType ? [plain('content-type')] : []),
    ...(
      signed?.items ?? ['@method', '@target-uri', '@authority'].map(plain)
    ).map(asReq),
    ...(signed === null
      ? []
      : [
          {
            value: 'signature',
            params: new Map<string, string | boolean>([
              ['key', signed.label],
              ['req', true],
            ]) as Params,
          },
        ]),
  ];
}

export function signResponse(i: SignResponseInput): Record<string, string> {
  const headers = new Headers(i.headers);
  const digest = i.body === null ? undefined : contentDigest(i.body);
  if (digest !== undefined) headers.set('content-digest', digest);
  const covered: InnerList = {
    items: responseItems(
      i.body !== null,
      i.request.headers,
      headers.has('content-type')
    ),
    params: sigParams(i.keyid, i.now, randomBytes(16).toString('base64url')),
  };
  const base = signatureBase(covered, {
    response: { status: i.status, headers },
    request: i.request,
  });
  return finish(covered, base, i.privateKey, digest);
}
