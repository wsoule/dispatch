import { MessagingError } from '@dispatch-foo/protocol';
import { describe, expect, it } from 'bun:test';

import { parsePortContinue, parsePortOpen } from '../../src/http/input.js';
import { ENVELOPE_URI } from '../../src/uris.js';

const open: Record<string, unknown> = {
  clientMessageId: 'm-1',
  contextId: null,
  kind: 'ask',
  to: null,
  replyTo: null,
  body: 'Are you there?',
  refs: [],
};

const refused = (fn: () => unknown, field?: string) => {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(MessagingError);
    expect((err as MessagingError).code).toBe('invalid');
    if (field !== undefined) expect((err as MessagingError).field).toBe(field);
    return;
  }
  throw new Error('expected a refusal');
};

describe('parsePortOpen', () => {
  it('passes a well-formed ask through', () => {
    expect(parsePortOpen({ ...open, choices: ['yes', 'no'] })).toEqual<
      Record<string, unknown>
    >({
      ...open,
      choices: ['yes', 'no'],
    });
  });

  it('refuses a body that is not an object, and fields of the wrong shape', () => {
    for (const raw of [null, 'ask', [], 42]) refused(() => parsePortOpen(raw));
    refused(() => parsePortOpen({ ...open, clientMessageId: 7 }));
    refused(() => parsePortOpen({ ...open, body: 7 }), 'body');
    refused(() => parsePortOpen({ ...open, refs: 'm-1' }), 'refs');
    refused(() => parsePortOpen({ ...open, to: 'human:wyat' }), 'to');
    refused(() => parsePortOpen({ ...open, contextId: 3 }), 'contextId');
    refused(() =>
      parsePortOpen({ ...open, refs: [{ type: 'file', id: 'a.ts' }] })
    );
  });

  it('limits kind to what a client can send, and work to the skills that need it', () => {
    for (const kind of ['question', 'answer', 'x-breaker', 'gate'])
      refused(() => parsePortOpen({ ...open, kind }), 'kind');
    refused(() => parsePortOpen({ ...open, kind: 'handoff' }), 'work');
    refused(
      () => parsePortOpen({ ...open, work: { skill: 'status' } }),
      'work'
    );
    const work = { skill: 'handoff' as const, title: 'Fix the build' };
    expect(parsePortOpen({ ...open, kind: 'handoff', work }).work).toEqual(
      work
    );
    expect(
      parsePortOpen({ ...open, kind: 'status', work: { skill: 'status' } }).kind
    ).toBe('status');
    refused(() => parsePortOpen({ ...open, kind: 'status', work }), 'work');
  });

  it('re-wraps data under the envelope URI, so it can never read as a gate', () => {
    const gate = { type: 'gate', gate: { id: 'g-1' } };
    expect(parsePortOpen({ ...open, data: gate }).data).toEqual({
      [ENVELOPE_URI]: gate,
    });
    const wrapped = { [ENVELOPE_URI]: [1, 2] };
    expect(parsePortOpen({ ...open, data: wrapped }).data).toEqual(wrapped);
  });

  it('applies the client size rules', () => {
    refused(
      () => parsePortOpen({ ...open, body: 'x'.repeat(64 * 1024 + 1) }),
      'body'
    );
    refused(() => parsePortOpen({ ...open, body: ' ' }), 'body');
  });
});

describe('parsePortContinue', () => {
  const next = {
    clientMessageId: 'm-2',
    taskId: 'm-1',
    contextId: 't-1',
    body: 'Yes.',
    refs: [],
  };

  it('passes a well-formed reply through, choice included', () => {
    expect(parsePortContinue({ ...next, choice: 'yes' })).toEqual({
      ...next,
      choice: 'yes',
    });
  });

  it('refuses a missing task id and a malformed choice', () => {
    refused(() => parsePortContinue({ ...next, taskId: undefined }), 'taskId');
    refused(() => parsePortContinue({ ...next, choice: ['a'] }), 'choice');
    refused(() => parsePortContinue(null));
  });
});
