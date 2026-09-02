// The planning queue's weight function. Like graph.ts this module must stay
// free of `node:*` imports — it is re-exported from the browser-safe entry
// point so the desktop webview can recompute a ranking without the daemon.
import {
  dispatchableTasks,
  isDone,
  isSatisfiedForDispatch,
  PRIORITY_ORDER,
} from './graph.js';
import type { TaskDoc } from './types.js';

/**
 * The factors this version scores. The full scoring service adds project rank,
 * initiative rank, and due-date proximity once the planning hierarchy exists;
 * those arrive as new rows in the factor table below, not as a rewrite here.
 */
export type ScoreFactorKey = 'urgency' | 'unblocking' | 'age';

/** How much each factor counts, keyed by factor. 0 turns a factor off. */
export type QueueWeights = Record<ScoreFactorKey, number>;

/**
 * Urgency leads because a person set it deliberately; unblocking is worth
 * roughly two thirds of that because freeing other work is real but indirect;
 * age is a small counterweight that eventually rescues a starved task rather
 * than a driver of ordering on its own.
 */
export const DEFAULT_QUEUE_WEIGHTS: QueueWeights = Object.freeze({
  urgency: 1,
  unblocking: 0.6,
  age: 0.3,
});

/**
 * The dependent count at which the unblocking factor reaches 0.5. The curve is
 * `count / (count + this)`, so value rises fast over the first few dependents
 * and flattens after — a task freeing 12 others is not twice as valuable as one
 * freeing 6, and normalizing against the batch instead would make every score
 * depend on whatever else happened to be ready at the time.
 */
export const UNBLOCKING_HALF_VALUE = 3;

/** Days of waiting at which the age factor saturates at 1. */
export const AGE_HORIZON_DAYS = 30;

const MS_PER_DAY = 86_400_000;

/**
 * Whether a value can serve as a factor weight: a finite number, zero or above.
 * Zero is valid and meaningful — it is how a factor is turned off. Negative is
 * not: it would invert the factor's meaning rather than disable it.
 *
 * Shared so config validation (which rejects a bad weight loudly) and
 * `rankTasks` (which must not let one bad weight NaN out every score) agree on
 * exactly what "usable" means.
 */
export function isQueueWeight(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

/** One factor's contribution to a single task's score. */
export interface ScoreFactor {
  /** Join against QUEUE_FACTORS on this to get the label and description —
   *  repeating them per task would just be the same strings N times. */
  key: ScoreFactorKey;
  /** The factor's own reading of the task, normalized to 0..1. */
  value: number;
  /** The configured weight, echoed so a UI can show the knob beside the value. */
  weight: number;
  /** `value * weight`, rescaled so a task's contributions sum to its score. */
  contribution: number;
  /** Why this task got this value, in words. */
  detail: string;
}

export interface ScoredTask {
  task: TaskDoc;
  /** Weighted mean of every factor value, 0..1. */
  score: number;
  factors: ScoreFactor[];
}

export interface RankOptions {
  weights: QueueWeights;
  /** Injected rather than read from the clock so scoring stays pure. */
  now: string;
  /** Keep only the top N. Applied after ranking. */
  limit?: number;
}

/** What a factor is, without the function that computes it: the shape config
 *  validation and the Settings UI need to name and explain a weight. */
export interface QueueFactorInfo {
  key: ScoreFactorKey;
  /** Display name for the queue's breakdown column and the weight setting. */
  label: string;
  /** What a value of 1 means, so a weight control can explain itself. */
  describes: string;
}

// Everything the factors need that is derived once per ranking rather than
// per task. A factor that needs new derived data (project rank, say) means
// adding a field here and filling it in `rankTasks`.
interface ScoringContext {
  nowMs: number;
  dependents: Map<string, DependentCount>;
}

interface DependentCount {
  /** Live dispatchable tasks anywhere downstream of this one. */
  transitive: number;
  /** Direct dependents this task is the *last* unsatisfied blocker for — the
   *  ones that actually become startable the moment it lands. Always <=
   *  transitive; the gap is work this task advances but does not release. */
  frees: number;
}

interface FactorReading {
  value: number;
  detail: string;
}

interface FactorDefinition extends QueueFactorInfo {
  read: (task: TaskDoc, ctx: ScoringContext) => FactorReading;
}

// Highest priority scores 1 and lowest scores 0, spread evenly across whatever
// PRIORITY_ORDER holds, so adding a priority level does not require retuning.
function readUrgency(task: TaskDoc): FactorReading {
  const priority = task.meta.priority;
  const detail = `priority: ${priority}`;
  const rank = PRIORITY_ORDER[priority] as number | undefined;
  const levels = Object.keys(PRIORITY_ORDER).length;
  if (rank === undefined || levels < 2) return { value: 0, detail };
  return { value: 1 - rank / (levels - 1), detail };
}

// The value tracks the whole downstream chain, not just what this task
// releases outright: being one of three blockers on a chain of ten is real
// critical-path work. The detail reports both numbers so the difference is
// visible — "unblocks 0 of 4" and "unblocks 4 of 4" score the same but read
// very differently, and a person pulling from the queue should see which.
function readUnblocking(task: TaskDoc, ctx: ScoringContext): FactorReading {
  const counts = ctx.dependents.get(task.meta.id);
  if (counts === undefined || counts.transitive === 0) {
    return { value: 0, detail: 'unblocks nothing' };
  }
  const plural = counts.transitive === 1 ? 'task' : 'tasks';
  return {
    value: counts.transitive / (counts.transitive + UNBLOCKING_HALF_VALUE),
    detail: `unblocks ${counts.frees} of ${counts.transitive} downstream ${plural}`,
  };
}

// A task file whose `created` stamp will not parse reads as brand new rather
// than as NaN, which would poison the whole score.
function readAge(task: TaskDoc, ctx: ScoringContext): FactorReading {
  const createdMs = Date.parse(task.meta.created);
  if (Number.isNaN(createdMs)) return { value: 0, detail: 'age unknown' };
  // Clamped at zero: a clock skew that puts `created` in the future must not
  // hand the task a negative value that drags its total below its other
  // factors' contributions.
  const ageDays = Math.max(0, (ctx.nowMs - createdMs) / MS_PER_DAY);
  const rounded = Math.round(ageDays * 10) / 10;
  return {
    value: Math.min(1, ageDays / AGE_HORIZON_DAYS),
    detail: `waiting ${rounded}d of the ${AGE_HORIZON_DAYS}d horizon`,
  };
}

// The factor table, in the order a breakdown renders. This is the extension
// point: the full scoring service appends `project`, `initiative`, and
// `dueDate` rows here (plus their keys, weights, and any derived context) and
// every consumer — config validation, the API payload, the queue view — picks
// them up without further change.
const FACTORS: readonly FactorDefinition[] = [
  {
    key: 'urgency',
    label: 'Urgency',
    describes: 'the priority a person set on the task',
    read: readUrgency,
  },
  {
    key: 'unblocking',
    label: 'Unblocking value',
    describes: 'how much other work finishing this task frees',
    read: readUnblocking,
  },
  {
    key: 'age',
    label: 'Age',
    describes: 'how long the task has been waiting',
    read: readAge,
  },
];

/** The factor table without its compute functions — what a config validator or
 *  a Settings screen needs to name, explain, and check a set of weights. */
export const QUEUE_FACTORS: readonly QueueFactorInfo[] = FACTORS.map(
  ({ key, label, describes }) => ({ key, label, describes })
);

/** Every valid weight key, in breakdown order. */
export const QUEUE_FACTOR_KEYS: readonly ScoreFactorKey[] = FACTORS.map(
  (factor) => factor.key
);

// Whether finishing something would free *this* task — i.e. whether it counts
// as work released. Mirrors the filters readyTasks/dispatchableTasks apply to
// their own candidates: an epic is a container the orchestrator never starts,
// and a derived task only anchors a review of someone else's artifact. Counting
// either as freed work would inflate a blocker's unblocking value with tasks
// nobody will ever be handed.
function countsAsFreedWork(task: TaskDoc): boolean {
  return (
    task.meta.kind === 'task' &&
    task.meta.derivedFrom === undefined &&
    !isDone(task)
  );
}

/**
 * For each of `sources`, counts the live dispatchable work waiting on it:
 * `transitive` across the whole downstream chain, and `frees` for the direct
 * dependents it is the last unsatisfied blocker of.
 *
 * The two differ because a dependent usually has several blockers. Counting
 * only `transitive` lets five different tasks each claim to "unblock" the same
 * dependent when none of them alone would release it; `frees` is the number
 * that actually becomes startable when this task lands. Both are reported so
 * the queue can state the difference rather than overstate the effect.
 *
 * "Satisfied" here is `isSatisfiedForDispatch`, matching the candidate set
 * `rankTasks` scores: a blocker sitting in review no longer holds anything up.
 *
 * The reversed blockedBy index is built from every task (a candidate's
 * dependents are mostly blocked tasks, which are never candidates themselves),
 * but the closure walk only runs for `sources`. Each walk uses an explicit
 * stack and a `seen` set, which both dedupes diamonds (two paths to the same
 * dependent count once) and makes a dependency cycle terminate instead of
 * looping forever. A source can never appear in its own closure — that would
 * mean listing a live task as its own blocker, and the candidate set never
 * contains a task with a live blocker — so no self-count guard is needed.
 */
function countDependents(
  tasks: TaskDoc[],
  sources: string[]
): Map<string, DependentCount> {
  const byId = new Map(tasks.map((task) => [task.meta.id, task]));
  const blocks = new Map<string, string[]>();
  const freesByBlocker = new Map<string, number>();

  for (const task of tasks) {
    if (!countsAsFreedWork(task)) continue;
    // Deduped so a blockedBy naming the same blocker twice neither doubles an
    // edge nor hides that blocker being the only one left.
    const blockers = new Set(task.meta.blockedBy);
    for (const blocker of blockers) {
      const existing = blocks.get(blocker);
      if (existing === undefined) blocks.set(blocker, [task.meta.id]);
      else existing.push(task.meta.id);
    }
    // A blocker that is absent from the set entirely is dangling, which
    // readyTasks treats as satisfied, so it is not what holds this task back.
    const holdingItBack = [...blockers].filter((id) => {
      const blocker = byId.get(id);
      return blocker !== undefined && !isSatisfiedForDispatch(blocker);
    });
    const last = holdingItBack.length === 1 ? holdingItBack[0] : undefined;
    if (last !== undefined) {
      freesByBlocker.set(last, (freesByBlocker.get(last) ?? 0) + 1);
    }
  }

  const counts = new Map<string, DependentCount>();
  for (const id of sources) {
    const seen = new Set<string>();
    const stack = [...(blocks.get(id) ?? [])];
    let transitive = 0;
    while (stack.length > 0) {
      const next = stack.pop() as string;
      if (seen.has(next)) continue;
      seen.add(next);
      transitive += 1;
      const downstream = blocks.get(next);
      if (downstream !== undefined) stack.push(...downstream);
    }
    counts.set(id, { transitive, frees: freesByBlocker.get(id) ?? 0 });
  }
  return counts;
}

// Config validation rejects an unusable weight loudly, but rankTasks is
// exported to callers that may hand it weights straight off the wire, where one
// NaN would make every score NaN and collapse the ordering. Same predicate as
// the validator, so the two can never disagree about what is acceptable.
function usableWeight(weights: QueueWeights, key: ScoreFactorKey): number {
  const weight = weights[key];
  return isQueueWeight(weight) ? weight : 0;
}

/**
 * Ranks the tasks that can be started now, highest weighted score first, with
 * the per-factor breakdown that makes the ordering explainable.
 *
 * Candidates come from `dispatchableTasks`, not `readyTasks`: this queue exists
 * to be pulled from, so it must show exactly what the orchestrator would agree
 * to start. The two differ on a blocker sitting in review — dispatchable, not
 * yet done — and using `readyTasks` would hide startable work from the one
 * surface whose whole job is to surface it.
 *
 * Takes the whole task set, not just the candidates: the unblocking factor
 * needs the full blockedBy graph — including blocked and in-progress tasks —
 * to see what a candidate would free.
 *
 * The score is the weighted *mean* of the factor values rather than their raw
 * weighted sum, so it always reads as 0..1 no matter how a project scales its
 * weights, and each factor's `contribution` sums back to it.
 */
export function rankTasks(
  tasks: TaskDoc[],
  options: RankOptions
): ScoredTask[] {
  const nowMs = Date.parse(options.now);
  const candidates = dispatchableTasks(tasks);
  const ctx: ScoringContext = {
    // An unparseable `now` would make every age reading NaN, so fall back to
    // the epoch, which pins that factor at 0 rather than poisoning the score.
    nowMs: Number.isNaN(nowMs) ? 0 : nowMs,
    dependents: countDependents(
      tasks,
      candidates.map((task) => task.meta.id)
    ),
  };

  const weightSum = QUEUE_FACTOR_KEYS.reduce(
    (sum, key) => sum + usableWeight(options.weights, key),
    0
  );

  const scored = candidates.map((task): ScoredTask => {
    const factors = FACTORS.map((factor): ScoreFactor => {
      const { value, detail } = factor.read(task, ctx);
      const weight = usableWeight(options.weights, factor.key);
      return {
        key: factor.key,
        value,
        weight,
        contribution: weightSum === 0 ? 0 : (value * weight) / weightSum,
        detail,
      };
    });
    return {
      task,
      score: factors.reduce((sum, factor) => sum + factor.contribution, 0),
      factors,
    };
  });

  // Oldest-first then id keeps the order total and stable: with every weight
  // at zero, or on a genuine tie, the queue still has one definite answer.
  scored.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    const byCreated = a.task.meta.created.localeCompare(b.task.meta.created);
    return byCreated !== 0
      ? byCreated
      : a.task.meta.id.localeCompare(b.task.meta.id);
  });

  const { limit } = options;
  return limit !== undefined && limit >= 0 ? scored.slice(0, limit) : scored;
}
