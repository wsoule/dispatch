/** Why a roster action was refused; the routes map each code to a status. */
export class RosterError extends Error {
  override name = 'RosterError';
  constructor(
    readonly code: 'forbidden' | 'conflict' | 'seat_limit' | 'invalid',
    message: string
  ) {
    super(message);
  }
}
