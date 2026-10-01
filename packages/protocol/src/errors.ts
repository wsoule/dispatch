import type { ERROR_CODES } from './constants.js';

export type MessagingErrorCode = keyof typeof ERROR_CODES;

// One error type for every protocol failure; hosts map `code` to the status
// ERROR_CODES gives it.
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
