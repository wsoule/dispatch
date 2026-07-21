import type { Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';

import type { PlanProposal } from '../../src/orchestrator/planner.js';
import { ClaudePlanner } from '../../src/orchestrator/planners/claude.js';

// Bun-compat gate, mirroring claude-executor.test.ts's own: constructing a
// ClaudePlanner must succeed under Bun with no import/native-binding crash.
// The real one-shot SDK call is never exercised in CI — every scenario below
// injects a stub `queryFn`, same seam ClaudeExecutor uses.
describe('ClaudePlanner Bun compatibility', () => {
  it('imports @anthropic-ai/claude-agent-sdk and constructs under Bun', () => {
    const planner = new ClaudePlanner('/tmp/does-not-matter');
    expect(planner).toBeInstanceOf(ClaudePlanner);
    expect(typeof planner.plan).toBe('function');
  });
});

describe('ClaudePlanner.plan', () => {
  it('returns the structured_output from a successful result message', async () => {
    const proposal: PlanProposal = {
      tasks: [
        {
          title: 'Do the thing',
          description: 'Do it well.',
          acceptanceCriteria: ['It is done'],
          blockedByIndices: [],
          priority: 'medium',
        },
      ],
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield {
        type: 'result',
        subtype: 'success',
        structured_output: proposal,
      };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    const result = await planner.plan('build the thing');
    expect(result).toEqual(proposal);
  });

  it('rejects when the result message is an error subtype', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield {
        type: 'result',
        subtype: 'error_during_execution',
        errors: ['boom'],
      };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.plan('build the thing')).rejects.toThrow(/boom/);
  });

  it('rejects when a successful result carries no structured_output', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield { type: 'result', subtype: 'success' };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.plan('build the thing')).rejects.toThrow(
      /no structured output/
    );
  });

  it('rejects when the stream ends with no result message at all', async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    async function* fakeMessages(): AsyncGenerator<any> {
      yield { type: 'system', subtype: 'init', session_id: 'sess-1' };
    }
    const fakeQueryFn = () => fakeMessages() as unknown as Query;
    const planner = new ClaudePlanner('/tmp/does-not-matter', fakeQueryFn);

    await expect(planner.plan('build the thing')).rejects.toThrow(
      /no result message/
    );
  });
});
