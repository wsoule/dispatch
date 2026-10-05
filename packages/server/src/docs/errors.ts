import type { DocConflict } from '@dispatch-foo/core';

// The one error every docs layer throws; `code` maps to an HTTP status the way
// MessagingError's does, and `field` names the input an agent should fix.
export type DocsErrorCode =
  | 'invalid'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'limited'
  | 'unavailable';

export const DOCS_ERROR_STATUS: Record<DocsErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  limited: 429,
  unavailable: 503,
};

export class DocsError extends Error {
  constructor(
    readonly code: DocsErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = 'DocsError';
  }
}

// A whole-body save that cannot be merged, or whose base hash is stale: 409
// with the head and the hunks, and nothing stored.
export class DocConflictError extends DocsError {
  constructor(readonly conflict: DocConflict) {
    super(
      'conflict',
      conflict.reason === 'base-changed'
        ? 'your base changed: another editor of yours saved first'
        : `rev ${conflict.head.n} by ${conflict.head.author} changed the same lines`,
      'body'
    );
    this.name = 'DocConflictError';
  }
}
