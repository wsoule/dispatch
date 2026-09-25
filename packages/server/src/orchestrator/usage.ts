// A run's token spend split by billing type. Dollar cost alone cannot say
// *why* a run was expensive: an uncached input token, a cache write, a cache
// read, and an output token are billed at very different rates (on Claude,
// roughly 1x, 1.25x, 0.1x and 5x the input rate), so a change that trims one
// kind can raise another. Recording all four per run is what lets a harness
// change be judged on cost per completed task rather than on a guess.

/** Token counts split the way the provider bills them. */
export interface TokenUsage {
  /** Input billed at the full rate: neither read from nor written to cache. */
  inputTokens: number;
  /** Input written to the prompt cache, billed at a premium over the base rate. */
  cacheCreationInputTokens: number;
  /** Input served from the prompt cache, billed at a fraction of the base rate. */
  cacheReadInputTokens: number;
  outputTokens: number;
}

/** A run's token spend, as its executor measured it. */
export interface RunUsage extends TokenUsage {
  /**
   * Model API requests the run made, its sub-agents' included. Absent when the
   * executor cannot count them.
   */
  requests?: number;
  /** How many of `requests` the run's sub-agents made. */
  subagentRequests?: number;
  /** Per-model totals, when the executor reports them. */
  byModel?: Record<string, TokenUsage>;
  /**
   * Where the totals came from. `'result'` is the executor's own end-of-run
   * accounting; `'stream'` is a partial count summed from the messages seen
   * before the run ended without one, and reports too few output tokens.
   */
  source: 'result' | 'stream';
}

export const ZERO_USAGE: TokenUsage = {
  inputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
  outputTokens: 0,
};

export function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    cacheCreationInputTokens:
      a.cacheCreationInputTokens + b.cacheCreationInputTokens,
    cacheReadInputTokens: a.cacheReadInputTokens + b.cacheReadInputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
  };
}

// The share of all input tokens that were served from cache, or null when the
// run sent no input at all (nothing to divide). The number that shows whether
// a request layout keeps its prefix stable across turns.
export function cacheHitRate(usage: TokenUsage): number | null {
  const input =
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens;
  return input === 0 ? null : usage.cacheReadInputTokens / input;
}
