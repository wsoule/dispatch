import type { Ref } from '@dispatch-foo/protocol';
import { createHash } from 'node:crypto';

import type { MemoryKind } from './types.js';

// sha256 of (kind, title, body, refs): finds duplicate proposals and imports.
export function memoryContentHash(content: {
  kind: MemoryKind;
  title: string;
  body: string;
  refs: readonly Ref[];
}): string {
  const refs = content.refs.map((r) => [r.type, r.id, r.at ?? null]);
  return createHash('sha256')
    .update(JSON.stringify([content.kind, content.title, content.body, refs]))
    .digest('hex');
}

export function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/\s+/g, ' ').trim();
}
