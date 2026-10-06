import { createHash } from 'node:crypto';

import { isInnerList, parseDictionary } from './sf.js';

function sha256(body: Uint8Array): Buffer {
  return createHash('sha256').update(body).digest();
}

/** The RFC 9530 Content-Digest field value for `body`, sha-256 only. */
export function contentDigest(body: Uint8Array): string {
  return `sha-256=:${sha256(body).toString('base64')}:`;
}

/** Whether `header` carries a sha-256 member equal to `body`'s digest; other members are ignored. */
export function digestMatches(
  header: string | null,
  body: Uint8Array
): boolean {
  if (header === null) return false;
  let member;
  try {
    member = parseDictionary(header).get('sha-256');
  } catch {
    return false;
  }
  if (member === undefined || isInnerList(member)) return false;
  if (!(member.value instanceof Uint8Array)) return false;
  return Buffer.from(member.value).equals(sha256(body));
}
