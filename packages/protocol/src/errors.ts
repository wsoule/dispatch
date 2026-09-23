export type MessagingErrorCode =
  | 'invalid'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'limited';

// One error type for every protocol failure; hosts map `code` to a status
// (invalid→400, forbidden→403, not-found→404, conflict→409, limited→429).
export class MessagingError extends Error {
  constructor(
    readonly code: MessagingErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = 'MessagingError';
  }
}
