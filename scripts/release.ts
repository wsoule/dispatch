#!/usr/bin/env bun
// Cuts a Dispatch release: bumps the version, commits, tags, pushes. The push
// of the tag is what triggers .github/workflows/release.yml (signed macOS
// builds, Linux packages, the updater manifest, the Homebrew cask bump).
//
//   moonx root:release -- 0.27.0 "one-line summary"            # for real
//   moonx root:release -- 0.27.0 "one-line summary" --dry-run  # checks only
//
// This script exists because the procedure lived in notes, the notes went
// stale, and a release was once cut from them wrong. The rules it encodes,
// verified against the v0.25.1 and v0.26.0 release commits:
//
// THE THREE-FILE RULE. The release version lives in exactly three files, and
// all three move together:
//   apps/desktop/src-tauri/tauri.conf.json   (the desktop app + updater)
//   apps/desktop/package.json
//   packages/cli/package.json
// Nothing else is touched. packages/core, packages/client and packages/mcp
// version independently for npm and are left alone. src-tauri/Cargo.toml
// stays at 0.1.0 — Tauri reads the version from tauri.conf.json, not Cargo.
//
// THE MESSAGE. Commit subject and annotated tag message are the same line:
//   chore(release): vX.Y.Z — <one-line summary>
// (an em dash, not a hyphen). The commit may carry a wrapped body describing
// the release (--body) and the repo's trailer lines (--trailer, repeatable;
// the agent-cut releases carry `Co-Authored-By: ...` and `Claude-Session:
// ...`). The tag is `vX.Y.Z`, annotated, message = the subject line only.
//
// THE ORDER. Every check runs before anything is written, and any failure
// aborts with nothing changed:
//   1. on main, clean tree (paths under .dispatch/ ignored), in sync with
//      origin/main after a fetch;
//   2. the new version parses, is strictly greater than the current one, and
//      the three files agree on the current one;
//   3. the tag exists neither locally nor on origin;
//   4. CI is green for HEAD: a completed, successful run of the `CI`
//      workflow for the exact HEAD sha on main;
//   5. bump, commit, tag, push main, push the tag — or, with --dry-run, print
//      the exact commands this step would run and stop.
// It ends by printing the Actions URL where the release workflow shows up.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The three files that carry the release version, relative to the repo root. */
export const VERSION_FILES = [
  'apps/desktop/src-tauri/tauri.conf.json',
  'apps/desktop/package.json',
  'packages/cli/package.json',
] as const;

const CI_WORKFLOW_NAME = 'CI';
const RELEASE_WORKFLOW_FILE = 'release.yml';

// ---------------------------------------------------------------------------
// Pure pieces (covered by release.test.ts)
// ---------------------------------------------------------------------------

/** Parses a strict `X.Y.Z` (no `v`, no pre-release suffix) into three ints. */
export function parseVersion(text: string): [number, number, number] | null {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(text.trim());
  if (m === null) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Numeric semver comparison: negative when a < b, zero when equal, positive
 * when a > b. Compares components as numbers so 0.10.0 sorts after 0.9.0 —
 * a string comparison would get that backwards. Throws on unparseable input
 * rather than guessing.
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (pa === null) throw new Error(`not a version: ${JSON.stringify(a)}`);
  if (pb === null) throw new Error(`not a version: ${JSON.stringify(b)}`);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

/**
 * Reads the top-level `"version"` string out of a JSON file's text without
 * parsing it, so the same line can later be rewritten in place.
 */
export function readVersionField(text: string): string | null {
  const m = /^(\s*)"version"\s*:\s*"([^"]*)"/m.exec(text);
  return m === null ? null : m[2];
}

/**
 * Rewrites the top-level `"version"` line of a JSON file's text to `next`,
 * touching nothing else — indentation, key order, trailing newline and the
 * rest of the file come through byte-for-byte. JSON.parse/stringify would
 * reflow every file, and tauri.conf.json is formatted differently from the
 * package.json files. Only the first `"version"` key is rewritten; the
 * top-level one comes first in all three files.
 */
export function bumpVersionField(text: string, next: string): string {
  const re = /^(\s*"version"\s*:\s*")([^"]*)(")/m;
  if (!re.test(text)) {
    throw new Error('no top-level "version" field to rewrite');
  }
  return text.replace(re, `$1${next}$3`);
}

/** The line shared by the commit subject and the annotated tag message. */
export function releaseSubject(version: string, summary: string): string {
  return `chore(release): v${version} — ${summary}`;
}

/**
 * Renders the full commit message: subject, an optional wrapped body, then
 * the trailer lines in their own paragraph so git recognises them as
 * trailers. Empty body and no trailers gives a subject-only message.
 */
export function renderCommitMessage(
  version: string,
  summary: string,
  options: { body?: string; trailers?: readonly string[] } = {}
): string {
  const paragraphs = [releaseSubject(version, summary)];
  const body = options.body?.trim();
  if (body) paragraphs.push(body);
  const trailers = (options.trailers ?? [])
    .map((t) => t.trim())
    .filter(Boolean);
  if (trailers.length > 0) paragraphs.push(trailers.join('\n'));
  return `${paragraphs.join('\n\n')}\n`;
}

export interface ReleaseArgs {
  version: string;
  summary: string;
  dryRun: boolean;
  body?: string;
  trailers: string[];
}

/** Parses `<version> <summary> [--dry-run] [--body text] [--trailer line]...`. */
export function parseArgs(argv: readonly string[]): ReleaseArgs {
  const positional: string[] = [];
  const trailers: string[] = [];
  let dryRun = false;
  let body: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '--dry-run') {
      dryRun = true;
    } else if (arg === '--body' || arg === '--trailer') {
      const value = argv[++i];
      if (value === undefined) throw new Error(`${arg} needs a value`);
      if (arg === '--body') body = value;
      else trailers.push(value);
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag ${arg}`);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length !== 2) {
    throw new Error(
      'usage: release.ts <version> "<one-line summary>" [--dry-run] [--body <text>] [--trailer <line>]...'
    );
  }
  const [version, summary] = positional as [string, string];
  if (parseVersion(version) === null) {
    throw new Error(
      `version must be X.Y.Z with no "v" prefix or suffix, got ${JSON.stringify(version)}`
    );
  }
  if (summary.trim() === '' || summary.includes('\n')) {
    throw new Error('summary must be a single non-empty line');
  }
  return { version, summary: summary.trim(), dryRun, body, trailers };
}

// ---------------------------------------------------------------------------
// Process helpers
// ---------------------------------------------------------------------------

/** Aborts the release. Nothing has been written when any check calls this. */
function refuse(message: string): never {
  console.error(`release: refusing — ${message}`);
  process.exit(1);
}

interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

// Runs a command from the repo root and returns its output; exit status is
// the caller's to check, since several checks *expect* a non-zero status
// (an absent tag, a clean diff).
function run(cmd: string, args: string[], env = process.env): RunResult {
  const res = spawnSync(cmd, args, { cwd: repoRoot, encoding: 'utf8', env });
  if (res.error) refuse(`could not run ${cmd}: ${res.error.message}`);
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? '',
    stderr: res.stderr ?? '',
  };
}

function git(...args: string[]): RunResult {
  return run('git', args);
}

// Runs a git command that must succeed and returns its trimmed stdout.
function gitOut(...args: string[]): string {
  const res = git(...args);
  if (res.status !== 0) {
    refuse(`git ${args.join(' ')} failed:\n${res.stderr.trim()}`);
  }
  return res.stdout.trim();
}

// Shell-quotes one argument for the dry-run transcript, which is meant to be
// copy-and-paste ready.
function shellQuote(arg: string): string {
  return /^[A-Za-z0-9_./:=@-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, `'\\''`)}'`;
}

function renderCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map(shellQuote).join(' ');
}

// ---------------------------------------------------------------------------
// Checks 1-4
// ---------------------------------------------------------------------------

// Check 1: on main, clean, and level with origin/main after a fresh fetch.
function checkBranchState(): string {
  const branch = gitOut('rev-parse', '--abbrev-ref', 'HEAD');
  if (branch !== 'main') {
    refuse(`must be on main, currently on ${branch}`);
  }
  // .dispatch/ is the daemon's working state; a live board edits it under
  // us and that is not a reason to hold a release.
  // Raw stdout, not gitOut: trimming would eat the leading space of a
  // ` M path` line and the path filter below would miss it.
  const status = git('status', '--porcelain', '--untracked-files=all');
  if (status.status !== 0)
    refuse(`git status failed:\n${status.stderr.trim()}`);
  const dirty = status.stdout
    .split('\n')
    .filter((line) => line !== '' && !/^.. "?\.dispatch\//.test(line));
  if (dirty.length > 0) {
    refuse(`working tree is not clean:\n${dirty.join('\n')}`);
  }
  const fetch = git('fetch', '--quiet', 'origin', 'main');
  if (fetch.status !== 0) {
    refuse(`git fetch origin main failed:\n${fetch.stderr.trim()}`);
  }
  const head = gitOut('rev-parse', 'HEAD');
  const remote = gitOut('rev-parse', 'origin/main');
  if (head !== remote) {
    refuse(
      `main is not in sync with origin/main (HEAD ${head.slice(0, 10)}, origin/main ${remote.slice(0, 10)}); pull or push first`
    );
  }
  return head;
}

// Check 2: the three files agree on the current version and the requested
// one is strictly higher. Returns each file's text for the later bump.
function checkVersions(next: string): Map<string, string> {
  const texts = new Map<string, string>();
  const current = new Map<string, string>();
  for (const file of VERSION_FILES) {
    const text = readFileSync(resolve(repoRoot, file), 'utf8');
    const version = readVersionField(text);
    if (version === null) refuse(`${file} has no top-level "version" field`);
    texts.set(file, text);
    current.set(file, version);
  }
  const distinct = new Set(current.values());
  if (distinct.size !== 1) {
    const listing = [...current].map(([f, v]) => `  ${f}: ${v}`).join('\n');
    refuse(
      `the three version files disagree; fix them by hand before releasing:\n${listing}`
    );
  }
  const [currentVersion] = distinct;
  if (parseVersion(currentVersion!) === null) {
    refuse(`current version ${JSON.stringify(currentVersion)} is not X.Y.Z`);
  }
  const cmp = compareVersions(next, currentVersion!);
  if (cmp <= 0) {
    refuse(
      `${next} is ${cmp === 0 ? 'the same as' : 'lower than'} the current version ${currentVersion}`
    );
  }
  console.log(
    `release: ${currentVersion} -> ${next} in ${VERSION_FILES.length} files`
  );
  return texts;
}

// Check 3: the tag is new on both ends.
function checkTagAbsent(tag: string): void {
  const local = git('rev-parse', '--quiet', '--verify', `refs/tags/${tag}`);
  if (local.status === 0) {
    refuse(
      `tag ${tag} already exists locally (${local.stdout.trim().slice(0, 10)})`
    );
  }
  const remote = git('ls-remote', '--tags', 'origin', `refs/tags/${tag}`);
  if (remote.status !== 0) {
    refuse(`git ls-remote origin failed:\n${remote.stderr.trim()}`);
  }
  if (remote.stdout.trim() !== '') {
    refuse(`tag ${tag} already exists on origin`);
  }
}

interface WorkflowRun {
  headSha: string;
  status: string;
  conclusion: string | null;
  workflowName: string;
  url?: string;
}

// Check 4: a completed, successful `CI` run exists for exactly HEAD.
// GITHUB_TOKEN in an agent shell is a public_repo-only token that 404s on
// this private repo, so gh runs without it and uses the keyring login.
function checkCiGreen(head: string): void {
  const env = { ...process.env };
  delete env.GITHUB_TOKEN;
  const res = run(
    'gh',
    [
      'run',
      'list',
      '--branch',
      'main',
      '--limit',
      '10',
      '--json',
      'headSha,status,conclusion,workflowName,url',
    ],
    env
  );
  if (res.status !== 0) {
    refuse(`gh run list failed:\n${res.stderr.trim()}`);
  }
  let runs: WorkflowRun[];
  try {
    runs = JSON.parse(res.stdout) as WorkflowRun[];
  } catch {
    refuse(`gh run list returned something other than JSON:\n${res.stdout}`);
  }
  const forHead = runs.filter(
    (r) => r.headSha === head && r.workflowName === CI_WORKFLOW_NAME
  );
  if (forHead.length === 0) {
    refuse(
      `no ${CI_WORKFLOW_NAME} run found for HEAD ${head.slice(0, 10)} in the last 10 runs on main; wait for CI or check the push landed`
    );
  }
  const green = forHead.find(
    (r) => r.status === 'completed' && r.conclusion === 'success'
  );
  if (green === undefined) {
    const states = forHead
      .map(
        (r) =>
          `${r.status}/${r.conclusion ?? 'pending'}${r.url ? ` ${r.url}` : ''}`
      )
      .join('\n  ');
    refuse(`CI is not green for HEAD ${head.slice(0, 10)}:\n  ${states}`);
  }
  console.log(
    `release: CI green for ${head.slice(0, 10)}${green.url ? ` (${green.url})` : ''}`
  );
}

// ---------------------------------------------------------------------------
// Step 5
// ---------------------------------------------------------------------------

function releaseWorkflowUrl(): string {
  const remote = gitOut('remote', 'get-url', 'origin');
  const m = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(remote);
  if (m === null)
    return `(origin ${remote} is not a GitHub remote; find the Release workflow by hand)`;
  return `https://github.com/${m[1]}/${m[2]}/actions/workflows/${RELEASE_WORKFLOW_FILE}`;
}

function main(): void {
  let args: ReleaseArgs;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    refuse(error instanceof Error ? error.message : String(error));
  }
  const { version, summary, dryRun } = args;
  const tag = `v${version}`;
  const subject = releaseSubject(version, summary);
  const message = renderCommitMessage(version, summary, {
    body: args.body,
    trailers: args.trailers,
  });

  const head = checkBranchState();
  const texts = checkVersions(version);
  checkTagAbsent(tag);
  checkCiGreen(head);

  const commands: Array<[string, string[]]> = [
    ['git', ['add', '--', ...VERSION_FILES]],
    ['git', ['commit', '--quiet', '-F', '-']],
    ['git', ['tag', '-a', tag, '-m', subject]],
    ['git', ['push', 'origin', 'main']],
    ['git', ['push', 'origin', tag]],
  ];

  if (dryRun) {
    console.log('\nrelease: dry run — every check passed. Would now:');
    console.log(`  rewrite "version" -> ${version} in:`);
    for (const file of VERSION_FILES) console.log(`    ${file}`);
    for (const [cmd, cmdArgs] of commands) {
      console.log(`  ${renderCommand(cmd, cmdArgs)}`);
    }
    console.log('\n  with commit message:');
    for (const line of message.trimEnd().split('\n'))
      console.log(`    | ${line}`);
    console.log(`\nThen watch: ${releaseWorkflowUrl()}`);
    return;
  }

  for (const file of VERSION_FILES) {
    writeFileSync(
      resolve(repoRoot, file),
      bumpVersionField(texts.get(file)!, version)
    );
  }
  for (const [cmd, cmdArgs] of commands) {
    console.log(`release: ${renderCommand(cmd, cmdArgs)}`);
    const res = spawnSync(cmd, cmdArgs, {
      cwd: repoRoot,
      encoding: 'utf8',
      stdio: ['pipe', 'inherit', 'inherit'],
      input: cmdArgs[0] === 'commit' ? message : undefined,
    });
    if (res.status !== 0) {
      refuse(
        `${renderCommand(cmd, cmdArgs)} exited ${res.status}. The tree may be partly released; inspect \`git status\`, \`git log -1\` and \`git tag -l ${tag}\` before retrying.`
      );
    }
  }
  console.log(`\nrelease: ${tag} pushed. Watch: ${releaseWorkflowUrl()}`);
}

if (import.meta.main) main();
