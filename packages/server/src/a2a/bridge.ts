import type {
  A2AStore,
  HandoffStatuses,
  PeerStatus,
  TaskRow,
} from '@dispatch/a2a';
import {
  DEFAULT_HANDOFF_STATUSES,
  handoffStatuses,
  isClientAddress,
  openA2ADb,
  SqliteA2AStore,
  TERMINAL_STATES,
} from '@dispatch/a2a';
import type { A2AConfig, TaskStorePort, UpdatePatch } from '@dispatch/core';
import {
  credentialsPath,
  credentialsUnreadable,
  DEFAULT_A2A,
  loadConfig,
  statusModelOf,
} from '@dispatch/core';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import { closeGate } from '../messaging/gates.js';
import type { Messaging } from '../messaging/service.js';
import type { Orchestrator } from '../orchestrator/orchestrator.js';
import { runsDir, transcriptPath } from '../orchestrator/paths.js';
import { replayTranscript } from '../orchestrator/transcript.js';
import type { LinkHub } from '../team/links/hub.js';
import type { AuthTier } from '../tiers.js';
import { RunResultsMemo } from './artifacts.js';
import { bridgeExternalPolicy } from './external.js';
import { gatherFacts } from './facts.js';
import type { GuardDeps, PatchGuard } from './guards.js';
import {
  dispatchRefusal,
  guardTaskPatch,
  isA2ATask,
  openProposalFor,
  ProposalGuard,
} from './guards.js';
import { handleProposal } from './handoff.js';
import { KeyService } from './keys.js';
import { A2ALineage } from './lineage.js';
import { LinkWiring } from './links.js';
import { A2AListener, freeLoopbackPort } from './listener.js';
import type { OutboundWorker } from './outbound.js';
import { startOutbound } from './outbound.js';
import { Unpairer } from './pairing.js';
import type { PeerService } from './peers.js';
import {
  createPeerService,
  probeUnverifiedPeers,
  refreshDuePeers,
} from './peers.js';
import type { BridgeDeps } from './port.js';
import { DaemonBridgePort } from './port.js';
import type { WatchLimits } from './portRoutes.js';
import {
  PortLeases,
  PortWatches,
  servePortCall,
  SignedSessions,
} from './portRoutes.js';
import { PushWorker } from './push.js';
import { reconcileA2A } from './reconcile.js';
import type { RelayStatus } from './relayClient.js';
import { RelayClient } from './relayClient.js';
import type {
  ListenerOverrides,
  ListenerSettings,
  RelaySettings,
} from './settings.js';
import {
  applyOverrides,
  readListenerSettings,
  readRelaySettings,
  resolveListener,
  writeListenerSettings,
  writeRelaySettings,
} from './settings.js';
import { CardSigner, finishRotation, loadSigningKeys } from './signing.js';
import { Upgrades } from './upgrade.js';
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
  // A free port for a listener whose settings name none; null once they do.
  suggestedPort: number | null;
}

export interface A2ABridge {
  // Null when a2a.db cannot be opened; the listener then stays closed.
  readonly port: DaemonBridgePort | null;
  readonly store: A2AStore | null;
  readonly watch: BridgeWatch | null;
  // Outbound peers; null when a2a.db is down.
  readonly peers: PeerService | null;
  readonly unpairer: Unpairer | null;
  readonly keys: KeyService | null;
  readonly upgrades: Upgrades | null;
  // This daemon as a relay tenant (a2a-relay.json).
  relayStatus(): RelayStatus;
  setRelay(settings: RelaySettings): RelayStatus;
  // XH-R3: cancels the open pairing offers `ref` made.
  cancelOffersBy(ref: string): void;
  // Probes each peer auth-failed only for unverifiable replies (hourly).
  probeUnverified(): Promise<void>;
  // Relays held a2a: deliveries and follows peer tasks; null when a2a.db is down.
  readonly outbound: OutboundWorker | null;
  // Teammate links (T54); null until the link keys load, or when a2a.db is down.
  readonly links: LinkHub | null;
  // Whether standalone hosts may use /api/a2a/port/* (the settings file).
  standalone(): boolean;
  // Changes only that flag in the settings file; the listener is untouched.
  setStandalone(enabled: boolean): Promise<{ standalone: boolean }>;
  // Stream slots and task-watch streams standalone hosts hold.
  readonly leases: PortLeases;
  readonly watches: PortWatches;
  // Signed clients' sessions across a standalone host's port calls.
  readonly signedSessions: SignedSessions;
  // Ends a revoked host's leases and watch streams.
  hostRevoked(hostId: string): void;
  peerStatus(alias: string): PeerStatus | null;
  status(): ListenerStatus;
  // Lines for GET /api/health: an unreadable credentials file, an unsigned card.
  problems(): string[];
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
  // Closes a revoked client's unanswered asks and open task-proposal gates
  // as the system ("client revoked").
  clientRevoked(address: string): void;
  // The proposal guards; each works with a2a.db down.
  guardTaskPatch(
    taskId: string,
    patch: UpdatePatch,
    caller: { tier: AuthTier; ref: string }
  ): Promise<PatchGuard>;
  proposalOpen(taskId: string): boolean;
  // 'a2a' when a client handed the task off, or an A2A run made, edited or
  // dispatched it: its runs act for no one and read team memory only.
  taskOrigin(taskId: string): 'a2a' | null;
  // Records that `taskId` was made from the A2A task `sourceTaskId`.
  markDerived(taskId: string, sourceTaskId: string): void;
  // XH-R2: marks `taskId` A2A-origin when run `runId` is; call it whenever a
  // run creates, edits or dispatches a task.
  inherit(runId: string, taskId: string): void;
  readonly lineage: A2ALineage;
  // Puts every gated draft something moved back in Draft; returns how many.
  recheckProposals(): number;
  close(): Promise<void>;
}

interface OpenBridgeDeps {
  // The tier a pairing offer's creator acts at now; null once revoked.
  creatorTier?: (ref: string) => AuthTier | null;
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
  // Standalone hosts' watch-stream limits over the defaults (tests).
  watchLimits?: Partial<WatchLimits>;
  // How long unverifiable replies run before auth-failed (tests shorten it).
  unverifiedWindowMs?: number;
  // Unpair notices' and key pushes' retry delays (tests shorten them).
  noticeBackoffMs?: number[];
  // How often teammate links exchange (tests shorten it).
  linkIntervalMs?: number;
  mark?: (label: string) => void;
  track?: (fn: () => Promise<Response>) => Promise<Response>;
}

// The a2a: block, its warnings and the handoff statuses, read from the
// project's typed status model; an unparseable config.yml falls back to the
// defaults instead of failing a request.
export function a2aConfig(rootDir: string): {
  policy: A2AConfig;
  warnings: string[];
  statuses: HandoffStatuses;
} {
  try {
    const config = loadConfig(rootDir);
    return {
      policy: config.a2a ?? DEFAULT_A2A,
      warnings: config.a2aWarnings ?? [],
      statuses: handoffStatuses(statusModelOf(config)),
    };
  } catch (err) {
    return {
      policy: DEFAULT_A2A,
      warnings: [`${(err as Error).message}; the a2a: defaults apply`],
      statuses: DEFAULT_HANDOFF_STATUSES,
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

  const lineage = new A2ALineage(join(runsDir(rootDir), 'a2a-lineage.log'));
  // Installed before the a2a.db branch: a gated draft stays held either way.
  const guardDeps: GuardDeps = {
    engine: messaging.engine,
    messages: messaging.store,
    tasks: deps.tasks,
    ownerRef: deps.ownerRef,
    updateTask: deps.updateTask,
    statuses: () => a2aConfig(rootDir).statuses,
    store,
    lineage,
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
  let peers: PeerService | null = null;
  let unpairer: Unpairer | null = null;
  let keys: KeyService | null = null;
  let upgrades: Upgrades | null = null;
  let relay: RelayClient | null = null;
  let stopUpgradeAnswers: (() => void) | null = null;
  let refreshTimer: ReturnType<typeof setInterval> | null = null;
  let outbound: { worker: OutboundWorker; stop: () => void } | null = null;
  let links: LinkWiring | null = null;
  const leases = new PortLeases();
  const watches = new PortWatches(deps.watchLimits);
  const signedSessions = new SignedSessions();
  // Loaded on the first card; null (with the reason) when it cannot be.
  let signer: CardSigner | null | undefined;
  let signerError: string | null = null;
  if (store === null) {
    messaging.setExternalPolicy(bridgeExternalPolicy(null, null));
  } else {
    const bridgeDeps: BridgeDeps = {
      rootDir,
      ...(deps.creatorTier === undefined
        ? {}
        : { creatorTier: deps.creatorTier }),
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
      signer: () => {
        if (signer !== undefined) return signer;
        try {
          signer = new CardSigner(loadSigningKeys(rootDir));
        } catch (err) {
          // The message names the problem, never the key.
          signerError = err instanceof Error ? err.message : 'unknown error';
          console.error(`dispatchd: A2A card signing is off: ${signerError}`);
          signer = null;
        }
        return signer;
      },
    };
    // Push delivery returns at once and runs on its own chains, so a slow
    // webhook never delays the watch, its streams or the broadcast.
    const push = new PushWorker({
      store,
      now: () => new Date(),
      clientActive: (client) =>
        messaging.store.getAgent(client)?.status === 'approved',
    });
    const hub = new BridgeWatch({
      ...bridgeDeps,
      events: deps.events,
      onChanged: (row, facts) => {
        deps.events.broadcast({ type: 'a2a.changed' });
        try {
          push.onChanged(row, facts);
        } catch (err) {
          console.error(
            `dispatchd: A2A push for ${row.id} failed: ${err instanceof Error ? err.name : 'error'}`
          );
        }
      },
    });
    watch = hub;
    stopWatch = hub.start();
    const peerService = createPeerService(bridgeDeps);
    bridgeDeps.peers = () => peerService;
    peers = peerService;
    unpairer = new Unpairer({
      ...peerService.deps,
      notices: peerService.notices,
      emit: peerService.emit,
      revokeClient: (address) => bridge.clientRevoked(address),
      changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
      linkUnpair: (alias, id) =>
        links?.unpair(alias, id) ?? Promise.resolve(false),
      ...(deps.noticeBackoffMs === undefined
        ? {}
        : { backoffMs: deps.noticeBackoffMs }),
    });
    bridgeDeps.unpairer = () => unpairer;
    const keyService = new KeyService({
      ...peerService.deps,
      notices: peerService.notices,
      emit: peerService.emit,
      revokeClient: (address) => bridge.clientRevoked(address),
      changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
      unpairer,
      resetSigner: () => {
        signer = undefined;
      },
      linkStatement: (alias, statement) =>
        links?.statement(alias, statement) ?? false,
      ...(deps.noticeBackoffMs === undefined
        ? {}
        : { backoffMs: deps.noticeBackoffMs }),
    });
    bridgeDeps.keys = () => keyService;
    keys = keyService;
    links = new LinkWiring({
      rootDir,
      store,
      messages: messaging.store,
      port: () => port,
      policy: () => a2aConfig(rootDir).policy,
      unpaired: (id) =>
        unpairer?.drop(
          id,
          (a) =>
            `a2a:${a} unpaired: the other side removed this pairing over the link. Its records are kept, disabled.`
        ),
      keyChange: (id, statement) => keyService.receiveOverLink(id, statement),
      pairing: () => ({
        ...peerService.deps,
        notices: peerService.notices,
        emit: peerService.emit,
      }),
      changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
      ...(deps.linkIntervalMs === undefined
        ? {}
        : { intervalMs: deps.linkIntervalMs }),
    });
    peerService.onChange((alias, what) => {
      if (what === 'removed') links?.removed(alias);
    });
    const upgradeService = new Upgrades({
      ...peerService.deps,
      notices: peerService.notices,
      emit: peerService.emit,
      changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
      ...(deps.noticeBackoffMs === undefined
        ? {}
        : { backoffMs: deps.noticeBackoffMs }),
    });
    bridgeDeps.upgrades = () => upgradeService;
    upgrades = upgradeService;
    // This daemon as a relay tenant: each call frame answered as the port
    // routes answer a standalone host pinned to the tenant URL.
    relay = new RelayClient({
      signer: () => bridgeDeps.signer?.() ?? null,
      serve: (req, rest, host, stillHost) =>
        servePortCall(req, bridge, rest, req.method, host, stillHost),
      hostGone: (hostId) => bridge.hostRevoked(hostId),
      ownerRef: deps.ownerRef,
      changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
    });
    // The owner's answers to upgrade questions (plain questions: a new gate
    // type would be a protocol registry change).
    stopUpgradeAnswers = messaging.engine.subscribe((e) => {
      if (e.type === 'message') upgradeService.answered(e.message);
    });
    messaging.setExternalPolicy(
      bridgeExternalPolicy(bridgeDeps, peerService.notices)
    );
    // The 24 h card refresh, checked hourly; a rotation whose overlap is
    // over is finished by reloading the keys.
    refreshTimer = setInterval(() => {
      void finishRotation(rootDir).then(
        (finished) => {
          if (finished) signer = undefined;
        },
        (err: unknown) =>
          console.error('dispatchd: finishing the A2A key rotation failed', err)
      );
      void probeUnverifiedPeers(peerService).catch((err: unknown) =>
        console.error('dispatchd: probing unverified A2A peers failed', err)
      );
      void refreshDuePeers(peerService.deps, peerService.notices).then(
        (n) => {
          if (n > 0) deps.events.broadcast({ type: 'a2a.changed' });
        },
        (err: unknown) =>
          console.error('dispatchd: A2A peer refresh failed', err)
      );
    }, 3_600_000);
    refreshTimer.unref();
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
      push.resume((row) => gatherFacts(bridgeDeps, row));
    } catch (err) {
      console.error('dispatchd: A2A push resume failed', err);
    }
    try {
      // Its gate sends finish in the background and log their own failures.
      reconcileA2A(bridgeDeps, hub);
    } catch (err) {
      console.error('dispatchd: A2A boot reconciliation failed', err);
    }
    // After reconciliation, before any listener opens: relays what boot found held.
    try {
      outbound = startOutbound(peerService, {
        changed: () => deps.events.broadcast({ type: 'a2a.changed' }),
        ...(deps.unverifiedWindowMs === undefined
          ? {}
          : { unverifiedWindowMs: deps.unverifiedWindowMs }),
        keyUnknown: (alias) => keyService.keyUnknown(alias),
        linkClientFor: (row) => links?.clientFor(row) ?? null,
      });
    } catch (err) {
      console.error('dispatchd: the A2A outbound worker did not start', err);
    }
    try {
      unpairer.resume();
      keyService.resume();
      upgradeService.resume();
      relay?.apply(readRelaySettings(rootDir).settings);
      void finishRotation(rootDir).then(
        (finished) => {
          if (finished) signer = undefined;
        },
        (err: unknown) =>
          console.error('dispatchd: finishing the A2A key rotation failed', err)
      );
    } catch (err) {
      console.error('dispatchd: A2A unpair resume failed', err);
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

  // Probed once, so the form's proposal holds still between polls.
  let suggested: number | null = null;
  function suggestedPort(): number | null {
    if (settings.port !== null) return null;
    suggested ??= freeLoopbackPort();
    return suggested;
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
      warnings: [
        ...a2aConfig(rootDir).warnings,
        ...(signerError === null
          ? []
          : [`card signing is off: ${signerError}`]),
      ],
      legacyClients,
      settings,
      teamTls: deps.teamTls ?? null,
      suggestedPort: suggestedPort(),
    };
  }

  const bridge: A2ABridge = {
    cancelOffersBy(ref) {
      if (store === null) return;
      for (const p of store.pairings())
        if (p.createdBy === ref && p.state === 'offered')
          store.setPairingState(p.id, 'canceled');
      deps.events.broadcast({ type: 'a2a.changed' });
    },
    async probeUnverified() {
      if (peers === null) return;
      await probeUnverifiedPeers(peers);
    },
    get unpairer() {
      return unpairer;
    },
    get keys() {
      return keys;
    },
    get upgrades() {
      return upgrades;
    },
    relayStatus: () =>
      relay?.status() ?? {
        ...readRelaySettings(rootDir).settings,
        connected: false,
        tenantUrl: null,
        error: 'the A2A bridge is unavailable',
      },
    setRelay(settings) {
      writeRelaySettings(rootDir, settings);
      relay?.apply(settings);
      return bridge.relayStatus();
    },
    get port() {
      return port;
    },
    get store() {
      return store;
    },
    get watch() {
      return watch;
    },
    get peers() {
      return peers;
    },
    get outbound() {
      return outbound?.worker ?? null;
    },
    get links() {
      return links?.links ?? null;
    },
    leases,
    watches,
    signedSessions,
    hostRevoked: (hostId) => {
      leases.endHost(hostId);
      watches.closeHost(hostId);
      signedSessions.endHost(hostId);
    },
    standalone: () => readListenerSettings(rootDir).settings.standalone,
    setStandalone: (enabled) =>
      serial(() => {
        const file = readListenerSettings(rootDir).settings;
        writeListenerSettings(rootDir, { ...file, standalone: enabled });
        settings = { ...settings, standalone: enabled };
        if (!enabled) {
          leases.closeAll();
          watches.closeAll();
          signedSessions.closeAll();
        }
        return Promise.resolve({ standalone: enabled });
      }),
    peerStatus(alias) {
      try {
        return store?.getPeer(alias)?.status ?? null;
      } catch (err) {
        console.error(`dispatchd: could not read A2A peer ${alias}`, err);
        return null;
      }
    },
    status,
    problems() {
      const out: string[] = [];
      let peered = false;
      try {
        peered = (store?.peers().length ?? 0) > 0;
      } catch {
        // a2a.db trouble shows in the listener status instead.
      }
      if ((peered || settings.enabled) && credentialsUnreadable())
        out.push(
          `${credentialsPath()} cannot be parsed: A2A peer sends wait and the agent card goes unsigned until it is fixed`
        );
      if (signerError !== null)
        out.push(`A2A card signing is off: ${signerError}`);
      return out;
    },
    start: () =>
      serial(async () => {
        const read = readListenerSettings(rootDir);
        settingsError = read.error;
        if (settingsError !== null)
          console.error(`dispatchd: ${settingsError}`);
        settings = applyOverrides(read.settings, deps.overrides);
        try {
          await links?.start();
        } catch (err) {
          console.error('dispatchd: teammate links did not start', err);
        }
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
      try {
        unpairer?.clientRevoked(address);
      } catch (err) {
        console.error(`dispatchd: could not unpair ${address}`, err);
      }
      // First, so closing its asks below pushes nothing to its webhooks.
      try {
        store?.deletePushConfigsOf(address);
      } catch (err) {
        console.error(
          `dispatchd: could not delete ${address}'s push configs`,
          err
        );
      }
      let rows: TaskRow[] = [];
      try {
        rows = store?.tasksOf(address) ?? [];
      } catch (err) {
        console.error(`dispatchd: could not list ${address}'s A2A tasks`, err);
      }
      for (const row of rows) {
        if (TERMINAL_STATES.has(row.state)) continue;
        // An ask closes its root question; a handoff, its open proposal gate.
        const question = row.skill === 'ask' ? row.id : row.gate;
        if (question === null) continue;
        try {
          // False when an answer got there first; the recompute shows which.
          closeGate(messaging.engine, question, 'client revoked');
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
    // The guards' evidence: a2a.db's row, else a handoff messages.db ties to the task.
    taskOrigin: (taskId) => (isA2ATask(guardDeps, taskId) ? 'a2a' : null),
    markDerived: (taskId, sourceTaskId) =>
      store?.markDerived(taskId, sourceTaskId, new Date().toISOString()),
    inherit(runId, taskId) {
      const parent = deps.orchestrator.taskIdOfRun(runId);
      if (parent !== null && parent !== taskId && isA2ATask(guardDeps, parent))
        lineage.mark(taskId, runId);
    },
    lineage,
    recheckProposals: () => proposals.recheck(),
    close: () =>
      serial(async () => {
        unpairer?.stop();
        keys?.stop();
        upgrades?.stop();
        relay?.stop();
        stopUpgradeAnswers?.();
        outbound?.stop();
        outbound = null;
        await links?.stop();
        leases.closeAll();
        watches.closeAll();
        signedSessions.closeAll();
        deps.orchestrator.setDispatchGuard(null);
        stopProposals();
        if (refreshTimer !== null) clearInterval(refreshTimer);
        refreshTimer = null;
        stopWatch?.();
        stopWatch = null;
        await listener?.close();
        messaging.setExternalPolicy(null);
        guardDeps.store = null;
        store?.close();
      }),
  };
  return bridge;
}
