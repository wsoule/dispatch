import type { Options, Query } from '@anthropic-ai/claude-agent-sdk';
import { describe, expect, it } from 'bun:test';
import { tmpdir } from 'node:os';

import { ClaudeAiTaskFilter } from '../src/aiTaskFilter.js';
import { CommitMessageGenerator } from '../src/git/commitMessage.js';
import type { InboxItem } from '../src/inbox.js';
import { InboxClusterer } from '../src/inboxClusterer.js';

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

function item(id: string, text: string): InboxItem {
  return {
    id,
    kind: 'idea',
    text,
    done: false,
    linkedTaskId: null,
    createdByRunId: null,
    created: '2026-09-23T00:00:00.000Z',
  } as InboxItem;
}

// These one-shot judgments read untrusted text (a diff, inbox captures, a
// filter sentence) and need no tools. `allowedTools: []` only pre-approved
// nothing: the model still had Bash, and plan mode runs a command that a
// settings allow rule matches. `tools: []` is what removes them, and
// strictMcpConfig keeps a project's `.mcp.json` servers from starting.
describe('one-shot model calls run with no tools and no MCP servers', () => {
  it('commit message generation', async () => {
    const seen: { options?: Options } = {};
    const generator = new CommitMessageGenerator(
      tmpdir(),
      recordingQuery({ message: 'fix: x' }, seen)
    );
    expect(await generator.generate('diff --git a/x b/x')).toBe('fix: x');
    expect(seen.options?.tools).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });

  it('inbox clustering', async () => {
    const seen: { options?: Options } = {};
    const clusterer = new InboxClusterer(
      tmpdir(),
      recordingQuery({ groups: [] }, seen)
    );
    await clusterer.cluster([
      item('i-1', 'a'),
      item('i-2', 'b'),
      item('i-3', 'c'),
    ]);
    expect(seen.options?.tools).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });

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
      epics: [],
      runStates: [],
    });
    expect(seen.options?.tools).toEqual([]);
    expect(seen.options?.strictMcpConfig).toBe(true);
  });
});
