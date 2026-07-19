import { createHash, randomBytes } from 'node:crypto';

import type { TaskKind } from './types.js';

export function generateTaskId(
  kind: TaskKind,
  title: string,
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const prefix = kind === 'epic' ? 'e' : 't';
  const hash = createHash('sha256')
    .update(`${now}\n${title}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `${prefix}-${hash}`;
}
