import { readJsonFile, writeJsonFile } from './jsonFile.js';
import type {
  PushMessage,
  PushOutcome,
  PushSubscriptionJson,
  VapidKeys,
} from './webPush.js';
import { isPushSubscription, sendPush } from './webPush.js';

// What turns "something changed in the daemon" into a notification on a phone.
//
// The notifier is fed snapshots — the open decisions waiting on the operator
// and the runs it can see — and diffs each against the last. Anything new
// that a person would want to be woken for (a question or gate, a run that
// failed, a run waiting for review) becomes a push. The first snapshot after a
// start only seeds the baseline: a restart must not re-announce everything
// that was already waiting.
//
// Bursts are coalesced: once one push has gone out, anything else in the next
// `windowMs` is held and then sent as one, so an agent asking three things in
// a row buzzes the phone once.

/** One subscription, as it is kept on disk against the device that made it. */
interface StoredSubscription extends PushSubscriptionJson {
  device: string;
  createdAt: string;
}

/** Push subscriptions by device, in one JSON file (or memory, for tests). */
export class PushSubscriptions {
  private subs: StoredSubscription[];

  constructor(
    private readonly path: string | null,
    private readonly clock: () => Date = () => new Date()
  ) {
    const loaded = path === null ? [] : readJsonFile<unknown>(path, []);
    this.subs = (Array.isArray(loaded) ? loaded : []).filter(
      (s): s is StoredSubscription =>
        isPushSubscription(s) &&
        typeof (s as StoredSubscription).device === 'string'
    );
  }

  private save(): void {
    if (this.path !== null) writeJsonFile(this.path, this.subs);
  }

  /** Records a device's subscription, replacing any it had: a browser hands a
   *  page one subscription per service worker, and a renewed one supersedes
   *  the old. */
  put(device: string, sub: PushSubscriptionJson): void {
    this.subs = this.subs.filter(
      (s) => s.device !== device && s.endpoint !== sub.endpoint
    );
    this.subs.push({
      device,
      endpoint: sub.endpoint,
      keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
      createdAt: this.clock().toISOString(),
    });
    this.save();
  }

  /** Drops a device's subscriptions (it turned notifications off or was
   *  unpaired). */
  removeDevice(device: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.device !== device);
    if (this.subs.length !== before) this.save();
  }

  /** Drops one endpoint the push service said is gone. */
  removeEndpoint(endpoint: string): void {
    const before = this.subs.length;
    this.subs = this.subs.filter((s) => s.endpoint !== endpoint);
    if (this.subs.length !== before) this.save();
  }

  has(device: string): boolean {
    return this.subs.some((s) => s.device === device);
  }

  all(): readonly StoredSubscription[] {
    return this.subs;
  }
}

/** A decision waiting on the operator: its message id and a title safe to
 *  hand a push service (never the question's body or a tool's input). */
export interface DecisionSnapshot {
  id: string;
  title: string;
}

/** A run as the notifier needs it. */
export interface RunSnapshot {
  id: string;
  title: string;
  state: string;
  /** Set once someone reviewed it; a reviewed run is not "waiting". */
  reviewed: boolean;
}

/** What one notification is about. Kept to an id and a title on purpose. */
export type MobileEvent =
  | { kind: 'decision'; id: string; title: string }
  | { kind: 'run-failed'; id: string; title: string }
  | { kind: 'run-review'; id: string; title: string };

/** The JSON a phone's service worker receives. */
export interface MobilePushPayload {
  kind: MobileEvent['kind'] | 'summary';
  /** The message or run id, or null for a summary. */
  id: string | null;
  title: string;
  body: string;
}

// Runs in these states ended without the person asking them to: worth a buzz.
const FAILED_STATES = new Set(['failed', 'interrupted-dirty']);

/** What changed between two snapshots that a person should hear about. */
export function diffSnapshots(
  before: { decisions: Set<string>; runs: Map<string, string> },
  decisions: readonly DecisionSnapshot[],
  runs: readonly RunSnapshot[]
): MobileEvent[] {
  const events: MobileEvent[] = [];
  for (const d of decisions)
    if (!before.decisions.has(d.id))
      events.push({ kind: 'decision', id: d.id, title: d.title });
  for (const run of runs) {
    const was = before.runs.get(run.id);
    if (was === run.state) continue;
    if (FAILED_STATES.has(run.state) && !FAILED_STATES.has(was ?? ''))
      events.push({ kind: 'run-failed', id: run.id, title: run.title });
    // Only a run seen running before counts: one that appears already
    // finished (an import, a restart's backfill) is history, not news.
    else if (run.state === 'finished' && was !== undefined && !run.reviewed)
      events.push({ kind: 'run-review', id: run.id, title: run.title });
  }
  return events;
}

/** The notification a batch of events becomes: the event itself when there is
 *  one, a count when there are several. */
export function payloadFor(events: readonly MobileEvent[]): MobilePushPayload {
  if (events.length === 1) {
    const [e] = events;
    const body =
      e.kind === 'decision'
        ? 'Waiting on you'
        : e.kind === 'run-failed'
          ? 'Run failed'
          : 'Ready for review';
    return { kind: e.kind, id: e.id, title: e.title, body };
  }
  const waiting = events.filter((e) => e.kind === 'decision').length;
  return {
    kind: 'summary',
    id: null,
    title: `${events.length} updates in Dispatch`,
    body:
      waiting > 0
        ? `${waiting} waiting on you`
        : `${events.length} runs changed`,
  };
}

interface NotifierDeps {
  subscriptions: PushSubscriptions;
  vapid: () => VapidKeys;
  /** The VAPID contact; Apple wants an https URL or a mailto:. */
  subject: string;
  /** Whether a device is still paired; a subscription outliving its device
   *  is dropped rather than sent to. */
  deviceExists: (device: string) => boolean;
  send?: (
    sub: PushSubscriptionJson,
    message: PushMessage,
    vapid: VapidKeys
  ) => Promise<PushOutcome>;
  windowMs?: number;
  now?: () => number;
  setTimer?: (fn: () => void, ms: number) => unknown;
  log?: (line: string) => void;
}

export class MobileNotifier {
  private baseline: {
    decisions: Set<string>;
    runs: Map<string, string>;
  } | null = null;
  private pending: MobileEvent[] = [];
  private lastSentAt = Number.NEGATIVE_INFINITY;
  private timerArmed = false;
  private readonly windowMs: number;
  private readonly now: () => number;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly send: NonNullable<NotifierDeps['send']>;
  /** Resolves once every push started so far has settled (tests). */
  private inflight: Promise<unknown> = Promise.resolve();

  constructor(private readonly deps: NotifierDeps) {
    this.windowMs = deps.windowMs ?? 10_000;
    this.now = deps.now ?? (() => Date.now());
    this.setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.send =
      deps.send ??
      ((sub, message, vapid) =>
        sendPush(sub, message, vapid, { subject: deps.subject }));
  }

  /** Feeds the current state; pushes whatever is new since the last call. */
  observe(
    decisions: readonly DecisionSnapshot[],
    runs: readonly RunSnapshot[]
  ): void {
    const previous = this.baseline;
    this.baseline = {
      decisions: new Set(decisions.map((d) => d.id)),
      runs: new Map(runs.map((r) => [r.id, r.state])),
    };
    if (previous === null) return;
    const events = diffSnapshots(previous, decisions, runs);
    if (events.length === 0) return;
    this.pending.push(...events);
    this.schedule();
  }

  private schedule(): void {
    if (this.timerArmed) return;
    const wait = this.lastSentAt + this.windowMs - this.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.timerArmed = true;
    this.setTimer(() => {
      this.timerArmed = false;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.pending.length === 0) return;
    const events = this.pending;
    this.pending = [];
    this.lastSentAt = this.now();
    const payload = payloadFor(events);
    // A device unpaired since it subscribed takes its subscription with it.
    for (const s of this.deps.subscriptions.all())
      if (!this.deps.deviceExists(s.device))
        this.deps.subscriptions.removeDevice(s.device);
    const subs = this.deps.subscriptions.all();
    if (subs.length === 0) return;
    const vapid = this.deps.vapid();
    const log = this.deps.log ?? ((line: string) => console.error(line));
    this.inflight = Promise.all(
      subs.map(async (sub) => {
        // One topic for everything: a phone that was offline gets the latest
        // notification when it reconnects, not a backlog.
        const outcome = await this.send(
          sub,
          { payload, topic: 'dispatch' },
          vapid
        );
        if (outcome.kind === 'gone')
          this.deps.subscriptions.removeEndpoint(sub.endpoint);
        else if (outcome.kind === 'failed')
          log(
            `dispatchd: push to ${new URL(sub.endpoint).host} failed (${outcome.status ?? 'network'}): ${outcome.error}`
          );
      })
    );
  }

  /** Waits for pushes already started (tests). */
  async settled(): Promise<void> {
    await this.inflight;
  }
}
