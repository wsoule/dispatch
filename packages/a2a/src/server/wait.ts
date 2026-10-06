import type { BridgePort, Caller, TaskFacts } from '../port.js';
import { decideState } from '../projection.js';
import { INTERRUPTED_STATES, TERMINAL_STATES } from '../states.js';

function settled(facts: TaskFacts | null): boolean {
  if (facts === null) return true;
  const state = decideState(facts).state;
  return TERMINAL_STATES.has(state) || INTERRUPTED_STATES.has(state);
}

// Waits at most maxMs for a terminal or interrupted state (a documented MUST
// deviation), always unsubscribing however it ends.
export async function waitForSettled(
  port: BridgePort,
  caller: Caller,
  taskId: string,
  opts: { maxMs: number; signal?: AbortSignal }
): Promise<TaskFacts | null> {
  let facts = await port.facts(caller, taskId);
  if (settled(facts) || opts.maxMs <= 0 || opts.signal?.aborted === true)
    return facts;
  return await new Promise<TaskFacts | null>((resolve, reject) => {
    let done = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unwatch = () => {};
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      unwatch();
      opts.signal?.removeEventListener('abort', finish);
      resolve(facts);
    };
    try {
      unwatch = port.watch(caller, taskId, () => {
        port.facts(caller, taskId).then((latest) => {
          if (done) return;
          facts = latest;
          if (settled(latest)) finish();
        }, finish);
      });
    } catch (err) {
      done = true;
      reject(err instanceof Error ? err : new Error(String(err)));
      return;
    }
    timer = setTimeout(finish, opts.maxMs);
    opts.signal?.addEventListener('abort', finish, { once: true });
  });
}
