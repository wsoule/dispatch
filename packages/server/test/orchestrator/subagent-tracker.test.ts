import { describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';

import { ClaudeExecutor } from '../../src/orchestrator/executors/claude.js';
import { SubagentTracker } from '../../src/orchestrator/executors/subagentTracker.js';
import type {
  ExecutorEvents,
  NormalizedEntry,
} from '../../src/orchestrator/types.js';
import { initGitRepo, withRunEndControls } from './helpers.js';

const TS = '2026-01-01T00:00:00.000Z';

const SPAWN = {
  id: 'tu-spawn',
  name: 'Task',
  input: {
    description: 'Map the server',
    subagent_type: 'Explore',
    prompt: 'Find every route.',
  },
};

describe('SubagentTracker', () => {
  it('logs a spawn as a started agent entry carrying the tool call', () => {
    const tracker = new SubagentTracker();
    expect(tracker.onSpawn(SPAWN, TS, undefined)).toEqual({
      ts: TS,
      kind: 'agent',
      toolUseId: 'tu-spawn',
      toolName: 'Task',
      toolInput: SPAWN.input,
      agent: {
        id: 'tu-spawn',
        phase: 'started',
        status: 'running',
        label: 'Map the server',
        type: 'Explore',
      },
    });
  });

  it('keys progress and notification by the SDK task id once task_started pairs it', () => {
    const tracker = new SubagentTracker();
    tracker.onSpawn(SPAWN, TS, undefined);
    // task_started names both ids; the spawn already logged, so nothing new.
    expect(
      tracker.onSystem(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'task-1',
          tool_use_id: 'tu-spawn',
          description: 'Map the server',
          subagent_type: 'Explore',
          task_type: 'subagent',
        },
        TS
      )
    ).toBeNull();
    const progress = tracker.onSystem(
      {
        type: 'system',
        subtype: 'task_progress',
        task_id: 'task-1',
        description: 'Map the server',
        usage: { total_tokens: 500, tool_uses: 3, duration_ms: 2000 },
        last_tool_name: 'Grep',
        summary: 'Reading routes',
      },
      TS
    );
    expect(progress?.agent).toEqual({
      id: 'tu-spawn',
      phase: 'progress',
      status: 'running',
      toolUses: 3,
      tokens: 500,
      durationMs: 2000,
      lastTool: 'Grep',
      summary: 'Reading routes',
      label: 'Map the server',
      type: 'Explore',
    });
    const finished = tracker.onSystem(
      {
        type: 'system',
        subtype: 'task_notification',
        task_id: 'task-1',
        status: 'completed',
        summary: 'Found 12 routes',
        usage: { total_tokens: 900, tool_uses: 7, duration_ms: 5000 },
      },
      TS
    );
    expect(finished?.agent).toMatchObject({
      id: 'tu-spawn',
      phase: 'finished',
      status: 'done',
      toolUses: 7,
      summary: 'Found 12 routes',
    });
    // The tool_result that follows reports the same end: not logged twice.
    expect(
      tracker.onToolResult({ tool_use_id: 'tu-spawn' }, undefined, TS)
    ).toBeNull();
    // Nor does a late progress tick revive it.
    expect(
      tracker.onSystem(
        { type: 'system', subtype: 'task_progress', task_id: 'task-1' },
        TS
      )
    ).toBeNull();
  });

  it('ends a sub-agent from its tool_result when no notification came, reading the totals', () => {
    const tracker = new SubagentTracker();
    tracker.onSpawn(SPAWN, TS, undefined);
    const finished = tracker.onToolResult(
      { tool_use_id: 'tu-spawn', is_error: false },
      { totalToolUseCount: 11, totalTokens: 4000, totalDurationMs: 9000 },
      TS
    );
    expect(finished?.agent).toEqual({
      id: 'tu-spawn',
      phase: 'finished',
      status: 'done',
      toolUses: 11,
      tokens: 4000,
      durationMs: 9000,
      label: 'Map the server',
      type: 'Explore',
    });
    const failing = new SubagentTracker();
    failing.onSpawn(SPAWN, TS, undefined);
    expect(
      failing.onToolResult(
        { tool_use_id: 'tu-spawn', is_error: true },
        undefined,
        TS
      )?.agent?.status
    ).toBe('failed');
  });

  it('ignores results and lifecycle messages for anything that is not a spawned sub-agent', () => {
    const tracker = new SubagentTracker();
    expect(
      tracker.onToolResult({ tool_use_id: 'tu-bash' }, undefined, TS)
    ).toBeNull();
    expect(
      tracker.onSystem(
        {
          type: 'system',
          subtype: 'task_started',
          task_id: 'shell-1',
          task_type: 'shell',
          description: 'npm test',
        },
        TS
      )
    ).toBeNull();
    expect(
      tracker.onSystem({ type: 'system', subtype: 'init' }, TS)
    ).toBeNull();
  });

  it('still records a sub-agent the SDK announces without a spawn call it saw', () => {
    const tracker = new SubagentTracker();
    const startedLate = tracker.onSystem(
      {
        type: 'system',
        subtype: 'task_started',
        task_id: 'task-2',
        tool_use_id: 'tu-late',
        description: 'Check the docs',
        subagent_type: 'general-purpose',
        task_type: 'subagent',
      },
      TS
    );
    expect(startedLate?.agent).toEqual({
      id: 'tu-late',
      phase: 'started',
      status: 'running',
      label: 'Check the docs',
      type: 'general-purpose',
    });
    const stopped = tracker.onSystem(
      {
        type: 'system',
        subtype: 'task_updated',
        task_id: 'task-2',
        patch: { status: 'killed' },
      },
      TS
    );
    expect(stopped?.agent?.status).toBe('stopped');
  });
});

// The executor half: the SDK stream's spawn block, the sub-agent's own tool
// calls (forwarded with parent_tool_use_id), the lifecycle messages and the
// final tool_result all land as entries on the run, in order.
describe('ClaudeExecutor sub-agent entries', () => {
  it('logs a spawned sub-agent, its tool calls and its finish as run entries', async () => {
    const repo = initGitRepo('dispatch-claude-subagents-');
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      function* messages(): Generator<any> {
        yield { type: 'system', subtype: 'init', session_id: 's-1' };
        yield {
          type: 'assistant',
          session_id: 's-1',
          parent_tool_use_id: null,
          message: {
            content: [
              { type: 'text', text: 'Fanning out.' },
              {
                type: 'tool_use',
                id: 'tu-spawn',
                name: 'Agent',
                input: SPAWN.input,
              },
            ],
          },
        };
        yield {
          type: 'system',
          subtype: 'task_started',
          session_id: 's-1',
          task_id: 'task-1',
          tool_use_id: 'tu-spawn',
          description: 'Map the server',
          subagent_type: 'Explore',
          task_type: 'subagent',
        };
        yield {
          type: 'assistant',
          session_id: 's-1',
          parent_tool_use_id: 'tu-spawn',
          message: {
            content: [
              {
                type: 'tool_use',
                id: 'tu-grep',
                name: 'Grep',
                input: { pattern: 'route' },
              },
            ],
          },
        };
        yield {
          type: 'system',
          subtype: 'task_progress',
          session_id: 's-1',
          task_id: 'task-1',
          description: 'Map the server',
          usage: { total_tokens: 100, tool_uses: 1, duration_ms: 500 },
          last_tool_name: 'Grep',
        };
        yield {
          type: 'user',
          session_id: 's-1',
          parent_tool_use_id: null,
          message: {
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tu-spawn', content: 'done' },
            ],
          },
          tool_use_result: { totalToolUseCount: 1, totalTokens: 150 },
        };
        yield {
          type: 'result',
          subtype: 'success',
          session_id: 's-1',
          total_cost_usd: 0.02,
          num_turns: 2,
          is_error: false,
          result: '',
        };
      }
      const executor = new ClaudeExecutor(() => withRunEndControls(messages()));
      const entries: NormalizedEntry[] = [];
      await new Promise<void>((resolve) => {
        const events: ExecutorEvents = {
          onEntry: (entry) => entries.push(entry),
          onApprovalRequest: () => {},
          onFinish: () => resolve(),
        };
        executor.start(
          {
            cwd: repo,
            prompt: 'go',
            permissionMode: 'acceptEdits',
            maxTurns: 5,
          },
          events
        );
      });

      expect(
        entries.map((e) => [e.kind, e.agent?.phase ?? e.toolName ?? null])
      ).toEqual([
        ['assistant', null],
        ['agent', 'started'],
        ['tool', 'Grep'],
        ['agent', 'progress'],
        ['agent', 'finished'],
      ]);
      // The spawn keeps the tool call it was, so the transcript can show the prompt.
      expect(entries[1]).toMatchObject({
        toolName: 'Agent',
        toolUseId: 'tu-spawn',
        toolInput: SPAWN.input,
        agent: { id: 'tu-spawn', label: 'Map the server', type: 'Explore' },
      });
      // The sub-agent's own call is attributed to it, and carries its block id.
      expect(entries[2]).toMatchObject({
        parentToolUseId: 'tu-spawn',
        toolUseId: 'tu-grep',
      });
      expect(entries[4].agent).toMatchObject({
        status: 'done',
        toolUses: 1,
        tokens: 150,
      });
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
