// Writing to a child's stdin when the child may already be gone. Shared by
// the CLI executor (a piped prompt) and piped terminals (keystrokes); kept
// free of imports so the terminal host process can load it alone.

// Whether `err` is EPIPE: a write to a pipe whose reading end is closed.
export function isClosedPipe(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    (err as { code?: unknown }).code === 'EPIPE'
  );
}

/**
 * Runs a write to, a flush of, or the close of a child's stdin, and ignores
 * EPIPE. A child can exit, or close its stdin, before it reads what was
 * written, and that is not a failure of the write's caller: the child's exit
 * status and output say how it went.
 *
 * Bun's stdin sink reports EPIPE in one of two ways. If the child is already
 * gone but Bun has not yet noticed (the daemon got no CPU between the child's
 * exit and the write), write(), flush() or end() throws it synchronously. If
 * the child goes while a write is still flushing, the promise that call
 * returned rejects. Any other error is thrown or rejected as before.
 */
export function ignoreClosedPipe(op: () => unknown): void {
  let pending: unknown;
  try {
    pending = op();
  } catch (err) {
    if (!isClosedPipe(err)) throw err;
    return;
  }
  if (pending instanceof Promise)
    pending.catch((err: unknown) => {
      if (!isClosedPipe(err)) throw err;
    });
}
