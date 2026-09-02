#!/usr/bin/env bun
//
// Worktree command suite for this monorepo.
//
//   moonx root:wt -- new <slug> [--branch <name>] [--base <ref>]
//   moonx root:wt -- setup [<slug>]
//   moonx root:wt -- rm <slug> [--keep-branch] [--force]
//   moonx root:wt -- clean [<slug>|--all]
//   moonx root:wt -- ps
//   moonx root:wt -- list
//
// Design notes:
//
// - Worktrees live at ../dispatch-worktrees/<dir> (a sibling of the main
//   clone, resolved from the main clone's own location rather than the
//   current worktree — see `resolveWorktreesHome`) where <dir> is the slug
//   with '/' replaced by '-'. Each worktree owns a port offset stored in
//   <worktree>/.env.worktree.
// - THE OFFSET IS RECORDED AND REPORTED, NOT YET ENFORCED. `wt new` allocates
//   an unused offset and writes it; `wt ps` and `wt list` report the ports it
//   implies and whether anything is actually LISTENing on them. But no dev
//   server reads DISPATCH_PORT_OFFSET today — apps/desktop/vite.config.ts
//   pins 5173 (src-tauri/tauri.conf.json's devUrl depends on that exact port),
//   packages/web/vite.config.ts takes vite's default, and apps/site/server.ts
//   reads only PORT. None of the moon dev tasks set `envFile` either. So two
//   worktrees running `moonx desktop:dev` still collide on 5173, and `wt ps`
//   reports on ports nothing binds. Closing this means picking up the offset
//   in those three configs (and adding `envFile: '.env.worktree'` to the dev
//   tasks); until then treat the offsets as a reservation ledger, not a
//   guarantee.
// - Discovery is stateless: `git worktree list --porcelain` is the source of
//   truth. Each worktree's own `.env.worktree` is the source of truth for its
//   offset. There is no central registry.
// - Agent-created worktrees (e.g. under .omx/worktrees/, /private/tmp/dispatch-*)
//   have no `.env.worktree`; they are visible to `wt list`/`wt ps` but they
//   don't claim offsets and are skipped by `wt clean --all`.

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

// Ports registered here are the repo's own dev servers. `desktop` is Vite's
// dev server for apps/desktop (see apps/desktop/src-tauri/tauri.conf.json's
// `devUrl`, which pins it to 5173). `site` is apps/site/server.ts's static
// server; it only takes its port from the `PORT` env var (default 3000), so
// this registers that default rather than a hardcoded constant elsewhere.
const PORT_BASES = {
  desktop: 5173,
  site: 3000,
} as const;

type PortMap = Record<keyof typeof PORT_BASES, number>;

interface Worktree {
  path: string;
  branch: string | null;
  head: string | null;
  /** Null for worktrees that don't participate in our offset system (main clone, agent worktrees). */
  offset: number | null;
  /** Null when no `.env.worktree` / no claimed slug. */
  slug: string | null;
  /** True if this is the primary (non-linked) worktree — i.e. the main clone. */
  isMain: boolean;
}

export interface SetupWorktreeOptions {
  /** Directory inside the worktree to initialize. Defaults to the current working directory. */
  path?: string;
  /** Slug to write into `.env.worktree`. Defaults to the existing env slug or worktree directory name. */
  slug?: string;
  /** Run `pnpm install` in the worktree after writing `.env.worktree`. Defaults to true. */
  install?: boolean;
  /** Print the port summary and cd command after setup. Defaults to true. */
  printSummary?: boolean;
}

export interface SetupWorktreeResult {
  path: string;
  slug: string;
  offset: number;
}

// -----------------------------------------------------------------------------
// Entry point
// -----------------------------------------------------------------------------

const commands: Record<string, (rest: string[]) => Promise<number> | number> = {
  new: cmdNew,
  setup: cmdSetup,
  rm: cmdRm,
  clean: cmdClean,
  ps: cmdPs,
  list: cmdList,
  help: cmdHelp,
  '--help': cmdHelp,
  '-h': cmdHelp,
};

if (import.meta.main) {
  const args = process.argv.slice(2);
  const sub = args[0];

  if (!sub || !(sub in commands)) {
    cmdHelp();
    process.exit(sub ? 1 : 0);
  }

  Promise.resolve(commands[sub](args.slice(1))).then(
    (code) => process.exit(code ?? 0),
    (err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    }
  );
}

function cmdHelp(): number {
  console.log(`Usage: moonx root:wt -- <subcommand> [args]

Subcommands:
  new <slug> [--branch <name>] [--base <ref>]
      Create a new worktree at ../dispatch-worktrees/<slug>.
      Branch defaults to "$USER/<slug>", cut from local main. --branch
      attaches an existing branch.
      --base selects the starting ref (default: main).

  setup [<slug>]
      Run post-add setup for an existing worktree: write .env.worktree,
      run pnpm install, and print the worktree's ports. With <slug>, targets
      ../dispatch-worktrees/<slug>. Without <slug>, targets the current
      linked worktree.

  rm <slug> [--keep-branch] [--force]
      Kill any processes bound to the worktree's ports, then remove it.
      --force passes --force through to git worktree remove.

  clean [<slug>|--all]
      Kill processes bound to a worktree's expected ports. Without arguments
      or with --all, does this for every managed worktree.

  ps  List every worktree with per-service port status (LISTEN / —).
  list  One-line-per-worktree summary.
`);
  return 0;
}

// -----------------------------------------------------------------------------
// wt new
// -----------------------------------------------------------------------------

async function cmdNew(rest: string[]): Promise<number> {
  const { slug, branch: branchOverride, base } = parseNewArgs(rest);
  if (!slug) {
    console.error('wt new: missing <slug>');
    return 1;
  }

  const worktreesHome = resolveWorktreesHome();
  const user = userInfo().username;
  const branch = branchOverride ?? `${user}/${slug}`;
  const dirName = slugify(slug);
  const worktreePath = join(worktreesHome, dirName);

  if (existsSync(worktreePath)) {
    console.error(`wt new: ${worktreePath} already exists`);
    return 1;
  }

  const worktrees = enumerateWorktrees();
  for (const wt of worktrees) {
    if (wt.branch === `refs/heads/${branch}` || wt.branch === branch) {
      console.error(
        `wt new: branch ${branch} is already checked out at ${wt.path}`
      );
      return 1;
    }
  }

  mkdirSync(worktreesHome, { recursive: true });

  // Decide how to invoke `git worktree add`:
  //   - If --branch was passed, the branch may already exist locally: use
  //     `git worktree add <path> <branch>` (no -b).
  //   - Otherwise create a new branch rooted at <base> (default: local main):
  //     `git worktree add -b <branch> <path> <base>`.
  const gitArgs = branchOverride
    ? ['worktree', 'add', worktreePath, branch]
    : ['worktree', 'add', '-b', branch, worktreePath, base ?? 'main'];

  const gitResult = spawnSync('git', gitArgs, { stdio: 'inherit' });
  if (gitResult.status !== 0) {
    return gitResult.status ?? 1;
  }

  await setupWorktree({ path: worktreePath, slug });
  return 0;
}

function parseNewArgs(rest: string[]): {
  slug?: string;
  branch?: string;
  base?: string;
} {
  let slug: string | undefined;
  let branch: string | undefined;
  let base: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const a = rest[i];
    if (a === '--branch') {
      branch = rest[++i];
    } else if (a === '--base') {
      base = rest[++i];
    } else if (!slug && !a.startsWith('--')) {
      slug = a;
    }
  }
  return { slug, branch, base };
}

// -----------------------------------------------------------------------------
// wt setup
// -----------------------------------------------------------------------------

async function cmdSetup(rest: string[]): Promise<number> {
  const slug = rest.find((a) => !a.startsWith('--'));
  const path = slug
    ? join(resolveWorktreesHome(), slugify(slug))
    : process.cwd();
  await setupWorktree({ path, slug });
  return 0;
}

// Initialize the generated worktree metadata and dependencies for a linked
// worktree. The path-first shape lets other scripts call this after they have
// already changed into the worktree they created.
export async function setupWorktree(
  options: SetupWorktreeOptions = {}
): Promise<SetupWorktreeResult> {
  const inputPath = resolve(options.path ?? process.cwd());
  const worktreeRoot = resolveGitWorktreeRoot(inputPath);
  const worktrees = enumerateWorktrees(worktreeRoot);
  const worktree = findWorktreeByPath(worktrees, worktreeRoot);

  if (!worktree) {
    throw new Error(
      `wt setup: ${worktreeRoot} is not listed as a git worktree`
    );
  }
  if (worktree.isMain) {
    throw new Error('wt setup: refusing to initialize the main clone');
  }

  const envPath = join(worktreeRoot, '.env.worktree');
  const existingEnv = existsSync(envPath) ? parseEnvFile(envPath) : {};
  const slug =
    options.slug ??
    existingEnv.DISPATCH_WORKTREE_SLUG ??
    basename(worktreeRoot);
  const existingOffset = parseOffset(existingEnv.DISPATCH_PORT_OFFSET);
  const offset =
    existingOffset ??
    allocateOffset(
      slug,
      worktrees.map((w) => w.offset).filter((o): o is number => o !== null)
    );

  const envText = `DISPATCH_WORKTREE_SLUG=${slug}\nDISPATCH_PORT_OFFSET=${offset}\n`;
  if (!existsSync(envPath) || readFileSync(envPath, 'utf8') !== envText) {
    writeFileSync(envPath, envText, 'utf8');
  }

  if (options.install ?? true) {
    console.log(`\nInstalling dependencies in ${worktreeRoot}...`);
    const pnpmInstall = spawnSync('pnpm', ['install'], {
      cwd: worktreeRoot,
      stdio: 'inherit',
    });
    if (pnpmInstall.status !== 0) {
      throw new Error(
        'wt setup: pnpm install failed; the worktree may be incomplete'
      );
    }
  }

  if (options.printSummary ?? true) {
    printPortMap(slug, offset, worktreeRoot);
  }

  return { path: worktreeRoot, slug, offset };
}

// -----------------------------------------------------------------------------
// wt rm
// -----------------------------------------------------------------------------

function cmdRm(rest: string[]): number {
  const keepBranch = rest.includes('--keep-branch');
  const force = rest.includes('--force');
  const slug = rest.find((a) => !a.startsWith('--'));
  if (!slug) {
    console.error('wt rm: missing <slug>');
    return 1;
  }

  const wt = findWorktreeBySlug(slug);
  if (!wt) {
    console.error(`wt rm: no managed worktree with slug "${slug}"`);
    return 1;
  }

  killWorktreePorts(wt);

  const removeArgs = ['worktree', 'remove'];
  if (force) removeArgs.push('--force');
  removeArgs.push(wt.path);
  const removeResult = spawnSync('git', removeArgs, { stdio: 'inherit' });
  if (removeResult.status !== 0) {
    return removeResult.status ?? 1;
  }

  if (!keepBranch && wt.branch) {
    const branchName = wt.branch.replace(/^refs\/heads\//, '');
    // `git branch -d` is safe: it refuses to delete unmerged branches.
    const del = spawnSync('git', ['branch', '-d', branchName], {
      stdio: 'pipe',
      encoding: 'utf8',
    });
    if (del.status === 0) {
      console.log(`Deleted branch ${branchName} (was merged).`);
    } else {
      console.log(
        `Left branch ${branchName} in place (${del.stderr.trim() || 'unmerged'}).`
      );
    }
  }

  return 0;
}

// -----------------------------------------------------------------------------
// wt clean
// -----------------------------------------------------------------------------

function cmdClean(rest: string[]): number {
  const all = rest.length === 0 || rest.includes('--all');
  const targets: Worktree[] = [];
  if (all) {
    for (const wt of enumerateWorktrees()) {
      if (wt.offset !== null || wt.isMain) targets.push(wt);
    }
  } else {
    const slug = rest.find((a) => !a.startsWith('--'));
    if (!slug) {
      console.error('wt clean: missing <slug> (or pass --all)');
      return 1;
    }
    const wt = findWorktreeBySlug(slug);
    if (!wt) {
      console.error(`wt clean: no managed worktree with slug "${slug}"`);
      return 1;
    }
    targets.push(wt);
  }

  for (const wt of targets) {
    killWorktreePorts(wt);
  }
  return 0;
}

// -----------------------------------------------------------------------------
// wt ps
// -----------------------------------------------------------------------------

function cmdPs(): number {
  const worktrees = enumerateWorktrees();
  const services: Array<[keyof typeof PORT_BASES, string]> = [
    ['desktop', 'desktop'],
    ['site', 'site'],
  ];

  const header = [
    padRight('worktree', 28),
    padRight('offset', 8),
    ...services.map(([, label]) => padRight(label, 14)),
  ].join(' ');
  console.log(header);
  console.log('-'.repeat(header.length));

  for (const wt of worktrees) {
    const label =
      wt.slug ?? (wt.isMain ? '(main)' : `(unmanaged:${basename(wt.path)})`);
    const offsetCell = wt.offset === null ? '—' : String(wt.offset);
    const portMap = wt.offset === null ? null : resolvePortMap(wt.offset);
    const cells = services.map(([key]) => {
      if (!portMap) return padRight('—', 14);
      const port = portMap[key];
      const pid = pidOnPort(port);
      return padRight(pid ? `${port}:${pid}` : `${port}`, 14);
    });
    console.log(
      [padRight(label, 28), padRight(offsetCell, 8), ...cells].join(' ')
    );
  }
  return 0;
}

// -----------------------------------------------------------------------------
// wt list
// -----------------------------------------------------------------------------

function cmdList(): number {
  for (const wt of enumerateWorktrees()) {
    const offset = wt.offset === null ? '—' : String(wt.offset);
    const slug = wt.slug ?? (wt.isMain ? '(main)' : '(unmanaged)');
    const branch = wt.branch
      ? wt.branch.replace(/^refs\/heads\//, '')
      : '(detached)';
    console.log(
      `${padRight(slug, 28)} offset=${padRight(offset, 4)} ${padRight(branch, 40)} ${wt.path}`
    );
  }
  return 0;
}

// -----------------------------------------------------------------------------
// Shared helpers
// -----------------------------------------------------------------------------

// Worktrees always live beside the *main* clone, not beside whichever
// worktree happens to be running this script. `git rev-parse
// --git-common-dir` resolves to the main clone's `.git` directory even when
// invoked from a linked worktree, so this is stable regardless of cwd.
function resolveWorktreesHome(): string {
  const result = spawnSync(
    'git',
    ['rev-parse', '--path-format=absolute', '--git-common-dir'],
    { cwd: process.cwd(), encoding: 'utf8' }
  );
  if (result.status !== 0) {
    throw new Error(`wt: could not resolve the main clone:\n${result.stderr}`);
  }
  const mainRepoRoot = dirname(result.stdout.trim());
  return resolve(mainRepoRoot, '..', 'dispatch-worktrees');
}

// Parse `git worktree list --porcelain`. Each record is terminated by a blank
// line. Fields we care about: `worktree <path>`, `HEAD <sha>`, `branch
// refs/heads/<name>` (or `detached`).
function enumerateWorktrees(cwd = process.cwd()): Worktree[] {
  const result = spawnSync(
    'git',
    ['-C', cwd, 'worktree', 'list', '--porcelain'],
    {
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`git worktree list failed:\n${result.stderr}`);
  }

  const records: Worktree[] = [];
  let current: Partial<Worktree> & { path?: string } = {};
  let primarySeen = false;
  const flush = () => {
    if (!current.path) return;
    const path = current.path;
    const isMain = !primarySeen;
    primarySeen = true;
    const envPath = join(path, '.env.worktree');
    let offset: number | null = null;
    let slug: string | null = null;
    if (existsSync(envPath)) {
      try {
        const parsed = parseEnvFile(envPath);
        if (parsed.DISPATCH_PORT_OFFSET !== undefined) {
          const n = Number(parsed.DISPATCH_PORT_OFFSET);
          if (Number.isFinite(n)) offset = n;
        }
        if (parsed.DISPATCH_WORKTREE_SLUG !== undefined) {
          slug = parsed.DISPATCH_WORKTREE_SLUG;
        }
      } catch {
        // Malformed env file; treat as unmanaged.
      }
    }
    records.push({
      path,
      branch: current.branch ?? null,
      head: current.head ?? null,
      offset,
      slug,
      isMain,
    });
    current = {};
  };

  for (const rawLine of result.stdout.split('\n')) {
    const line = rawLine.trim();
    if (line === '') {
      flush();
      continue;
    }
    if (line.startsWith('worktree ')) {
      current.path = line.slice('worktree '.length);
    } else if (line.startsWith('HEAD ')) {
      current.head = line.slice('HEAD '.length);
    } else if (line.startsWith('branch ')) {
      current.branch = line.slice('branch '.length);
    }
  }
  flush();
  return records;
}

function findWorktreeBySlug(slug: string): Worktree | undefined {
  return enumerateWorktrees().find((w) => w.slug === slug);
}

function findWorktreeByPath(
  worktrees: Worktree[],
  path: string
): Worktree | undefined {
  const targetPath = resolve(path);
  return worktrees.find((w) => resolve(w.path) === targetPath);
}

function resolveGitWorktreeRoot(path: string): string {
  const result = spawnSync(
    'git',
    ['-C', path, 'rev-parse', '--show-toplevel'],
    {
      encoding: 'utf8',
    }
  );
  if (result.status !== 0) {
    throw new Error(`wt setup: ${path} is not inside a git worktree`);
  }
  return resolve(result.stdout.trim());
}

function parseOffset(value: string | undefined): number | null {
  if (value === undefined) return null;
  const offset = Number(value);
  return Number.isFinite(offset) ? offset : null;
}

// Stable, deterministic offset candidate from slug. Steps by 10 so ports in
// adjacent slots (e.g. desktop=5173 and site=3000) never overlap across
// worktrees. Main clone is offset 0 — reserved, never allocated to a worktree.
function allocateOffset(slug: string, inUse: number[]): number {
  const taken = new Set<number>(inUse);
  taken.add(0);
  let hash = 0;
  for (let i = 0; i < slug.length; i++) {
    hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  }
  let offset = ((hash % 10) + 1) * 10; // starts at 10, wraps through 100
  for (let i = 0; i < 100; i++) {
    if (!taken.has(offset)) return offset;
    offset += 10;
  }
  throw new Error('wt new: could not allocate a free port offset');
}

function resolvePortMap(offset: number): PortMap {
  const out: Partial<PortMap> = {};
  for (const key of Object.keys(PORT_BASES) as (keyof typeof PORT_BASES)[]) {
    out[key] = PORT_BASES[key] + offset;
  }
  return out as PortMap;
}

// Find listener PIDs for `port`, SIGTERM them, wait, then SIGKILL survivors.
function killPorts(ports: number[]): void {
  for (const port of ports) {
    const pids = pidsOnPort(port);
    if (pids.length === 0) continue;
    console.log(`[wt clean] port ${port}: killing ${pids.join(', ')}`);
    spawnSync('kill', ['-TERM', ...pids.map(String)], { stdio: 'ignore' });
  }
  // Single shared pause, then kill survivors.
  if (ports.some((p) => pidsOnPort(p).length > 0)) {
    spawnSync('sleep', ['0.3']);
  }
  for (const port of ports) {
    const survivors = pidsOnPort(port);
    if (survivors.length === 0) continue;
    console.log(`[wt clean] port ${port}: SIGKILL ${survivors.join(', ')}`);
    spawnSync('kill', ['-KILL', ...survivors.map(String)], { stdio: 'ignore' });
  }
}

// The main clone has no `.env.worktree` and therefore no offset, but it still
// owns the default ports (offset 0). Treat it as offset 0 so `wt clean` on the
// main clone terminates stale servers on 5173/3000.
function killWorktreePorts(wt: Worktree): void {
  const offset = wt.offset ?? (wt.isMain ? 0 : null);
  if (offset === null) return;
  killPorts(Object.values(resolvePortMap(offset)));
}

function pidsOnPort(port: number): number[] {
  const r = spawnSync('lsof', ['-ti', `:${port}`, '-sTCP:LISTEN'], {
    encoding: 'utf8',
  });
  if (r.status !== 0) return [];
  return r.stdout
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => Number.isFinite(n));
}

function pidOnPort(port: number): number | null {
  const pids = pidsOnPort(port);
  return pids[0] ?? null;
}

function parseEnvFile(path: string): Record<string, string> {
  const text = readFileSync(path, 'utf8');
  const out: Record<string, string> = {};
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

function slugify(input: string): string {
  return input.replace(/[/\\]+/g, '-').replace(/^-+|-+$/g, '');
}

function padRight(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function printPortMap(slug: string, offset: number, path: string): void {
  const ports = resolvePortMap(offset);
  console.log(`
Worktree: ${slug} (offset ${offset})
  desktop dev: http://localhost:${ports.desktop}
  site dev:    http://localhost:${ports.site}

cd ${path}
`);
}
