import { MessagingError } from '@dispatch/protocol';
import { expect, it, spyOn } from 'bun:test';

import { A2AError } from '../../src/errors.js';
import { portErrorFrom, portErrorJson } from '../../src/http/wire.js';

it('carries messaging and A2A errors across HTTP unchanged', () => {
  for (const err of [
    new MessagingError('forbidden', 'nope', 'to[0]'),
    new MessagingError('limited', 'slow down', 'from'),
    new A2AError('TASK_NOT_FOUND', 'task not found'),
  ]) {
    const { status, body } = portErrorJson(err);
    const back = portErrorFrom(status, JSON.parse(JSON.stringify(body)));
    expect(back.constructor).toBe(err.constructor);
    expect(back).toMatchObject({ message: err.message });
  }
  expect(portErrorJson(new MessagingError('limited', 'x')).status).toBe(429);
  expect(portErrorJson(new A2AError('TASK_NOT_FOUND', 'x')).status).toBe(404);
});

it('reads a client revoked mid-request as a revoked sender, and hides internal errors', () => {
  expect(
    portErrorFrom(401, {
      error: {
        kind: 'auth',
        status: 401,
        reason: 'AUTH_AGENT_REVOKED',
        message: 'revoked',
      },
    })
  ).toMatchObject({ code: 'forbidden', field: 'from' });
  const spy = spyOn(console, 'error').mockImplementation(() => undefined);
  try {
    expect(portErrorJson(new Error('secret path /Users/x')).body.error).toEqual(
      { kind: 'internal', message: 'the daemon failed this call' }
    );
  } finally {
    spy.mockRestore();
  }
  expect(portErrorFrom(502, 'garbage').message).toBe(
    'the daemon answered HTTP 502'
  );
});
