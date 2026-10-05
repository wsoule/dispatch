/** Retry delays for notices a paired peer must hear: 30 s up to 24 h, then give up. */
const NOTICE_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
];

// One retried send per id: `send` resolves true once the peer heard it; after
// the last backoff step `settle(false)` gives up. Timers never hold the
// process open.
export class NoticeRetries {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(private readonly backoffMs: number[] = NOTICE_BACKOFF_MS) {}

  /** The delay before retry `attempt` (1-based), or undefined past the last. */
  delay(attempt: number): number | undefined {
    return this.backoffMs[attempt - 1];
  }

  start(
    id: string,
    send: () => Promise<boolean>,
    settle: (heard: boolean) => void,
    delayMs = 0,
    attempt = 0
  ): void {
    if (this.stopped) return;
    this.cancel(id);
    const t = setTimeout(() => {
      this.timers.delete(id);
      void (async () => {
        let heard = false;
        try {
          heard = await send();
        } catch {
          // Unreachable or unverifiable: retried.
        }
        if (this.stopped) return;
        if (heard) return settle(true);
        const next = this.delay(attempt + 1);
        if (next === undefined) return settle(false);
        this.start(id, send, settle, next, attempt + 1);
      })();
    }, delayMs);
    t.unref();
    this.timers.set(id, t);
  }

  cancel(id: string): void {
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }

  stop(): void {
    this.stopped = true;
    for (const t of this.timers.values()) clearTimeout(t);
    this.timers.clear();
  }
}
