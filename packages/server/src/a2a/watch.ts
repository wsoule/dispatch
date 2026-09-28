import type { TaskFacts, TaskRow } from '@dispatch/a2a';
import { decideState, projectionKey, statusAt } from '@dispatch/a2a';
import type { EngineEvent } from '@dispatch/protocol';

import type { EventBus } from '../events.js';
import { gatherFacts } from './facts.js';
import type { BridgeDeps } from './port.js';

type WatchDeps = BridgeDeps & {
  events: EventBus;
  coalesceMs?: number;
  onChanged?: (row: TaskRow, facts: TaskFacts) => void;
};

// One engine and bus subscription for every open A2A task: it keeps the
// tasks table's state cache current and tells a task's watchers it changed.
export class BridgeWatch {
  private readonly listeners = new Map<string, Set<() => void>>();
  private readonly keys = new Map<string, string>();
  private readonly pending = new Set<string>();
  private everything = false;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly deps: WatchDeps) {}

  start(): () => void {
    const offEngine = this.deps.engine.subscribe((e) => this.onEngine(e));
    const offBus = this.deps.events.subscribe((e) => {
      if (e.type === 'task.changed') this.schedule(null);
    });
    return () => {
      offEngine();
      offBus();
      if (this.timer !== null) clearTimeout(this.timer);
      this.timer = null;
    };
  }

  add(taskId: string, onChange: () => void): () => void {
    const set = this.listeners.get(taskId) ?? new Set();
    set.add(onChange);
    this.listeners.set(taskId, set);
    return () => {
      set.delete(onChange);
      if (set.size === 0) this.listeners.delete(taskId);
    };
  }

  count(): number {
    return [...this.listeners.values()].reduce((n, s) => n + s.size, 0);
  }

  private onEngine(e: EngineEvent): void {
    if (e.type === 'membership') return;
    const message =
      e.type === 'message'
        ? e.message
        : this.deps.engine.getMessage(
            e.type === 'remote' ? e.messageId : e.delivery.messageId
          );
    if (message === null) return;
    for (const row of this.deps.store.openTasks())
      if (row.contextId === message.thread) this.schedule(row.id);
  }

  // Recomputes `taskId` (null: every open task) once the burst settles; a
  // task that fails to recompute is logged and never stops the others.
  schedule(taskId: string | null): void {
    if (taskId === null) this.everything = true;
    else this.pending.add(taskId);
    if (this.timer !== null) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const everything = this.everything;
      const pending = [...this.pending];
      this.everything = false;
      this.pending.clear();
      try {
        const ids = everything
          ? this.deps.store.openTasks().map((r) => r.id)
          : pending;
        for (const id of ids) this.recomputeLogged(id);
      } catch (err) {
        console.error('a2a: could not list open tasks', err);
      }
    }, this.deps.coalesceMs ?? 1000);
  }

  // Like recompute, but a task that fails is logged rather than thrown.
  recomputeLogged(taskId: string): void {
    try {
      this.recompute(taskId);
    } catch (err) {
      console.error(`a2a: could not recompute task ${taskId}`, err);
    }
  }

  // Rewrites the row's state and status_at, and fires its watchers when what
  // a client would see (the projection key) changed.
  recompute(taskId: string): void {
    const row = this.deps.store.getTask(taskId);
    if (row === null) return;
    const facts = gatherFacts(this.deps, row);
    const decision = decideState(facts);
    const at = statusAt(facts, decision);
    if (row.state !== decision.state || row.statusAt !== at)
      this.deps.store.updateTask(row.id, {
        state: decision.state,
        statusAt: at,
      });
    const key = projectionKey(facts);
    if (this.keys.get(row.id) === key) return;
    this.keys.set(row.id, key);
    for (const fn of this.listeners.get(row.id) ?? []) fn();
    this.deps.onChanged?.(row, facts);
  }
}
