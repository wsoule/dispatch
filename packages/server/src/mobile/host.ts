import type { Message } from '@dispatch-foo/protocol';
import { gateOf } from '@dispatch-foo/protocol';
import { join } from 'node:path';

import { readJsonFile, writeJsonFile } from './jsonFile.js';
import { MobileListener } from './listener.js';
import type { DecisionSnapshot, RunSnapshot } from './notifier.js';
import { MobileNotifier, PushSubscriptions } from './notifier.js';
import type { VapidKeys } from './webPush.js';
import { generateVapidKeys, isVapidKeys } from './webPush.js';

// Everything the phone app needs from one daemon, in one place: push
// subscriptions, the VAPID key pushes are signed with, the notifier that
// decides when to push, and the listener the phone talks to. Pairing and the
// device tokens themselves are the daemon's paired devices (devices.ts),
// shared with remote desktop connections; this module keys everything on the
// `TokenIdentity.device` id they resolve to. The daemon builds one at boot
// (index.ts) and hands it to handleApi as `ctx.mobile`; see
// the Doc `mobile-app-spec`.

/** How the mobile listener is set up, as `mobile.json` keeps it. */
export interface MobileSettings {
  /** The loopback port the listener binds, or null for off. */
  port: number | null;
  /** The https URL the phone reaches the listener at (a Tailscale or tunnel
   *  hostname). The daemon cannot discover it; pairing links need it. */
  publicUrl: string | null;
}

export interface MobileStatus extends MobileSettings {
  /** The port actually listening, or null when the listener is closed. */
  listening: number | null;
  /** Why the listener is not open when settings say it should be. */
  error: string | null;
}

const OFF: MobileSettings = { port: null, publicUrl: null };

// Apple refuses VAPID JWTs whose subject is not a URL or mailto: it could
// plausibly reach; the project's site is the honest contact.
const VAPID_SUBJECT = 'https://dispatch.foo';

/** Checks settings sent by a client or read from disk; an error says which
 *  field is wrong and how. */
export function parseMobileSettings(
  value: unknown
): { ok: true; settings: MobileSettings } | { ok: false; error: string } {
  if (typeof value !== 'object' || value === null)
    return { ok: false, error: 'expected { port, publicUrl }' };
  const v = value as Record<string, unknown>;
  const port = v.port ?? null;
  if (
    port !== null &&
    (typeof port !== 'number' ||
      !Number.isInteger(port) ||
      port < 1 ||
      port > 65535)
  )
    return { ok: false, error: 'port must be a whole number 1–65535, or null' };
  let publicUrl = v.publicUrl ?? null;
  if (publicUrl !== null) {
    if (typeof publicUrl !== 'string')
      return { ok: false, error: 'publicUrl must be a string or null' };
    let url: URL;
    try {
      url = new URL(publicUrl);
    } catch {
      return { ok: false, error: `publicUrl is not a URL: ${publicUrl}` };
    }
    // Service workers and push need a secure context: https, or this machine.
    const local = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
    if (url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
      return {
        ok: false,
        error:
          'publicUrl must be https:// — a phone only installs the app and accepts notifications over HTTPS',
      };
    publicUrl = url.origin;
  }
  return {
    ok: true,
    settings: { port, publicUrl: publicUrl as string | null },
  };
}

const GATE_LABELS: Partial<Record<string, string>> = {
  'tool-approval': 'Approve a tool call',
  scope: 'Scope request',
  'agent-registration': 'New agent wants access',
  memory: 'Memory proposal',
  'overseer-action': 'Confirm an action',
  'task-proposal': 'Task proposal',
};

/**
 * A notification title for a decision: what kind of thing it is and who is
 * asking, never what it says. A question's body or a tool call's input can
 * carry anything from the repo, and the push service sees the payload's size
 * and timing even though it cannot read it; the title it carries stays
 * generic, and the phone fetches the rest over its own connection.
 */
export function decisionTitle(
  message: Message,
  runTitle: (runId: string) => string | undefined
): string {
  const gate = gateOf(message);
  const label =
    gate === null ? 'Question' : (GATE_LABELS[gate.type] ?? 'Needs you');
  const runId =
    gate?.type === 'tool-approval' && gate.runId !== undefined
      ? gate.runId
      : message.from.startsWith('run:')
        ? message.from.slice(4)
        : null;
  const who = (runId === null ? undefined : runTitle(runId)) ?? message.from;
  return `${label} · ${who}`.slice(0, 120);
}

interface MobileHostDeps {
  /** Where the module's files live; null keeps everything in memory. */
  dir: string | null;
  /** The built desktop bundle the listener serves `/m/` from. */
  distDir: string | null;
  /** The decisions and runs right now, for the notifier to diff. */
  snapshot: () => { decisions: DecisionSnapshot[]; runs: RunSnapshot[] };
  /** The paired device a bearer token belongs to, or null. */
  deviceOf: (token: string) => string | null;
  /** Whether a paired device still exists; a revoked device's subscription
   *  is skipped rather than sent to. */
  deviceExists: (id: string) => boolean;
  /** Boot-only overrides from dispatchd's `--mobile-*` flags. */
  overrides?: Partial<MobileSettings>;
  /** Wraps a request so idle shutdown sees it. */
  track?: <T>(fn: () => Promise<T>) => Promise<T>;
  /** Replaces real pushes (tests). */
  notifier?: ConstructorParameters<typeof MobileNotifier>[0]['send'];
  /** How long to wait after a change before snapshotting, so a burst of
   *  events is read once. */
  scanDelayMs?: number;
}

export class MobileHost {
  readonly subscriptions: PushSubscriptions;
  readonly notifier: MobileNotifier;
  private readonly listener: MobileListener;
  private settingsValue: MobileSettings;
  private error: string | null = null;
  private vapidValue: VapidKeys | null = null;
  private handleApi: ((req: Request) => Promise<Response>) | null = null;
  private scanTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: MobileHostDeps) {
    const file = (name: string) =>
      deps.dir === null ? null : join(deps.dir, name);
    this.subscriptions = new PushSubscriptions(file('subscriptions.json'));
    this.notifier = new MobileNotifier({
      subscriptions: this.subscriptions,
      vapid: () => this.vapid(),
      subject: VAPID_SUBJECT,
      deviceExists: (id) => deps.deviceExists(id),
      ...(deps.notifier === undefined ? {} : { send: deps.notifier }),
    });
    const settingsPath = file('settings.json');
    const saved = parseMobileSettings(
      settingsPath === null ? OFF : readJsonFile<unknown>(settingsPath, OFF)
    );
    this.settingsValue = {
      ...(saved.ok ? saved.settings : OFF),
      ...deps.overrides,
    };
    this.listener = new MobileListener({
      handleApi: (req) => {
        if (this.handleApi === null)
          return Promise.resolve(
            new Response('daemon starting', { status: 503 })
          );
        return this.handleApi(req);
      },
      isDeviceToken: (token) => deps.deviceOf(token) !== null,
      distDir: deps.distDir,
      ...(deps.track === undefined ? {} : { track: deps.track }),
    });
  }

  /** The VAPID keypair, made on first use and kept for good: every
   *  subscription a phone holds is bound to this public key. */
  vapid(): VapidKeys {
    if (this.vapidValue !== null) return this.vapidValue;
    const path =
      this.deps.dir === null ? null : join(this.deps.dir, 'vapid.json');
    const saved = path === null ? null : readJsonFile<unknown>(path, null);
    if (isVapidKeys(saved)) {
      this.vapidValue = saved;
    } else {
      this.vapidValue = generateVapidKeys();
      if (path !== null) writeJsonFile(path, this.vapidValue);
    }
    return this.vapidValue;
  }

  /** Connects the API router and opens the listener if settings say so. */
  start(handleApi: (req: Request) => Promise<Response>): void {
    this.handleApi = handleApi;
    this.apply();
    // Seed the notifier's baseline, so whatever already waits at boot is not
    // announced as new.
    this.scanNow();
  }

  private apply(): void {
    const { port } = this.settingsValue;
    if (port === null) {
      void this.listener.close();
      this.error = null;
      return;
    }
    const current = this.listener.port();
    if (current === port) return;
    const reopen = async () => {
      await this.listener.close();
      const opened = this.listener.open(port);
      this.error = opened.ok ? null : opened.error;
      if (!opened.ok) console.error(`dispatchd: mobile: ${opened.error}`);
    };
    // Opening is synchronous when nothing is bound yet, which keeps boot and
    // tests deterministic; a port change closes first.
    if (current === null) {
      const opened = this.listener.open(port);
      this.error = opened.ok ? null : opened.error;
      if (!opened.ok) console.error(`dispatchd: mobile: ${opened.error}`);
    } else void reopen();
  }

  status(): MobileStatus {
    return {
      ...this.settingsValue,
      listening: this.listener.port(),
      error: this.error,
    };
  }

  /** Saves new settings and opens, moves or closes the listener to match. */
  configure(settings: MobileSettings): MobileStatus {
    this.settingsValue = settings;
    if (this.deps.dir !== null)
      writeJsonFile(join(this.deps.dir, 'settings.json'), settings);
    this.apply();
    return this.status();
  }

  /** Whether a device has a push subscription. */
  subscribed(device: string): boolean {
    return this.subscriptions.has(device);
  }

  /** Something changed (a message, a run); snapshot shortly and notify. */
  changed(): void {
    if (this.scanTimer !== null) return;
    this.scanTimer = setTimeout(() => {
      this.scanTimer = null;
      this.scanNow();
    }, this.deps.scanDelayMs ?? 250);
  }

  /** Snapshots now and hands it to the notifier. */
  scanNow(): void {
    try {
      const { decisions, runs } = this.deps.snapshot();
      this.notifier.observe(decisions, runs);
    } catch (err) {
      console.error(
        `dispatchd: mobile: snapshot failed: ${(err as Error).message}`
      );
    }
  }

  async close(): Promise<void> {
    if (this.scanTimer !== null) clearTimeout(this.scanTimer);
    this.scanTimer = null;
    await this.listener.close();
  }
}
