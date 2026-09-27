#!/usr/bin/env node
// The reference adapter over stdio: one JSON object per line each way, and
// nothing else on stdout. An error other than an unsupported op exits 1,
// which fails the vector in flight.
import type { RunnableVector } from '@dispatch/protocol-spec';
import { createInterface } from 'node:readline';

import { REFERENCE_HELLO, runVector } from './adapter.js';
import { UnsupportedOp } from './errors.js';

function out(msg: unknown): void {
  process.stdout.write(`${JSON.stringify(msg)}\n`);
}

async function handle(line: string): Promise<void> {
  const msg = JSON.parse(line) as { dmp?: string; vector?: RunnableVector };
  if (msg.dmp === 'hello') {
    out(REFERENCE_HELLO);
    return;
  }
  if (msg.dmp === 'bye') process.exit(0);
  if (msg.dmp !== 'run' || msg.vector === undefined) return;
  try {
    out(await runVector(msg.vector));
  } catch (err) {
    if (!(err instanceof UnsupportedOp)) throw err;
    out({ dmp: 'unsupported', id: msg.vector.id, reason: err.message });
  }
}

// Lines are handled one at a time, in order, so each answer follows its run.
let queue: Promise<void> = Promise.resolve();
createInterface({ input: process.stdin }).on('line', (line) => {
  queue = queue
    .then(() => handle(line))
    .catch((err: unknown) => {
      const why =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`${why}\n`, () => process.exit(1));
    });
});
