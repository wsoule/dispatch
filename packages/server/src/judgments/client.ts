import { loadConfig, resolveTypesafeApiKey } from '@dispatch-foo/core';
import { choice, TypeSafeClient } from '@typesafe-ai/sdk';
import type {
  EntryType,
  Fetch,
  Questions,
  SystemOneResult,
} from '@typesafe-ai/sdk';

/**
 * The one door every judgment in the daemon goes through. Wraps the TypeSafe
 * SDK so callers never see the key, the model, or the transport — they hand
 * over state plus typed questions and get typed answers back.
 *
 * Fail-open by construction: `createJudgmentClient` returns null when no key
 * resolves, and every feature runner treats null as "behave as before". A
 * transport error here throws; the runner catches it and falls back too.
 */
export interface JudgmentClient {
  /** The Jev model id every request is sent with (`models.judge`). */
  readonly model: string;
  judge<const Q extends Questions>(
    state: EntryType,
    questions: Q,
    opts?: { signal?: AbortSignal }
  ): Promise<SystemOneResult<Q>>;
}

/** Per-attempt ceiling. Jev answers in well under a second; anything longer
 *  is the network, and the runners must not pin a request open. */
const TIMEOUT_MS = 10_000;

export function createJudgmentClient(
  rootDir: string,
  deps: { fetch?: Fetch; apiKey?: string } = {}
): JudgmentClient | null {
  const apiKey = deps.apiKey ?? resolveTypesafeApiKey(rootDir).apiKey;
  if (apiKey === null) return null;
  const model = loadConfig(rootDir).models.judge;
  const client = new TypeSafeClient({
    apiKey,
    defaultModel: model,
    timeout: TIMEOUT_MS,
    fetch: deps.fetch,
    // The runners log failures themselves, once per feature; the SDK's own
    // request log would repeat every retry.
    logLevel: 'off',
  });
  return {
    model,
    // Awaited here so callers get a plain Promise, not the SDK's APIPromise.
    judge: async (state, questions, opts) =>
      await client.systemOne({ state, questions }, { signal: opts?.signal }),
  };
}

/** Cuts `text` to `maxChars` and marks the cut, so a runner can bound its
 *  state below Jev's context budget without silently losing the tail. */
export function capText(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars)}\n[truncated]`;
}

const warned = new Set<string>();

/** The most recent judgment failure, for Settings' status line. */
export interface JudgmentFailure {
  feature: string;
  message: string;
  at: string;
}
let lastFailure: JudgmentFailure | null = null;

export function lastJudgmentFailure(): JudgmentFailure | null {
  return lastFailure;
}

/** Logs a judgment failure once per feature per process — a dead API must
 *  not fill the daemon log with one line per task on every board refresh. */
export function warnOnce(feature: string, err: unknown): void {
  const message = err instanceof Error ? err.message : String(err);
  lastFailure = { feature, message, at: new Date().toISOString() };
  if (warned.has(feature)) return;
  warned.add(feature);
  console.warn(
    `dispatchd: ${feature} judgment unavailable, falling back: ${message}`
  );
}

/** Runs `fn` over `items` with at most `limit` in flight, preserving order.
 *  The runners judge whole boards and inboxes per pass; this keeps a
 *  100-task project from opening 100 requests at once. */
export async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker)
  );
  return results;
}

/** One tiny judgment, timed: whether Jev answers right now. */
export async function probeJudgments(
  client: JudgmentClient
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const started = Date.now();
  try {
    await client.judge(
      { message: 'ping' },
      {
        reachable: choice('Is `message` a greeting or a test?', {
          yes: 'it is',
          no: 'it is not',
        }),
      }
    );
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
