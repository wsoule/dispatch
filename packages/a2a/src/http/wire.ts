import type { MessagingErrorCode } from '@dispatch/protocol';
import { MessagingError } from '@dispatch/protocol';

import { A2AError } from '../errors.js';
import type { A2AReason } from '../errors.js';

/** The header a standalone host forwards its A2A client's bearer in. */
export const PORT_CLIENT_HEADER = 'x-a2a-client-authorization';

/** An error as /api/a2a/port/* carries it, both sides of the contract. */
export type PortError =
  | {
      kind: 'messaging';
      code: MessagingErrorCode;
      message: string;
      field?: string;
    }
  | { kind: 'a2a'; reason: A2AReason; message: string }
  | { kind: 'auth'; status: 401 | 403; reason: string; message: string }
  | { kind: 'internal'; message: string };

const MESSAGING_STATUS: Record<MessagingErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  limited: 429,
};

// The daemon side: a port error as a status and a body the host rebuilds. An
// unexpected error is logged here and crosses as an opaque message.
export function portErrorJson(err: unknown): {
  status: number;
  body: { error: PortError };
} {
  if (err instanceof MessagingError) {
    return {
      status: MESSAGING_STATUS[err.code],
      body: {
        error: {
          kind: 'messaging',
          code: err.code,
          message: err.message,
          ...(err.field === undefined ? {} : { field: err.field }),
        },
      },
    };
  }
  if (err instanceof A2AError)
    return {
      status: err.reason === 'TASK_NOT_FOUND' ? 404 : 400,
      body: {
        error: { kind: 'a2a', reason: err.reason, message: err.message },
      },
    };
  console.error('a2a: port call failed', err);
  return {
    status: 500,
    body: {
      error: { kind: 'internal', message: 'the daemon failed this call' },
    },
  };
}

// The host side: the same error class, so handleA2A answers exactly as the
// in-daemon listener would. A client revoked mid-request reads as a refused
// sender.
export function portErrorFrom(status: number, body: unknown): Error {
  const e =
    typeof body === 'object' && body !== null
      ? (body as { error?: PortError }).error
      : undefined;
  if (e?.kind === 'messaging')
    return new MessagingError(e.code, e.message, e.field);
  if (e?.kind === 'a2a') return new A2AError(e.reason, e.message);
  if (e?.kind === 'auth')
    return new MessagingError('forbidden', e.message, 'from');
  return new Error(`the daemon answered HTTP ${status}`);
}
