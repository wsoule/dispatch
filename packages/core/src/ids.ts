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

// Same shape as generateTaskId's id (a short, collision-resistant hex tag),
// but for orchestrator runs, which have no title to mix into the hash — a
// timestamp plus a random nonce is enough entropy since runs are created one
// at a time per dispatch call, never in the tight batches task ids can see.
export function generateRunId(
  now: string,
  nonce: string = randomBytes(4).toString('hex')
): string {
  const hash = createHash('sha256')
    .update(`${now}\n${nonce}`)
    .digest('hex')
    .slice(0, 6);
  return `r-${hash}`;
}
