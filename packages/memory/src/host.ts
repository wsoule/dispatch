import type { MemoryStore } from './store.js';
import type {
  IndexContext,
  MemoryChange,
  Operator,
  Principal,
} from './types.js';

// The databases the engine reads and writes; the host decides where they live.
export interface MemoryStores {
  // memory.db; throws MemoryError('unavailable') when it is down.
  shared(): MemoryStore;
  // An identity's <identity>.db; throws MemoryError('unavailable' | 'conflict').
  personal(identity: string): MemoryStore;
  // Which identity's store holds `id`, so a decider asking for it learns why it is refused.
  locatePersonal?(id: string): string | null;
}

// What the engine needs from the daemon around it.
export interface MemoryHost {
  // The human and identity a principal acts for, or null when none.
  operatorOf(principal: Principal): Operator | null;
  // This project's key, which personal entries narrowed to one project carry.
  projectKey(): string;
  // A task's title, body, writes, epic and A2A provenance, or null when unknown.
  taskContext(taskId: string): IndexContext | null;
  // The task a run principal works on; null for humans and agents.
  taskOfPrincipal(principal: Principal): string | null;
  // Told after every committed change, so the host can notify listeners.
  changed(change: MemoryChange): void;
  // The clock every recall and write is stamped with.
  now(): Date;
}
