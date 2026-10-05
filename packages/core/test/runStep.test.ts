import { describe, expect, it } from 'bun:test';

import { runStepFromEntry } from '../src/runStep.js';
import type { RunStepEntry } from '../src/runStep.js';

const RUN = 'r-abc123';
const WORKTREE = `/Users/me/.dispatch/worktrees/5f3a/${RUN}`;

const tool = (toolName: string, toolInput: unknown): RunStepEntry => ({
  kind: 'tool',
  toolName,
  toolInput,
});
const step = (entry: RunStepEntry) => runStepFromEntry(entry, RUN);

describe('runStepFromEntry', () => {
  it('names a file relative to the run’s worktree', () => {
    expect(step(tool('Edit', { file_path: `${WORKTREE}/src/foo.ts` }))).toBe(
      'Editing src/foo.ts'
    );
    expect(step(tool('Write', { file_path: `${WORKTREE}/docs/a.md` }))).toBe(
      'Writing docs/a.md'
    );
    expect(step(tool('Read', { file_path: '/a/b/c/d/e.ts' }))).toBe(
      'Reading c/d/e.ts'
    );
    expect(
      step(tool('codex.fileChange', { changes: [{ path: 'lib/x.rs' }] }))
    ).toBe('Editing lib/x.rs');
  });

  it('reads a shell command as the work it does', () => {
    expect(
      step(tool('Bash', { command: `cd ${WORKTREE} && bun test src/a.ts` }))
    ).toBe('Running tests');
    expect(
      step(tool('codex.commandExecution', { command: ['pnpm', 'tsc', '-b'] }))
    ).toBe('Typechecking');
    expect(step(tool('Bash', { command: 'moon run root:lint' }))).toBe(
      'Linting'
    );
    expect(step(tool('Bash', { command: 'git commit -m x' }))).toBe(
      'Committing'
    );
    expect(
      step(tool('Bash', { command: 'ls -la', description: 'List the files' }))
    ).toBe('List the files');
    expect(step(tool('Bash', { command: 'cd /tmp && FOO=1 /bin/rg x' }))).toBe(
      'Running rg'
    );
  });

  it('names other tools, thinking and a sub-agent’s start', () => {
    expect(step(tool('Grep', { pattern: 'needle' }))).toBe(
      'Searching for needle'
    );
    expect(step(tool('mcp__dispatch__task_save', {}))).toBe('Using task_save');
    expect(step({ kind: 'thinking' })).toBe('Thinking');
    expect(
      step({ kind: 'agent', agent: { phase: 'started', label: 'Map it' } })
    ).toBe('Sub-agent: Map it');
  });

  it('says nothing for prose, progress or a sub-agent’s own calls', () => {
    expect(step({ kind: 'assistant' })).toBeNull();
    expect(step({ kind: 'usage' })).toBeNull();
    expect(step({ kind: 'agent', agent: { phase: 'progress' } })).toBeNull();
    expect(
      step({ ...tool('Edit', { file_path: 'a.ts' }), parentToolUseId: 'tu' })
    ).toBeNull();
  });
});
