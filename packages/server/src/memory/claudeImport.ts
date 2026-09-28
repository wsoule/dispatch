import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import { untrustedInline } from '@dispatch/core';
import {
  cutUtf8,
  insertFresh,
  kindFromClaudeType,
  MEMORY_LIMITS,
  memoryContentHash,
  newMemoryEntry,
  parseMemoryFile,
  projectOnlyForClaudeType,
} from '@dispatch/memory';
import type {
  MemoryEntry,
  MemoryIds,
  MemoryKind,
  MemoryStore,
} from '@dispatch/memory';
import { LINE_BREAK } from '@dispatch/protocol';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { spawnGitSync } from '../blockingGit.js';
import { readMemoryTree } from './claudeExport.js';

interface ClaudeImportSource {
  dir: string;
  from: 'user' | 'managed' | 'project' | 'local' | 'default' | 'explicit';
}

export interface SourceSearch {
  found: ClaudeImportSource | null;
  // A repository's own settings named a directory, which the owner must confirm.
  needsConfirmation: boolean;
  candidates: string[];
}

export interface ClaudeImportReport {
  state: 'complete' | 'failed' | 'unconfirmed';
  source: string | null;
  imported: number;
  updated: number;
  unchanged: number;
  duplicates: number;
  tombstoned: number;
  problems: string[];
  candidates: string[];
}

type EffectiveSetting = { value: string; source: string } | null;

// Where the owner's Claude notes are looked for: a home directory, the env
// Claude Code reads, and the effective autoMemoryDirectory setting.
interface ClaudeImportEnv {
  home: string;
  env: Record<string, string | undefined>;
  resolveEffective?: (cwd: string) => Promise<EffectiveSetting>;
}

type ImportInput = Parameters<typeof importClaudeNotes>[0];

interface Note {
  origin: string;
  kind: MemoryKind;
  projectKey: string | null;
  title: string;
  body: string;
  createdAt: string;
}

const INDEX_FILE = 'MEMORY.md';
const ROLLBACK = Symbol('rollback');
// Every `[text](target)` link in a line; a `[` behind a backslash opens none.
const LINKS = /(?<!\\)\[((?:\\.|[^\\\][])*)\]\(([^()\s]*)\)/g;
const BULLET = /^(?:[-*+]|\d+[.)])[ \t]+/;
const HEADING = /^#{1,6}(?:[ \t]|$)/;
const UTC_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;

const stateKey = (projectKey: string): string => `claude-import:${projectKey}`;

const reportKey = (projectKey: string): string =>
  `claude-import-report:${projectKey}`;

const sha256 = (text: string): string =>
  createHash('sha256').update(text).digest('hex');

const nonEmpty = (value: string | undefined): string | undefined =>
  value === undefined || value.trim() === '' ? undefined : value;

/** Claude Code's project directory name: every character outside [A-Za-z0-9] becomes '-'. */
export function sanitizeProjectDirName(absolutePath: string): string {
  return absolutePath.replace(/[^A-Za-z0-9]/g, '-');
}

// The effective autoMemoryDirectory and the settings source that set it, as
// the CLI resolves them in `cwd`; an unnamed source reads as the repository's.
async function effectiveAutoMemoryDirectory(
  cwd: string
): Promise<EffectiveSetting> {
  const resolved = await resolveSettings({ cwd });
  const value = resolved.effective.autoMemoryDirectory;
  if (typeof value !== 'string' || value.trim() === '') return null;
  return {
    value,
    source: resolved.provenance.autoMemoryDirectory?.source ?? 'project',
  };
}

/**
 * The real home, env and Claude settings. A redirected DISPATCH_HOME stands in
 * for all three, so a test or sandboxed daemon never reads the real ~/.claude.
 */
export function claudeImportEnv(): ClaudeImportEnv {
  const redirected = process.env.DISPATCH_HOME;
  if (redirected !== undefined && redirected !== '')
    return { home: redirected, env: {} };
  return {
    home: homedir(),
    env: process.env,
    resolveEffective: effectiveAutoMemoryDirectory,
  };
}

/** The checkout every worktree of `rootDir` shares, which Claude Code names its project directory after. */
export function mainCheckoutOf(rootDir: string): string {
  const result = spawnGitSync(rootDir, [
    'rev-parse',
    '--path-format=absolute',
    '--git-common-dir',
  ]);
  const common = result.stdout.trim();
  return result.exitCode === 0 && common !== '' ? dirname(common) : rootDir;
}

function isDirectory(path: string): boolean {
  try {
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

// `~` and relative settings values, as Claude Code expands them.
function settingPath(value: string, home: string, rootDir: string): string {
  if (value === '~') return home;
  if (value.startsWith('~/')) return join(home, value.slice(2));
  return resolve(rootDir, value);
}

// Claude project directories that may hold this repository's notes: the name
// ends with the checkout's directory name or contains its whole path.
function candidateDirs(configDir: string, mainCheckout: string): string[] {
  const projects = join(configDir, 'projects');
  const tail = sanitizeProjectDirName(basename(mainCheckout));
  const whole = sanitizeProjectDirName(mainCheckout);
  let names: string[];
  try {
    names = readdirSync(projects).sort();
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith(tail) || name.includes(whole))
    .map((name) => join(projects, name, 'memory'))
    .filter(isDirectory);
}

// Claude Code's override for the project directory name, when it is one plain path segment.
function projectDirName(
  env: Record<string, string | undefined>
): string | undefined {
  const name = nonEmpty(env.CLAUDE_CODE_PROJECT_DIR_NAME);
  if (name === undefined || name === '.' || name === '..') return undefined;
  return /[/\\]/.test(name) ? undefined : name;
}

/**
 * Finds the owner's notes for this project: the effective autoMemoryDirectory
 * first (a repository's own settings only as a candidate to confirm), then
 * Claude Code's per-project directory under its config dir.
 */
export async function findClaudeMemorySource(input: {
  rootDir: string;
  mainCheckout: string;
  env: Record<string, string | undefined>;
  home: string;
  resolveEffective?: (cwd: string) => Promise<EffectiveSetting>;
}): Promise<SourceSearch> {
  const configDir =
    nonEmpty(input.env.CLAUDE_CONFIG_DIR) ?? join(input.home, '.claude');
  let effective: EffectiveSetting = null;
  try {
    effective = (await input.resolveEffective?.(input.rootDir)) ?? null;
  } catch (err) {
    console.error('memory: reading Claude Code settings failed', err);
  }
  if (effective !== null) {
    const dir = settingPath(effective.value, input.home, input.rootDir);
    if (effective.source === 'user' || effective.source === 'managed')
      return {
        found: { dir, from: effective.source },
        needsConfirmation: false,
        candidates: [],
      };
    const others = candidateDirs(configDir, input.mainCheckout);
    return {
      found: null,
      needsConfirmation: true,
      candidates: [dir, ...others.filter((c) => c !== dir)],
    };
  }
  const name =
    projectDirName(input.env) ?? sanitizeProjectDirName(input.mainCheckout);
  const dir = join(configDir, 'projects', name, 'memory');
  if (exists(dir))
    return {
      found: { dir, from: 'default' },
      needsConfirmation: false,
      candidates: [],
    };
  return {
    found: null,
    needsConfirmation: false,
    candidates: candidateDirs(configDir, input.mainCheckout),
  };
}

// Why an explicit --from is refused, or null: it must be absolute, lie under
// the home directory once resolved, and be reached through no symlink.
function refuseExplicit(from: string, home: string): string | null {
  if (!isAbsolute(from)) return `${from}: --from must be an absolute path`;
  const path = resolve(from);
  let real: string;
  try {
    real = realpathSync(path);
  } catch {
    return `${from}: --from does not exist or cannot be read`;
  }
  let realHome = home;
  try {
    realHome = realpathSync(home);
  } catch {
    // A home that will not resolve is compared as given.
  }
  if (real !== realHome && !real.startsWith(`${realHome}${sep}`))
    return `${from}: --from must lie under the home directory`;
  // Components above the home are the system's, so only those below it are checked.
  const stop = path === home || path.startsWith(`${home}${sep}`) ? home : null;
  for (let at = path; at !== stop && at !== dirname(at); at = dirname(at)) {
    try {
      if (lstatSync(at).isSymbolicLink())
        return `${from}: --from is reached through a symlink (${at})`;
    } catch {
      return `${from}: --from does not exist or cannot be read`;
    }
  }
  return null;
}

// A note's creation time: its frontmatter stamp, else the file's mtime.
function createdAtOf(
  modified: string | undefined,
  path: string,
  fallback: string
): string {
  if (modified !== undefined) {
    if (UTC_STAMP.test(modified) && !Number.isNaN(Date.parse(modified)))
      return modified;
    const ms = Date.parse(modified);
    if (!Number.isNaN(ms)) return new Date(ms).toISOString();
  }
  try {
    return lstatSync(path).mtime.toISOString();
  } catch {
    return fallback;
  }
}

// A MEMORY.md link target as a path relative to the notes directory.
function linkTarget(raw: string): string {
  const bare = raw.replace(/^<|>$/g, '').replace(/#.*$/, '');
  let decoded = bare;
  try {
    decoded = decodeURIComponent(bare);
  } catch {
    // A malformed escape is matched as written.
  }
  return decoded.replace(/^\.\//, '');
}

const unescapeLinkText = (text: string): string =>
  text.replace(/\\([\\[\]])/g, '$1');

// Reads MEMORY.md: each file's first link text titles it, and every other
// line (links to no file here, not blank, not a heading) is a fact.
function readIndex(
  text: string,
  files: ReadonlySet<string>
): { linkText: Map<string, string>; lines: string[] } {
  const linkText = new Map<string, string>();
  const lines = new Set<string>();
  for (const raw of text.split(LINE_BREAK)) {
    const line = raw.trim();
    if (line === '' || HEADING.test(line)) continue;
    let linked = false;
    for (const match of line.matchAll(LINKS)) {
      const file = linkTarget(match[2]);
      if (!files.has(file)) continue;
      linked = true;
      if (!linkText.has(file)) linkText.set(file, unescapeLinkText(match[1]));
    }
    if (!linked) lines.add(line);
  }
  return { linkText, lines: [...lines] };
}

// A MEMORY.md line as a title: no bullet, each link reduced to its text.
function lineTitle(line: string): string {
  const text = line
    .replace(BULLET, '')
    .replace(LINKS, (_, label: string) => unescapeLinkText(label));
  return cutUtf8(untrustedInline(text), MEMORY_LIMITS.titleBytes).trim();
}

// Title and body as the entry was last imported, so a Dispatch-side edit is
// never mistaken for a change to the file.
function lastImported(
  store: MemoryStore,
  entry: MemoryEntry
): Pick<MemoryEntry, 'title' | 'body'> {
  const revision = store
    .revisions(entry.id)
    .findLast((r) => r.cause === 'import');
  return revision?.snapshot ?? entry;
}

// A cross-project note already imported, with the same content, from another project.
function importedElsewhere(
  store: MemoryStore,
  note: Note,
  projectKey: string
): boolean {
  const hash = memoryContentHash({ ...note, refs: [] });
  return store
    .entriesByContentHash(hash, ['personal'])
    .some(
      (e) =>
        e.origin !== null &&
        e.origin.startsWith('claude:') &&
        !e.origin.startsWith(`claude:${projectKey}/`)
    );
}

// Every topic file, then every MEMORY.md line that links to no file, as the entries they become.
function notesOf(
  dir: string,
  tree: ReturnType<typeof readMemoryTree>,
  projectKey: string,
  at: string
): Note[] {
  const files = new Set(tree.files.map((f) => f.file));
  const { linkText, lines } = readIndex(tree.index ?? '', files);
  const notes: Note[] = [];
  for (const { file } of tree.files) {
    const parsed = parseMemoryFile(tree.text.get(file) ?? '', basename(file), {
      linkText: linkText.get(file),
    });
    notes.push({
      origin: `claude:${projectKey}/${file}`,
      kind: kindFromClaudeType(parsed.type),
      projectKey: projectOnlyForClaudeType(parsed.type) ? projectKey : null,
      title: parsed.title,
      body: parsed.body,
      createdAt: createdAtOf(parsed.modified, join(dir, file), at),
    });
  }
  const indexAt = createdAtOf(undefined, join(dir, INDEX_FILE), at);
  for (const line of lines) {
    const title = lineTitle(line);
    if (!/[\p{L}\p{N}]/u.test(title)) continue;
    notes.push({
      origin: `claude:${projectKey}/${INDEX_FILE}#${sha256(line).slice(0, 12)}`,
      kind: kindFromClaudeType(undefined),
      projectKey: null,
      title,
      body: '',
      createdAt: indexAt,
    });
  }
  return notes;
}

// Writes the notes into the store in one transaction; a dry run counts, then rolls back.
function applyNotes(
  input: ImportInput,
  notes: readonly Note[],
  report: ClaudeImportReport
): void {
  const { store, ids, projectKey } = input;
  const at = input.now.toISOString();
  const nowMs = input.now.getTime();
  const author = `agent:${input.ownerRef.slice('human:'.length)}/claude-code`;
  try {
    store.transaction(() => {
      for (const note of notes) {
        if (store.isTombstoned(note.origin)) {
          report.tombstoned += 1;
          continue;
        }
        const existing = store.entryByOrigin(note.origin);
        if (existing !== null) {
          const last = lastImported(store, existing);
          if (last.title === note.title && last.body === note.body) {
            report.unchanged += 1;
            continue;
          }
          store.updateEntry(
            {
              ...existing,
              title: note.title,
              body: note.body,
              trust: 'agent',
              rev: existing.rev + 1,
              updatedAt: at,
            },
            author,
            'import'
          );
          report.updated += 1;
          continue;
        }
        if (
          note.projectKey === null &&
          importedElsewhere(store, note, projectKey)
        ) {
          report.duplicates += 1;
          continue;
        }
        insertFresh(
          store,
          ids,
          nowMs,
          (id) =>
            newMemoryEntry(
              {
                scope: 'personal',
                kind: note.kind,
                title: note.title,
                body: note.body,
                projectKey: note.projectKey,
                author,
                trust: 'agent',
                origin: note.origin,
                createdAt: note.createdAt,
                lastRecalledAt: at,
              },
              id,
              at
            ),
          author,
          'import'
        );
        report.imported += 1;
      }
      if (input.dryRun === true) throw ROLLBACK;
      record(store, projectKey, report);
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
  }
}

function record(
  store: MemoryStore,
  projectKey: string,
  report: ClaudeImportReport
): void {
  store.transaction(() => {
    store.setMeta(stateKey(projectKey), report.state);
    store.setMeta(reportKey(projectKey), JSON.stringify(report));
  });
}

/** The last recorded import's report for the project, or null when none parses. */
export function lastClaudeImport(
  store: MemoryStore,
  projectKey: string
): ClaudeImportReport | null {
  const raw = store.meta(reportKey(projectKey));
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ClaudeImportReport;
  } catch {
    return null;
  }
}

/**
 * Imports the owner's Claude notes as personal agent-trust memory and records
 * the outcome in the store's meta. The source is only read; re-running is
 * idempotent by origin, skips tombstoned origins and revises changed notes.
 */
export function importClaudeNotes(input: {
  source: SourceSearch | { explicit: string } | { none: true };
  store: MemoryStore;
  projectKey: string;
  ownerRef: string;
  ids: MemoryIds;
  now: Date;
  home: string;
  dryRun?: boolean;
}): Promise<ClaudeImportReport> {
  return Promise.resolve().then(() => importNow(input));
}

function importNow(input: ImportInput): ClaudeImportReport {
  const report: ClaudeImportReport = {
    state: 'complete',
    source: null,
    imported: 0,
    updated: 0,
    unchanged: 0,
    duplicates: 0,
    tombstoned: 0,
    problems: [],
    candidates: [],
  };
  const finish = (): ClaudeImportReport => {
    if (input.dryRun !== true) record(input.store, input.projectKey, report);
    return report;
  };
  const { source } = input;
  if ('none' in source) return finish();
  let dir: string;
  if ('explicit' in source) {
    report.source = source.explicit;
    const refusal = refuseExplicit(source.explicit, input.home);
    // A refused --from is an input error: nothing is recorded.
    if (refusal !== null)
      return { ...report, state: 'failed', problems: [refusal] };
    dir = resolve(source.explicit);
  } else if (source.found === null) {
    report.state = 'unconfirmed';
    report.candidates = source.candidates;
    return finish();
  } else {
    dir = source.found.dir;
  }
  report.source = dir;
  const tree = readMemoryTree(dir);
  if (tree.missing) {
    report.state = 'unconfirmed';
    report.problems.push(`${dir}: does not exist`);
    return finish();
  }
  report.problems = tree.problems.map((p) => `${p.file}: ${p.reason}`);
  if (tree.problems.some((p) => p.file === '.')) {
    report.state = 'failed';
    return finish();
  }
  applyNotes(
    input,
    notesOf(dir, tree, input.projectKey, input.now.toISOString()),
    report
  );
  return report;
}
