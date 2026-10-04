import type { MemoryConfig } from '@dispatch/core';
import { decayStore, MEMORY_SCOPES } from '@dispatch/memory';
import type {
  DecayResult,
  MemoryEngine,
  MemoryHost,
  MemoryProposal,
  MemoryScope,
  MemoryStore,
} from '@dispatch/memory';
import {
  isDecidingAuthor,
  MessagingError,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';

import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { Messaging } from '../messaging/service.js';
import { memoryGateAnswer } from './gate.js';
import type { PersonalStores } from './personalStores.js';

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const LAST_DECAY_KEY = 'last_decay_at';

interface DecaySummary {
  stores: number;
  staled: number;
  expired: number;
  proposalsExpired: number;
  backups: number;
  /** Personal identities another daemon swept within 24 hours. */
  skipped: string[];
}

type DecayPolicy = Parameters<typeof decayStore>[1];

interface DecaySchedulerDeps {
  shared: () => MemoryStore | null;
  personal: PersonalStores;
  engine: () => MemoryEngine | null;
  messaging: Pick<Messaging, 'engine'>;
  config: () => MemoryConfig;
  host: Pick<MemoryHost, 'changed'>;
  /** memory.db's file; its backup is `<sharedPath>.bak`. */
  sharedPath: string;
  /** Runs gate raising and proposal expiry one at a time with the service's recovery. */
  serial: <T>(step: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  /** How often to look for a store whose own stamp is over a day old. */
  intervalMs?: number;
}

// A stamp in the future (a skewed clock) or one that will not parse is due.
function sweptWithinADay(stamp: string | null, nowMs: number): boolean {
  if (stamp === null) return false;
  const age = nowMs - Date.parse(stamp);
  return age >= 0 && age < DAY_MS;
}

// A memory.db whose stamp will not read is due; the pass then logs why.
function sharedDue(shared: MemoryStore, nowMs: number): boolean {
  try {
    return !sweptWithinADay(shared.meta(LAST_DECAY_KEY), nowMs);
  } catch {
    return true;
  }
}

// Ages one store and prunes its recalls; a failure is logged so the other
// stores still run. Null when the store could not be swept.
function sweep(
  store: MemoryStore,
  label: string,
  policy: DecayPolicy,
  summary: DecaySummary
): DecayResult | null {
  try {
    const result = decayStore(store, policy);
    if (result.anomaly !== null)
      console.error(
        `dispatchd: memory decay of ${label} only marked stale: ${result.anomaly}`
      );
    summary.stores += 1;
    summary.staled += result.staled;
    summary.expired += result.expired;
    return result;
  } catch (err) {
    console.error(`dispatchd: memory decay of ${label} failed`, err);
    return null;
  }
}

function backup(
  store: MemoryStore,
  path: string,
  label: string,
  summary: DecaySummary
): void {
  try {
    store.backup(path);
    summary.backups += 1;
  } catch (err) {
    console.error(`dispatchd: memory backup of ${label} failed`, err);
  }
}

// Expires one proposal through its gate, or directly with no gate to answer;
// an answer that beat the expiry but never took effect is applied instead.
async function expireProposal(
  messaging: Pick<Messaging, 'engine'>,
  memory: MemoryEngine,
  p: MemoryProposal,
  body: string
): Promise<void> {
  if (p.gate === null) {
    memory.expireUngated(p.id);
    return;
  }
  const gate = p.gate;
  try {
    await messaging.engine.reply(
      gate,
      { choice: 'reject', body, data: { type: 'x-expired' } },
      SYSTEM_SENDER
    );
    return;
  } catch (err) {
    if (!(err instanceof MessagingError)) throw err;
    const question = messaging.engine.getMessage(gate);
    if (err.code === 'not-found' && question === null) {
      memory.applyGateAnswer({
        proposalId: p.id,
        gateId: gate,
        choice: 'reject',
        by: SYSTEM_ADDRESS,
        reason: body,
        expired: true,
      });
      return;
    }
    if (err.code !== 'conflict' || question === null) throw err;
    const answer = messaging.engine.answerOf(gate);
    if (answer === null || !isDecidingAuthor(answer.from)) return;
    const decided = memoryGateAnswer(question, answer);
    if (decided !== null) memory.applyGateAnswer(decided);
  }
}

// Sweeps each store whose own stamp is over a day old, on every tick and as a
// personal store opens, so uptime never sets the pace; a call mid-pass joins it.
export function startDecayScheduler(deps: DecaySchedulerDeps): {
  /** Sweeps every store but a personal one another daemon swept within a day. */
  runNow(): Promise<DecaySummary>;
  /** Sweeps only the stores whose own stamp is over a day old. */
  runDue(): Promise<DecaySummary>;
  stop(): void;
} {
  const clock = deps.now ?? (() => new Date());
  // The stamps this scheduler wrote, so only another daemon's sweep skips a store.
  const ours = new Map<string, string>();
  let stopped = false;
  let running: Promise<DecaySummary> | null = null;

  // The scope of each proposal it expired.
  const expireProposals = async (
    memory: MemoryEngine,
    shared: MemoryStore,
    now: Date,
    ttlDays: number
  ): Promise<MemoryScope[]> => {
    // It may start after stop(), once the queue ahead of it drains.
    if (stopped) return [];
    const cutoff = new Date(now.getTime() - ttlDays * DAY_MS).toISOString();
    const body = `Expired: no one decided within ${ttlDays} days.`;
    const expired: MemoryScope[] = [];
    for (const p of memory.openProposalsOlderThan(cutoff)) {
      if (stopped) break;
      try {
        await expireProposal(deps.messaging, memory, p, body);
      } catch (err) {
        console.error(
          `dispatchd: could not expire memory proposal ${p.id}`,
          err
        );
      }
      if (!stopped && shared.getProposal(p.id)?.state === 'expired')
        expired.push(p.scope);
    }
    return expired;
  };

  const sweepShared = async (
    shared: MemoryStore,
    memory: MemoryEngine | null,
    policy: DecayPolicy,
    ttlDays: number,
    summary: DecaySummary
  ): Promise<void> => {
    const aged = sweep(shared, 'memory.db', policy, summary);
    const changed = new Set<MemoryScope>(aged?.scopes ?? []);
    if (memory !== null) {
      try {
        const expired = await deps.serial(() =>
          expireProposals(memory, shared, policy.now, ttlDays)
        );
        summary.proposalsExpired = expired.length;
        for (const scope of expired) changed.add(scope);
      } catch (err) {
        console.error('dispatchd: memory proposal expiry failed', err);
      }
    }
    if (stopped) return;
    backup(shared, `${deps.sharedPath}.bak`, 'memory.db', summary);
    for (const scope of MEMORY_SCOPES)
      if (changed.has(scope)) deps.host.changed({ scope });
  };

  // Raises the gates failed sends left off open proposals, so they reach Needs you.
  const raiseMissingGates = async (memory: MemoryEngine): Promise<void> => {
    try {
      await deps.serial(async () => {
        if (!stopped) await memory.recover();
      });
    } catch (err) {
      console.error('dispatchd: raising memory gates failed', err);
    }
  };

  const sweepPersonal = (
    identity: string,
    policy: DecayPolicy,
    onlyDue: boolean,
    summary: DecaySummary
  ): void => {
    try {
      const store = deps.personal.personal(identity);
      const stamp = store.meta(LAST_DECAY_KEY);
      if (sweptWithinADay(stamp, policy.now.getTime())) {
        if (stamp !== (ours.get(identity) ?? null)) {
          summary.skipped.push(identity);
          return;
        }
        if (onlyDue) return;
      }
      const aged = sweep(store, identity, policy, summary);
      if (aged !== null) ours.set(identity, policy.now.toISOString());
      backup(store, `${deps.personal.pathOf(identity)}.bak`, identity, summary);
      if (aged !== null && aged.staled + aged.expired > 0)
        deps.host.changed({ scope: 'personal' });
    } catch (err) {
      console.error(`dispatchd: memory decay of ${identity} failed`, err);
    }
  };

  const pass = async (onlyDue: boolean): Promise<DecaySummary> => {
    const summary: DecaySummary = {
      stores: 0,
      staled: 0,
      expired: 0,
      proposalsExpired: 0,
      backups: 0,
      skipped: [],
    };
    if (stopped) return summary;
    const config = deps.config();
    const policy: DecayPolicy = {
      now: clock(),
      staleAfterDays: config.staleAfterDays,
      retireAfterDays: config.retireAfterDays,
    };
    const shared = deps.shared();
    const memory = deps.engine();
    if (
      shared !== null &&
      (!onlyDue || sharedDue(shared, policy.now.getTime()))
    )
      await sweepShared(
        shared,
        memory,
        policy,
        config.proposalTtlDays,
        summary
      );
    if (memory !== null && !stopped) await raiseMissingGates(memory);
    for (const identity of deps.personal.opened()) {
      if (stopped) break;
      sweepPersonal(identity, policy, onlyDue, summary);
    }
    return summary;
  };

  const run = (onlyDue: boolean): Promise<DecaySummary> => {
    running ??= pass(onlyDue).finally(() => {
      running = null;
    });
    return running;
  };
  const tick = () => {
    run(true).catch((err: unknown) =>
      console.error('dispatchd: memory decay pass failed', err)
    );
  };
  // Off the opener's path, and once for a burst of opens.
  let soon: ReturnType<typeof setTimeout> | null = null;
  const tickSoon = () => {
    if (soon !== null) return;
    soon = setTimeout(() => {
      soon = null;
      tick();
    }, 0);
  };

  const unsubscribe = deps.personal.onOpen(tickSoon);
  const timer = setInterval(tick, deps.intervalMs ?? HOUR_MS);
  timer.unref();
  return {
    runNow: () => run(false),
    runDue: () => run(true),
    stop: () => {
      stopped = true;
      clearInterval(timer);
      unsubscribe();
      if (soon !== null) clearTimeout(soon);
    },
  };
}
