import type { NormalizedEntry } from '@dispatch/client';
import { describe, expect, test } from 'bun:test';

import { groupLogEntries, liveCostUsd, toolEntryPreview } from './runLog';

function entry(partial: Partial<NormalizedEntry>): NormalizedEntry {
  return { ts: '2026-01-01T00:00:00.000Z', kind: 'assistant', ...partial };
}

describe('groupLogEntries', () => {
  test('gives every non-tool entry its own group', () => {
    const entries = [
      entry({ kind: 'assistant', text: 'hi' }),
      entry({ kind: 'thinking', text: 'hmm' }),
      entry({ kind: 'system', text: 'user: hello' }),
    ];
    const groups = groupLogEntries(entries);
    expect(groups).toEqual([
      { kind: 'message', entries: [entries[0]] },
      { kind: 'message', entries: [entries[1]] },
      { kind: 'message', entries: [entries[2]] },
    ]);
  });

  test('collapses consecutive tool entries into one group', () => {
    const entries = [
      entry({ kind: 'assistant', text: 'starting' }),
      entry({ kind: 'tool', toolName: 'Bash' }),
      entry({ kind: 'tool', toolName: 'Read' }),
      entry({ kind: 'assistant', text: 'done' }),
    ];
    const groups = groupLogEntries(entries);
    expect(groups).toEqual([
      { kind: 'message', entries: [entries[0]] },
      { kind: 'tools', entries: [entries[1], entries[2]] },
      { kind: 'message', entries: [entries[3]] },
    ]);
  });

  test('does not merge tool clusters separated by a message entry', () => {
    const entries = [
      entry({ kind: 'tool', toolName: 'Bash' }),
      entry({ kind: 'assistant', text: 'checking in' }),
      entry({ kind: 'tool', toolName: 'Read' }),
    ];
    const groups = groupLogEntries(entries);
    expect(groups.map((g) => g.kind)).toEqual(['tools', 'message', 'tools']);
    expect(groups[0].entries).toEqual([entries[0]]);
    expect(groups[2].entries).toEqual([entries[2]]);
  });

  test('drops usage entries entirely — they drive the cost ticker, not the log', () => {
    const entries = [
      entry({ kind: 'usage', text: '{"costUsd":0.1}' }),
      entry({ kind: 'assistant', text: 'hi' }),
    ];
    expect(groupLogEntries(entries)).toEqual([
      { kind: 'message', entries: [entries[1]] },
    ]);
  });
});

describe('liveCostUsd', () => {
  test('prefers RunMeta.costUsd once the run has finished', () => {
    expect(liveCostUsd({ costUsd: 1.5 }, [])).toBe(1.5);
  });

  test('falls back to the latest usage entry while still live', () => {
    const entries = [
      entry({ kind: 'usage', text: '{"costUsd":0.1}' }),
      entry({ kind: 'assistant', text: 'working' }),
      entry({ kind: 'usage', text: '{"costUsd":0.42}' }),
    ];
    expect(liveCostUsd({}, entries)).toBe(0.42);
  });

  test('accepts a bare dollar-prefixed usage entry', () => {
    const entries = [entry({ kind: 'usage', text: '$0.07 so far' })];
    expect(liveCostUsd({}, entries)).toBe(0.07);
  });

  test('returns null with no finish cost and no usage entries', () => {
    expect(liveCostUsd({}, [entry({ kind: 'assistant', text: 'hi' })])).toBe(
      null
    );
  });
});

describe('toolEntryPreview', () => {
  test('renders the tool name with its JSON input', () => {
    const e = entry({
      kind: 'tool',
      toolName: 'Bash',
      toolInput: { command: 'ls' },
    });
    expect(toolEntryPreview(e)).toBe('Bash({"command":"ls"})');
  });

  test('falls back to the tool name alone with no input', () => {
    expect(toolEntryPreview(entry({ kind: 'tool', toolName: 'Read' }))).toBe(
      'Read'
    );
  });

  test('truncates a very large input payload', () => {
    const bigInput = { content: 'x'.repeat(200) };
    const preview = toolEntryPreview(
      entry({ kind: 'tool', toolName: 'Write', toolInput: bigInput })
    );
    expect(preview.includes('…)')).toBe(true);
    expect(preview.length).toBeLessThan(120);
  });
});
