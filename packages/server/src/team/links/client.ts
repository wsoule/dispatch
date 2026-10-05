import { PeerHttpError } from '@dispatch/a2a';
import type {
  LinkPayload,
  MessageJson,
  PeerSendResult,
  TaskJson,
} from '@dispatch/a2a';

import type { LinkHub } from './hub.js';
import { provisionalTaskId } from './hub.js';

// How stale a non-final remote snapshot may get before the sender asks the
// other side to publish it again (OD-10).
const RESYNC_AFTER_MS = 60 * 60 * 1000;

// The outbound worker's client for a link peer: a send is published to the
// link and answered at once with a provisional task; reads come from what
// the other side's `event` ops said, and each new one wakes the worker.
export class LinkPeerClient {
  private readonly asked = new Map<string, number>();

  constructor(
    private readonly hub: LinkHub,
    private readonly alias: string,
    private readonly now: () => Date
  ) {}

  send(message: MessageJson): Promise<PeerSendResult> {
    const out = { ...message } as MessageJson & {
      taskId?: string;
      contextId?: string;
    };
    // A follow-up names the receiver's own ids once they are known; a
    // provisional id never leaves this machine.
    if (typeof out.taskId === 'string' && out.taskId.startsWith('link-')) {
      const real = this.hub.taskFor(this.alias, out.taskId.slice(5));
      if (real === null) delete out.taskId;
      else out.taskId = real;
    }
    if (
      typeof out.contextId === 'string' &&
      out.contextId.startsWith('link-')
    ) {
      const snap = this.hub.snapshot(this.alias, out.contextId);
      const ctx = snap?.task['contextId'];
      if (typeof ctx === 'string' && !ctx.startsWith('link-'))
        out.contextId = ctx;
      else delete out.contextId;
    }
    const result = this.hub.publish(this.alias, {
      kind: 'send',
      message: out,
      configuration: { returnImmediately: true },
    } as LinkPayload);
    if (result === 'oversize')
      return Promise.reject(
        new PeerHttpError(413, 'the message is too large for a link')
      );
    if (result === 'refused')
      return Promise.reject(
        new PeerHttpError(400, 'the link refused the message')
      );
    const id = provisionalTaskId(message.messageId);
    return Promise.resolve({
      kind: 'task',
      task: {
        id,
        contextId: id,
        status: { state: 'TASK_STATE_SUBMITTED' },
      } as unknown as TaskJson,
    });
  }

  getTask(taskId: string): Promise<TaskJson> {
    const snap = this.hub.snapshot(this.alias, taskId);
    if (snap === null)
      return Promise.resolve({
        id: taskId,
        contextId: taskId,
        status: { state: 'TASK_STATE_SUBMITTED' },
      } as unknown as TaskJson);
    const state = (snap.task['status'] as { state?: string } | undefined)
      ?.state;
    const stale =
      this.now().getTime() - Date.parse(snap.at) > RESYNC_AFTER_MS &&
      state !== undefined &&
      !/COMPLETED|FAILED|CANCELED|REJECTED/.test(state);
    const real = snap.task['id'];
    if (stale && typeof real === 'string') this.resync(real);
    return Promise.resolve(snap.task as unknown as TaskJson);
  }

  // One tick per event the link brings for this peer; the worker re-reads
  // the snapshot on each. Ends when `signal` aborts.
  async *changes(_taskId: string, signal: AbortSignal): AsyncGenerator<void> {
    let pending = false;
    let wake: (() => void) | null = null;
    const off = this.hub.onEvent((alias) => {
      if (alias !== this.alias) return;
      pending = true;
      wake?.();
    });
    try {
      while (!signal.aborted) {
        if (!pending)
          await new Promise<void>((resolve) => {
            wake = resolve;
            signal.addEventListener('abort', () => resolve(), { once: true });
          });
        wake = null;
        if (signal.aborted) return;
        pending = false;
        yield;
      }
    } finally {
      off();
    }
  }

  // At most once an hour per task.
  private resync(taskId: string): void {
    const last = this.asked.get(taskId) ?? 0;
    if (this.now().getTime() - last < RESYNC_AFTER_MS) return;
    this.asked.set(taskId, this.now().getTime());
    this.hub.publish(this.alias, { kind: 'resync', taskId });
  }
}
