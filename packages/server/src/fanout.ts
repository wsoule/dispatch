import type { CreateInput, TaskDoc } from '@dispatch/core';

/**
 * Fanning one piece of work out across several agents at once.
 *
 * The shape of this is decided by an invariant the orchestrator already
 * holds: a task may have at most one live run. That is load-bearing — task
 * status, review and the merge queue all assume one run is "the" run — so
 * fan-out does not race several agents on one task. It clones the task once
 * per variant, and each clone gets its own run, worktree, branch and diff.
 *
 * That turns out to be the better model anyway. Comparing the results is
 * exactly the review the app already does, one diff per variant, and merging
 * the winner is merging that variant's task. Nothing new has to learn what a
 * "candidate" is.
 */

/** One agent to try the work with. */
export interface FanoutVariant {
  executor: string;
  /** Overrides the executor's configured model for this variant. */
  model?: string;
}

/** The label every clone of one fan-out carries, so the group stays findable. */
export function fanoutLabel(sourceTaskId: string): string {
  return `fanout:${sourceTaskId}`;
}

/**
 * A variant's title.
 *
 * The executor and model go in the title rather than only in metadata because
 * this is what a person reads in the board, the run list and the merge queue,
 * and "which agent produced this one" is the single question a comparison is
 * asking.
 */
export function variantTitle(
  sourceTitle: string,
  variant: FanoutVariant
): string {
  const agent =
    variant.model === undefined
      ? variant.executor
      : `${variant.executor} · ${variant.model}`;
  return `${sourceTitle} [${agent}]`;
}

export class FanoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FanoutError';
  }
}

/** The most variants one fan-out may start, so a typo cannot start fifty runs. */
export const MAX_FANOUT_VARIANTS = 8;

/**
 * Validates the requested variants.
 *
 * Duplicates are rejected rather than de-duplicated: asking for the same agent
 * twice is either a mistake or a request to compare an agent against itself,
 * and silently collapsing it would leave the caller with fewer results than
 * they asked for and no idea why.
 */
export function validateVariants(
  variants: readonly FanoutVariant[],
  registeredExecutors: readonly string[]
): void {
  if (variants.length === 0) {
    throw new FanoutError('name at least one executor to fan out across');
  }
  if (variants.length > MAX_FANOUT_VARIANTS) {
    throw new FanoutError(
      `at most ${MAX_FANOUT_VARIANTS} variants (asked for ${variants.length})`
    );
  }
  const seen = new Set<string>();
  for (const variant of variants) {
    if (!registeredExecutors.includes(variant.executor)) {
      throw new FanoutError(
        `unknown executor: ${variant.executor} (have ${registeredExecutors.join(', ')})`
      );
    }
    const key = `${variant.executor}\u0000${variant.model ?? ''}`;
    if (seen.has(key)) {
      throw new FanoutError(
        `duplicate variant: ${variantTitle('', variant).trim()}`
      );
    }
    seen.add(key);
  }
}

/**
 * The task to create for one variant.
 *
 * Everything that scopes or gates the work is copied — `writes`, `risk`,
 * `selfReview`, `priority` — because a variant that ran under looser rules
 * than the original would not be comparable with the others, and the whole
 * point is to compare them. The clone sits under the original's `parent`; the
 * legacy `milestone` string is never written to a new task.
 *
 * `blockedBy` is deliberately not copied: the clones are cut at the moment the
 * original is ready to run, and re-inheriting its blockers would park every
 * one of them behind work that is already done.
 */
export function variantTaskInput(
  source: TaskDoc,
  variant: FanoutVariant
): CreateInput {
  const meta = source.meta;
  // Deliberately no `derivedFrom`. That field is a security marker meaning
  // "this body is text from outside this repo" — a PR description — and the
  // orchestrator refuses to start an execute run on anything carrying it. A
  // fan-out clone's body is the user's own task, so it is not derived in that
  // sense, and reusing the field for traceability would both break dispatch
  // and quietly weaken what the marker means. The `fanout:<id>` label is what
  // ties a clone back to its source.
  return {
    title: variantTitle(meta.title, variant),
    kind: meta.kind,
    ...(meta.parent === null ? {} : { parent: meta.parent }),
    labels: [...meta.labels, fanoutLabel(meta.id)],
    priority: meta.priority,
    ...(meta.writes === undefined ? {} : { writes: meta.writes }),
    ...(meta.risk === undefined ? {} : { risk: meta.risk }),
    selfReview: meta.selfReview,
    ...(variant.model === undefined ? {} : { model: variant.model }),
    // The body is the prompt: every variant has to be given the same problem
    // statement, or the comparison is between different questions.
    description: source.body,
  };
}

/** Reads a request body's `variants` into the shape above. */
export function parseVariants(raw: unknown): FanoutVariant[] {
  if (!Array.isArray(raw)) {
    throw new FanoutError('variants must be a list');
  }
  return raw.map((entry) => {
    // A bare string is the common case — "fan out across these agents" — and
    // the object form is only needed to pin a model.
    if (typeof entry === 'string') return { executor: entry };
    if (typeof entry !== 'object' || entry === null) {
      throw new FanoutError(
        'each variant must be an executor name or an object'
      );
    }
    const value = entry as { executor?: unknown; model?: unknown };
    if (typeof value.executor !== 'string' || value.executor === '') {
      throw new FanoutError('each variant needs an executor');
    }
    if (value.model !== undefined && typeof value.model !== 'string') {
      throw new FanoutError('a variant model must be a string');
    }
    return {
      executor: value.executor,
      ...(value.model === undefined ? {} : { model: value.model }),
    };
  });
}
