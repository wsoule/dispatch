import type { A2AStore, TaskRow } from '@dispatch/a2a';
import {
  isClientAddress,
  openA2ADb,
  SqliteA2AStore,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { A2AConfig, TaskStorePort } from '@dispatch/core';
import { CANONICAL_STATUSES, DEFAULT_A2A, loadConfig } from '@dispatch/core';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import { closeGate } from '../messaging/gates.js';
import type { Messaging } from '../messaging/service.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir } from '../orchestrator/paths.js';
import { bridgeExternalPolicy } from './external.js';
import { A2AListener } from './listener.js';
import type { BridgeDeps } from './port.js';
import { DaemonBridgePort } from './port.js';
import { reconcileA2A } from './reconcile.js';
import type { ListenerOverrides, ListenerSettings } from './settings.js';
import {
  applyOverrides,
  readListenerSettings,
  resolveListener,
  writeListenerSettings,
} from './settings.js';
import { BridgeWatch } from './watch.js';

interface ListenerStatus {
  enabled: boolean;
  listening: boolean;
  url: string | null;
  error: string | null;
  // config.yml `a2a:` keys that fell back to their defaults.
  warnings: string[];
  // Approved a2a.* agents with no clients row, registered before the bridge.
  legacyClients: string[];
  // What the listener opens from: the file plus any one-boot flags.
  settings: ListenerSettings;
  // The daemon's own `--tls-cert`/`--tls-key`, which a network listener may reuse.
  teamTls: { certPath: string; keyPath: string } | null;
}

export interface A2ABridge {
  // Null when a2a.db cannot be opened; the listener then stays closed.
  readonly port: DaemonBridgePort | null;
  readonly store: A2AStore | null;
  readonly watch: BridgeWatch | null;
  status(): ListenerStatus;
  // Opens the listener from the settings file plus the one-boot overrides.
  start(): Promise<void>;
  // The key that would keep `next` closed, before anything is written;
  // disabled settings always pass.
  check(
    next: ListenerSettings
  ): { ok: true } | { ok: false; key: string; error: string };
  // Writes the settings file and (re)opens the listener from it.
  applySettings(next: ListenerSettings): Promise<ListenerStatus>;
  disable(): Promise<ListenerStatus>;
  listening(): boolean;
  // Closes a revoked client's unanswered asks as the system ("client
  // revoked"); its handoff gates stay open for the owner.
  clientRevoked(address: string): void;
  close(): Promise<void>;
}

interface OpenBridgeDeps {
  rootDir: string;
  messaging: Messaging;
  tasks: TaskStorePort;
  orchestrator: Orchestrator;
  events: EventBus;
  ownerRef: string;
  version: string;
  // The daemon's own ports, read when the listener opens; it never shares one.
  daemonPorts: () => number[];
  overrides?: ListenerOverrides;
  teamTls?: { certPath: string; keyPath: string };
  mark?: (label: string) => void;
  track?: (fn: () => Promise<Response>) => Promise<Response>;
}

// The a2a: block and its warnings; a config.yml that does not parse leaves
// the defaults rather than failing an A2A request.
function a2aConfig(rootDir: string): {
  policy: A2AConfig;
  warnings: string[];
  statuses: string[];
} {
  try {
    const config = loadConfig(rootDir);
    return {
      policy: config.a2a ?? DEFAULT_A2A,
      warnings: config.a2aWarnings ?? [],
      statuses: config.statuses,
    };
  } catch (err) {
    return {
      policy: DEFAULT_A2A,
      warnings: [`${(err as Error).message}; the a2a: defaults apply`],
      statuses: [...CANONICAL_STATUSES],
    };
  }
}

// Opens a2a.db, keeps its state current and owns the listener. Never throws:
// a store that cannot open leaves the bridge down and the daemon booting.
export function openA2ABridge(deps: OpenBridgeDeps): A2ABridge {
  const { rootDir, messaging } = deps;
  let store: SqliteA2AStore | null = null;
  let dbError: string | null = null;
  try {
    store = new SqliteA2AStore(openA2ADb(join(runsDir(rootDir), 'a2a.db')));
  } catch (err) {
    dbError = `the A2A bridge is down: ${(err as Error).message}`;
    console.error(`dispatchd: ${dbError}`);
  }

  let port: DaemonBridgePort | null = null;
  let watch: BridgeWatch | null = null;
  let stopWatch: (() => void) | null = null;
  let listener: A2AListener | null = null;
  if (store === null) {
    messaging.setExternalPolicy(bridgeExternalPolicy(null));
  } else {
    const bridgeDeps: BridgeDeps = {
      rootDir,
      engine: messaging.engine,
      messages: messaging.store,
      store,
      tasks: deps.tasks,
      runs: deps.orchestrator,
      ownerRef: deps.ownerRef,
      policy: () => a2aConfig(rootDir).policy,
      statuses: () => a2aConfig(rootDir).statuses,
      cardBase: () => ({
        publicUrl: listener?.url() ?? 'http://127.0.0.1',
        version: deps.version,
      }),
    };
    watch = new BridgeWatch({
      ...bridgeDeps,
      events: deps.events,
      onChanged: () => deps.events.broadcast({ type: 'a2a.changed' }),
    });
    stopWatch = watch.start();
    messaging.setExternalPolicy(bridgeExternalPolicy(bridgeDeps));
    port = new DaemonBridgePort(bridgeDeps, watch);
    listener = new A2AListener({
      port,
      policy: () => a2aConfig(rootDir).policy,
      ...(deps.mark === undefined ? {} : { mark: deps.mark }),
      ...(deps.track === undefined ? {} : { track: deps.track }),
    });
    try {
      reconcileA2A(bridgeDeps, watch);
    } catch (err) {
      console.error('dispatchd: A2A boot reconciliation failed', err);
    }
  }

  let settings: ListenerSettings = readListenerSettings(rootDir).settings;
  let settingsError: string | null = null;
  let openError: string | null = null;

  // Closes whatever is open, then opens from `settings` when it is enabled.
  async function reopen(): Promise<void> {
    await listener?.close();
    openError = null;
    if (!settings.enabled || listener === null) return;
    const resolved = resolveListener(settings, deps.daemonPorts());
    if (!resolved.ok) {
      openError = resolved.error;
      return;
    }
    const opened = listener.open(resolved.listener);
    if (!opened.ok) openError = opened.error;
  }

  const url = (): string | null => listener?.url() ?? null;

  // Listener changes run one at a time, so two quick saves never interleave
  // a close and an open.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = queue.then(fn, fn);
    queue = next.catch(() => {});
    return next;
  }

  function status(): ListenerStatus {
    let legacyClients: string[] = [];
    try {
      legacyClients = messaging.store
        .agents()
        .filter(
          (a) =>
            a.status === 'approved' &&
            isClientAddress(a.address) &&
            (store === null || store.getClient(a.address) === null)
        )
        .map((a) => a.address);
    } catch (err) {
      console.error('dispatchd: could not list A2A clients', err);
    }
    return {
      enabled: settings.enabled,
      listening: url() !== null,
      url: url(),
      error: dbError ?? settingsError ?? openError,
      warnings: a2aConfig(rootDir).warnings,
      legacyClients,
      settings,
      teamTls: deps.teamTls ?? null,
    };
  }

  return {
    get port() {
      return port;
    },
    get store() {
      return store;
    },
    get watch() {
      return watch;
    },
    status,
    start: () =>
      serial(async () => {
        const read = readListenerSettings(rootDir);
        settingsError = read.error;
        if (settingsError !== null)
          console.error(`dispatchd: ${settingsError}`);
        settings = applyOverrides(read.settings, deps.overrides);
        for (const warning of a2aConfig(rootDir).warnings)
          console.warn(`dispatchd: ${warning}`);
        await reopen();
        if (openError !== null)
          console.error(`dispatchd: A2A listener closed: ${openError}`);
        else if (url() !== null)
          console.log(`dispatchd: A2A listener at ${url()}`);
      }),
    // A runtime change supersedes the one-boot flags: the file gets exactly
    // `next`, and the listener follows it.
    applySettings: (next) =>
      serial(async () => {
        writeListenerSettings(rootDir, next);
        settings = next;
        settingsError = null;
        await reopen();
        return status();
      }),
    // Keeps the file's other keys, never the one-boot flags.
    disable: () =>
      serial(async () => {
        const file = readListenerSettings(rootDir).settings;
        writeListenerSettings(rootDir, { ...file, enabled: false });
        settings = { ...settings, enabled: false };
        settingsError = null;
        await reopen();
        return status();
      }),
    listening: () => url() !== null,
    check(next) {
      if (!next.enabled) return { ok: true };
      const resolved = resolveListener(next, deps.daemonPorts());
      return resolved.ok
        ? { ok: true }
        : { ok: false, key: resolved.key, error: resolved.error };
    },
    // Never throws: the revocation has already happened, and one task that
    // cannot close is logged without stopping the others.
    clientRevoked(address) {
      let rows: TaskRow[] = [];
      try {
        rows = store?.tasksOf(address) ?? [];
      } catch (err) {
        console.error(`dispatchd: could not list ${address}'s A2A tasks`, err);
      }
      for (const row of rows) {
        if (row.skill !== 'ask' || TERMINAL_STATES.has(row.state)) continue;
        try {
          // False when an answer got there first; the recompute shows which.
          closeGate(messaging.engine, row.id, 'client revoked');
          watch?.recompute(row.id);
        } catch (err) {
          console.error(`dispatchd: could not close A2A task ${row.id}`, err);
        }
      }
      deps.events.broadcast({ type: 'a2a.changed' });
    },
    close: () =>
      serial(async () => {
        stopWatch?.();
        stopWatch = null;
        await listener?.close();
        messaging.setExternalPolicy(null);
        store?.close();
      }),
  };
}
