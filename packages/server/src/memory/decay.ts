import type { MemoryConfig } from '@dispatch/core';
import { decayStore } from '@dispatch/memory';
import type {
  DecayResult,
  MemoryEngine,
  MemoryHost,
  MemoryProposal,
  MemoryStore,
} from '@dispatch/memory';
import { MessagingError, SYSTEM_ADDRESS } from '@dispatch/protocol';

import { SYSTEM_SENDER } from '../messaging/gates.js';
import type { Messaging } from '../messaging/service.js';
import { memoryGateAnswer } from './gate.js';
import type { PersonalStores } from './personalStores.js';

const DAY_MS = 86_400_000;
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
  /** Runs proposal expiry so it never overlaps the service's gate recovery. */
  serial?: <T>(step: () => Promise<T>) => Promise<T>;
  now?: () => Date;
  intervalMs?: number;
}

function sweptWithinADay(stamp: string | null, nowMs: number): boolean {
  return stamp !== null && nowMs - Date.parse(stamp) < DAY_MS;
}

// A memory.db whose stamp will not read is due; the pass then logs why.
function dueAtStart(shared: MemoryStore | null, nowMs: number): boolean {
  if (shared === null) return false;
  try {
    return !sweptWithinADay(shared.meta(LAST_DECAY_KEY), nowMs);
  } catch {
    return true;
  }
}

// Only a deciding human's or the system's answer takes effect, as in messaging.
function decides(address: string): boolean {
  return address === SYSTEM_ADDRESS || address.startsWith('human:');
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
    if (answer === null || !decides(answer.from)) return;
    const decided = memoryGateAnswer(question, answer);
    if (decided !== null) memory.applyGateAnswer(decided);
  }
}

// Sweeps memory.db and each opened personal database at start when memory.db
// is over a day stale, then every intervalMs; runNow() mid-pass joins that pass.
export function startDecayScheduler(deps: DecaySchedulerDeps): {
  runNow(): Promise<DecaySummary>;
  stop(): void;
} {
  const clock = deps.now ?? (() => new Date());
  const serial =
    deps.serial ?? (<T>(step: () => Promise<T>): Promise<T> => step());
  // The stamps this scheduler wrote, so only another daemon's sweep skips a store.
  const ours = new Map<string, string>();
  let stopped = false;
  let running: Promise<DecaySummary> | null = null;

  const expireProposals = async (
    memory: MemoryEngine,
    shared: MemoryStore,
    now: Date,
    ttlDays: number
  ): Promise<number> => {
    // It may start after stop(), once the queue ahead of it drains.
    if (stopped) return 0;
    const cutoff = new Date(now.getTime() - ttlDays * DAY_MS).toISOString();
    const body = `Expired: no one decided within ${ttlDays} days.`;
    let expired = 0;
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
        expired += 1;
    }
    return expired;
  };

  const sweepShared = async (
    shared: MemoryStore,
    policy: DecayPolicy,
    ttlDays: number,
    summary: DecaySummary
  ): Promise<void> => {
    const aged = sweep(shared, 'memory.db', policy, summary);
    const memory = deps.engine();
    if (memory !== null) {
      try {
        summary.proposalsExpired = await serial(() =>
          expireProposals(memory, shared, policy.now, ttlDays)
        );
      } catch (err) {
        console.error('dispatchd: memory proposal expiry failed', err);
      }
    }
    if (stopped) return;
    backup(shared, `${deps.sharedPath}.bak`, 'memory.db', summary);
    if (
      (aged !== null && aged.staled + aged.expired > 0) ||
      summary.proposalsExpired > 0
    )
      deps.host.changed({ scope: 'team' });
  };

  const sweepPersonal = (
    identity: string,
    policy: DecayPolicy,
    summary: DecaySummary
  ): void => {
    try {
      const store = deps.personal.personal(identity);
      const stamp = store.meta(LAST_DECAY_KEY);
      if (
        stamp !== (ours.get(identity) ?? null) &&
        sweptWithinADay(stamp, policy.now.getTime())
      ) {
        summary.skipped.push(identity);
        return;
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

  const pass = async (): Promise<DecaySummary> => {
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
    if (shared !== null)
      await sweepShared(shared, policy, config.proposalTtlDays, summary);
    for (const identity of deps.personal.opened()) {
      if (stopped) break;
      sweepPersonal(identity, policy, summary);
    }
    return summary;
  };

  const runNow = (): Promise<DecaySummary> => {
    running ??= pass().finally(() => {
      running = null;
    });
    return running;
  };
  const tick = () => {
    runNow().catch((err: unknown) =>
      console.error('dispatchd: memory decay pass failed', err)
    );
  };

  if (dueAtStart(deps.shared(), clock().getTime())) tick();
  const timer = setInterval(tick, deps.intervalMs ?? DAY_MS);
  timer.unref();
  return {
    runNow,
    stop: () => {
      stopped = true;
      clearInterval(timer);
    },
  };
}
