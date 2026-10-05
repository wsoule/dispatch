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

// Another writer held the database past the short busy wait; retry shortly.
export class MemoryBusyError extends MemoryError {
  constructor() {
    super('unavailable', 'the memory database is busy; retry shortly', 'store');
    this.name = 'MemoryBusyError';
  }
}

// Whether `err` is SQLite reporting a lock another connection holds.
export function isSqliteBusy(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' && /^SQLITE_(BUSY|LOCKED)/.test(code);
}
