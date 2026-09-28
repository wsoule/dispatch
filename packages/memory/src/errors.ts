export type MemoryErrorCode =
  | 'invalid'
  | 'forbidden'
  | 'not-found'
  | 'conflict'
  | 'limited'
  | 'unavailable';

export const MEMORY_ERROR_STATUS: Record<MemoryErrorCode, number> = {
  invalid: 400,
  forbidden: 403,
  'not-found': 404,
  conflict: 409,
  limited: 429,
  unavailable: 503,
};

// One error for every memory failure; `field` names the bad input so an agent can fix it.
export class MemoryError extends Error {
  constructor(
    readonly code: MemoryErrorCode,
    message: string,
    readonly field?: string
  ) {
    super(message);
    this.name = 'MemoryError';
  }

  get status(): number {
    return MEMORY_ERROR_STATUS[this.code];
  }
}
