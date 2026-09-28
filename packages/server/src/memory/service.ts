import { readMemoryConfig } from '@dispatch/core';
import type { MemoryConfigWarning, TaskStorePort } from '@dispatch/core';
import {
  createMemoryIds,
  MemoryEngine,
  MemoryError,
  openMemoryDb,
  personalIdentityFor,
  SqliteMemoryStore,
} from '@dispatch/memory';
import type { MemoryStores, Principal } from '@dispatch/memory';
import { unwatchFile, watchFile } from 'node:fs';
import { join } from 'node:path';

import type { EventBus } from '../events.js';
import type { LedgerStorePort } from '../ledger.js';
import type { Messaging } from '../messaging/service.js';
import {
  memoryDbPath,
  personalMemoryDir,
  projectKeyOf,
} from '../orchestrator/paths.js';
import type {
  MemoryPromptPort,
  MemoryPromptSection,
} from '../orchestrator/types.js';
import { closeStrayMemoryGates, registerMemoryGate } from './gate.js';
import {
  DaemonMemoryHost,
  IDENTITIES_DOWN_IDENTITY,
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
  configWarnings: MemoryConfigWarning[];
  lastDecayAt: string | null;
  // The caller's own personal store; null when the caller acts for no one.
  personal: { available: boolean; reason: string | null } | null;
  // The caller's pinned entries alone exceed indexTokens.
  pinnedOverflow: boolean;
}

export interface MemoryService extends MemoryPromptPort {
  /** Null when memory.db would not open. */
  readonly engine: MemoryEngine | null;
  readonly shared: SqliteMemoryStore | null;
  readonly host: DaemonMemoryHost;
  /** Null when identities.db would not open. */
  readonly identities: MemoryIdentities | null;
  readonly personal: PersonalStores;
  /** Throws MemoryError('unavailable') with the open failure. */
  requireEngine(): MemoryEngine;
  importLedger(opts?: { dryRun?: boolean }): LedgerImportReport | null;
  lastLedgerImport(): LedgerImportReport | null;
  /** Boot, after messaging.recover(): raises gates a crash left unsent, then closes strays. */
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
  now?: () => Date;
}

const LAST_IMPORT_KEY = 'ledger-import:last';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
  let shared: SqliteMemoryStore | null = null;
  let reason: string | null = null;
  try {
    shared = new SqliteMemoryStore(
      openMemoryDb(deps.dbPath ?? memoryDbPath(deps.rootDir))
    );
  } catch (err) {
    reason = message(err);
    console.error(`dispatchd: memory unavailable: ${reason}`);
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
  const ids = createMemoryIds();
  let last = readLastImport(shared);

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
      cutoverAt: shared.meta('ledger-cutover-at'),
      dryRun: opts.dryRun,
    });
    if (opts.dryRun === true) return report;
    last = report;
    shared.setMeta(LAST_IMPORT_KEY, JSON.stringify(report));
    if (report.outcome === 'MISMATCH')
      console.error(
        `dispatchd: ledger import MISMATCH\n${renderImportReport(report)}`
      );
    if (report.memory.imported + report.memory.proposed > 0)
      host.changed({ scope: 'team' });
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
  // The run's '## Memory' section, or 'ledger' while memory is unavailable or no import has succeeded.
  const promptSection = (input: {
    runId: string;
    taskId: string;
    dispatchTools: boolean;
  }): MemoryPromptSection => {
    if (engine === null || last?.outcome !== 'ok') return { source: 'ledger' };
    try {
      const out = engine.index({
        principal: {
          address: `run:${input.runId}`,
          canDecide: false,
          kind: 'run',
        },
        taskId: input.taskId,
        runId: input.runId,
        variant: input.dispatchTools ? 'tools' : 'no-tools',
        onRecallError: (err) =>
          console.error(
            `dispatchd: recording index recalls for run ${input.runId} failed`,
            err
          ),
      });
      return { source: 'memory', text: out.text };
    } catch (err) {
      console.error(
        `dispatchd: memory index for run ${input.runId} failed`,
        err
      );
      return { source: 'ledger' };
    }
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

  const unsubscribe = deps.events.subscribe((event) => {
    if (event.type === 'ledger.changed') importQuietly();
  });
  const watched = deps.watchLedgerFile ?? null;
  if (watched !== null)
    watchFile(watched, { interval: 5000, persistent: false }, importQuietly);

  return {
    engine,
    shared,
    host,
    identities,
    personal,
    requireEngine: () => {
      if (engine === null) throw unavailable();
      return engine;
    },
    importLedger,
    lastLedgerImport: () => last,
    promptSection,
    recover: async () => {
      if (engine === null || shared === null) return { raised: 0, closed: 0 };
      const { raised } = await engine.recover();
      return {
        raised,
        closed: closeStrayMemoryGates(deps.messaging.engine, shared),
      };
    },
    health: (principal) => ({
      available: shared !== null,
      reason,
      search: shared?.search ?? null,
      entries: shared?.countEntries() ?? 0,
      openProposals: shared?.countOpenProposals() ?? 0,
      ledgerImport: last,
      configWarnings: readMemoryConfig(deps.rootDir).warnings,
      lastDecayAt: shared?.meta('last_decay_at') ?? null,
      personal: principal === null ? null : personalHealth(principal),
      pinnedOverflow: principal === null ? false : pinnedOverflow(principal),
    }),
    close: () => {
      unsubscribe();
      if (watched !== null) unwatchFile(watched, importQuietly);
      shared?.close();
      personal.close();
      identities?.close();
    },
  };
}
