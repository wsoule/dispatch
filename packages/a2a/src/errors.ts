import { MessagingError } from '@dispatch-foo/protocol';
import type { JsonValue } from '@dispatch-foo/protocol';

import { ENVELOPE_URI, WORK_URI } from './uris.js';

export type A2AReason =
  | 'TASK_NOT_FOUND'
  | 'TASK_NOT_CANCELABLE'
  | 'PUSH_NOTIFICATION_NOT_SUPPORTED'
  | 'UNSUPPORTED_OPERATION'
  | 'CONTENT_TYPE_NOT_SUPPORTED'
  | 'EXTENDED_AGENT_CARD_NOT_CONFIGURED'
  | 'VERSION_NOT_SUPPORTED'
  | 'INVALID_PARAMS';

// An A2A-domain error (a2a-protocol.org); handleA2A writes it as google.rpc.Status.
export class A2AError extends Error {
  constructor(
    readonly reason: A2AReason,
    message: string
  ) {
    super(message);
    this.name = 'A2AError';
  }
}

const A2A_DOMAIN = 'a2a-protocol.org';
const DISPATCH_DOMAIN = 'dispatch.foo';
const ERROR_INFO = 'type.googleapis.com/google.rpc.ErrorInfo';
const BAD_REQUEST = 'type.googleapis.com/google.rpc.BadRequest';

// google.rpc status per reason as @a2a-js/sdk 1.2.0 names it; HTTP status per
// the A2A 1.0 §5.4 table, which the TCK checks and the SDK's 400s miss twice.
export const A2A_SPECS: Record<A2AReason, { http: number; status: string }> = {
  TASK_NOT_FOUND: { http: 404, status: 'NOT_FOUND' },
  TASK_NOT_CANCELABLE: { http: 409, status: 'FAILED_PRECONDITION' },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { http: 400, status: 'FAILED_PRECONDITION' },
  UNSUPPORTED_OPERATION: { http: 400, status: 'FAILED_PRECONDITION' },
  CONTENT_TYPE_NOT_SUPPORTED: { http: 415, status: 'INVALID_ARGUMENT' },
  EXTENDED_AGENT_CARD_NOT_CONFIGURED: {
    http: 400,
    status: 'FAILED_PRECONDITION',
  },
  VERSION_NOT_SUPPORTED: { http: 400, status: 'FAILED_PRECONDITION' },
  INVALID_PARAMS: { http: 400, status: 'INVALID_ARGUMENT' },
};
const FORBIDDEN_REASONS: Record<string, string> = {
  urgent: 'URGENT_NOT_ALLOWED',
  wake: 'WAKE_NOT_ALLOWED',
  kind: 'KIND_NOT_ALLOWED',
};
const ENVELOPE_FIELD =
  /^(to|kind|replyTo|blocking|choices|choice|refs|urgent|wake)(\[|\.|$)/;

// The daemon behind a standalone host cannot be reached; answered 503.
export class DaemonUnavailableError extends Error {
  constructor() {
    super('the Dispatch daemon is unavailable; retry later');
    this.name = 'DaemonUnavailableError';
  }
}

// Carries a finished Response through a throw (415, 413).
export class HttpFailure extends Error {
  constructor(readonly response: Response) {
    super(`HTTP ${response.status}`);
    this.name = 'HttpFailure';
  }
}

type Detail = { '@type': string } & { [key: string]: JsonValue };

function status(
  http: number,
  name: string,
  message: string,
  details: Detail[],
  headers: Record<string, string> = {}
): Response {
  return new Response(
    JSON.stringify({ error: { code: http, status: name, message, details } }),
    {
      status: http,
      headers: { 'content-type': 'application/json', ...headers },
    }
  );
}

function info(reason: string, domain: string): Detail {
  return { '@type': ERROR_INFO, reason, domain };
}

// An engine or parser field as the A2A request path a client can fix.
export function a2aFieldPath(field: string): string {
  if (
    field.startsWith('message.') ||
    field === 'query' ||
    field === 'pageToken'
  )
    return field;
  if (field === 'body') return 'message.parts';
  if (field === 'data' || field.startsWith('data.'))
    return 'message.parts[].data';
  if (field.startsWith('work.'))
    return `message.metadata[${WORK_URI}].${field.slice('work.'.length)}`;
  if (ENVELOPE_FIELD.test(field))
    return `message.metadata[${ENVELOPE_URI}].${field}`;
  return field;
}

function badRequest(field: string, description: string): Response {
  return status(400, 'INVALID_ARGUMENT', description, [
    info('INVALID_PARAMS', A2A_DOMAIN),
    {
      '@type': BAD_REQUEST,
      fieldViolations: [{ field: a2aFieldPath(field), description }],
    },
  ]);
}

export function authFailure(
  code: 401 | 403,
  reason: string,
  message: string
): Response {
  return status(
    code,
    code === 401 ? 'UNAUTHENTICATED' : 'PERMISSION_DENIED',
    message,
    [info(reason, DISPATCH_DOMAIN)],
    code === 401 ? { 'www-authenticate': 'Bearer' } : {}
  );
}

export function rateLimited(
  retryAfterSec: number,
  message = 'rate limit reached; retry later'
): Response {
  return status(
    429,
    'RESOURCE_EXHAUSTED',
    message,
    [info('RATE_LIMITED', DISPATCH_DOMAIN)],
    { 'retry-after': String(retryAfterSec) }
  );
}

function a2aErrorResponse(err: A2AError): Response {
  const spec = A2A_SPECS[err.reason];
  return status(spec.http, spec.status, err.message, [
    info(err.reason, A2A_DOMAIN),
  ]);
}

// Engine and parser refusals as A2A answers; an absent and a forbidden
// target read alike, so a client cannot probe what exists.
function messagingErrorResponse(err: MessagingError): Response {
  const field = err.field ?? '';
  const hidden = err.code === 'forbidden' || err.code === 'not-found';
  if (hidden && field === 'taskId')
    return a2aErrorResponse(new A2AError('TASK_NOT_FOUND', 'task not found'));
  if (err.code === 'forbidden' && field === 'from')
    return authFailure(
      401,
      'AUTH_AGENT_REVOKED',
      "this client's access was revoked"
    );
  const named = Object.hasOwn(FORBIDDEN_REASONS, field);
  if (err.code === 'forbidden' && (/^to\[\d+\]$/.test(field) || named)) {
    return status(403, 'PERMISSION_DENIED', err.message, [
      info(
        named ? FORBIDDEN_REASONS[field] : 'FORBIDDEN_ADDRESS',
        DISPATCH_DOMAIN
      ),
    ]);
  }
  if (hidden && field === 'message.contextId')
    return badRequest(field, 'unknown contextId');
  if (hidden && (field === 'replyTo' || /^refs\[\d+\]/.test(field)))
    return badRequest(field, 'unknown message');
  if (err.code === 'conflict')
    return a2aErrorResponse(new A2AError('UNSUPPORTED_OPERATION', err.message));
  if (err.code === 'limited') return rateLimited(60, err.message);
  return badRequest(field, err.message);
}

// Any thrown value as a response; an unknown error is logged, never sent.
export function errorResponse(err: unknown): Response {
  if (err instanceof HttpFailure) return err.response;
  if (err instanceof A2AError) return a2aErrorResponse(err);
  if (err instanceof MessagingError) return messagingErrorResponse(err);
  if (err instanceof DaemonUnavailableError) {
    console.error(`a2a: ${err.message}`);
    return status(503, 'UNAVAILABLE', err.message, [], { 'retry-after': '5' });
  }
  console.error('a2a: request failed', err);
  return status(500, 'INTERNAL', 'internal error', []);
}
