import type { A2AStore, TaskRow } from '@dispatch/a2a';
import {
  hasA2AProvenance,
  isClientAddress,
  openA2ADb,
  SqliteA2AStore,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { A2AConfig, TaskStorePort, UpdatePatch } from '@dispatch/core';
import { CANONICAL_STATUSES, DEFAULT_A2A, loadConfig } from '@dispatch/core';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import { closeGate } from '../messaging/gates.js';
import type { Messaging } from '../messaging/service.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir, transcriptPath } from '../orchestrator/paths.js';
import { replayTranscript } from '../orchestrator/transcript.js';
import type { AuthTier } from '../tiers.js';
import { RunResultsMemo } from './artifacts.js';
import { bridgeExternalPolicy } from './external.js';
import type { GuardDeps, PatchGuard } from './guards.js';
import {
  dispatchRefusal,
  guardTaskPatch,
  openProposalFor,
  ProposalGuard,
} from './guards.js';
import { handleProposal } from './handoff.js';
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
  // The proposal guards; each works with a2a.db down.
  guardTaskPatch(
    taskId: string,
    patch: UpdatePatch,
    caller: { tier: AuthTier; ref: string }
  ): Promise<PatchGuard>;
  proposalOpen(taskId: string): boolean;
  // 'a2a' when a client handed the task off: its runs act for no one and
  // read team memory only.
  taskOrigin(taskId: string): 'a2a' | null;
  // Puts every gated draft something moved back in Draft; returns how many.
  recheckProposals(): number;
  close(): Promise<void>;
}

interface OpenBridgeDeps {
  rootDir: string;
  messaging: Messaging;
  tasks: TaskStorePort;
  // The daemon's checked task writes (cache rebuild and task.changed included).
  validateTask: BridgeDeps['validateTask'];
  createTask: BridgeDeps['createTask'];
  updateTask: BridgeDeps['updateTask'];
  // Whether the PR poll lists a URL as open; false until its first poll.
  prOpen: BridgeDeps['prOpen'];
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

  // Installed before the a2a.db branch: a gated draft stays held either way.
  const guardDeps: GuardDeps = {
    engine: messaging.engine,
    tasks: deps.tasks,
    ownerRef: deps.ownerRef,
    updateTask: deps.updateTask,
    store,
  };
  deps.orchestrator.setDispatchGuard((task) =>
    dispatchRefusal(guardDeps, task)
  );
  const proposals = new ProposalGuard(guardDeps, deps.events);
  const stopProposals = proposals.start();

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
      validateTask: deps.validateTask,
      createTask: deps.createTask,
      updateTask: deps.updateTask,
      // Straight from the transcript: getRun would also recheck a failed run
      // as though someone had opened it.
      runEvidence: (id) =>
        replayTranscript(transcriptPath(rootDir, id))?.evidence ?? [],
      // A run whose worktree and diff snapshot are both gone has no patch.
      runPatch: (id) => {
        try {
          return deps.orchestrator.diff(id).patch;
        } catch {
          return null;
        }
      },
      prOpen: deps.prOpen,
      runResults: new RunResultsMemo(),
    };
    const hub = new BridgeWatch({
      ...bridgeDeps,
      events: deps.events,
      onChanged: () => deps.events.broadcast({ type: 'a2a.changed' }),
    });
    watch = hub;
    stopWatch = hub.start();
    messaging.setExternalPolicy(bridgeExternalPolicy(bridgeDeps));
    messaging.gates.register('task-proposal', (question, answer) =>
      handleProposal(bridgeDeps, hub, question, answer)
    );
    port = new DaemonBridgePort(bridgeDeps, hub);
    listener = new A2AListener({
      port,
      policy: () => a2aConfig(rootDir).policy,
      ...(deps.mark === undefined ? {} : { mark: deps.mark }),
      ...(deps.track === undefined ? {} : { track: deps.track }),
    });
    try {
      // Its gate sends finish in the background and log their own failures.
      reconcileA2A(bridgeDeps, hub);
    } catch (err) {
      console.error('dispatchd: A2A boot reconciliation failed', err);
    }
  }
  try {
    proposals.recheck();
  } catch (err) {
    console.error('dispatchd: A2A proposal recheck failed', err);
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
    guardTaskPatch: (taskId, patch, caller) =>
      guardTaskPatch(guardDeps, taskId, patch, caller),
    proposalOpen: (taskId) => openProposalFor(guardDeps, taskId) !== null,
    // a2a.db is the record; while it is down or failing, the task's own
    // provenance answers instead, so a refused file never reads as local work.
    taskOrigin(taskId) {
      if (store !== null) {
        try {
          return store.taskForDispatchTask(taskId) === null ? null : 'a2a';
        } catch (err) {
          console.error(
            `dispatchd: could not read ${taskId}'s A2A record`,
            err
          );
        }
      }
      return hasA2AProvenance(deps.tasks.get(taskId)) ? 'a2a' : null;
    },
    recheckProposals: () => proposals.recheck(),
    close: () =>
      serial(async () => {
        deps.orchestrator.setDispatchGuard(null);
        stopProposals();
        stopWatch?.();
        stopWatch = null;
        await listener?.close();
        messaging.setExternalPolicy(null);
        store?.close();
      }),
  };
}
