import type { QueueWeights, ScoredTask } from '@dispatch/core';
import {
  loadConfig,
  QUEUE_FACTORS,
  queueWeights,
  rankTasks,
} from '@dispatch/core';
import type { QueueFactorInfo } from '@dispatch/core';

import type { ApiContext } from '../api.js';
import { errorResponse, jsonResponse, parseCountParam } from './http.js';

// The GET /api/queue response body. Deliberately not exported: nothing outside
// this module consumes it yet, and knip gates unused exports at zero. The
// client's typed wrapper is where it becomes shared (see the queue-view task).
interface QueueSnapshot {
  /** The factor table behind the ranking, so a client can render the breakdown
   *  columns and weight controls without knowing the factor list itself. When
   *  the scoring service gains project/initiative/due-date factors, they show
   *  up here and every client picks them up. */
  factors: readonly QueueFactorInfo[];
  /** The weights this ranking actually used, straight from `queue.weights`. */
  weights: QueueWeights;
  /** The `now` the age factor was scored against, echoed so a stale tab can
   *  tell how old its ranking is. */
  generatedAt: string;
  tasks: ScoredTask[];
}

/**
 * GET /api/queue — the planning queue: every task the orchestrator would agree
 * to start, ranked by the scoring function, with the per-factor breakdown that
 * makes the order explainable.
 *
 * Computed on demand rather than cached, the same way GET /api/landing works:
 * the ranking depends on both the task set and `queue.weights`, and the
 * existing `task.changed` / `config.changed` WS events are the client's signal
 * to refetch. `cache.query()` supplies the whole live task set (archived tasks
 * excluded) because the unblocking factor needs the full blockedBy graph, not
 * just the candidates.
 */
export function getQueue(ctx: ApiContext, url: URL): Response {
  const limit = parseCountParam(url, 'limit');
  if (!limit.ok) return limit.response;

  // A `queue:` block that would not parse is carried on the config rather than
  // thrown by loadConfig, so it does not 422 unrelated routes. This is the
  // route that depends on it, so this is where it becomes an error: ranking
  // against defaults while the user's real weights sit unread would be a
  // silently wrong answer.
  const weights = queueWeights(loadConfig(ctx.rootDir));
  if (!weights.ok) return errorResponse(422, weights.error);
  const generatedAt = new Date().toISOString();
  const snapshot: QueueSnapshot = {
    factors: QUEUE_FACTORS,
    weights: weights.weights,
    generatedAt,
    tasks: rankTasks(ctx.cache.query(), {
      weights: weights.weights,
      now: generatedAt,
      limit: limit.value,
    }),
  };
  return jsonResponse(snapshot);
}
