export type ToastTone = 'error' | 'success' | 'info';

/** Errors do not auto-dismiss: a failure you did not manage to read is the
 * same as a failure that was never reported. */
export function sonnerOptionsFor(tone: ToastTone): { duration: number } {
  const ms = { success: 3500, info: 4500, error: Infinity } as const;
  return { duration: ms[tone] };
}
