import { formatSSEEvent, SSE_HEADERS } from '@a2a-js/sdk';
import { createHash } from 'node:crypto';

import type { BridgePort, Caller } from '../port.js';
import { decideState, project, withReask } from '../projection.js';
import type { ProjectionView } from '../projection.js';
import { TERMINAL_STATES } from '../states.js';
import type { TaskStateName } from '../states.js';
import type { StreamResponseJson, TaskJson } from '../wire.js';

export interface StreamOptions {
  port: BridgePort;
  caller: Caller;
  // Re-checked every tick, so a revoked or rotated token ends the stream.
  bearer: string;
  taskId: string;
  view: ProjectionView;
  // Frees the caller's stream slot; runs exactly once, however the stream ends.
  release: () => void;
  signal: AbortSignal;
  // Replaces the first event's status message, as on a unary send.
  reask?: string | null;
  // Stay open through INPUT_REQUIRED until a terminal state, as
  // SubscribeToTask must (§3.1.6); a streamed send ends there instead.
  untilTerminal?: boolean;
  tickMs?: number;
  keepaliveMs?: number;
  maxMs?: number;
  bufferLimit?: number;
}

/** A projected task as a stream last sent it; push delivery keeps one too. */
export interface Snapshot {
  task: TaskJson;
  state: TaskStateName;
  statusKey: string;
  artifacts: Map<string, string>;
}

export function snapshotOf(task: TaskJson, state: TaskStateName): Snapshot {
  const artifacts = new Map(
    (task.artifacts ?? []).map(
      (a) =>
        [
          a.artifactId,
          createHash('sha256').update(JSON.stringify(a)).digest('hex'),
        ] as const
    )
  );
  return {
    task,
    state,
    statusKey: `${task.status.state}|${task.status.message?.messageId ?? ''}`,
    artifacts,
  };
}

// The events that take a client from `last` to `next`: artifacts first, then status.
export function eventsBetween(
  last: Snapshot | null,
  next: Snapshot
): StreamResponseJson[] {
  if (last === null) return [{ task: next.task }];
  const out: StreamResponseJson[] = [];
  for (const artifact of next.task.artifacts ?? []) {
    if (
      last.artifacts.get(artifact.artifactId) !==
      next.artifacts.get(artifact.artifactId)
    ) {
      out.push({
        artifactUpdate: {
          taskId: next.task.id,
          contextId: next.task.contextId,
          artifact,
          append: false,
          lastChunk: true,
        },
      });
    }
  }
  if (last.statusKey !== next.statusKey) {
    out.push({
      statusUpdate: {
        taskId: next.task.id,
        contextId: next.task.contextId,
        status: next.task.status,
      },
    });
  }
  return out;
}

// One A2A task as an SSE stream, re-projected per watch tick; it closes on a
// final state, revocation, overflow or maxMs.
export function taskEventStream(o: StreamOptions): Response {
  const tickMs = o.tickMs ?? 1000;
  const keepaliveMs = o.keepaliveMs ?? 15_000;
  const maxMs = o.maxMs ?? 3_600_000;
  const encoder = new TextEncoder();
  let stop = () => {};
  const body = new ReadableStream<Uint8Array>(
    {
      start(controller) {
        const started = Date.now();
        let lastKeepalive = Date.now();
        let closed = false;
        let dirty = true;
        let busy = false;
        let last: Snapshot | null = null;
        const close = () => {
          if (closed) return;
          closed = true;
          clearInterval(timer);
          unwatch();
          o.signal.removeEventListener('abort', close);
          o.release();
          try {
            controller.close();
          } catch {
            // the client already cancelled the stream
          }
        };
        // A client that stops reading fills the buffer; the stream then closes.
        const send = (chunk: string) => {
          if (closed) return;
          if (controller.desiredSize !== null && controller.desiredSize <= 0) {
            close();
            return;
          }
          controller.enqueue(encoder.encode(chunk));
        };
        const tick = async () => {
          if (closed || busy) return;
          busy = true;
          try {
            if (Date.now() - started >= maxMs) return close();
            if (!(await o.port.authenticate(o.bearer)).ok) return close();
            if (dirty) {
              dirty = false;
              const facts = await o.port.facts(o.caller, o.taskId);
              if (facts === null) return close();
              const state = decideState(facts).state;
              const task = project(facts, o.view);
              const next = snapshotOf(
                last === null ? withReask(task, o.reask ?? null, o.view) : task,
                state
              );
              for (const event of eventsBetween(last, next))
                send(formatSSEEvent(event));
              last = next;
              const interrupted =
                state === 'INPUT_REQUIRED' && o.untilTerminal !== true;
              if (TERMINAL_STATES.has(state) || interrupted) return close();
            }
            if (Date.now() - lastKeepalive >= keepaliveMs) {
              send(': keepalive\n\n');
              lastKeepalive = Date.now();
            }
          } finally {
            busy = false;
          }
        };
        const fail = (err: unknown) => {
          console.error('a2a: stream failed', err);
          close();
        };
        const unwatch = o.port.watch(o.caller, o.taskId, () => {
          dirty = true;
        });
        const timer = setInterval(() => {
          tick().catch(fail);
        }, tickMs);
        stop = close;
        if (o.signal.aborted) {
          close();
          return;
        }
        o.signal.addEventListener('abort', close, { once: true });
        tick().catch(fail);
      },
      cancel() {
        stop();
      },
    },
    new CountQueuingStrategy({ highWaterMark: o.bufferLimit ?? 256 })
  );
  return new Response(body, { headers: SSE_HEADERS });
}
