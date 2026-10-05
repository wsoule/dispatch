import type { A2AStore, PendingNotice } from '@dispatch/a2a';

/** Retry delays for notices a paired peer must hear: 30 s up to 24 h, then give up. */
const NOTICE_BACKOFF_MS = [
  30_000, 120_000, 600_000, 3_600_000, 21_600_000, 86_400_000,
];

// Retried sends of one kind of pending notice. Each notice is a row in
// a2a.db with its attempt count, so a restart resumes where it left off:
// `send` resolves true once the peer heard it, and after the last backoff
// step `settle(false)` gives up. The row is gone before settle runs.
export class NoticeRetries {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private stopped = false;
  constructor(
    private readonly store: A2AStore,
    private readonly kind: PendingNotice['kind'],
    private readonly backoffMs: number[] = NOTICE_BACKOFF_MS
  ) {}

  /** Tries notice `id` after `delayMs`; resolves with whether that first try was heard. */
  start(
    id: string,
    send: () => Promise<boolean>,
    settle: (heard: boolean) => void,
    delayMs = 0
  ): Promise<boolean> {
    if (this.stopped) return Promise.resolve(false);
    this.cancel(id);
    return new Promise((resolve) => {
      const t = setTimeout(() => {
        this.timers.delete(id);
        void this.attempt(id, send, settle).then(resolve);
      }, delayMs);
      t.unref();
      this.timers.set(id, t);
    });
  }

  private async attempt(
    id: string,
    send: () => Promise<boolean>,
    settle: (heard: boolean) => void
  ): Promise<boolean> {
    let heard = false;
    try {
      heard = await send();
    } catch {
      // Unreachable or unverifiable: retried.
    }
    if (this.stopped) return heard;
    if (heard) {
      this.store.deleteNotice(this.kind, id);
      settle(true);
      return true;
    }
    const next = this.backoffMs[this.store.noteAttempt(this.kind, id) - 1];
    if (next === undefined) {
      this.store.deleteNotice(this.kind, id);
      settle(false);
    } else {
      void this.start(id, send, settle, next);
    }
    return false;
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
