import type { TaskFacts, TaskRow } from '@dispatch/a2a';
import {
  decideState,
  gateInScope,
  projectionKey,
  statusAt,
} from '@dispatch/a2a';
import type { EngineEvent, Message } from '@dispatch/protocol';
import { hasGateData } from '@dispatch/protocol';

import type { EventBus } from '../events.js';
import { gatherFacts } from './facts.js';
import { linkOf } from './handoff.js';
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

  // Schedules every open task in the event's thread, and every approved
  // handoff whose task, runs or their gates the event touches.
  private onEngine(e: EngineEvent): void {
    if (e.type === 'membership') return;
    const message =
      e.type === 'message'
        ? e.message
        : this.deps.engine.getMessage(
            e.type === 'remote' ? e.messageId : e.delivery.messageId
          );
    if (message === null) return;
    // Read once, and only when an open handoff might be linked to the message.
    let linked: { tasks: Set<string>; gate: Message | null } | null = null;
    for (const row of this.deps.store.openTasks()) {
      if (row.contextId === message.thread) {
        this.schedule(row.id);
        continue;
      }
      if (row.skill !== 'handoff' || row.dispatchTask === null) continue;
      linked ??= {
        tasks: this.tasksTouched(message),
        gate: this.gateBehind(message),
      };
      if (!linked.tasks.has(row.dispatchTask) && linked.gate === null) continue;
      const link = linkOf(this.deps, row);
      if (link?.approved !== true) continue;
      if (
        linked.tasks.has(link.taskId) ||
        (linked.gate !== null && gateInScope(linked.gate, row.gate, link))
      )
        this.schedule(row.id);
    }
  }

  // The Dispatch tasks a message is from or to: task:<id> directly, run:<id>
  // through the task its execute run works.
  private tasksTouched(m: Message): Set<string> {
    const out = new Set<string>();
    for (const address of [m.from, ...m.to]) {
      if (address.startsWith('task:')) out.add(address.slice('task:'.length));
      else if (address.startsWith('run:')) {
        const task = this.deps.runs.taskIdOfRun(address.slice('run:'.length));
        if (task !== null) out.add(task);
      }
    }
    return out;
  }

  // The gate a message is, or the gate it answers; null for anything else.
  // Gate data of a type this build does not know still counts.
  private gateBehind(m: Message): Message | null {
    if (hasGateData(m)) return m;
    const target =
      m.replyTo === null ? null : this.deps.engine.getMessage(m.replyTo);
    return target !== null && hasGateData(target) ? target : null;
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
