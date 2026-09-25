import type { ModelUsage } from '@anthropic-ai/claude-agent-sdk';

import { addUsage, ZERO_USAGE } from '../usage.js';
import type { RunUsage, TokenUsage } from '../usage.js';

// The Anthropic API's snake_case usage block, as it appears on an assistant
// message and on the SDK's terminal result. Every field is optional here
// because synthetic messages (API-error notices) carry partial or no usage.
interface ApiUsage {
  input_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
  output_tokens?: number | null;
}

// The slice of an SDK assistant message the meter reads.
interface MeteredAssistantMessage {
  message: { id?: string; model?: string; usage?: unknown };
  parent_tool_use_id?: string | null;
  error?: unknown;
}

// The slice of the SDK's terminal result message the meter reads.
interface MeteredResultMessage {
  usage?: unknown;
  modelUsage?: Record<string, ModelUsage>;
}

function count(value: number | null | undefined): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function fromApiUsage(usage: unknown): TokenUsage {
  if (typeof usage !== 'object' || usage === null) return ZERO_USAGE;
  const u = usage as ApiUsage;
  return {
    inputTokens: count(u.input_tokens),
    cacheCreationInputTokens: count(u.cache_creation_input_tokens),
    cacheReadInputTokens: count(u.cache_read_input_tokens),
    outputTokens: count(u.output_tokens),
  };
}

function fromModelUsage(usage: ModelUsage): TokenUsage {
  return {
    inputTokens: count(usage.inputTokens),
    cacheCreationInputTokens: count(usage.cacheCreationInputTokens),
    cacheReadInputTokens: count(usage.cacheReadInputTokens),
    outputTokens: count(usage.outputTokens),
  };
}

/**
 * Accumulates one Claude run's token usage by billing type.
 *
 * Two sources, because neither is enough alone:
 *
 * - The terminal `result` message's `modelUsage` is the CLI's own per-model
 *   accounting — the same numbers `total_cost_usd` is priced from, sub-agents
 *   and side calls included — so it is what the totals use whenever a result
 *   arrives.
 * - The streamed assistant messages are the only way to count API requests
 *   (one message id per request; the CLI emits one SDK message per content
 *   block, all sharing that id) and to tell a sub-agent's requests from the
 *   agent's own. They are also the fallback when a run dies before its
 *   result. Their `output_tokens` is NOT final, though: the streamed copy is
 *   captured before the API's closing `message_delta` reports the real count
 *   (verified against SDK 0.3.207: 1 streamed vs 20 in the result), which is
 *   why a stream-only total is marked `source: 'stream'`.
 */
export class ClaudeUsageMeter {
  // Latest usage seen per API message id.
  private readonly byMessage = new Map<string, TokenUsage>();
  private subagentRequests = 0;

  onAssistant(message: MeteredAssistantMessage): void {
    // The SDK's synthetic API-error notices are not model requests.
    if (
      message.error !== undefined ||
      message.message.model === '<synthetic>'
    ) {
      return;
    }
    const id = message.message.id;
    if (id === undefined || id === '') return;
    const fromSubagent = (message.parent_tool_use_id ?? null) !== null;
    if (!this.byMessage.has(id) && fromSubagent) {
      this.subagentRequests += 1;
    }
    this.byMessage.set(id, fromApiUsage(message.message.usage));
  }

  // The run's usage once the SDK has reported its terminal result.
  fromResult(result: MeteredResultMessage): RunUsage {
    const byModel: Record<string, TokenUsage> = {};
    let totals = ZERO_USAGE;
    for (const [model, usage] of Object.entries(result.modelUsage ?? {})) {
      byModel[model] = fromModelUsage(usage);
      totals = addUsage(totals, byModel[model]);
    }
    const hasModels = Object.keys(byModel).length > 0;
    return {
      ...(hasModels ? totals : fromApiUsage(result.usage)),
      ...this.requestCounts(),
      ...(hasModels ? { byModel } : {}),
      source: 'result',
    };
  }

  // The partial usage of a run that ended without a result, or undefined
  // when not one request was seen.
  fromStream(): RunUsage | undefined {
    if (this.byMessage.size === 0) return undefined;
    let totals = ZERO_USAGE;
    for (const usage of this.byMessage.values()) {
      totals = addUsage(totals, usage);
    }
    return { ...totals, ...this.requestCounts(), source: 'stream' };
  }

  private requestCounts(): { requests: number; subagentRequests: number } {
    return {
      requests: this.byMessage.size,
      subagentRequests: this.subagentRequests,
    };
  }
}
