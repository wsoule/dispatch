import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import {
  ClaudeExecutor,
  LEAN_TOOL_EXCLUSIONS,
  UNUSABLE_IN_DISPATCHED_RUN,
} from '../../src/orchestrator/executors/claude.js';
import type { ExperimentName } from '../../src/orchestrator/experiments.js';
import { activeExperiments } from '../../src/orchestrator/experiments.js';
import { withRunEndControls } from './helpers.js';

describe('activeExperiments', () => {
  it('is empty when DISPATCH_EXPERIMENTS is unset or blank', () => {
    expect(activeExperiments({})).toEqual([]);
    expect(activeExperiments({ DISPATCH_EXPERIMENTS: ' , ' })).toEqual([]);
  });

  it('keeps known names only, sorted and deduplicated', () => {
    expect(
      activeExperiments({
        DISPATCH_EXPERIMENTS: 'lean-tools, cache-1h,typo,lean-tools',
      })
    ).toEqual(['cache-1h', 'lean-tools']);
  });
});

// Starts a run under `experiments` and returns the options handed to the SDK.
function optionsUnder(experiments: ExperimentName[]): Options | undefined {
  let captured: Options | undefined;
  const executor = new ClaudeExecutor(
    (args: { options?: Options }) => {
      captured = args.options;
      // eslint-disable-next-line @typescript-eslint/no-empty-function
      return (async function* () {})() as unknown as Query;
    },
    () => experiments
  );
  executor.start(
    { cwd: '/tmp/dispatch-worktree-x', prompt: 'x', permissionMode: 'auto' },
    { onEntry: () => {}, onApprovalRequest: () => {}, onFinish: () => {} }
  );
  return captured;
}

describe('ClaudeExecutor experiments', () => {
  it('changes nothing beyond the always-removed tools by default', () => {
    const options = optionsUnder([]);
    expect(options?.disallowedTools).toEqual([...UNUSABLE_IN_DISPATCHED_RUN]);
    // No env override: the CLI inherits the daemon's environment as before.
    expect(options?.env).toBeUndefined();
  });

  it('lean-tools also removes the rarely needed tools, keeping the core set', () => {
    const disallowed = optionsUnder(['lean-tools'])?.disallowedTools ?? [];
    expect(disallowed).toEqual([
      ...UNUSABLE_IN_DISPATCHED_RUN,
      ...LEAN_TOOL_EXCLUSIONS,
    ]);
    for (const core of ['Bash', 'Read', 'Edit', 'Write', 'Agent', 'Skill']) {
      expect(disallowed).not.toContain(core);
    }
    expect(disallowed.some((name) => name.startsWith('mcp__dispatch__'))).toBe(
      false
    );
  });

  it('cache-1h asks the CLI for 1-hour cache entries without dropping the inherited env', () => {
    const env = optionsUnder(['cache-1h'])?.env;
    expect(env?.ENABLE_PROMPT_CACHING_1H).toBe('1');
    expect(env?.PATH).toBe(process.env.PATH);
  });

  it('reports the experiments a run ran under on its finish', async () => {
    const executor = new ClaudeExecutor(
      (() =>
        withRunEndControls(
          (function* (): Generator<unknown> {
            yield { type: 'system', subtype: 'init', session_id: 's' };
            yield {
              type: 'assistant',
              message: { content: [{ type: 'text', text: 'done' }] },
            };
            yield {
              type: 'result',
              subtype: 'success',
              is_error: false,
              num_turns: 1,
              total_cost_usd: 0.01,
              session_id: 's',
              result: 'done',
              terminal_reason: 'completed',
              modelUsage: {},
              errors: [],
            };
          })()
        )) as never,
      () => ['lean-tools']
    );
    const experiments = await new Promise<string[] | undefined>((resolve) => {
      executor.start(
        {
          cwd: '/tmp/dispatch-worktree-x',
          prompt: 'x',
          permissionMode: 'auto',
        },
        {
          onEntry: () => {},
          onApprovalRequest: () => {},
          onFinish: (finish) => resolve(finish.experiments),
        }
      );
    });
    expect(experiments).toEqual(['lean-tools']);
  });
});
