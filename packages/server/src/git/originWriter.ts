/**
 * The one door this daemon uses to write to origin's default branch.
 *
 * Two parts of the daemon push to the same branch on origin: the merge queue
 * landing a run (see OriginLander) and the board syncer committing task files
 * from its private worktree. Before this existed they raced each other. One
 * would fetch, compute, and push while the other's push slipped in between,
 * so the slower one got a rejected push, a wedged rebase, or (in one real
 * evening) a corrupt rebase-merge directory. Serializing every fetch → compute
 * → push sequence through one FIFO lock means the daemon never races itself.
 * A push from outside the daemon (a human, CI) can still race it, and each
 * writer handles that with its own rejected-push retry.
 *
 * A plain promise chain, not a general-purpose mutex: callers hold it only
 * across their own network round trips. A failed section still releases it,
 * so one bad push never wedges every later writer.
 */
export class OriginWriter {
  private tail: Promise<unknown> = Promise.resolve();
  private held = 0;

  /** Runs `section` once every earlier section has settled, then returns its result. */
  exclusive<T>(section: () => Promise<T>): Promise<T> {
    const run = this.tail.then(async () => {
      this.held += 1;
      try {
        return await section();
      } finally {
        this.held -= 1;
      }
    });
    // The chain must survive a rejection, or the first failed push would
    // reject every queued writer behind it without ever running them.
    this.tail = run.catch(() => undefined);
    return run;
  }

  /** Whether a section is running right now. For tests and diagnostics. */
  busy(): boolean {
    return this.held > 0;
  }
}
