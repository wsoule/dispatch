import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';

import { ClaudeAiTaskFilter } from '../src/aiTaskFilter.js';

// A stub queryFn that records the options it was given and answers with one
// successful structured result.
function recordingQuery(
  structuredOutput: unknown,
  seen: { options?: Options }
): never {
  return ((args: { options?: Options }) => {
    seen.options = args.options;
    return (function* (): Generator<unknown> {
      yield {
        type: 'result',
        subtype: 'success',
        session_id: 's',
        structured_output: structuredOutput,
      };
    })() as unknown as Query;
  }) as never;
}

// These one-shot judgments read untrusted text (a diff, inbox captures, a
// filter sentence) and need no tools. `allowedTools: []` only pre-approved
// nothing: the model still had Bash, and plan mode runs a command that a
// settings allow rule matches. `tools: []` is what removes them, and
// strictMcpConfig keeps a project's `.mcp.json` servers from starting.
describe('one-shot model calls run with no tools and no MCP servers', () => {
  it('natural-language task filtering', async () => {
    const seen: { options?: Options } = {};
    const filter = new ClaudeAiTaskFilter(
      tmpdir(),
      recordingQuery({ clauses: [], join: 'and' }, seen)
    );
    await filter.toFilters('urgent tasks', {
      statuses: ['ready'],
      labels: [],
      milestones: [],
      runStates: [],
    });
    expect(seen.options?.tools).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });
});
