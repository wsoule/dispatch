import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  GitRepo,
  STAGED_DISCARD_PREFIX,
  WHOLE_TREE_DISCARD_ERROR,
} from '../src/git/commands.js';
import type { CommandResult, CommandRunner } from '../src/orchestrator/pr.js';

// Fixture setup only — throws on failure so a broken fixture fails loudly
// rather than turning into a confusing assertion further down.
function setupGit(cwd: string, args: string[]): void {
  const result = Bun.spawnSync(['git', ...args], {
    cwd,
    stdout: 'pipe',
    stderr: 'pipe',
  });
  if (result.exitCode !== 0) {
    throw new Error(
      `git ${args.join(' ')} failed: ${result.stderr.toString()}`
    );
  }
}

let root: string;
let repo: GitRepo;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-discard-'));
  setupGit(root, ['init', '-b', 'main']);
  setupGit(root, ['config', 'user.email', 'test@example.com']);
  setupGit(root, ['config', 'user.name', 'Test']);
  mkdirSync(join(root, 'src'));
  writeFileSync(join(root, 'tracked.txt'), 'committed\n');
  writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 1;\n');
  setupGit(root, ['add', '-A']);
  setupGit(root, ['commit', '-m', 'initial']);
  repo = new GitRepo(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// The uncommitted state a whole-tree discard would destroy: a tracked edit, an
// untracked file, and the untracked `.dispatch/` state stores.
function dirtyTheTree(): void {
  writeFileSync(join(root, 'tracked.txt'), 'uncommitted edit\n');
  writeFileSync(join(root, 'untracked.txt'), 'precious\n');
  mkdirSync(join(root, '.dispatch'), { recursive: true });
  writeFileSync(join(root, '.dispatch', 'findings.jsonl'), '{"id":"f1"}\n');
}

describe('GitRepo.discard refuses a whole-tree pathspec', () => {
  // `.` passes an "escapes the repo root" check while naming every file in it.
  for (const pathspec of ['.', './', 'src/..']) {
    it(`refuses ${pathspec} and leaves every uncommitted file in place`, async () => {
      dirtyTheTree();

      const result = await repo.discard([pathspec], true);

      expect(result).toEqual({ ok: false, stderr: WHOLE_TREE_DISCARD_ERROR });
      expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe(
        'uncommitted edit\n'
      );
      expect(existsSync(join(root, 'untracked.txt'))).toBe(true);
      expect(existsSync(join(root, '.dispatch', 'findings.jsonl'))).toBe(true);
    });
  }

  it('refuses the absolute path of the repo root', async () => {
    dirtyTheTree();

    const result = await repo.discard([root], true);

    expect(result).toEqual({ ok: false, stderr: WHOLE_TREE_DISCARD_ERROR });
    expect(existsSync(join(root, 'untracked.txt'))).toBe(true);
  });

  it('refuses the whole batch when only one entry targets the root', async () => {
    dirtyTheTree();

    const result = await repo.discard(['tracked.txt', '.'], true);

    expect(result).toEqual({ ok: false, stderr: WHOLE_TREE_DISCARD_ERROR });
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe(
      'uncommitted edit\n'
    );
  });

  it('still discards a named file and a named subdirectory', async () => {
    dirtyTheTree();
    writeFileSync(join(root, 'src', 'app.ts'), 'export const x = 2;\n');
    writeFileSync(join(root, 'src', 'scratch.ts'), 'junk\n');

    expect(await repo.discard(['tracked.txt'], true)).toEqual({ ok: true });
    expect(await repo.discard(['src'], true)).toEqual({ ok: true });

    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe('committed\n');
    expect(readFileSync(join(root, 'src', 'app.ts'), 'utf8')).toBe(
      'export const x = 1;\n'
    );
    expect(existsSync(join(root, 'src', 'scratch.ts'))).toBe(false);
    // Only the named paths were touched.
    expect(existsSync(join(root, 'untracked.txt'))).toBe(true);
  });
});

describe('GitRepo.discard restores before it deletes', () => {
  it('leaves untracked files alone when the restore fails', async () => {
    dirtyTheTree();
    writeFileSync(join(root, 'src', 'scratch.ts'), 'junk\n');

    // Fails only `checkout`, so the ordering decides whether the untracked
    // files are already gone by the time the failure is reported.
    const failingCheckout: CommandRunner = (
      cwd,
      argv
    ): Promise<CommandResult> => {
      if (argv.includes('checkout')) {
        return Promise.resolve({
          ok: false,
          stdout: '',
          stderr: 'checkout exploded',
        });
      }
      const result = Bun.spawnSync(argv, {
        cwd,
        stdout: 'pipe',
        stderr: 'pipe',
      });
      return Promise.resolve({
        ok: result.exitCode === 0,
        stdout: result.stdout.toString(),
        stderr: result.stderr.toString(),
      });
    };
    const repoWithFailure = new GitRepo(root, failingCheckout);

    const result = await repoWithFailure.discard(['tracked.txt', 'src'], true);

    expect(result).toEqual({ ok: false, stderr: 'checkout exploded' });
    expect(existsSync(join(root, 'src', 'scratch.ts'))).toBe(true);
    expect(readFileSync(join(root, 'tracked.txt'), 'utf8')).toBe(
      'uncommitted edit\n'
    );
  });
});

describe('GitRepo.discard reports staged removals it cannot undo', () => {
  it('refuses a staged deletion instead of reporting a no-op success', async () => {
    setupGit(root, ['rm', '-q', 'tracked.txt']);

    const result = await repo.discard(['tracked.txt'], true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.stderr).toBe(`${STAGED_DISCARD_PREFIX}tracked.txt`);
    expect(existsSync(join(root, 'tracked.txt'))).toBe(false);
  });

  it('refuses a staged rename instead of reporting a no-op success', async () => {
    setupGit(root, ['mv', 'src/app.ts', 'src/renamed.ts']);

    const result = await repo.discard(['src'], true);

    expect(result.ok).toBe(false);
    if (result.ok) throw new Error('expected a refusal');
    expect(result.stderr).toBe(`${STAGED_DISCARD_PREFIX}src/renamed.ts`);
    expect(existsSync(join(root, 'src', 'renamed.ts'))).toBe(true);
  });

  it('discards normally on an unborn branch, where HEAD does not exist', async () => {
    const unborn = mkdtempSync(join(tmpdir(), 'dispatch-unborn-'));
    setupGit(unborn, ['init', '-b', 'main']);
    writeFileSync(join(unborn, 'scratch.txt'), 'junk\n');

    const result = await new GitRepo(unborn).discard(['scratch.txt'], true);

    expect(result).toEqual({ ok: true });
    expect(existsSync(join(unborn, 'scratch.txt'))).toBe(false);
    rmSync(unborn, { recursive: true, force: true });
  });
});
