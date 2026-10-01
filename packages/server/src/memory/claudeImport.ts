import { resolveSettings } from '@anthropic-ai/claude-agent-sdk';
import {
  claudeIndexLineTitle,
  insertFresh,
  kindFromClaudeType,
  memoryContentHash,
  newMemoryEntry,
  parseMemoryFile,
  projectOnlyForClaudeType,
  readClaudeIndex,
} from '@dispatch/memory';
import type {
  MemoryEntry,
  MemoryIds,
  MemoryKind,
  MemoryStore,
} from '@dispatch/memory';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path';

import { spawnGitSync } from '../blockingGit.js';
import { readMemoryTree } from './claudeExport.js';
import type { DocsOverflowPort } from './overflow.js';
import { overflowBody, overflowDocOf, overflowedText } from './overflow.js';

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
  // The whole text when `body` was cut: a personal doc may take it.
  fullBody?: string;
  createdAt: string;
}

const INDEX_FILE = 'MEMORY.md';
const ROLLBACK = Symbol('rollback');
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
    .filter(isDirectory)
    .map(realOrSelf);
}

// A candidate by its real path, since --from refuses one reached through a
// symlink (a dotfile manager's ~/.claude, say).
function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
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
      candidates: [
        realOrSelf(dir),
        ...others.filter((c) => c !== realOrSelf(dir)),
      ],
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
  const { linkText, lines } = readClaudeIndex(tree.index ?? '', files);
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
      ...(parsed.fullBody === undefined ? {} : { fullBody: parsed.fullBody }),
      createdAt: createdAtOf(parsed.modified, join(dir, file), at),
    });
  }
  const indexAt = createdAtOf(undefined, join(dir, INDEX_FILE), at);
  for (const line of lines) {
    const title = claudeIndexLineTitle(line);
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

// Whether a note's full text should go to the owner's personal doc on this
// run: a port and identity, not a dry run, a cut note keyed to this project.
function overflows(input: ImportInput, note: Note): boolean {
  return (
    input.overflow !== undefined &&
    input.identity !== undefined &&
    input.dryRun !== true &&
    note.fullBody !== undefined &&
    note.projectKey === input.projectKey
  );
}

// Whether `body` is what overflow made of this note: its full text cut with
// the marker of the doc it names.
function isOverflowOf(body: string, note: Note, projectKey: string): boolean {
  const docId = overflowDocOf(body);
  return (
    docId !== null &&
    note.fullBody !== undefined &&
    body === overflowedText(note.fullBody, docId, projectKey)
  );
}

interface PendingOverflow {
  note: Note;
  entryId: string;
  // A note cut plainly before docs were here: counted as updated once it overflows.
  recovery: boolean;
}

// After the import committed, hands each queued note's full text to the
// owner's personal doc and points its entry at it; docs.db is never written for
// an import that rolled back. Answers how many recoveries took.
function overflowAfterCommit(
  input: ImportInput,
  pending: readonly PendingOverflow[],
  author: string
): number {
  const { store, overflow, identity } = input;
  if (overflow === undefined || identity === undefined) return 0;
  let recovered = 0;
  for (const { note, entryId, recovery } of pending) {
    const entry = store.getEntry(entryId);
    if (entry === null) continue;
    const over = overflowBody(
      { ...entry, scope: 'personal', title: note.title },
      note,
      {
        projectKey: input.projectKey,
        human: input.ownerRef,
        identity,
        port: { overflow },
      }
    );
    if (over === null) continue;
    const at = input.now.toISOString();
    store.transaction(() =>
      store.updateEntry(
        {
          ...entry,
          body: over.body,
          refs: over.refs,
          rev: entry.rev + 1,
          updatedAt: at,
        },
        author,
        'import'
      )
    );
    if (recovery) recovered += 1;
  }
  return recovered;
}

// Writes the notes into the store in one transaction; a dry run counts, then
// rolls back. Long project notes overflow into a doc once it has committed.
function applyNotes(
  input: ImportInput,
  notes: readonly Note[],
  report: ClaudeImportReport
): void {
  const { store, ids, projectKey } = input;
  const at = input.now.toISOString();
  const nowMs = input.now.getTime();
  const author = `agent:${input.ownerRef.slice('human:'.length)}/claude-code`;
  const pending: PendingOverflow[] = [];
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
            // Cut plainly before docs were here: recovered after commit, but
            // only while the owner has not edited it since that import.
            if (
              overflows(input, note) &&
              existing.title === last.title &&
              existing.body === last.body
            )
              pending.push({ note, entryId: existing.id, recovery: true });
            else report.unchanged += 1;
            continue;
          }
          if (
            last.title === note.title &&
            isOverflowOf(last.body, note, projectKey)
          ) {
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
          if (overflows(input, note))
            pending.push({ note, entryId: existing.id, recovery: false });
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
        const fresh = insertFresh(
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
        if (overflows(input, note))
          pending.push({ note, entryId: fresh.id, recovery: false });
        report.imported += 1;
      }
      if (input.dryRun === true) throw ROLLBACK;
      record(store, projectKey, report);
    });
  } catch (err) {
    if (err !== ROLLBACK) throw err;
    return;
  }
  const recovered = overflowAfterCommit(input, pending, author);
  const waiting = pending.filter((p) => p.recovery).length;
  report.updated += recovered;
  report.unchanged += waiting - recovered;
  if (pending.length > 0) record(store, projectKey, report);
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
  // With both set, long project notes overflow into the owner's personal doc.
  overflow?: DocsOverflowPort['overflow'];
  identity?: string;
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
