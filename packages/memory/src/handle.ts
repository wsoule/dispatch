import { createHash } from 'node:crypto';

import { MemoryError } from './errors.js';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const HANDLE_PATTERN = /^#[0-9A-HJKMNP-TV-Z]{8}$/;
export const MEMORY_ID_PATTERN = /^mem-[0-9A-HJKMNP-TV-Z]{26}$/;
export const PROPOSAL_ID_PATTERN = /^mp-[0-9A-HJKMNP-TV-Z]{26}$/;

// '#' + 40 bits of sha256(id) in Crockford base32: a hash, so ids minted in
// one millisecond (which differ only at the end) get unrelated handles.
export function memoryHandle(id: string): string {
  const digest = createHash('sha256').update(id).digest();
  let bits = 0n;
  for (let i = 0; i < 5; i++) bits = (bits << 8n) | BigInt(digest[i]);
  let out = '';
  for (let shift = 35n; shift >= 0n; shift -= 5n)
    out += CROCKFORD[Number((bits >> shift) & 31n)];
  return `#${out}`;
}

export type MemoryRef =
  | { kind: 'handle'; handle: string }
  | { kind: 'id'; id: string };

/** Reads a `#handle` or full `mem-…` id; a messaging `m-…` id gets a hint. */
export function parseMemoryRef(raw: string, field = 'id'): MemoryRef {
  const value = raw.trim();
  if (value.startsWith('m-'))
    throw new MemoryError(
      'invalid',
      `${field}: that is a message id; memory handles start with #`,
      field
    );
  if (value.startsWith('#')) {
    const handle = value.toUpperCase();
    if (HANDLE_PATTERN.test(handle)) return { kind: 'handle', handle };
  } else if (MEMORY_ID_PATTERN.test(value)) {
    return { kind: 'id', id: value };
  }
  throw new MemoryError(
    'invalid',
    `${field}: expected a handle like #7QX2K9PA or an id like mem-01K…`,
    field
  );
}
