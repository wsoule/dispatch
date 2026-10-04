import { describe, expect, it } from 'bun:test';

import { parseAddress } from '../src/address.js';
import { validateSendInput } from '../src/envelope.js';
import { MessagingError } from '../src/errors.js';

// Whatever a JSON body holds, validation answers with a MessagingError (or
// passes): never a TypeError that surfaces as a 500.
function refusesCleanly(fn: () => unknown): void {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MessagingError);
  }
}

const ok = { to: ['human:wyat'], kind: 'message', body: 'hi' };

describe('validateSendInput on non-string and non-object input', () => {
  const inputs: unknown[] = [
    null,
    undefined,
    'text',
    42,
    [],
    { ...ok, to: [null] },
    { ...ok, to: [1] },
    { ...ok, to: 'human:wyat' },
    { ...ok, kind: 7 },
    { ...ok, kind: null },
    { ...ok, kind: [Object.create(null)] },
    { ...ok, refs: 'task:t-1' },
    { ...ok, refs: [null] },
    { ...ok, refs: [{ type: 'task', id: 5 }] },
    { ...ok, refs: [{ type: 'task', id: 't-1', at: 3 }] },
    { ...ok, kind: 'question', choices: 'yes' },
    { ...ok, kind: 'question', choices: [1, 2] },
    { ...ok, kind: 'question', choices: [null] },
    { ...ok, kind: 'question', blocking: true, data: null },
    { ...ok, kind: 'question', blocking: true, data: 'scope' },
    {
      ...ok,
      kind: 'question',
      blocking: true,
      data: { type: 'scope', paths: 'a' },
    },
    { ...ok, session: 5 },
    { ...ok, choice: 5 },
    { ...ok, replyTo: 5 },
    { ...ok, replyTo: {} },
    { ...ok, replyTo: [] },
    { ...ok, replyTo: Object.create(null) },
    { ...ok, replyTo: [Object.create(null)] },
    { ...ok, idempotencyKey: {} },
  ];
  for (const [i, input] of inputs.entries()) {
    it(`case ${i}: ${JSON.stringify(input)}`, () => {
      refusesCleanly(() =>
        validateSendInput(input as never, 'human:wyat', true, null)
      );
    });
  }
});

describe('parseAddress on non-strings', () => {
  for (const raw of [null, undefined, 1, {}, [], true]) {
    it(`refuses ${JSON.stringify(raw)} with a MessagingError`, () => {
      expect(() => parseAddress(raw as never)).toThrow(MessagingError);
    });
  }
});
