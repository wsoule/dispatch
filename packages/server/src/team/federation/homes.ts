import {
  isFederationLocalAddress,
  parseAddress,
  SYSTEM_ADDRESS,
} from '@dispatch/protocol';
import type { Address, ParsedAddress } from '@dispatch/protocol';

import type { RosterService } from './roster.js';
import type { FedStore } from './store.js';

/** What Homes reads of the board: a task's assignee. */
export interface HomeTasks {
  get(id: string): { meta: { assignee: string } } | null;
}

export interface LiveRun {
  run: string;
  replica: string;
  hlc: string;
}

// Parses an address, or null for one that does not parse.
function parsed(address: Address): ParsedAddress | null {
  try {
    return parseAddress(address);
  } catch {
    return null;
  }
}

// The replicas that store and deliver an address, from replicated state only,
// so every replica computes the same homes (spec "Homes").
export class Homes {
  constructor(
    private readonly deps: {
      fed: FedStore;
      roster: RosterService;
      tasks: HomeTasks;
    }
  ) {}

  /** Sorted replica ids; never pending, revoked, uncovered or observer ones. */
  of(address: Address): string[] {
    if (isFederationLocalAddress(address) || address === SYSTEM_ADDRESS)
      return [];
    const p = parsed(address);
    switch (p?.kind) {
      case 'human':
        return this.usable(this.deps.roster.replicasOfHandle(p.handle));
      case 'agent': {
        const row = this.deps.fed.db
          .query<{ replica: string }, [string]>(
            'SELECT replica FROM fed_agents WHERE address = ?'
          )
          .get(address);
        return row === null ? [] : this.usable([row.replica]);
      }
      case 'task': {
        const live = this.taskLiveRun(p.id);
        if (live !== null) return this.usable([live.replica]);
        const assignee = this.deps.tasks.get(p.id)?.meta.assignee ?? '';
        const ref = parsed(assignee);
        if (ref?.kind === 'human') return this.of(assignee);
        if (ref?.kind === 'agent' && ref.operator !== null)
          return this.of(`human:${ref.operator}`);
        return [];
      }
      default:
        return [];
    }
  }

  /** The task's live execute run with the earliest claim, this machine's own
   *  included (its presence writes its row too), or null. */
  taskLiveRun(taskId: string): LiveRun | null {
    return this.deps.fed.db
      .query<LiveRun, [string]>(
        "SELECT run, replica, hlc FROM fed_runs WHERE task = ? AND run_kind = 'execute' AND live = 1 ORDER BY hlc, replica LIMIT 1"
      )
      .get(taskId);
  }

  // Admitted, unrevoked, within the seats and not an observer (an observer
  // is home to nobody; mail reaches it only by the observer rule); sorted.
  private usable(replicas: readonly string[]): string[] {
    const { roster } = this.deps;
    return [...new Set(replicas)]
      .filter(
        (r) =>
          roster.isAdmitted(r) && roster.isCovered(r) && !roster.isObserver(r)
      )
      .sort();
  }
}
