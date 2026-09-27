import { createHash } from 'node:crypto';

import { crockford32 } from './encoding.js';
import { TAG } from './ops.js';

// What two people compare out of band: the first 15 bytes of a tagged hash
// over both public keys, as six groups of four Crockford characters.
export function fingerprint(signPub: string, sealPub: string): string {
  const digest = createHash('sha256')
    .update(`${TAG.fingerprint}\n${signPub}\n${sealPub}`)
    .digest();
  return (crockford32(digest.subarray(0, 15)).match(/.{4}/g) ?? []).join('-');
}
