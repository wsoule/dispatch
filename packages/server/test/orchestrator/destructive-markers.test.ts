import { describe, expect, it } from 'bun:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { scanDestructiveWrites } from '../../src/orchestrator/review.js';

// Each case is one file's content and the marker label it must be reported
// under, or null when nothing in it should fire.
const CASES: readonly { name: string; text: string; marker: string | null }[] =
  [
    // Shell form — how a script, CI job, Makefile or package.json script spells it.
    {
      name: 'shell: git reset --hard',
      text: 'git reset --hard HEAD~1\n',
      marker: 'git reset --hard',
    },
    {
      name: 'shell: git clean -fdx',
      text: 'git clean -fdx\n',
      marker: 'git clean -fd',
    },
    {
      name: 'shell: git branch -D',
      text: 'git branch -D feature/x\n',
      marker: 'branch deletion',
    },
    {
      name: 'shell: git worktree remove',
      text: 'git worktree remove /tmp/wt\n',
      marker: 'worktree removal',
    },
    {
      name: 'shell: git checkout',
      text: 'git checkout main\n',
      marker: 'git checkout',
    },
    // Argv form — how code spawning git spells it.
    {
      name: 'argv: git clean',
      text: "Bun.spawnSync(['git', 'clean', '-fd']);\n",
      marker: 'git clean -fd',
    },
    {
      name: 'argv: git branch -D',
      text: "Bun.spawnSync(['git', 'branch', '-D', name]);\n",
      marker: 'branch deletion',
    },
    {
      name: 'argv: git worktree remove',
      text: "Bun.spawnSync(['git', 'worktree', 'remove', path]);\n",
      marker: 'worktree removal',
    },
    {
      name: 'argv: git checkout',
      text: "Bun.spawnSync(['git', 'checkout', '--', path]);\n",
      marker: 'git checkout',
    },
    {
      name: 'argv: git reset --hard',
      text: "Bun.spawnSync(['git', 'reset', '--hard', sha]);\n",
      marker: 'git reset --hard',
    },
    // Prose and unrelated flags that share a prefix with a real marker.
    {
      name: 'prose: --hardly worth it',
      text: '// this is --hardly worth it\n',
      marker: null,
    },
    {
      name: 'flag: --hardlink',
      text: 'const args = ["--hardlink", src, dest];\n',
      marker: null,
    },
    {
      name: 'flag: --hard-timeout',
      text: 'spawn(["tool", "--hard-timeout", "30"]);\n',
      marker: null,
    },
    {
      name: 'prose: mentions checking out a branch',
      text: '// callers may check out a branch first\n',
      marker: null,
    },
    { name: 'ordinary code', text: 'export const x = 1;\n', marker: null },
  ];

describe('scanDestructiveWrites markers', () => {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-destructive-'));

  for (const [index, testCase] of CASES.entries()) {
    it(`${testCase.marker === null ? 'ignores' : `flags as ${testCase.marker}`} — ${testCase.name}`, () => {
      const file = `case${index}.ts`;
      writeFileSync(join(root, file), testCase.text);
      expect(scanDestructiveWrites(root, [file])).toEqual(
        testCase.marker === null
          ? []
          : [{ path: file, marker: testCase.marker }]
      );
    });
  }
});
