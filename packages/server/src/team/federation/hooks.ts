import { localOnlyReason, SYSTEM_ADDRESS } from '@dispatch/protocol';
import type {
  Address,
  DeliveryVia,
  FederationHooks,
  Message,
  MessageStore,
  Placement,
} from '@dispatch/protocol';

import type { SyncLedger } from '../boardSync/ledger.js';
import type { Homes } from './homes.js';
import type { RosterService } from './roster.js';
import type { FedStore } from './store.js';

const LOCAL: Placement = { kind: 'local' };
const REFUSED_SETTLE = "only the question's origin settles it";

// The engine's federation hooks over the roster, homes and presence: where
// each recipient's mail lives, the clock, labels and problems.
export class DaemonFederationHooks implements FederationHooks {
  readonly replica: string;

  constructor(
    private readonly deps: {
      ledger: SyncLedger;
      fed: FedStore;
      roster: RosterService;
      homes: Homes;
      messages: () => MessageStore | null;
      /** Whether this daemon has, or had, a run with this id. */
      knowsRun: (runId: string) => boolean;
    }
  ) {
    this.replica = deps.fed.replica;
  }

  hlc(): string {
    return this.deps.ledger.tickPersisted();
  }

  label(replica: string): string {
    return this.deps.roster.label(replica);
  }

  problem(subject: string, message: string): void {
    this.deps.fed.problem(subject, message);
    // A settle from anyone but the settler is a speaks-for refusal (F-D32).
    if (message.endsWith(REFUSED_SETTLE))
      this.deps.fed.audit('speaks-for', subject, { message });
  }

  remoteRunTask(runId: string): string | null {
    const row = this.deps.fed.db
      .query<{ replica: string; task: string | null }, [string]>(
        'SELECT replica, task FROM fed_runs WHERE run = ?'
      )
      .get(runId);
    return row === null || row.replica === this.replica ? null : row.task;
  }

  placement(
    target: { recipient: Address; via: DeliveryVia },
    message: Message,
    replyTarget: Message | null
  ): Placement {
    // FW-R31(4): no mail leaves before this machine is admitted under a firm pin.
    if (!this.deps.roster.mailReady()) return LOCAL;
    const me = this.replica;
    const root =
      message.thread === message.id
        ? null
        : (this.deps.messages()?.getMessage(message.thread) ?? null);
    const homes = this.homesFor(target.recipient, message, replyTarget);
    if (homes.length === 0 || (homes.length === 1 && homes[0] === me))
      return LOCAL;
    if (localOnlyReason(message, replyTarget, root) !== null)
      return homes.includes(me)
        ? LOCAL
        : { kind: 'refuse', reason: 'local-only' };
    const alsoLocal = homes.includes(me);
    const wakeAt =
      message.wake === 'request' && target.recipient.startsWith('task:')
        ? this.wakeAt(target.recipient, homes)
        : undefined;
    return {
      kind: 'remote',
      homes,
      alsoLocal,
      ...(wakeAt === undefined ? {} : { wakeAt }),
    };
  }

  // A run lives where it runs: a reply to its message goes to the message's
  // origin, a system notice to the replica its presence names.
  private homesFor(
    recipient: Address,
    message: Message,
    replyTarget: Message | null
  ): string[] {
    if (!recipient.startsWith('run:')) return this.deps.homes.of(recipient);
    if (
      replyTarget !== null &&
      replyTarget.from === recipient &&
      replyTarget.origin !== undefined
    )
      return [replyTarget.origin];
    const runId = recipient.slice('run:'.length);
    if (
      message.from === SYSTEM_ADDRESS &&
      message.origin === undefined &&
      !this.deps.knowsRun(runId)
    ) {
      const row = this.deps.fed.db
        .query<{ replica: string }, [string]>(
          'SELECT replica FROM fed_runs WHERE run = ?'
        )
        .get(runId);
      if (row !== null && row.replica !== this.replica) return [row.replica];
    }
    return [];
  }

  // The one home that wakes a task: its live run's, else the home heard from
  // last, else the lowest id.
  private wakeAt(task: Address, homes: string[]): string {
    const live = this.deps.homes.taskLiveRun(task.slice('task:'.length));
    if (live !== null && homes.includes(live.replica)) return live.replica;
    let best: { replica: string; hlc: string } | null = null;
    for (const r of homes) {
      const row = this.deps.fed.db
        .query<{ last_hlc: string }, [string]>(
          'SELECT last_hlc FROM fed_replicas WHERE replica = ?'
        )
        .get(r);
      if (row !== null && (best === null || row.last_hlc > best.hlc))
        best = { replica: r, hlc: row.last_hlc };
    }
    return best?.replica ?? homes[0] ?? this.replica;
  }
}
