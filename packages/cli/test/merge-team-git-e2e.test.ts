import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// Exercises `dispatch merge-team` through a real `git merge`, not just the
// pure mergeTeamFile() logic — proves the git config wiring (the driver
// name git actually invokes, %O/%A/%B argument order, the exit-code
// contract) works end to end, the same way mergeTask's driver was verified
// during development.

const CLI = resolve(import.meta.dirname, '../src/cli.ts');

function run(cwd: string, args: string[]) {
  return spawnSync('git', args, { cwd, encoding: 'utf8' });
}

function initRepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'dispatch-team-merge-e2e-'));
  run(root, ['init', '-q']);
  run(root, ['config', 'user.email', 'test@example.com']);
  run(root, ['config', 'user.name', 'Test']);
  run(root, [
    'config',
    'merge.dispatch-team.name',
    'Dispatch team roster merge',
  ]);
  run(root, [
    'config',
    'merge.dispatch-team.driver',
    // Runs the CLI straight from source (bun executes TS natively) instead
    // of relying on a `dispatch` binary being on PATH.
    `bun ${CLI} merge-team %O %A %B`,
  ]);
  writeFileSync(
    join(root, '.gitattributes'),
    '.dispatch/team.yml merge=dispatch-team\n'
  );
  return root;
}

const roster = (...members: { handle: string; email: string }[]) =>
  `members:\n${members
    .map(
      (m) =>
        `  - handle: ${m.handle}\n    email: ${m.email}\n    displayName: ${m.handle}\n    emails: []`
    )
    .join('\n')}\n`;

function commitTeam(root: string, content: string, message: string) {
  writeFileSync(join(root, '.dispatch', 'team.yml'), content);
  run(root, ['add', '-A']);
  run(root, ['commit', '-q', '-m', message]);
}

describe('dispatch merge-team — real git merge', () => {
  it('keeps two concurrently self-registered members after a real merge', () => {
    const root = initRepo();
    spawnSync('mkdir', ['-p', join(root, '.dispatch')]);
    commitTeam(
      root,
      roster({ handle: 'wyat', email: 'wyat@example.com' }),
      'base'
    );

    const baseBranch = run(root, ['branch', '--show-current']).stdout.trim();
    run(root, ['switch', '-q', '-c', 'alice-branch']);
    commitTeam(
      root,
      roster(
        { handle: 'wyat', email: 'wyat@example.com' },
        { handle: 'alice', email: 'alice@example.com' }
      ),
      'alice joins'
    );

    run(root, ['switch', '-q', baseBranch]);
    run(root, ['switch', '-q', '-c', 'bob-branch', baseBranch]);
    commitTeam(
      root,
      roster(
        { handle: 'wyat', email: 'wyat@example.com' },
        { handle: 'bob', email: 'bob@example.com' }
      ),
      'bob joins'
    );

    const merge = run(root, ['merge', 'alice-branch', '--no-edit']);
    expect(merge.status).toBe(0);

    const merged = readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8');
    expect(merged).toContain('handle: wyat');
    expect(merged).toContain('handle: alice');
    expect(merged).toContain('handle: bob');
    expect(merged).not.toContain('<<<<<<<');
  });

  it('leaves conflict markers and a non-zero exit when the same member changes differently', () => {
    const root = initRepo();
    spawnSync('mkdir', ['-p', join(root, '.dispatch')]);
    commitTeam(
      root,
      roster({ handle: 'alice', email: 'alice-old@example.com' }),
      'base'
    );
    const baseBranch = run(root, ['branch', '--show-current']).stdout.trim();

    run(root, ['switch', '-q', '-c', 'ours-branch']);
    commitTeam(
      root,
      roster({ handle: 'alice', email: 'alice-ours@example.com' }),
      'ours changes email'
    );

    run(root, ['switch', '-q', baseBranch]);
    run(root, ['switch', '-q', '-c', 'theirs-branch', baseBranch]);
    commitTeam(
      root,
      roster({ handle: 'alice', email: 'alice-theirs@example.com' }),
      'theirs changes email'
    );

    run(root, ['switch', '-q', 'ours-branch']);
    const merge = run(root, ['merge', 'theirs-branch', '--no-edit']);
    expect(merge.status).not.toBe(0);

    const status = run(root, ['status', '--short']);
    expect(status.stdout).toContain('UU .dispatch/team.yml');

    const merged = readFileSync(join(root, '.dispatch', 'team.yml'), 'utf8');
    expect(merged).toContain('<<<<<<< ours');
    expect(merged).toContain('alice-ours@example.com');
    expect(merged).toContain('alice-theirs@example.com');
    expect(merged).toContain('>>>>>>> theirs');
  });
});
