#!/usr/bin/env node
// The reference adapter over stdio: one JSON line each way and nothing else on
// stdout; an error other than an unsupported op exits 1, failing the vector.
import type { RunnableVector } from '@dispatch/protocol-spec';

import { REFERENCE_HELLO, runVector } from './adapter.js';
import { UnsupportedOp } from './errors.js';

const SEPARATORS = /[\u2028\u2029]/g;

// Writes one JSON line with U+2028 and U+2029 escaped (the same JSON value),
// so a reader that breaks lines at them still sees whole lines.
function out(msg: unknown): void {
  const text = JSON.stringify(msg).replace(
    SEPARATORS,
    (c) => `\\u${c.charCodeAt(0).toString(16)}`
  );
  process.stdout.write(`${text}\n`);
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
function enqueue(line: string): void {
  queue = queue
    .then(() => handle(line))
    .catch((err: unknown) => {
      const why =
        err instanceof Error ? (err.stack ?? err.message) : String(err);
      process.stderr.write(`${why}\n`, () => process.exit(1));
    });
}

// Splits stdin at LF alone (a CR before it is dropped), so U+2028 and U+2029
// inside a JSON string never end a line.
let buffered = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk: string) => {
  const lines = (buffered + chunk).split('\n');
  buffered = lines.pop() ?? '';
  for (const line of lines)
    enqueue(line.endsWith('\r') ? line.slice(0, -1) : line);
});
process.stdin.on('end', () => {
  if (buffered !== '') enqueue(buffered);
});
