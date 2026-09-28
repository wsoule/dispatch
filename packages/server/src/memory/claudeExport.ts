import { untrustedInline } from '@dispatch/core';
import type { MemoryConfig } from '@dispatch/core';
import {
  createMemoryIds,
  cutUtf8,
  diffExport,
  kindFromClaudeType,
  MemoryError,
  newIndexLines,
  parsedHash,
  parseMemoryFile,
  personalIdentityFor,
  projectOnlyForClaudeType,
  renderClaudeIndex,
  renderTopicFile,
  topicFileName,
  utf8Bytes,
} from '@dispatch/memory';
import type {
  ManifestRow,
  MemoryEngine,
  MemoryStore,
  Principal,
  SaveResult,
  ScannedFile,
} from '@dispatch/memory';
import { createUlidFactory } from '@dispatch/protocol';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  constants,
  existsSync,
  fchmodSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  opendirSync,
  openSync,
  readdirSync,
  readSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import type { Stats } from 'node:fs';
import { basename, isAbsolute, join, relative, sep } from 'node:path';

import { claudeMemoryDir, claudeMemoryRoot } from '../orchestrator/paths.js';
import { runKind, runLineage } from '../orchestrator/types.js';
import type { RunMeta } from '../orchestrator/types.js';

const MAX_DEPTH = 3;
const MAX_FILES = 500;
const MAX_READ = 64 * 1024;
const KEPT_BYTES = 8 * 1024;
const MAX_EXPORTED = 300;
const POLL_MS = 15_000;
const INDEX_FILE = 'MEMORY.md';
const FORGET_REASON = 'deleted from the Claude memory directory';
const PROBLEMS_NAMED = 5;
const HOUR_MS = 3_600_000;
const RUN_LINEAGE_DAYS = 7;
const OVERSEER_LINEAGE_HOURS = 24;
// A lineage id or `o-<conversation>`: one plain path segment.
const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// An export being written, or a directory moved out of the way to be deleted.
const SET_ASIDE_PATTERN = /^\.(staging|closing)-/;

export interface ExportTarget {
  // A run lineage id, or `o-<conversation>` for an overseer conversation.
  name: string;
  principal: Principal;
  taskId: string | null;
}

export interface IngestSummary {
  saved: number;
  edited: number;
  proposed: number;
  retired: number;
  renamed: number;
  // `<file>: <reason>` for every file refused in this scan.
  problems: string[];
}

interface Problem {
  file: string;
  reason: string;
  size: number;
  sha256: string;
  content: string | null;
}

interface Scan {
  // The directory is missing, so no file in it was seen.
  missing: boolean;
  files: ScannedFile[];
  // Each scanned file's text, kept for a problem row if saving it is refused.
  text: Map<string, string>;
  problems: Problem[];
  // The directory's own MEMORY.md, or null when it is absent or refused.
  index: string | null;
  // The walk stopped at MAX_FILES, so files past that point went unseen.
  cutShort: boolean;
}

interface TreeEntry {
  file: string;
  stat: Stats;
  tooDeep: boolean;
}

// One scan's effects in flight: a settle callback books a result into the
// manifest only while `current`, since a later prepare rebuilt the manifest.
type Settle = (result: SaveResult | null, current: boolean) => void;

interface ScanRun {
  target: ExportTarget;
  state: LineageState;
  generation: number;
  refused: Problem[];
  // Keys of new files the engine refused, so no later scan tries them again.
  refusedNew: string[];
  effects: Promise<void>[];
  summary: IngestSummary;
}

interface LineageState {
  // Bumped by prepare: bookkeeping from scans before it no longer applies.
  generation: number;
  // Files whose effect is still settling, so no other scan repeats it.
  inFlight: Set<string>;
  // Refusals already recorded, kept in meta so no later scan records them again.
  reported: Set<string>;
  queue: Promise<unknown>;
  stopWatch: (() => void) | null;
}

export interface ClaudeExportDeps {
  rootDir: string;
  engine: MemoryEngine;
  shared: MemoryStore;
  // The principal's operator's personal store; null when it acts for no one or it will not open.
  personalStore: (principal: Principal) => MemoryStore | null;
  config: () => MemoryConfig;
  now?: () => Date;
  pollMs?: number;
}

const sha256 = (bytes: Uint8Array | string): string =>
  createHash('sha256').update(bytes).digest('hex');

const decode = (bytes: Uint8Array): string => new TextDecoder().decode(bytes);

const indexKey = (name: string): string => `export-index:${name}`;

const reportedKey = (name: string): string => `export-reported:${name}`;

const runIdOf = (principal: Principal): string | null =>
  principal.kind === 'run' ? principal.address.slice('run:'.length) : null;

function problem(
  file: string,
  reason: string,
  size: number,
  kept: string | null
): Problem {
  return { file, reason, size, sha256: sha256(kept ?? ''), content: kept };
}

const problemKey = (p: Pick<Problem, 'file' | 'reason' | 'sha256'>): string =>
  `${p.file}\0${p.reason}\0${p.sha256}`;

// A `new` file refused before is keyed by its parsed content, whatever the reason.
const refusedKey = (file: string, hash: string): string =>
  `${file}\0refused\0${hash}`;

// Up to `limit` names in `path`, sorted; a huge directory is never read whole.
function listNames(path: string, limit: number): string[] {
  const dir = opendirSync(path);
  try {
    const names: string[] = [];
    for (let d = dir.readSync(); d !== null; d = dir.readSync()) {
      if (names.length >= limit) break;
      names.push(d.name);
    }
    return names.sort();
  } finally {
    dir.closeSync();
  }
}

// Up to MAX_FILES paths under `dir`, links unfollowed, and the first path past that limit;
// a path that vanishes mid-walk is skipped, a subdirectory that will not list is `unlisted`.
function walkTree(dir: string): {
  entries: TreeEntry[];
  unlisted: string[];
  stoppedAt: string | null;
} {
  const entries: TreeEntry[] = [];
  const unlisted: string[] = [];
  let stoppedAt: string | null = null;
  const walk = (rel: string, depth: number, tooDeep: boolean): void => {
    let names: string[];
    try {
      names = listNames(join(dir, rel), MAX_FILES + 1);
    } catch (err) {
      if (rel === '') throw err;
      unlisted.push(rel);
      return;
    }
    for (const name of names) {
      if (stoppedAt !== null) return;
      const file = rel === '' ? name : `${rel}/${name}`;
      if (entries.length >= MAX_FILES) {
        stoppedAt = file;
        return;
      }
      let stat: Stats;
      try {
        stat = lstatSync(join(dir, file));
      } catch {
        continue;
      }
      entries.push({ file, stat, tooDeep });
      if (stat.isDirectory())
        walk(file, depth + 1, tooDeep || depth >= MAX_DEPTH);
    }
  };
  walk('', 0, false);
  return { entries, unlisted, stoppedAt };
}

// Reads at most `n` bytes of a regular file; a link or special file is never opened.
function readBounded(path: string, n: number): Uint8Array | null {
  const fd = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    if (!fstatSync(fd).isFile()) return null;
    const buf = Buffer.alloc(n);
    let got = 0;
    while (got < n) {
      const read = readSync(fd, buf, got, n - got, null);
      if (read === 0) break;
      got += read;
    }
    return buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

// Walks a Claude memory directory without following links, reading each file
// at most 64 KiB; every refusal is recorded, never thrown.
export function readMemoryTree(dir: string): Scan {
  const scan: Scan = {
    missing: false,
    files: [],
    text: new Map(),
    problems: [],
    index: null,
    cutShort: false,
  };
  let root: Stats;
  try {
    root = lstatSync(dir);
  } catch {
    scan.missing = true;
    return scan;
  }
  if (!root.isDirectory()) {
    const reason = root.isSymbolicLink() ? 'symlink' : 'not-a-file';
    scan.problems.push(problem('.', reason, root.size, null));
    return scan;
  }
  let tree: ReturnType<typeof walkTree>;
  try {
    tree = walkTree(dir);
  } catch {
    scan.problems.push(problem('.', 'unreadable', root.size, null));
    return scan;
  }
  const { entries, unlisted, stoppedAt } = tree;
  for (const file of unlisted)
    scan.problems.push(problem(file, 'unreadable', 0, null));
  for (const { file, stat, tooDeep } of entries) {
    if (stat.isDirectory()) continue;
    if (stat.isSymbolicLink()) {
      scan.problems.push(problem(file, 'symlink', stat.size, null));
      continue;
    }
    if (!stat.isFile()) {
      scan.problems.push(problem(file, 'not-a-file', stat.size, null));
      continue;
    }
    if (tooDeep) {
      scan.problems.push(problem(file, 'too-deep', stat.size, null));
      continue;
    }
    if (!file.endsWith('.md')) continue;
    let bytes: Uint8Array | null;
    try {
      bytes = readBounded(join(dir, file), MAX_READ + 1);
    } catch {
      bytes = null;
    }
    if (bytes === null) {
      scan.problems.push(problem(file, 'unreadable', stat.size, null));
      continue;
    }
    if (bytes.byteLength > MAX_READ) {
      const kept = cutUtf8(decode(bytes), KEPT_BYTES);
      scan.problems.push(problem(file, 'too-large', stat.size, kept));
      continue;
    }
    const text = decode(bytes);
    if (file === INDEX_FILE) {
      scan.index = text;
      continue;
    }
    const parsed = parseMemoryFile(text, basename(file));
    scan.files.push({ file, parsed, hash: parsedHash(parsed) });
    scan.text.set(file, text);
  }
  if (stoppedAt !== null) {
    scan.cutShort = true;
    scan.problems.push(problem(stoppedAt, 'too-many-files', 0, null));
  }
  return scan;
}

// Whether a scan could not see `file`: refused, under a refused or missing directory,
// or past where a cut-short walk stopped. Such a file is never read as deleted.
function hiddenFrom(scan: Scan): (file: string) => boolean {
  const seen = new Set(scan.files.map((f) => f.file));
  const refused = scan.problems.map((p) => p.file);
  return (file) =>
    scan.missing ||
    (scan.cutShort && !seen.has(file)) ||
    refused.some((r) => r === '.' || file === r || file.startsWith(`${r}/`));
}

// Paths, sizes and modification times: a cheap test of whether a scan could find anything new.
function fingerprint(dir: string): string {
  try {
    return walkTree(dir)
      .entries.map(({ file, stat }) => `${file}:${stat.size}:${stat.mtimeMs}`)
      .join('\n');
  } catch {
    return '';
  }
}

// Creates `path` as a 0700 directory, refusing a link or a file already there.
function ensurePrivateDir(path: string): void {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  if (!lstatSync(path).isDirectory())
    throw new Error(`${path} is not a directory`);
  chmodSync(path, 0o700);
}

// Replaces whatever is at `path` (a link is removed, never followed) with a new 0600 file.
function writePrivate(path: string, text: string): void {
  rmSync(path, { force: true, recursive: true });
  const fd = openSync(path, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fchmodSync(fd, 0o600);
  } finally {
    closeSync(fd);
  }
}

// Deletes `path` and everything under it, links unfollowed; a failure is logged for the next sweep.
function removeQuietly(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch (err) {
    console.error(`memory: removing ${path} failed`, err);
  }
}

// Refusal keys a lineage recorded before; anything unparseable reads as none.
function parseReported(raw: string | null): string[] {
  if (raw === null) return [];
  try {
    const keys: unknown = JSON.parse(raw);
    return Array.isArray(keys)
      ? keys.filter((k): k is string => typeof k === 'string')
      : [];
  } catch {
    return [];
  }
}

// Exports memory into one Claude auto-memory directory per session lineage
// and ingests what Claude changed there back through the engine.
export class ClaudeExportManager {
  private readonly lineages = new Map<string, LineageState>();
  private readonly ids = createMemoryIds();
  private readonly ulid = createUlidFactory();
  private readonly pollMs: number;

  constructor(private readonly deps: ClaudeExportDeps) {
    this.pollMs = deps.pollMs ?? POLL_MS;
  }

  // Ingests anything left in the directory, then swaps in the ranked export and
  // its manifest; throws when the directory cannot be written.
  prepare(target: ExportTarget): { dir: string; indexText: string } {
    const dir = this.dirOf(target.name);
    ensurePrivateDir(claudeMemoryRoot(this.deps.rootDir));
    const state = this.state(target.name);
    const leftovers = this.scanAndApply(target, state);
    state.generation += 1;
    leftovers.catch((err: unknown) =>
      console.error(`memory: ingesting ${target.name}'s leftovers failed`, err)
    );
    // The old directory goes whole: its leftovers now live in entries, which
    // re-export under their own names.
    try {
      return this.writeExport(target, dir, state);
    } catch (err) {
      this.discard(target.name, state);
      throw err;
    }
  }

  async ingest(target: ExportTarget): Promise<IngestSummary> {
    this.dirOf(target.name);
    const state = this.state(target.name);
    return await this.enqueue(state, () => this.scanAndApply(target, state));
  }

  // Polls the directory's paths, sizes and modification times while a run is
  // live, and ingests when they move.
  watch(target: ExportTarget): () => void {
    const dir = this.dirOf(target.name);
    const state = this.state(target.name);
    state.stopWatch?.();
    let last = fingerprint(dir);
    let busy = false;
    const timer = setInterval(() => {
      if (busy) return;
      const current = fingerprint(dir);
      if (current === last) return;
      last = current;
      busy = true;
      this.ingest(target)
        .catch((err: unknown) =>
          console.error(`memory: ingesting ${target.name} failed`, err)
        )
        .finally(() => {
          busy = false;
        });
    }, this.pollMs);
    timer.unref();
    const stop = () => {
      clearInterval(timer);
      if (state.stopWatch === stop) state.stopWatch = null;
    };
    state.stopWatch = stop;
    return stop;
  }

  // A final scan when there is someone to attribute it to, then the directory,
  // its manifest and its stored index go, unless a prepare reopened it meanwhile.
  async closeLineage(name: string, target: ExportTarget | null): Promise<void> {
    this.dirOf(name);
    const state = this.state(name);
    state.stopWatch?.();
    const judged = state.generation;
    const closed = await this.enqueue(state, async () => {
      if (state.generation !== judged) return false;
      if (target !== null) await this.scanAndApply(target, state);
      if (state.generation !== judged) return false;
      state.generation += 1;
      this.removeExport(name, state);
      return true;
    });
    if (
      closed &&
      this.lineages.get(name) === state &&
      state.inFlight.size === 0
    )
      this.lineages.delete(name);
  }

  // Every export directory and manifest: open lineages are scanned, closed ones closed.
  async sweep(input: {
    targetOf(name: string): ExportTarget | null;
    isOpen(name: string): boolean;
  }): Promise<{ scanned: number; closed: number }> {
    this.clearSetAside();
    const names = new Set(this.deps.shared.manifestLineages());
    for (const name of this.directoryNames()) names.add(name);
    let scanned = 0;
    let closed = 0;
    for (const name of [...names].sort()) {
      try {
        const target = input.targetOf(name);
        const scannable = target !== null && existsSync(this.dirOf(name));
        if (!input.isOpen(name)) {
          await this.closeLineage(name, scannable ? target : null);
          closed += 1;
          if (scannable) scanned += 1;
        } else if (target !== null && scannable) {
          await this.ingest(target);
          scanned += 1;
        }
      } catch (err) {
        console.error(`memory: sweeping the Claude export ${name} failed`, err);
      }
    }
    return { scanned, closed };
  }

  // Files Claude read from the directory become recalls through the manifest;
  // any other path names no exported entry and is ignored.
  recordRecalls(
    runId: string,
    name: string,
    paths: readonly string[],
    via: 'read' | 'claude-recall'
  ): number {
    const dir = this.dirOf(name);
    const principal: Principal = {
      address: `run:${runId}`,
      canDecide: false,
      kind: 'run',
    };
    const rows = new Map(
      this.deps.shared.manifest(name).map((r) => [r.file, r])
    );
    const at = this.now().toISOString();
    const identity = this.identityOf(principal);
    const ignored: string[] = [];
    let recorded = 0;
    for (const path of paths) {
      if (!isAbsolute(path)) {
        ignored.push(path);
        continue;
      }
      const rel = relative(dir, path);
      if (
        rel === '' ||
        rel === '..' ||
        rel.startsWith(`..${sep}`) ||
        isAbsolute(rel)
      )
        continue;
      const row = rows.get(rel.split(sep).join('/'));
      if (row === undefined) continue;
      const store =
        row.store === 'shared'
          ? this.deps.shared
          : row.store === identity
            ? this.deps.personalStore(principal)
            : null;
      if (store === null || store.getEntry(row.memoryId) === null) continue;
      store.recordRecall(row.memoryId, {
        runId,
        via,
        at,
        countsAsUse: true,
      });
      recorded += 1;
    }
    if (ignored.length > 0)
      console.info(
        `memory: run ${runId} recalled ${ignored.map((p) => untrustedInline(p)).join(', ')}, which names no exported file`
      );
    return recorded;
  }

  // Stops every watch; the directories stay for the next boot's sweep.
  close(): void {
    for (const state of this.lineages.values()) state.stopWatch?.();
  }

  private dirOf(name: string): string {
    if (!NAME_PATTERN.test(name))
      throw new Error(
        `${JSON.stringify(name)} is not an export directory name`
      );
    return claudeMemoryDir(this.deps.rootDir, name);
  }

  private state(name: string): LineageState {
    let state = this.lineages.get(name);
    if (state === undefined) {
      state = {
        generation: 0,
        inFlight: new Set(),
        reported: new Set(
          parseReported(this.deps.shared.meta(reportedKey(name)))
        ),
        queue: Promise.resolve(),
        stopWatch: null,
      };
      this.lineages.set(name, state);
    }
    return state;
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  // One lineage's scans run one after another.
  private enqueue<T>(state: LineageState, step: () => Promise<T>): Promise<T> {
    const next = state.queue.then(step, step);
    state.queue = next.catch(() => undefined);
    return next;
  }

  private directoryNames(): string[] {
    const root = claudeMemoryRoot(this.deps.rootDir);
    if (!existsSync(root)) return [];
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory() && NAME_PATTERN.test(d.name))
      .map((d) => d.name);
  }

  // Deletes what an interrupted export or removal left set aside; no scan ever reads it.
  private clearSetAside(): void {
    const root = claudeMemoryRoot(this.deps.rootDir);
    if (!existsSync(root)) return;
    for (const name of readdirSync(root))
      if (SET_ASIDE_PATTERN.test(name)) removeQuietly(join(root, name));
  }

  // A fresh path beside the lineage directories that no scan or sweep reads as a lineage.
  private asidePath(kind: 'staging' | 'closing', name: string): string {
    const id = this.ulid(this.now().getTime());
    return join(claudeMemoryRoot(this.deps.rootDir), `.${kind}-${name}-${id}`);
  }

  // Renames the lineage directory out of every scan's way; null when there was none.
  private setAside(name: string): string | null {
    const aside = this.asidePath('closing', name);
    try {
      renameSync(this.dirOf(name), aside);
      return aside;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
  }

  // The directory moves aside before its manifest, index and refusals clear, so a
  // crash at any step leaves no manifest row that a scan could read as deleted.
  private removeExport(name: string, state: LineageState): void {
    const aside = this.setAside(name);
    const { shared } = this.deps;
    shared.transaction(() => {
      shared.replaceManifest(name, []);
      shared.deleteMeta(indexKey(name));
      shared.deleteMeta(reportedKey(name));
    });
    state.reported.clear();
    if (aside !== null) removeQuietly(aside);
  }

  // The identity whose personal store the principal writes, or null.
  private identityOf(principal: Principal): string | null {
    try {
      return personalIdentityFor(this.deps.engine.viewer(principal));
    } catch (err) {
      if (err instanceof MemoryError) return null;
      throw err;
    }
  }

  // Scans the directory and starts every effect at once: each engine write
  // lands before this returns, and the promise resolves when the effects have.
  private scanAndApply(
    target: ExportTarget,
    state: LineageState
  ): Promise<IngestSummary> {
    const { shared, engine } = this.deps;
    const scan = readMemoryTree(this.dirOf(target.name));
    const run: ScanRun = {
      target,
      state,
      generation: state.generation,
      refused: scan.problems.filter((p) => !state.reported.has(problemKey(p))),
      refusedNew: [],
      effects: [],
      summary: {
        saved: 0,
        edited: 0,
        proposed: 0,
        retired: 0,
        renamed: 0,
        problems: [],
      },
    };
    const { summary } = run;
    const hidden = hiddenFrom(scan);
    const manifest = shared.manifest(target.name);
    const changes = diffExport(
      manifest.filter((row) => !hidden(row.file)),
      scan.files
    );
    for (const change of changes) {
      if (change.type === 'new') {
        const { file, parsed } = change;
        const hash = parsedHash(parsed);
        if (
          state.inFlight.has(file) ||
          state.reported.has(refusedKey(file, hash))
        )
          continue;
        this.start(
          run,
          file,
          scan.text.get(file) ?? null,
          () =>
            engine.save(target.principal, {
              scope: 'personal',
              kind: kindFromClaudeType(parsed.type),
              projectOnly: projectOnlyForClaudeType(parsed.type),
              title: parsed.title,
              body: parsed.body,
              cause: 'ingest',
            }),
          (result, current) => {
            if (result === null) {
              run.refusedNew.push(refusedKey(file, hash));
              return;
            }
            if (result.status !== 'active') return;
            summary.saved += 1;
            if (current)
              shared.putManifestRow({
                lineage: target.name,
                file,
                store: this.identityOf(target.principal) ?? 'shared',
                memoryId: result.id,
                rev: 1,
                parsedHash: hash,
              });
          }
        );
        continue;
      }
      const { row } = change;
      if (state.inFlight.has(row.file)) continue;
      if (change.type === 'renamed') {
        if (state.inFlight.has(change.file)) continue;
        shared.transaction(() => {
          shared.deleteManifestRow(target.name, row.file);
          shared.putManifestRow({ ...row, file: change.file });
        });
        summary.renamed += 1;
        continue;
      }
      if (change.type === 'deleted') {
        this.start(
          run,
          row.file,
          null,
          () => engine.forget(target.principal, row.memoryId, FORGET_REASON),
          (result, current) => {
            if (result?.status === 'retired') summary.retired += 1;
            if (result?.status === 'proposed') summary.proposed += 1;
            if (current) shared.deleteManifestRow(target.name, row.file);
          }
        );
        continue;
      }
      const hash = parsedHash(change.parsed);
      this.start(
        run,
        row.file,
        scan.text.get(row.file) ?? null,
        () =>
          engine.edit(target.principal, row.memoryId, {
            title: change.parsed.title,
            body: change.parsed.body,
            baseRev: row.rev,
            cause: 'ingest',
          }),
        (result, current) => {
          if (result?.status === 'proposed') summary.proposed += 1;
          if (result?.status === 'active') summary.edited += 1;
          if (!current) return;
          // Moved on even when refused or proposed: the same edit is never tried twice.
          if (result?.status !== 'active') {
            shared.putManifestRow({ ...row, parsedHash: hash });
            return;
          }
          // An approved supersede leaves the file standing for the new entry.
          shared.putManifestRow({
            ...row,
            memoryId: result.id,
            rev: this.revOf(row, result.id, target.principal) ?? row.rev,
            parsedHash: hash,
          });
        }
      );
    }
    this.applyIndexLines(run, scan, manifest);
    return Promise.all(run.effects).then(() => {
      this.report(run);
      return summary;
    });
  }

  // Starts one engine write for `file`; a refusal is kept as a problem with
  // up to 8 KiB of the file's text.
  private start(
    run: ScanRun,
    file: string,
    text: string | null,
    write: () => Promise<SaveResult>,
    settle: Settle
  ): void {
    const { state, generation } = run;
    state.inFlight.add(file);
    run.effects.push(
      write()
        .then(
          (result) => settle(result, state.generation === generation),
          (err: unknown) => {
            if (!(err instanceof MemoryError))
              console.error(`memory: ingesting ${file} failed`, err);
            run.refused.push({
              file,
              reason: err instanceof MemoryError ? err.code : 'error',
              size: text === null ? 0 : utf8Bytes(text),
              sha256: sha256(text ?? ''),
              content: text === null ? null : cutUtf8(text, KEPT_BYTES),
            });
            settle(null, state.generation === generation);
          }
        )
        .finally(() => state.inFlight.delete(file))
    );
  }

  // Lines Claude added to MEMORY.md that link to no file become personal
  // facts; the stored index moves on first, so each line is saved once.
  private applyIndexLines(
    run: ScanRun,
    scan: Scan,
    manifest: readonly ManifestRow[]
  ): void {
    const { shared, engine } = this.deps;
    const { target, summary } = run;
    const key = indexKey(target.name);
    const written = shared.meta(key);
    if (scan.index === null || written === null || scan.index === written)
      return;
    const files = new Set([
      ...scan.files.map((f) => f.file),
      ...scan.problems.map((p) => p.file),
      ...manifest.map((r) => r.file),
    ]);
    const titles = newIndexLines(written, scan.index, files);
    shared.setMeta(key, scan.index);
    for (const title of titles)
      this.start(
        run,
        INDEX_FILE,
        title,
        () =>
          engine.save(target.principal, {
            scope: 'personal',
            kind: kindFromClaudeType(undefined),
            projectOnly: projectOnlyForClaudeType(undefined),
            title,
            body: '',
            cause: 'ingest',
          }),
        (result) => {
          if (result?.status === 'active') summary.saved += 1;
        }
      );
  }

  // The entry's revision after an ingested edit, from the store the row names.
  private revOf(
    row: ManifestRow,
    id: string,
    principal: Principal
  ): number | null {
    const store =
      row.store === 'shared'
        ? this.deps.shared
        : this.deps.personalStore(principal);
    return store?.getEntry(id)?.rev ?? null;
  }

  // Refused files go to the operator's ingest_problems, with one activity row naming them.
  private report(run: ScanRun): void {
    const { target, refused, summary } = run;
    if (refused.length === 0) return;
    for (const p of refused) summary.problems.push(`${p.file}: ${p.reason}`);
    const store = this.deps.personalStore(target.principal);
    if (store === null) {
      console.error(
        `memory: ${target.principal.address} has no personal memory for its skipped Claude files: ${summary.problems.join(', ')}`
      );
      this.markReported(run);
      return;
    }
    const now = this.now();
    const at = now.toISOString();
    const named = refused
      .slice(0, PROBLEMS_NAMED)
      .map((p) => `${untrustedInline(p.file)} (${p.reason})`);
    const more = refused.length - named.length;
    store.transaction(() => {
      for (const p of refused)
        store.addIngestProblem({
          id: `ip-${this.ulid(now.getTime())}`,
          lineage: target.name,
          file: p.file,
          reason: p.reason,
          size: p.size,
          sha256: p.sha256,
          content: p.content,
          at,
        });
      store.appendActivity({
        id: this.ids.activity(now.getTime()),
        at,
        kind: 'ingest-problem',
        memoryId: null,
        runId: runIdOf(target.principal),
        summary: `${target.principal.address} left Claude memory files unsaved: ${named.join(', ')}${more > 0 ? `, and ${more} more` : ''}`,
      });
    });
    this.markReported(run);
  }

  // Once recorded, a scan's refusals are kept in meta, so no later scan (after a restart
  // too) records them again or retries a refused new file; a prepare since then starts afresh.
  private markReported(run: ScanRun): void {
    const { target, state, generation, refused, refusedNew } = run;
    if (state.generation !== generation) return;
    for (const p of refused) state.reported.add(problemKey(p));
    for (const key of refusedNew) state.reported.add(key);
    this.deps.shared.setMeta(
      reportedKey(target.name),
      JSON.stringify([...state.reported])
    );
  }

  // Writes the export beside the lineage directory, sets the old one aside, moves the
  // manifest on, then renames the new one in: a crash never leaves files the manifest does not name.
  private writeExport(
    target: ExportTarget,
    dir: string,
    state: LineageState
  ): { dir: string; indexText: string } {
    const { engine, shared } = this.deps;
    const ranked = engine.rank(target.principal, target.taskId);
    const exported = ranked.ranked.slice(0, MAX_EXPORTED).map((r) => r.entry);
    const identity = this.identityOf(target.principal);
    const texts = new Map<string, string>();
    const rows: ManifestRow[] = [];
    for (const entry of exported) {
      const file = topicFileName(entry);
      const text = renderTopicFile(entry);
      texts.set(file, text);
      rows.push({
        lineage: target.name,
        file,
        store:
          entry.scope === 'personal' && identity !== null ? identity : 'shared',
        memoryId: entry.id,
        rev: entry.rev,
        parsedHash: parsedHash(parseMemoryFile(text, file)),
      });
    }
    const index = renderClaudeIndex(
      exported,
      ranked.ctx,
      this.deps.config().indexTokens
    );
    const staging = this.asidePath('staging', target.name);
    try {
      ensurePrivateDir(staging);
      for (const [file, text] of texts) writePrivate(join(staging, file), text);
      writePrivate(join(staging, INDEX_FILE), index.text);
      const aside = this.setAside(target.name);
      shared.transaction(() => {
        shared.replaceManifest(target.name, rows);
        shared.setMeta(indexKey(target.name), index.text);
        shared.deleteMeta(reportedKey(target.name));
      });
      state.reported.clear();
      renameSync(staging, dir);
      if (aside !== null) removeQuietly(aside);
    } catch (err) {
      removeQuietly(staging);
      throw err;
    }
    const runId = runIdOf(target.principal);
    if (runId !== null) {
      try {
        engine.recordIndexRecalls(
          target.principal,
          runId,
          ranked,
          index.included
        );
      } catch (err) {
        console.error(
          `memory: recording index recalls for run ${runId} failed`,
          err
        );
      }
    }
    return { dir, indexText: index.text };
  }

  // A failed export drops the lineage whole, so no later scan reads its ingested
  // leftovers as new again.
  private discard(name: string, state: LineageState): void {
    try {
      this.removeExport(name, state);
    } catch (err) {
      console.error(`memory: dropping the failed export ${name} failed`, err);
    }
  }
}

// Open while a run of the lineage is live; closed once its last run is reviewed,
// a newer execute run of the task starts another lineage, or a week passes without a run.
export function runLineageOpen(
  runs: readonly RunMeta[],
  name: string,
  isLive: (runId: string) => boolean,
  nowMs: number
): boolean {
  const mine = runs.filter((r) => runLineage(r) === name);
  const last = latestRun(mine);
  if (last === null) return false;
  if (mine.some((r) => isLive(r.id))) return true;
  if (last.reviewedAt !== undefined) return false;
  const replaced = runs.some(
    (r) =>
      r.taskId === last.taskId &&
      runKind(r) === 'execute' &&
      runLineage(r) !== name &&
      r.createdAt > last.createdAt
  );
  if (replaced) return false;
  return nowMs - Date.parse(last.updatedAt) < RUN_LINEAGE_DAYS * 24 * HOUR_MS;
}

// The lineage's latest run, which a leftover file is attributed to.
export function runLineageTarget(
  runs: readonly RunMeta[],
  name: string
): ExportTarget | null {
  const last = latestRun(runs.filter((r) => runLineage(r) === name));
  if (last === null) return null;
  return {
    name,
    principal: { address: `run:${last.id}`, canDecide: false, kind: 'run' },
    taskId: last.taskId,
  };
}

// An overseer conversation's directory closes a day after its last write.
export function overseerLineageOpen(dir: string, nowMs: number): boolean {
  try {
    return nowMs - lstatSync(dir).mtimeMs < OVERSEER_LINEAGE_HOURS * HOUR_MS;
  } catch {
    return false;
  }
}

function latestRun(runs: readonly RunMeta[]): RunMeta | null {
  let last: RunMeta | null = null;
  for (const r of runs)
    if (last === null || r.createdAt > last.createdAt) last = r;
  return last;
}
