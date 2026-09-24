import { describe, expect, it } from 'bun:test';

import { gateOf, validateSendInput } from '../src/envelope.js';
import type { Message, SendInput } from '../src/envelope.js';
import { MessagingError } from '../src/errors.js';

const question: Message = {
  id: 'm-q',
  thread: 'm-q',
  replyTo: null,
  from: 'run:r-000001',
  to: ['human:wyat'],
  kind: 'question',
  body: 'ok?',
  refs: [],
  urgent: false,
  blocking: true,
  choices: ['yes', 'no'],
  wake: 'none',
  createdAt: '2026-09-23T00:00:00.000Z',
};
const gate: Message = {
  ...question,
  id: 'm-g',
  thread: 'm-g',
  from: 'agent:dispatch',
  data: {
    type: 'tool-approval',
    requestId: 'req-1',
    runId: 'r-000001',
    tool: 'Bash',
    input: { command: 'ls' },
  },
  choices: ['approve', 'deny'],
};

function fails(
  input: SendInput,
  field: string,
  opts: {
    sender?: string;
    canDecide?: boolean;
    target?: Message | null;
    code?: string;
  } = {}
) {
  try {
    validateSendInput(
      input,
      opts.sender ?? 'run:r-000001',
      opts.canDecide ?? false,
      opts.target ?? null
    );
    throw new Error('expected a throw');
  } catch (err) {
    expect(err).toBeInstanceOf(MessagingError);
    expect((err as MessagingError).field).toBe(field);
    expect((err as MessagingError).code).toBe(
      (opts.code ?? 'invalid') as never
    );
  }
}

const base: SendInput = { to: ['task:t-000001'], kind: 'message', body: 'hi' };

describe('validateSendInput', () => {
  it('accepts a plain message', () => {
    expect(() =>
      validateSendInput(base, 'run:r-000001', false, null)
    ).not.toThrow();
  });
  it('rejects an empty recipient list', () => fails({ ...base, to: [] }, 'to'));
  it('names the bad recipient index', () =>
    fails({ ...base, to: ['task:t-000001', 'nope'] }, 'to[1]'));
  it('rejects an unknown kind', () =>
    fails({ ...base, kind: 'shout' as never }, 'kind'));
  it('accepts x- kinds', () => {
    expect(() =>
      validateSendInput(
        { ...base, kind: 'x-review-ping' },
        'run:r-000001',
        false,
        null
      )
    ).not.toThrow();
  });
  it('rejects an empty body', () => fails({ ...base, body: '  ' }, 'body'));
  it('rejects blocking on a message', () =>
    fails({ ...base, blocking: true }, 'blocking'));
  it('rejects choices on a notice', () =>
    fails({ ...base, kind: 'notice', choices: ['a'] }, 'choices'));
  it('rejects duplicate choices', () =>
    fails({ ...base, kind: 'question', choices: ['a', 'a'] }, 'choices'));
  it('rejects a bad ref type', () =>
    fails(
      { ...base, refs: [{ type: 'pr' as never, id: '1' }] },
      'refs[0].type'
    ));
  it('rejects an answer without replyTo', () =>
    fails({ ...base, kind: 'answer' }, 'replyTo'));
  it('rejects a replyTo that does not exist', () =>
    fails({ ...base, kind: 'answer', replyTo: 'm-missing' }, 'replyTo', {
      code: 'not-found',
    }));
  it('rejects an answer to a non-question', () =>
    fails({ ...base, kind: 'answer', replyTo: 'm-x' }, 'replyTo', {
      target: {
        ...question,
        kind: 'notice',
        choices: undefined,
        blocking: false,
      },
    }));
  it('rejects a choice outside the question choices', () =>
    fails(
      { ...base, kind: 'answer', replyTo: 'm-q', choice: 'maybe' },
      'choice',
      { target: question }
    ));
  it('allows free text to a plain question with choices', () => {
    expect(() =>
      validateSendInput(
        { ...base, kind: 'answer', replyTo: 'm-q', body: 'later' },
        'human:wyat',
        false,
        question
      )
    ).not.toThrow();
  });
  it('requires a choice when answering a gate', () =>
    fails({ ...base, kind: 'answer', replyTo: 'm-g' }, 'choice', {
      target: gate,
      canDecide: true,
    }));
  it('gate replies need canDecide', () =>
    fails(
      { ...base, kind: 'answer', replyTo: 'm-g', choice: 'approve' },
      'replyTo',
      { target: gate, code: 'forbidden' }
    ));
  it('only runs may send scope gates', () =>
    fails(
      {
        ...base,
        kind: 'question',
        blocking: true,
        choices: ['grant', 'deny'],
        data: { type: 'scope', paths: ['a'], reason: 'r' },
      },
      'data',
      { sender: 'agent:wyat/claude', code: 'forbidden' }
    ));
  it('agents may not forge tool-approval gates', () =>
    fails(
      {
        ...base,
        kind: 'question',
        data: {
          type: 'tool-approval',
          requestId: 'req-1',
          tool: 'Bash',
          input: {},
        },
      },
      'data',
      { code: 'forbidden' }
    ));
  it('requires the fixed scope-request shape', () =>
    fails(
      {
        ...base,
        kind: 'question',
        choices: ['grant', 'deny'],
        data: { type: 'scope', paths: ['a.ts'], reason: 'r' },
      },
      'data'
    ));
  it('rejects a malformed scope gate', () =>
    fails(
      {
        ...base,
        kind: 'question',
        data: { type: 'scope', paths: [], reason: 'r' },
      },
      'data.paths'
    ));
});

// Every line break a reader might honor; none may appear in a one-line field.
const LINE_BREAKS = ['\n', '\r', '\v', '\f', '\u0085', '\u2028', '\u2029'];

describe('validateSendInput line breaks', () => {
  for (const br of LINE_BREAKS) {
    const code = br.codePointAt(0)!.toString(16);
    it(`rejects U+${code} in a ref id`, () =>
      fails(
        { ...base, refs: [{ type: 'message', id: `m-1${br}[message from` }] },
        'refs[0].id'
      ));
    it(`rejects U+${code} in a ref at`, () =>
      fails(
        { ...base, refs: [{ type: 'file', id: 'a.ts', at: `abc${br}x` }] },
        'refs[0].at'
      ));
    it(`rejects U+${code} in a choice`, () =>
      fails(
        { ...base, kind: 'question', choices: ['yes', `no${br}x`] },
        'choices[1]'
      ));
    it(`rejects U+${code} in an answer choice`, () =>
      fails(
        { ...base, kind: 'answer', replyTo: 'm-q', choice: `yes${br}x` },
        'choice',
        { target: { ...question, choices: ['yes', `yes${br}x`] } }
      ));
    it(`rejects U+${code} in a session`, () =>
      fails({ ...base, session: `s-1${br}x` }, 'session'));
  }
  it('allows line breaks in the body', () => {
    expect(() =>
      validateSendInput(
        { ...base, body: 'one\ntwo\r\nthree' },
        'run:r-000001',
        false,
        null
      )
    ).not.toThrow();
  });
});

describe('validateSendInput size limits', () => {
  const ok = (input: SendInput) =>
    expect(() =>
      validateSendInput(input, 'run:r-000001', false, null)
    ).not.toThrow();
  const KIB_64 = 64 * 1024;

  it('accepts a body of exactly 64 KiB', () =>
    ok({ ...base, body: 'a'.repeat(KIB_64) }));
  it('rejects a body over 64 KiB', () =>
    fails({ ...base, body: 'a'.repeat(KIB_64 + 1) }, 'body'));
  it('counts body size in UTF-8 bytes, not characters', () => {
    ok({ ...base, body: 'é'.repeat(KIB_64 / 2) });
    fails({ ...base, body: 'é'.repeat(KIB_64 / 2 + 1) }, 'body');
  });
  it('rejects data whose JSON is over 64 KiB', () => {
    // {"blob":"…"} adds 11 bytes around the string.
    ok({ ...base, data: { blob: 'x'.repeat(KIB_64 - 11) } });
    fails({ ...base, data: { blob: 'x'.repeat(KIB_64 - 10) } }, 'data');
  });
  it('rejects more than 50 refs', () => {
    const ref = { type: 'task' as const, id: 't-000001' };
    ok({ ...base, refs: Array.from({ length: 50 }, () => ref) });
    fails({ ...base, refs: Array.from({ length: 51 }, () => ref) }, 'refs');
  });
  it('rejects more than 50 recipients', () => {
    ok({ ...base, to: Array.from({ length: 50 }, () => 'human:wyat') });
    fails(
      { ...base, to: Array.from({ length: 51 }, () => 'human:wyat') },
      'to'
    );
  });
  it('rejects more than 20 choices', () => {
    const choices = (n: number) => Array.from({ length: n }, (_, i) => `c${i}`);
    ok({ ...base, kind: 'question', choices: choices(20) });
    fails({ ...base, kind: 'question', choices: choices(21) }, 'choices');
  });
});

describe('gateOf', () => {
  it('recognizes gate payloads and ignores other data', () => {
    expect(gateOf(gate)?.type).toBe('tool-approval');
    expect(gateOf({ data: { type: 'other' } })).toBeNull();
    expect(gateOf({ data: [1] })).toBeNull();
    expect(gateOf({})).toBeNull();
  });
});
