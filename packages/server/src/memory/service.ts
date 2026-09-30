import { memoryReadView, readMemoryConfig } from '@dispatch/core';
import type { MemoryConfigWarning, TaskStorePort } from '@dispatch/core';
import {
  createMemoryIds,
  MemoryEngine,
  MemoryError,
  openMemoryDb,
  personalIdentityFor,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type {
  MemoryStore,
  MemoryStores,
  Operator,
  Principal,
} from '@dispatch/memory';
import { SYSTEM_ADDRESS } from '@dispatch/protocol';
import { unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import type { Messaging } from '../messaging/service.js';
import { resolveClaudeCli } from '../orchestrator/claudeCli.js';
import type { OverseerToolContext } from '../orchestrator/overseerTools.js';
import {
  claudeMemoryDir,
  memoryDbPath,
  personalMemoryDir,
  projectKeyOf,
} from '../orchestrator/paths.js';
import { runLineage } from '../orchestrator/types.js';
import type {
  MemoryPromptPort,
  PreparedMemory,
  RunKind,
  RunMeta,
} from '../orchestrator/types.js';
import {
  ClaudeExportManager,
  overseerLineageOpen,
  runLineageOpen,
  runLineageTarget,
} from './claudeExport.js';
import {
  claudeImportEnv,
  findClaudeMemorySource,
  importClaudeNotes,
  lastClaudeImport,
  mainCheckoutOf,
} from './claudeImport.js';
import type { ClaudeImportReport, SourceSearch } from './claudeImport.js';
import {
  chooseMemoryMode,
  EXPORT_PROMPT_LINE,
  PROBED_CLAUDE_CODE_VERSION,
  resolveManagedSettings,
  runPreflight,
} from './claudeModes.js';
import type { PreflightResult } from './claudeModes.js';
import { startDecayScheduler } from './decay.js';
import { closeStrayMemoryGates, registerMemoryGate } from './gate.js';
import {
  DaemonMemoryHost,
  IDENTITIES_DOWN_IDENTITY,
  NOT_OWNER_IDENTITY,
  REUSED_HANDLE_IDENTITY,
} from './host.js';
import type { DaemonMemoryHostDeps } from './host.js';
import { MemoryIdentities } from './identities.js';
import {
  importLedger as importLedgerRows,
  renderImportReport,
} from './ledgerImport.js';
import type { LedgerImportReport } from './ledgerImport.js';
import { PersonalStores } from './personalStores.js';

interface MemoryHealth {
  available: boolean;
  reason: string | null;
  search: 'fts5' | 'like' | null;
  entries: number;
  openProposals: number;
  ledgerImport: LedgerImportReport | null;
  // The last import's parity block, as the CLI prints it.
  ledgerImportText: string | null;
  configWarnings: MemoryConfigWarning[];
  lastDecayAt: string | null;
  // The caller's own personal store; null when the caller acts for no one.
  personal: { available: boolean; reason: string | null } | null;
  // The caller's pinned entries alone exceed indexTokens.
  pinnedOverflow: boolean;
  // Why runs cannot use the Claude export (the preflight failed), or null.
  exportBlocked: string | null;
  // The owner's Claude-notes import; null for anyone but the daemon's own human.
  claudeImport: {
    state: ImportState | null;
    source: string | null;
    candidates: string[];
    problems: string[];
  } | null;
}

export interface MemoryService extends MemoryPromptPort {
  /** Null when memory.db would not open. */
  readonly engine: MemoryEngine | null;
  readonly shared: SqliteMemoryStore | null;
  readonly host: DaemonMemoryHost;
  /** Null when identities.db would not open. */
  readonly identities: MemoryIdentities | null;
  readonly personal: PersonalStores;
  /** Null when memory.db would not open. */
  readonly claudeExport: ClaudeExportManager | null;
  /** The engine's stores: a reused handle answers 409, a down identities.db 503. */
  readonly stores: MemoryStores;
  /** Throws MemoryError('unavailable') with the open failure. */
  requireEngine(): MemoryEngine;
  importLedger(opts?: { dryRun?: boolean }): LedgerImportReport | null;
  lastLedgerImport(): LedgerImportReport | null;
  /** Re-runs the export preflight that prepare reads from its cache. */
  refreshPreflight(): Promise<PreflightResult>;
  /** Boot: imports the owner's Claude notes unless this project already recorded an import. */
  importClaudeOnce(): Promise<ClaudeImportReport | null>;
  /** Re-runs the owner's Claude-notes import; `from` or `none` answers an unconfirmed one. */
  importClaude(opts?: {
    from?: string;
    none?: boolean;
    dryRun?: boolean;
  }): Promise<ClaudeImportReport>;
  /** Boot, after messaging.recover(): raises unsent gates, closes strays, sweeps Claude exports, then starts decay. */
  recover(): Promise<{ raised: number; closed: number }>;
  health(principal: Principal | null): MemoryHealth;
  close(): void;
}

export interface OpenMemoryDeps {
  rootDir: string;
  store: TaskStorePort;
  orchestrator: DaemonMemoryHostDeps['orchestrator'];
  events: EventBus;
  ledgerStore: LedgerStorePort;
  messaging: Pick<Messaging, 'engine' | 'gates'>;
  /** The human memory gates go to, and policy receipts are credited to. */
  ownerRef: string;
  /** The task Activity line a policy approval writes. */
  appendPolicyActivity: (taskId: string, text: string) => void;
  dbPath?: string;
  /** Where identities.db and the personal databases live. */
  personalDir?: string;
  /** The files backend's ledger.jsonl, re-imported when a pull rewrites it. */
  watchLedgerFile?: string | null;
  /** How often leftover Claude export directories are swept; hourly unless a test shortens it. */
  exportSweepMs?: number;
  /** The export preflight; the real one checks the Claude Code CLI, env and managed settings. */
  preflight?: () => Promise<PreflightResult>;
  /** How often the export preflight re-runs; hourly unless a test shortens it. */
  preflightRefreshMs?: number;
  /** The version boot records as probed; this build's own unless a test overrides it. */
  probedClaudeVersion?: string | null;
  now?: () => Date;
}

const LAST_IMPORT_KEY = 'ledger-import:last';
const CUTOVER_KEY = 'ledger-cutover-at';
// Set by the first import after the cutover.
const CUTOVER_SWEPT_KEY = 'ledger-cutover-swept-at';
// The oldest Claude Code version the live probe passed on.
const PROBE_KEY = 'claude-probe-passed';
const HOUR_MS = 3_600_000;
const UNLOADED_NOTE =
  'Your auto-memory directory is not active; save memories with memory_save.';
const IMPORT_STATES = ['complete', 'failed', 'unconfirmed', 'running'] as const;

type ImportState = (typeof IMPORT_STATES)[number];

// A session's chosen mode: export names its written directory; review and
// verify runs get prompt mode with no index.
type SessionMode =
  | { mode: 'export'; dir: string }
  | { mode: 'native' | 'prompt'; index: boolean };

// One run's Claude session whose memory mode is being chosen.
interface SessionTarget {
  principal: Principal;
  // The export directory's name: the run's lineage.
  name: string;
  taskId: string | null;
  runKind: RunKind;
  isClaude: boolean;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

const runPrincipal = (runId: string): Principal => ({
  address: `run:${runId}`,
  canDecide: false,
  kind: 'run',
});

// The owner's Claude-import state for the project, or null when none is recorded.
function importState(
  store: MemoryStore,
  projectKey: string
): ImportState | null {
  const raw = store.meta(`claude-import:${projectKey}`);
  return IMPORT_STATES.find((state) => state === raw) ?? null;
}

// The last committed import report, or null when none was stored or it no longer parses.
function readLastImport(
  shared: SqliteMemoryStore | null
): LedgerImportReport | null {
  const raw = shared?.meta(LAST_IMPORT_KEY) ?? null;
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as LedgerImportReport;
  } catch {
    return null;
  }
}

/**
 * Opens memory.db, identities.db and the engine over them, registers the
 * memory gate's handler and keeps the ledger's lessons imported. A database
 * that will not open leaves its part unavailable, never a failed boot.
 */
export function openMemory(deps: OpenMemoryDeps): MemoryService {
  const now = deps.now ?? (() => new Date());
  const personalDir = deps.personalDir ?? personalMemoryDir();
  const dbPath = deps.dbPath ?? memoryDbPath(deps.rootDir);
  let shared: SqliteMemoryStore | null = null;
  let reason: string | null = null;
  try {
    shared = new SqliteMemoryStore(openMemoryDb(dbPath));
  } catch (err) {
    reason = message(err);
    console.error(`dispatchd: memory unavailable: ${reason}`);
  }
  // The first boot of a build with the cutover; ledger rows written after it
  // become proposals, never entries.
  if (shared !== null && shared.meta(CUTOVER_KEY) === null)
    shared.setMeta(CUTOVER_KEY, now().toISOString());
  // Every boot records this build's probe, so a value an older build left never outlives it.
  const probed =
    deps.probedClaudeVersion === undefined
      ? PROBED_CLAUDE_CODE_VERSION
      : deps.probedClaudeVersion;
  if (shared !== null) {
    if (probed === null) shared.deleteMeta(PROBE_KEY);
    else shared.setMeta(PROBE_KEY, probed);
  }
  let identities: MemoryIdentities | null = null;
  let identitiesReason = 'identities.db will not open';
  try {
    identities = new MemoryIdentities({
      path: join(personalDir, 'identities.db'),
      now,
    });
  } catch (err) {
    identitiesReason = message(err);
    console.error(
      `dispatchd: personal memory unavailable: ${identitiesReason}`
    );
  }
  const personal = new PersonalStores({ dir: personalDir });
  const unavailable = () =>
    new MemoryError('unavailable', `memory unavailable: ${reason}`, 'store');
  const stores: MemoryStores = {
    shared: () => {
      if (shared === null) throw unavailable();
      return shared;
    },
    personal: (identity) => {
      if (identity === REUSED_HANDLE_IDENTITY)
        throw new MemoryError(
          'conflict',
          'this handle was bound to someone else; link or start fresh',
          'identity'
        );
      if (identity === NOT_OWNER_IDENTITY)
        throw new MemoryError(
          'forbidden',
          "only the owner's own credential reaches the owner's personal memory",
          'identity'
        );
      if (identity === IDENTITIES_DOWN_IDENTITY)
        throw new MemoryError(
          'unavailable',
          `personal memory unavailable: ${identitiesReason}`,
          'store'
        );
      return personal.personal(identity);
    },
    locatePersonal: (id) =>
      identities === null ? null : personal.locate(id, identities.identities()),
  };
  const host = new DaemonMemoryHost({
    projectKey: projectKeyOf(deps.rootDir),
    rootDir: deps.rootDir,
    ownerRef: deps.ownerRef,
    store: deps.store,
    orchestrator: deps.orchestrator,
    events: deps.events,
    messaging: deps.messaging,
    ledgerStore: deps.ledgerStore,
    appendPolicyActivity: deps.appendPolicyActivity,
    identities,
    shared: () => stores.shared(),
    engine: () => {
      if (engine === null) throw unavailable();
      return engine;
    },
    now,
  });
  const config = () => readMemoryConfig(deps.rootDir).config;
  const engine =
    shared === null ? null : new MemoryEngine({ stores, host, config });
  // Registered here, before messaging.recover(), so an answer a crash left
  // unapplied is replayed into it. With memory down the answer stays
  // unapplied for the next boot rather than being marked done.
  if (engine === null)
    deps.messaging.gates.register('memory', () =>
      Promise.reject(unavailable())
    );
  else registerMemoryGate(deps.messaging, engine);
  // The operator's personal store for an export's writes and problems; null when there is none.
  const personalStoreOf = (principal: Principal): MemoryStore | null => {
    if (engine === null) return null;
    try {
      const identity = personalIdentityFor(engine.viewer(principal));
      return identity === null ? null : stores.personal(identity);
    } catch (err) {
      if (err instanceof MemoryError) return null;
      throw err;
    }
  };
  const claudeExport =
    engine === null || shared === null
      ? null
      : new ClaudeExportManager({
          rootDir: deps.rootDir,
          engine,
          shared,
          personalStore: personalStoreOf,
          config,
          now,
        });
  // Scans leftover export directories and deletes those whose lineage closed.
  const sweepExports = async (): Promise<void> => {
    if (claudeExport === null) return;
    try {
      const runs = deps.orchestrator.list();
      const nowMs = now().getTime();
      await claudeExport.sweep({
        // An overseer directory is closed, never ingested: the overseer
        // writes no one's memory.
        targetOf: (name) =>
          name.startsWith('o-') ? null : runLineageTarget(runs, name),
        isOpen: (name) =>
          name.startsWith('o-')
            ? overseerLineageOpen(claudeMemoryDir(deps.rootDir, name), nowMs)
            : runLineageOpen(
                runs,
                name,
                (id) => deps.orchestrator.isRunLive(id),
                nowMs
              ),
      });
    } catch (err) {
      console.error('dispatchd: sweeping Claude memory exports failed', err);
    }
  };
  const exportSweep = setInterval(
    () => void sweepExports(),
    deps.exportSweepMs ?? HOUR_MS
  );
  exportSweep.unref();
  const ids = createMemoryIds();
  let last = readLastImport(shared);
  // Gate recovery and proposal expiry run one at a time, so a proposal is
  // never expired while its gate is being raised, nor raised twice.
  let queue: Promise<unknown> = Promise.resolve();
  const serial = <T>(step: () => Promise<T>): Promise<T> => {
    const next = queue.then(step, step);
    queue = next;
    return next;
  };
  const raisePending = (): Promise<{ raised: number }> =>
    engine === null
      ? Promise.resolve({ raised: 0 })
      : serial(() => engine.recover());

  // A dry run reports without writing and leaves the stored report alone.
  const importLedger = (
    opts: { dryRun?: boolean } = {}
  ): LedgerImportReport | null => {
    if (shared === null) return null;
    const snapshot = deps.ledgerStore.listSafe();
    const report = importLedgerRows({
      rows: snapshot.records,
      damaged: snapshot.errors.length,
      store: shared,
      ids,
      now: now(),
      cutoverAt: shared.meta(CUTOVER_KEY),
      cutoverSwept: shared.meta(CUTOVER_SWEPT_KEY) !== null,
      dryRun: opts.dryRun,
    });
    if (opts.dryRun === true) return report;
    if (shared.meta(CUTOVER_KEY) !== null)
      shared.setMeta(CUTOVER_SWEPT_KEY, now().toISOString());
    last = report;
    shared.setMeta(LAST_IMPORT_KEY, JSON.stringify(report));
    if (report.outcome === 'MISMATCH')
      console.error(
        `dispatchd: ledger import MISMATCH\n${renderImportReport(report)}`
      );
    if (report.memory.imported + report.memory.proposed > 0)
      host.changed({ scope: 'team' });
    // The import stores its proposals with no gate; recovery raises them.
    if (report.outcome === 'ok' && report.memory.proposed > 0)
      void raisePending().catch((err: unknown) =>
        console.error('dispatchd: raising imported memory gates failed', err)
      );
    return report;
  };

  // A failed import is logged and retried on the next change, never thrown
  // into the ledger writer that broadcast it.
  const importQuietly = () => {
    try {
      importLedger();
    } catch (err) {
      console.error('dispatchd: ledger import failed', err);
    }
  };
  // The run's '## Memory' section, or null while memory is unavailable. An
  // export records its own index recalls, so `record` is false for one.
  const indexSection = (
    input: { runId: string; taskId: string; dispatchTools: boolean },
    record: boolean
  ): string | null => {
    if (engine === null) return null;
    try {
      return engine.index({
        principal: runPrincipal(input.runId),
        taskId: input.taskId,
        runId: input.runId,
        variant: input.dispatchTools ? 'tools' : 'no-tools',
        recordRecalls: record,
        onRecallError: (err) =>
          console.error(
            `dispatchd: recording index recalls for run ${input.runId} failed`,
            err
          ),
      }).text;
    } catch (err) {
      console.error(
        `dispatchd: memory index for run ${input.runId} failed`,
        err
      );
      return null;
    }
  };

  // The last export preflight: prepare reads it, so no dispatch waits on the CLI.
  let preflight: PreflightResult = {
    ok: false,
    reason: 'the export preflight has not finished',
  };
  const exportPreflight =
    deps.preflight ??
    (() =>
      runPreflight({
        env: process.env,
        probePassed: shared?.meta(PROBE_KEY) ?? null,
        cliVersion: async () => (await resolveClaudeCli()).version,
        resolveManaged: () => resolveManagedSettings(deps.rootDir),
      }));
  const refreshPreflight = async (): Promise<PreflightResult> => {
    try {
      preflight = await exportPreflight();
    } catch (err) {
      preflight = { ok: false, reason: message(err) };
    }
    return preflight;
  };
  void refreshPreflight();
  const preflightTimer = setInterval(
    () => void refreshPreflight(),
    deps.preflightRefreshMs ?? HOUR_MS
  );
  preflightTimer.unref();

  // Who the principal acts for; null for no one, or when that cannot be told.
  const operatorFor = (principal: Principal): Operator | null => {
    try {
      return engine === null
        ? host.operatorOf(principal)
        : engine.viewer(principal).operator;
    } catch (err) {
      console.error(
        `dispatchd: could not tell who ${principal.address} acts for`,
        err
      );
      return null;
    }
  };
  // The identity's personal store, or null when it will not open (D30's reused handle too).
  const openPersonal = (identity: string): MemoryStore | null => {
    try {
      return stores.personal(identity);
    } catch (err) {
      if (err instanceof MemoryError) return null;
      throw err;
    }
  };
  // Picks a session's memory mode; the export is written only once every other
  // step says export.
  const chooseMode = (t: SessionTarget): SessionMode => {
    const operator = operatorFor(t.principal);
    const personalStore =
      operator === null ? null : openPersonal(operator.identity);
    const operatorIsOwner = operator?.human === deps.ownerRef;
    const choice = chooseMemoryMode({
      isClaude: t.isClaude,
      runKind: t.runKind,
      hasOperator: operator !== null,
      personalAvailable: personalStore !== null,
      operatorIsOwner,
      ownerImport:
        operatorIsOwner && personalStore !== null
          ? importState(personalStore, projectKeyOf(deps.rootDir))
          : null,
      claudeAutoMemory: config().claudeAutoMemory,
      preflight,
      exportWritten: () => {
        if (claudeExport === null) return false;
        try {
          claudeExport.prepare({
            name: t.name,
            principal: t.principal,
            taskId: t.taskId,
          });
          return true;
        } catch (err) {
          console.error(
            `dispatchd: writing the Claude memory export ${t.name} failed`,
            err
          );
          return false;
        }
      },
    });
    return choice.mode === 'export'
      ? { mode: 'export', dir: claudeMemoryDir(deps.rootDir, t.name) }
      : { mode: choice.mode, index: choice.index };
  };

  // Each export-mode run's directory watch, by lineage, until the run ends.
  const watches = new Map<string, { runId: string; stop: () => void }>();
  const prepare: MemoryPromptPort['prepare'] = (input): PreparedMemory => {
    const target = {
      name: input.lineage,
      principal: runPrincipal(input.runId),
      taskId: input.taskId,
    };
    const choice = chooseMode({
      ...target,
      runKind: input.runKind,
      isClaude: input.isClaude,
    });
    if (choice.mode !== 'export') {
      const section = choice.index
        ? indexSection(input, !input.continues)
        : null;
      return {
        text: section,
        indexSection: section,
        memory: { mode: choice.mode },
      };
    }
    const section = indexSection(input, false);
    if (claudeExport !== null) {
      watches.get(input.lineage)?.stop();
      watches.set(input.lineage, {
        runId: input.runId,
        stop: claudeExport.watch(target),
      });
    }
    const probe = shared?.meta(PROBE_KEY) ?? null;
    return {
      text: EXPORT_PROMPT_LINE,
      indexSection: section,
      memory: {
        mode: 'export',
        dir: choice.dir,
        ...(probe === null ? {} : { probeVersion: probe }),
        unloadedNote:
          section === null ? UNLOADED_NOTE : `${section}\n\n${UNLOADED_NOTE}`,
      },
    };
  };
  // The export's files the agent read become recalls; any other path is ignored.
  const recall: MemoryPromptPort['recall'] = (runId, lineage, paths, via) => {
    if (claudeExport === null) return;
    try {
      claudeExport.recordRecalls(runId, lineage, paths, via);
    } catch (err) {
      console.error(
        `dispatchd: recording recalls for run ${runId} failed`,
        err
      );
    }
  };
  // The run's final scan; its directory stays until the lineage closes.
  const runEnded = (meta: RunMeta): void => {
    const name = runLineage(meta);
    const watched = watches.get(name);
    if (watched === undefined || watched.runId !== meta.id) return;
    watched.stop();
    watches.delete(name);
    claudeExport
      ?.ingest({ name, principal: runPrincipal(meta.id), taskId: meta.taskId })
      .catch((err: unknown) =>
        console.error(
          `dispatchd: ingesting run ${meta.id}'s memory failed`,
          err
        )
      );
  };

  // Whether the principal's own personal store opens; null when it acts for no one.
  const personalHealth = (principal: Principal): MemoryHealth['personal'] => {
    const identity =
      engine === null
        ? (host.operatorOf(principal)?.identity ?? null)
        : personalIdentityFor(engine.viewer(principal));
    if (identity === null) return null;
    try {
      stores.personal(identity);
      return { available: true, reason: null };
    } catch (err) {
      if (err instanceof MemoryError)
        return { available: false, reason: err.message };
      throw err;
    }
  };
  // With no task, every visible entry reaches, so this is the pins alone.
  const pinnedOverflow = (principal: Principal): boolean => {
    if (engine === null) return false;
    try {
      return engine.index({
        principal,
        taskId: null,
        runId: null,
        variant: 'tools',
        recordRecalls: false,
      }).pinnedOverflow;
    } catch (err) {
      if (err instanceof MemoryError) return false;
      throw err;
    }
  };

  const projectKey = projectKeyOf(deps.rootDir);
  // The real home and Claude settings, unless DISPATCH_HOME redirects them.
  const claudeEnv = claudeImportEnv();
  // Imports run one at a time; `claudeWrites` counts those queued that write.
  let claudeQueue: Promise<unknown> = Promise.resolve();
  let claudeWrites = 0;
  // A search that finds nothing keeps a completed import's source, or its
  // "no Claude notes" answer, rather than asking the owner again.
  const keepAnswer = (
    store: MemoryStore,
    search: SourceSearch
  ): SourceSearch | { explicit: string } | { none: true } => {
    if (search.found !== null || importState(store, projectKey) !== 'complete')
      return search;
    const last = lastClaudeImport(store, projectKey);
    if (last === null) return search;
    return last.source === null ? { none: true } : { explicit: last.source };
  };
  const importClaude: MemoryService['importClaude'] = (opts = {}) => {
    const writes = opts.dryRun !== true;
    if (writes) claudeWrites += 1;
    const step = async (): Promise<ClaudeImportReport> => {
      try {
        // The owner is always identity `self`.
        const store = stores.personal('self');
        const source =
          opts.none === true
            ? { none: true as const }
            : opts.from !== undefined
              ? { explicit: opts.from }
              : keepAnswer(
                  store,
                  await findClaudeMemorySource({
                    rootDir: deps.rootDir,
                    mainCheckout: mainCheckoutOf(deps.rootDir),
                    env: claudeEnv.env,
                    home: claudeEnv.home,
                    resolveEffective: claudeEnv.resolveEffective,
                  })
                );
        const report = await importClaudeNotes({
          source,
          store,
          projectKey,
          ownerRef: deps.ownerRef,
          ids,
          now: now(),
          home: claudeEnv.home,
          dryRun: opts.dryRun,
        });
        if (writes && report.imported + report.updated > 0)
          host.changed({ scope: 'personal' });
        return report;
      } finally {
        if (writes) claudeWrites -= 1;
      }
    };
    const next = claudeQueue.then(step, step);
    claudeQueue = next.catch(() => undefined);
    return next;
  };
  // Settings → Memory's view of the owner's import: its state, source and candidates.
  const claudeImportHealth = (): MemoryHealth['claudeImport'] => {
    const store = openPersonal('self');
    const last = store === null ? null : lastClaudeImport(store, projectKey);
    return {
      state:
        claudeWrites > 0
          ? 'running'
          : store === null
            ? null
            : importState(store, projectKey),
      source: last?.source ?? null,
      candidates: last?.candidates ?? [],
      problems: last?.problems ?? [],
    };
  };

  const unsubscribe = deps.events.subscribe((event) => {
    if (event.type === 'ledger.changed') importQuietly();
  });
  const watched = deps.watchLedgerFile ?? null;
  if (watched !== null)
    watchFile(watched, { interval: 5000, persistent: false }, importQuietly);
  const decay = startDecayScheduler({
    shared: () => shared,
    personal,
    engine: () => engine,
    messaging: deps.messaging,
    config,
    host,
    sharedPath: dbPath,
    serial,
    now,
  });

  return {
    engine,
    shared,
    host,
    identities,
    personal,
    claudeExport,
    stores,
    requireEngine: () => {
      if (engine === null) throw unavailable();
      return engine;
    },
    importLedger,
    lastLedgerImport: () => last,
    prepare,
    recall,
    runEnded,
    refreshPreflight,
    importClaudeOnce: async () => {
      const store = openPersonal('self');
      if (store === null || importState(store, projectKey) !== null)
        return null;
      try {
        return await importClaude();
      } catch (err) {
        console.error(
          "dispatchd: importing the owner's Claude notes failed",
          err
        );
        return null;
      }
    },
    importClaude,
    recover: async () => {
      try {
        if (engine === null || shared === null) return { raised: 0, closed: 0 };
        const { raised } = await raisePending();
        const closed = closeStrayMemoryGates(deps.messaging.engine, shared);
        await sweepExports();
        return { raised, closed };
      } finally {
        void decay
          .runDue()
          .catch((err: unknown) =>
            console.error('dispatchd: memory decay pass failed', err)
          );
      }
    },
    health: (principal) => ({
      available: shared !== null,
      reason,
      search: shared?.search ?? null,
      entries: shared?.countEntries() ?? 0,
      openProposals: shared?.countOpenProposals() ?? 0,
      ledgerImport: last,
      ledgerImportText: last === null ? null : renderImportReport(last),
      configWarnings: readMemoryConfig(deps.rootDir).warnings,
      lastDecayAt: shared?.meta('last_decay_at') ?? null,
      personal: principal === null ? null : personalHealth(principal),
      pinnedOverflow: principal === null ? false : pinnedOverflow(principal),
      exportBlocked: preflight.ok ? null : preflight.reason,
      claudeImport:
        principal !== null &&
        principal.kind === 'human' &&
        principal.address === deps.ownerRef &&
        principal.ownerCredential === true
          ? claudeImportHealth()
          : null,
    }),
    close: () => {
      clearInterval(exportSweep);
      clearInterval(preflightTimer);
      claudeExport?.close();
      decay.stop();
      unsubscribe();
      if (watched !== null) unwatchFile(watched, importQuietly);
      shared?.close();
      personal.close();
      identities?.close();
    },
  };
}

// Every request-tier caller can read an overseer transcript, so the overseer
// reads as Dispatch itself, which acts for no human: project and team only.
export function overseerMemory(
  memory: Pick<MemoryService, 'requireEngine'>
): NonNullable<OverseerToolContext['memory']> {
  const principal: Principal = {
    address: SYSTEM_ADDRESS,
    canDecide: false,
    kind: 'agent',
  };
  return {
    search: (input) => {
      const engine = memory.requireEngine();
      return {
        hits: engine.search(principal, input),
        search: engine.searchMode(),
      };
    },
    read: (ref) => memoryReadView(memory.requireEngine().read(principal, ref)),
  };
}
