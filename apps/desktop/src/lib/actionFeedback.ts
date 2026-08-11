/**
 * Makes every project action report its own failure.
 *
 * `useDispatchProject` exposes ~45 mutation handlers and, before this, two of
 * them had a `catch`. Call sites mostly invoke them as `void data.handleX(...)`,
 * so a rejection became an unhandled promise: the button appeared to do
 * nothing, and the reason went to the console where nobody was looking.
 *
 * Wrapping the returned bag once is the right place for it. Doing it per
 * handler would be forty-five chances to forget, and the next handler added
 * would be the forty-sixth.
 */

/** Turns a handler name into something worth reading on a toast. */
export function describeAction(name: string): string {
  const stripped = name.replace(/^handle/, '');
  const spaced = stripped.replace(/([a-z0-9])([A-Z])/g, '$1 $2');
  return spaced.charAt(0).toUpperCase() + spaced.slice(1).toLowerCase();
}

/**
 * The daemon's message if there is one, since it is nearly always the useful part.
 *
 * Duck-typed rather than `instanceof Error`. That check is false for an error
 * thrown in a different realm — an iframe, a worker, or a differently-bundled
 * copy of a library — and the result is a toast that says "Unknown error" while
 * holding a perfectly good message. Anything carrying a string `message` is
 * close enough to an error to report as one.
 */
export function describeError(err: unknown): string {
  if (typeof err === 'string') return err;
  if (typeof err === 'object' && err !== null) {
    const message = (err as { message?: unknown }).message;
    if (typeof message === 'string' && message !== '') return message;
  }
  return 'Unknown error';
}

/**
 * Returns `api` with every function-valued `handle*` key wrapped so a rejection
 * is reported instead of lost. The wrapper re-throws nothing: these are
 * fire-and-forget UI actions, and a caller that wants the result already awaits
 * the original.
 */
/**
 * Handlers worth confirming, and what to say.
 *
 * Deliberately a short list. Most actions confirm themselves — a card moves
 * column, a row disappears — and a toast for those is noise that trains you to
 * ignore the ones that matter. These are the actions whose effect happens
 * somewhere you are not looking: a queue, a remote, a directory on disk.
 */
const SUCCESS_MESSAGES: Record<string, string> = {
  handleEnqueueMerge: 'Queued to merge',
  handleEnqueueMergeStack: 'Stack queued to merge',
  handleMergeAllReady: 'Ready work queued to merge',
  handleReview: 'Review recorded',
  handleOpenPr: 'Pull request opened',
  handleFreeBranchDisk: 'Worktree reclaimed',
  handleDeleteBranch: 'Branch deleted',
  handleArchiveRun: 'Run archived',
  handleCancelRun: 'Run cancelled',
  // Worth a toast even though the Stop button visibly changes: unlike every
  // other action here, nothing has finished yet — the agent is still working,
  // and the wording is what says the wait is expected rather than a stuck UI.
  handleStopRun: 'Stopping. The agent finishes its current step.',
};

export function withActionFeedback<T extends object>(
  api: T,
  onError: (action: string, message: string) => void,
  onSuccess?: (message: string) => void
): T {
  // `object` rather than Record<string, unknown>: the Record constraint widens
  // every property of the wrapped type to unknown at the call site, which turns
  // a typed project bag into `{}`.
  const out: Record<string, unknown> = { ...(api as Record<string, unknown>) };
  for (const [key, value] of Object.entries(api) as [string, unknown][]) {
    if (!key.startsWith('handle') || typeof value !== 'function') continue;
    const original = value as (...args: unknown[]) => unknown;
    out[key] = (...args: unknown[]) => {
      try {
        const success = SUCCESS_MESSAGES[key];
        const result = original(...args);
        if (result instanceof Promise) {
          return result
            .then((value: unknown) => {
              if (success !== undefined && onSuccess !== undefined) {
                onSuccess(success);
              }
              return value;
            })
            .catch((err: unknown) => {
              onError(describeAction(key), describeError(err));
              // Swallow deliberately: the failure has been reported, and
              // re-throwing would still land in an unhandled rejection at the
              // `void` call sites this exists to protect.
              return undefined;
            });
        }
        return result;
      } catch (err) {
        onError(describeAction(key), describeError(err));
        return undefined;
      }
    };
  }
  return out as T;
}
