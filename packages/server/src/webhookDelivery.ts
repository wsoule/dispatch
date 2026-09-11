import type { NotificationsConfig } from '@dispatch/core';

import type { DecisionItem } from './decisionFeed.js';
import type { EventBus } from './events.js';

/** The JSON body one webhook POST carries. `item` is the feed's own record,
 *  unchanged, so a receiver sees exactly what the app would show. */
export interface WebhookPayload {
  event: 'decision.opened';
  sentAt: string;
  /** Which project this came from — one Slack channel may take several. */
  project: { rootDir: string };
  item: DecisionItem;
}

/** The slice of DecisionFeed this deliverer reads: the open items, already
 *  classified, so the blocking-vs-recorded filter happens here per item. */
interface WebhookDeliveryFeed {
  list(): DecisionItem[];
}

export interface WebhookDeliveryContext {
  rootDir: string;
  feed: WebhookDeliveryFeed;
  events: Pick<EventBus, 'subscribe'>;
  /** Read on every pass rather than once at boot, so editing the URL or a
   *  toggle in config.yml applies without restarting the daemon. May throw
   *  (a malformed config.yml); the pass is skipped and the error logged. */
  readConfig: () => NotificationsConfig;
  /** Test seam. Defaults to the global fetch. */
  fetch?: typeof globalThis.fetch;
  /** Test seam. Defaults to console.warn. */
  log?: (message: string) => void;
  /** Ceiling on one POST. Defaults to 10 seconds. */
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Posts each newly-blocking decision-feed item to the configured webhook as
 * JSON — the one delivery channel that reaches beyond the app when it is
 * closed, and the seam for Slack or anything else without a per-service
 * integration.
 *
 * Delivery is at-most-once per open item: an id is recorded as seen before its
 * POST is attempted, so two feed changes in quick succession cannot double
 * post, and a failed POST is logged rather than retried on the next change —
 * a dead endpoint would otherwise re-fire for every open item on every feed
 * change. An item that resolves and later reopens under the same id (a fix
 * loop capped again on the same task) is new again, matching the feed.
 *
 * Every open item is marked seen on a pass that read config, whether or not it
 * was posted: a daemon restart must not re-post what the previous daemon
 * already sent, a kind switched on later must not dump its backlog, and a
 * webhook configured later starts from that moment. A pass whose config would
 * not parse is the one exception — it decided nothing, so it marks nothing,
 * and a typo elsewhere in config.yml delays delivery rather than dropping it.
 */
export class WebhookDelivery {
  private readonly seen = new Set<string>();
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly log: (message: string) => void;
  private readonly timeoutMs: number;
  // The last config error reported, so a broken config.yml is logged once
  // rather than on every feed change until it is fixed.
  private lastConfigError: string | null = null;

  constructor(private readonly ctx: WebhookDeliveryContext) {
    this.fetchImpl = ctx.fetch ?? globalThis.fetch;
    this.log = ctx.log ?? ((message) => console.warn(message));
    this.timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** Seeds the seen set with what is open now and starts delivering on
   *  `decisions.changed`. Returns its own unsubscribe. */
  start(): () => void {
    for (const item of this.ctx.feed.list()) this.seen.add(item.id);
    return this.ctx.events.subscribe((event) => {
      if (event.type !== 'decisions.changed') return;
      void this.deliverNew();
    });
  }

  /**
   * One pass: posts every blocking item not seen before, subject to the
   * per-kind toggles. Public so a test can await a pass; production only
   * reaches it through the subscription in `start`.
   */
  async deliverNew(): Promise<void> {
    const open = this.ctx.feed.list();
    const openIds = new Set(open.map((item) => item.id));
    // Forgetting a resolved id is what lets the same id notify again when it
    // reopens, and what keeps this set bounded by the feed rather than by the
    // daemon's uptime.
    for (const id of this.seen) {
      if (!openIds.has(id)) this.seen.delete(id);
    }
    const fresh = open.filter((item) => !this.seen.has(item.id));
    if (fresh.length === 0) return;

    // Read before marking anything seen, and only once there is something to
    // deliver so a quiet `decisions.changed` does not re-parse config.yml. A
    // config that will not parse means this pass decided nothing, so its items
    // stay unseen and the next pass reconsiders them; every outcome below
    // ("no webhook", "kind off") is a real decision and does mark them.
    const config = this.readConfig();
    if (config === null) return;
    for (const item of fresh) this.seen.add(item.id);
    if (config.webhook === undefined) return;
    const url = config.webhook;
    const sentAt = new Date().toISOString();
    await Promise.all(
      fresh
        .filter(
          (item) =>
            item.disposition === 'blocking' && config.kinds[item.kind] !== false
        )
        .map((item) =>
          this.post(url, {
            event: 'decision.opened',
            sentAt,
            project: { rootDir: this.ctx.rootDir },
            item,
          })
        )
    );
  }

  // Reads the notifications block, turning a throw into one log line and a
  // skipped pass — a malformed config.yml must never surface as an unhandled
  // rejection out of an event handler.
  private readConfig(): NotificationsConfig | null {
    try {
      const config = this.ctx.readConfig();
      this.lastConfigError = null;
      return config;
    } catch (err) {
      const message = (err as Error).message;
      if (message !== this.lastConfigError) {
        this.lastConfigError = message;
        this.log(
          `dispatchd: webhook delivery skipped, could not read notifications config: ${message}`
        );
      }
      return null;
    }
  }

  // One POST, never throwing: a delivery failure is a log line, not an error
  // anything upstream has to handle.
  private async post(url: string, payload: WebhookPayload): Promise<void> {
    const label = `${payload.item.id} to ${url}`;
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'user-agent': 'dispatchd',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        this.log(
          `dispatchd: webhook delivery of ${label} failed: HTTP ${res.status}`
        );
      }
    } catch (err) {
      this.log(
        `dispatchd: webhook delivery of ${label} failed: ${(err as Error).message}`
      );
    }
  }
}
