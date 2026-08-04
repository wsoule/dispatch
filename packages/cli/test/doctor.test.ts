import { TaskStore } from '@dispatch/core';
import { beforeEach, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';

import { type CliContext, CliError } from '../src/context.js';
import { makeProgram } from '../src/program.js';

let root: string;
let lines: string[];
let ctx: CliContext;

async function run(...argv: string[]) {
  await makeProgram(ctx).parseAsync(argv, { from: 'user' });
}

// Scaffolds a fresh .dispatch/ project via the real `init` command, then
// drops the given files (paths relative to the project root) on top.
function writeProject(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  makeProgram({ cwd: dir, log: () => {} }).parse(['init'], { from: 'user' });
  for (const [path, content] of Object.entries(files)) {
    const full = join(dir, path);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

// Runs `doctor` against `root` with a capturing CliContext, returning the
// joined log output. carto is absent for these runs via the suite-wide
// DISPATCH_CARTO_DISABLED (test/setup.ts). A CliError from issues found is
// swallowed since these tests only assert on what got logged.
function runDoctor(root: string) {
  const out: string[] = [];
  try {
    makeProgram({ cwd: root, log: (l) => out.push(l) }).parse(['doctor'], {
      from: 'user',
    });
  } catch {
    // doctor throws CliError when issues are found; irrelevant here
  }
  return out.join('\n');
}

// Puts a discoverable `carto` stub on PATH for the duration of `fn`: it
// answers `--version` with 2.1.4 and `doctor --json` with `health`, so the
// health-reporting tests prove doctor's own decision rather than whatever
// carto the machine running them happens to have. test/setup.ts's
// suite-wide DISPATCH_CARTO_DISABLED is lifted and restored around it.
function withStubCarto<T>(health: string, fn: () => T): T {
  const binDir = mkdtempSync(join(tmpdir(), 'dispatch-carto-bin-'));
  const stub = join(binDir, 'carto');
  writeFileSync(
    stub,
    `#!/bin/sh\nif [ "$1" = "--version" ]; then\n  echo "carto-md 2.1.4"\nelse\n  cat <<'CARTO_JSON'\n${health}\nCARTO_JSON\nfi\n`
  );
  chmodSync(stub, 0o755);
  const originalPath = process.env.PATH;
  const originalDisabled = process.env.DISPATCH_CARTO_DISABLED;
  process.env.PATH = `${binDir}${delimiter}${originalPath ?? ''}`;
  delete process.env.DISPATCH_CARTO_DISABLED;
  try {
    return fn();
  } finally {
    process.env.PATH = originalPath;
    if (originalDisabled !== undefined) {
      process.env.DISPATCH_CARTO_DISABLED = originalDisabled;
    }
    rmSync(binDir, { recursive: true, force: true });
  }
}

beforeEach(async () => {
  root = mkdtempSync(join(tmpdir(), 'dispatch-cli-'));
  lines = [];
  ctx = { cwd: root, log: (l) => lines.push(l) };
  await run('init');
});

describe('doctor', () => {
  it('reports ok on a healthy tracker', async () => {
    await run('task', 'create', 'Fine');
    lines = [];
    await run('doctor');
    expect(lines.join('\n')).toMatch(/ok — 1 task/);
  });
  it('flags unparsable files and dangling references', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    writeFileSync(join(root, '.dispatch/tasks/broken.md'), 'not a task file');
    await expect(run('doctor')).rejects.toThrow(/2 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.ok).toBe(false);
    expect(report.issues).toHaveLength(2);
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/missing frontmatter/);
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/dangling blocked-by/);
  });
  it('reports malformed config as a clean CliError', async () => {
    await run('task', 'create', 'Fine');
    writeFileSync(join(root, '.dispatch/config.yml'), 'statuses: [a\n');
    await expect(run('doctor')).rejects.toThrow(CliError);
    await expect(run('doctor')).rejects.toThrow(
      /invalid \.dispatch\/config\.yml/
    );
  });
  it('flags duplicate ids across files', async () => {
    await run('task', 'create', 'Only one id');
    const tasksDir = join(root, '.dispatch/tasks');
    const [original] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const id = original.split('-').slice(0, 2).join('-');
    const contents = readFileSync(join(tasksDir, original), 'utf8');
    writeFileSync(join(tasksDir, `${id}-copy.md`), contents);
    lines = [];
    await expect(run('doctor')).rejects.toThrow(/1 issue/);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(
      report.issues.map((i: { problem: string }) => i.problem).join(' ')
    ).toMatch(/duplicate id/);
  });

  it('flags an unparsable created/updated timestamp', async () => {
    await run('task', 'create', 'Bad stamp');
    const tasksDir = join(root, '.dispatch/tasks');
    const [file] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const contents = readFileSync(join(tasksDir, file), 'utf8');
    writeFileSync(
      join(tasksDir, file),
      contents.replace(/^created:.*$/m, 'created: not-a-date')
    );
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(
      'invalid created timestamp: not-a-date'
    );
  });

  it('flags a parent that is not an epic', async () => {
    await run('task', 'create', 'Sibling');
    const tasksDir = join(root, '.dispatch/tasks');
    const [sibling] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const siblingId = sibling.split('-').slice(0, 2).join('-');
    await run('task', 'create', 'Child', '--parent', siblingId);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(
      `parent is not an epic: ${siblingId}`
    );
  });

  it('does not flag a parent that is an epic', async () => {
    const epicOut: string[] = [];
    ctx.log = (l) => epicOut.push(l);
    await run('task', 'create', 'The epic', '--kind', 'epic', '--json');
    const epicId = JSON.parse(epicOut.join('\n')).meta.id;
    ctx.log = (l) => lines.push(l);
    await run('task', 'create', 'Child', '--parent', epicId);
    lines = [];
    await run('doctor');
    expect(lines.join('\n')).toMatch(/ok — 2 tasks/);
  });

  it('flags a blockedBy self-reference', async () => {
    await run('task', 'create', 'Self blocker');
    const tasksDir = join(root, '.dispatch/tasks');
    const [file] = readdirSync(tasksDir).filter((f) => f.endsWith('.md'));
    const id = file.split('-').slice(0, 2).join('-');
    await run('task', 'edit', id, '--add-blocked-by', id);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toBe(`blocked-by self-reference: ${id}`);
  });

  it('flags a dependency cycle across tasks', async () => {
    const out: string[] = [];
    ctx.log = (l) => out.push(l);
    await run('task', 'create', 'A', '--json');
    const idA = JSON.parse(out.pop() as string).meta.id;
    await run('task', 'create', 'B', '--json');
    const idB = JSON.parse(out.pop() as string).meta.id;
    ctx.log = (l) => lines.push(l);
    await run('task', 'edit', idA, '--add-blocked-by', idB);
    await run('task', 'edit', idB, '--add-blocked-by', idA);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toMatch(/^dependency cycle: /);
    expect(report.issues[0].problem).toContain(idA);
    expect(report.issues[0].problem).toContain(idB);
  });

  it('attributes issues to the on-disk filename', async () => {
    await run('task', 'create', 'Refs ghost', '--blocked-by', 't-ghost0');
    const files = readdirSync(join(root, '.dispatch/tasks')).filter((f) =>
      f.endsWith('.md')
    );
    expect(files).toHaveLength(1);
    lines = [];
    await expect(run('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(lines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].file).toMatch(/\.md$/);
    expect(report.issues[0].file).toBe(files[0]);
  });

  it('warns when the dependency map would be empty', () => {
    // A project with no TypeScript at all: the built-in scanner can only
    // ever return [], which is the silent-degradation case this warning
    // exists to expose.
    const root = writeProject({ 'main.go': 'package main\n' });
    const out = runDoctor(root);
    expect(out).toContain('dependency map');
  });

  // `carto --version` loads no native module, so an install whose bindings
  // never built reports a healthy version string while every `carto init`
  // dies. doctor therefore runs carto's own `doctor --json`, which does load
  // them.
  it('reports a carto whose native build is broken, with the fix carto itself suggests', () => {
    const root = writeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const out = withStubCarto(
      `{ "results": [ { "id": "native-tree-sitter", "status": "fail", "label": "Native module: tree-sitter", "detail": "failed: No native build was found", "fix": "Reinstall the package: npm install -g carto-md" } ], "ok": false }`,
      () => runDoctor(root)
    );
    expect(out).toContain('Native module: tree-sitter');
    expect(out).toContain('No native build was found');
    expect(out).toContain('Reinstall the package');
    expect(out).toContain('built-in dependency scanner');
  });

  it('stays quiet about health when the carto install works', () => {
    const root = writeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const out = withStubCarto(
      `{ "results": [ { "id": "native-tree-sitter", "status": "ok", "label": "Native module: tree-sitter", "detail": "loaded", "fix": null } ], "ok": true }`,
      () => runDoctor(root)
    );
    expect(out).toContain('carto 2.1.4 at ');
    expect(out).not.toContain('Native module');
    expect(out).not.toContain('built-in dependency scanner');
  });

  // A broken carto leaves the dependency map as empty as a missing one, so
  // on a repo the built-in scanner can't read either, the warning must still
  // fire — `discovery.ok` alone would suppress it.
  it('warns about an empty dependency map when carto is broken and there are no TypeScript sources', () => {
    const root = writeProject({ 'main.go': 'package main\n' });
    const out = withStubCarto(
      `{ "results": [ { "id": "native-tree-sitter", "status": "fail", "label": "Native module: tree-sitter", "detail": "failed", "fix": null } ], "ok": false }`,
      () => runDoctor(root)
    );
    expect(out).toContain('dependency map');
  });

  it('reports carto as absent without failing, and suppresses the empty-map warning when TypeScript is present', () => {
    const root = writeProject({ 'src/a.ts': 'export const a = 1;\n' });
    const out = runDoctor(root);
    expect(out).toContain('carto');
    expect(out).not.toContain('Error');
    // The install line must name the command that actually produces a working
    // native build; `bun install -g` never did.
    expect(out).toContain('npm install -g carto-md');
    expect(out).not.toContain('bun install -g');
    // TypeScript sources are present, so the built-in scanner isn't blind
    // here — the warning must NOT fire. This is the AND-conjunction in
    // doctor.ts's guard (`!discovery.ok && !hasTypeScriptSources(...)`);
    // without this assertion a regression to `!discovery.ok` alone would go
    // unnoticed, since the Go-project test above passes either way.
    expect(out).not.toContain('warning: no carto container');
  });
});

// Separate describe: the outer suite's `root` is never a real git repo, so
// the merge-driver check (which shells out to `git config`) never fires
// there — see the `existsSync(.git)` gate in doctor.ts.
describe('doctor — task-file merge driver', () => {
  let gitRoot: string;
  let gitLines: string[];
  let gitCtx: CliContext;

  async function runGit(...argv: string[]) {
    await makeProgram(gitCtx).parseAsync(argv, { from: 'user' });
  }

  beforeEach(async () => {
    gitRoot = mkdtempSync(join(tmpdir(), 'dispatch-cli-git-'));
    spawnSync('git', ['init', '-q'], { cwd: gitRoot });
    gitLines = [];
    gitCtx = { cwd: gitRoot, log: (l) => gitLines.push(l) };
  });

  it('is quiet once dispatch init has registered the driver', async () => {
    await runGit('init');
    gitLines = [];
    await runGit('doctor');
    expect(gitLines.join('\n')).toMatch(/ok — 0 tasks/);
  });

  it('flags the local git config as missing after init in another clone', async () => {
    await runGit('init');
    // Simulates a fresh clone: .gitattributes is committed and travels with
    // the repo, but the local (never-committed) git config does not.
    spawnSync(
      'git',
      ['config', '--local', '--unset', 'merge.dispatch-task.driver'],
      {
        cwd: gitRoot,
      }
    );
    gitLines = [];
    await expect(runGit('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(gitLines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toMatch(/merge\.dispatch-task/);
  });

  it('flags a missing .gitattributes line when dispatch init never wrote one', async () => {
    // Scaffold .dispatch/ directly (bypassing the CLI's `init`, which is
    // exactly what registers the driver) so doctor has a store to check
    // without the merge-driver setup it's meant to be flagging as absent.
    TaskStore.init(gitRoot);
    await expect(runGit('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(gitLines.join('\n'));
    expect(
      report.issues.some((i: { problem: string }) =>
        i.problem.includes('missing merge driver line')
      )
    ).toBe(true);
  });
});

// Mirrors the task-file suite above — team.yml's driver is reported the
// same way, just under its own git config key.
describe('doctor — team-roster merge driver', () => {
  let gitRoot: string;
  let gitLines: string[];
  let gitCtx: CliContext;

  async function runGit(...argv: string[]) {
    await makeProgram(gitCtx).parseAsync(argv, { from: 'user' });
  }

  beforeEach(() => {
    gitRoot = mkdtempSync(join(tmpdir(), 'dispatch-cli-git-'));
    spawnSync('git', ['init', '-q'], { cwd: gitRoot });
    gitLines = [];
    gitCtx = { cwd: gitRoot, log: (l) => gitLines.push(l) };
  });

  it('is quiet once dispatch init has registered the driver', async () => {
    await runGit('init');
    gitLines = [];
    await runGit('doctor');
    expect(gitLines.join('\n')).toMatch(/ok — 0 tasks/);
  });

  it('flags the local git config as missing after init in another clone', async () => {
    await runGit('init');
    spawnSync(
      'git',
      ['config', '--local', '--unset', 'merge.dispatch-team.driver'],
      { cwd: gitRoot }
    );
    gitLines = [];
    await expect(runGit('doctor', '--json')).rejects.toThrow(/1 issue/);
    const report = JSON.parse(gitLines.join('\n'));
    expect(report.issues).toHaveLength(1);
    expect(report.issues[0].problem).toMatch(/merge\.dispatch-team/);
  });

  it('flags a missing .gitattributes line when dispatch init never wrote one', async () => {
    TaskStore.init(gitRoot);
    await expect(runGit('doctor', '--json')).rejects.toThrow();
    const report = JSON.parse(gitLines.join('\n'));
    expect(
      report.issues.some((i: { problem: string }) =>
        i.problem.includes('missing team-roster merge driver line')
      )
    ).toBe(true);
  });
});
