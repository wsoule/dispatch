import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import { ClaudeUsageMeter } from '../../src/orchestrator/executors/claudeUsage.js';
import type { RunUsage } from '../../src/orchestrator/usage.js';
import { cacheHitRate } from '../../src/orchestrator/usage.js';
import { initGitRepo, withRunEndControls } from './helpers.js';

// One streamed assistant message as the SDK emits it: one per content block,
// every block of an API response sharing its message id and usage snapshot.
function assistant(
  id: string,
  usage: Record<string, number>,
  parent: string | null = null
): Record<string, unknown> {
  return {
    type: 'assistant',
    parent_tool_use_id: parent,
    message: {
      id,
      model: 'claude-opus-5',
      usage,
      content: [{ type: 'text', text: 'x' }],
    },
  };
}

const STREAMED = {
  input_tokens: 100,
  cache_creation_input_tokens: 50,
  cache_read_input_tokens: 1000,
  // The streamed snapshot predates the API's closing message_delta, so this
  // is the stale message_start value, not the real count.
  output_tokens: 1,
};

describe('ClaudeUsageMeter', () => {
  it('takes billing-type totals from the result modelUsage, summed across models', () => {
    const meter = new ClaudeUsageMeter();
    meter.onAssistant(assistant('msg_1', STREAMED) as never);
    const usage = meter.fromResult({
      modelUsage: {
        'claude-opus-5': {
          inputTokens: 200,
          outputTokens: 40,
          cacheReadInputTokens: 2000,
          cacheCreationInputTokens: 100,
          webSearchRequests: 0,
          costUSD: 0.01,
          contextWindow: 1_000_000,
          maxOutputTokens: 32_000,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 0,
          cacheCreationInputTokens: 0,
          webSearchRequests: 0,
          costUSD: 0.001,
          contextWindow: 200_000,
          maxOutputTokens: 8_000,
        },
      },
    });
    expect(usage).toEqual({
      inputTokens: 210,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 2000,
      outputTokens: 45,
      requests: 1,
      subagentRequests: 0,
      byModel: {
        'claude-opus-5': {
          inputTokens: 200,
          cacheCreationInputTokens: 100,
          cacheReadInputTokens: 2000,
          outputTokens: 40,
        },
        'claude-haiku-4-5-20251001': {
          inputTokens: 10,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 0,
          outputTokens: 5,
        },
      },
      source: 'result',
    });
  });

  it("falls back to the result's own usage block when it carries no modelUsage", () => {
    const usage = new ClaudeUsageMeter().fromResult({
      usage: { ...STREAMED, output_tokens: 20 },
    });
    expect(usage.outputTokens).toBe(20);
    expect(usage.cacheReadInputTokens).toBe(1000);
    expect(usage.byModel).toBeUndefined();
  });

  it('counts one request per message id and attributes sub-agent requests', () => {
    const meter = new ClaudeUsageMeter();
    // Two content blocks of one response: one request, not two.
    meter.onAssistant(assistant('msg_1', STREAMED) as never);
    meter.onAssistant(assistant('msg_1', STREAMED) as never);
    meter.onAssistant(assistant('msg_2', STREAMED, 'toolu_spawn') as never);
    // The SDK's synthetic API-error notice is not a model request.
    meter.onAssistant({
      ...assistant('msg_3', {}),
      error: 'rate_limit',
    } as never);
    expect(meter.fromStream()).toEqual({
      inputTokens: 200,
      cacheCreationInputTokens: 100,
      cacheReadInputTokens: 2000,
      outputTokens: 2,
      requests: 2,
      subagentRequests: 1,
      source: 'stream',
    });
  });

  it('reports nothing from the stream when no request was seen', () => {
    expect(new ClaudeUsageMeter().fromStream()).toBeUndefined();
  });
});

describe('cacheHitRate', () => {
  it('is the cached share of all input, or null with no input', () => {
    expect(
      cacheHitRate({
        inputTokens: 100,
        cacheCreationInputTokens: 100,
        cacheReadInputTokens: 800,
        outputTokens: 50,
      })
    ).toBe(0.8);
    expect(
      cacheHitRate({
        inputTokens: 0,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 0,
        outputTokens: 0,
      })
    ).toBeNull();
  });
});

// Drives a scripted SDK stream through a real ClaudeExecutor and returns the
// usage its finish reported.
async function usageForStream(
  messages: Record<string, unknown>[]
): Promise<RunUsage | undefined> {
  const repo = initGitRepo('dispatch-claude-usage-');
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    function* fakeMessages(): Generator<any> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-usage' };
      yield* messages;
    }
    const executor = new ClaudeExecutor((() =>
      withRunEndControls(fakeMessages())) as never);
    return await new Promise((resolve) => {
      executor.start(
        { cwd: repo, prompt: 'do the thing', permissionMode: 'acceptEdits' },
        {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onFinish: (finish) => resolve(finish.usage),
        }
      );
    });
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
}

describe('ClaudeExecutor usage reporting', () => {
  it('reports result-sourced usage on a normal finish', async () => {
    const usage = await usageForStream([
      assistant('msg_1', STREAMED),
      {
        type: 'result',
        subtype: 'success',
        is_error: false,
        num_turns: 1,
        total_cost_usd: 0.01,
        session_id: 'sess-usage',
        result: 'done',
        terminal_reason: 'completed',
        usage: { ...STREAMED, output_tokens: 20 },
        modelUsage: {},
        errors: [],
      },
    ]);
    expect(usage?.source).toBe('result');
    expect(usage?.outputTokens).toBe(20);
    expect(usage?.requests).toBe(1);
  });

  it('reports stream-sourced usage when the session ends without a result', async () => {
    const usage = await usageForStream([assistant('msg_1', STREAMED)]);
    expect(usage?.source).toBe('stream');
    expect(usage?.cacheReadInputTokens).toBe(1000);
  });
});
