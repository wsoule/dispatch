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
