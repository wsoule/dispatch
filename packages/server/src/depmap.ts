import type { CartoMode } from '@dispatch/core';
import {
  cartoInit,
  cartoSyncAsync,
  discoverCarto,
  openCartoReader,
} from '@dispatch/core/carto';
import type {
  CartoBinary,
  CartoBlastRadius,
  CartoDiscovery,
  CartoReader,
  CartoRunResult,
} from '@dispatch/core/carto';
import { type Dirent, existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve, sep } from 'node:path';

// A reverse module graph over the workspace's TypeScript source: who imports a
// file (transitively) and who claims, in a comment, to hand-mirror it.
export interface DepMap {
  dependents(file: string): string[];
  mirrors(file: string): string[];
}

const SOURCE_EXTENSIONS = ['.ts', '.tsx'];
const MEMBER_SUBDIRS = ['src', 'test'];
const WORKSPACE_ROOTS = ['packages', 'apps'];
// `.carto` is carto's own output directory: on a single-package repo the
// watcher covers the whole tree, so without it a sync re-arms the watcher.
const SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.dispatch',
  '.carto',
]);

interface PackageInfo {
  dir: string;
  // export subpath (e.g. '.', './graph') -> package-relative source file
  // ('src/index.ts'), derived from package.json's `exports` map.
  exports: Map<string, string>;
}

// "./dist/graph.js" -> "src/graph.ts". Anything not under dist/*.js|jsx (a
// package.json subpath like "./package.json") resolves to nothing.
function distToSource(relPath: string): string | null {
  const match = /^\.?\/?dist\/(.+)\.(jsx?)$/.exec(relPath);
  if (match === null) return null;
  const ext = match[2] === 'jsx' ? 'tsx' : 'ts';
  return `src/${match[1]}.${ext}`;
}

function exportTargetToSource(target: unknown): string | null {
  if (typeof target === 'string') return distToSource(target);
  if (typeof target !== 'object' || target === null) return null;
  const obj = target as Record<string, unknown>;
  const chosen = obj.import ?? obj.default ?? obj.require;
  return typeof chosen === 'string' ? distToSource(chosen) : null;
}

// Reads one workspace member's package.json into its name and a map from
// each export subpath to the *source* file the built dist path came from.
function readPackageInfo(dir: string): [string, PackageInfo] | null {
  const pkgPath = join(dir, 'package.json');
  if (!existsSync(pkgPath)) return null;
  let raw: { name?: unknown; exports?: unknown; main?: unknown };
  try {
    raw = JSON.parse(readFileSync(pkgPath, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw.name !== 'string') return null;
  const exports = new Map<string, string>();
  if (typeof raw.exports === 'object' && raw.exports !== null) {
    for (const [subpath, target] of Object.entries(
      raw.exports as Record<string, unknown>
    )) {
      const source = exportTargetToSource(target);
      if (source !== null) exports.set(subpath, source);
    }
  } else if (typeof raw.main === 'string') {
    const source = distToSource(raw.main);
    if (source !== null) exports.set('.', source);
  }
  return [raw.name, { dir, exports }];
}

function discoverPackages(rootDir: string): Map<string, PackageInfo> {
  const packages = new Map<string, PackageInfo>();
  for (const workspaceRoot of WORKSPACE_ROOTS) {
    const base = join(rootDir, workspaceRoot);
    let members: string[];
    try {
      members = readdirSync(base);
    } catch {
      continue;
    }
    for (const name of members) {
      const found = readPackageInfo(join(base, name));
      if (found !== null) packages.set(found[0], found[1]);
    }
  }
  return packages;
}

function collectSourceFiles(dir: string, out: string[]): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectSourceFiles(full, out);
    } else if (SOURCE_EXTENSIONS.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
}

function toPosixRelative(rootDir: string, abs: string): string {
  return relative(rootDir, abs).split(sep).join('/');
}

// Blanks out `//` comment lines so a comment that mentions import syntax as
// prose (e.g. describing another file's code) can't be read as a real import.
function stripLineComments(content: string): string {
  return content
    .split('\n')
    .map((line) => (line.trim().startsWith('//') ? '' : line))
    .join('\n');
}

// Every `from '...'`, dynamic `import('...')`, `require('...')` and bare
// `import '...'` specifier a file's code (not its comments) contains.
function extractSpecifiers(content: string): string[] {
  const code = stripLineComments(content);
  const patterns = [
    /\bfrom\s+['"]([^'"]+)['"]/g,
    /\bimport\(\s*['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
  ];
  const out = new Set<string>();
  for (const pattern of patterns) {
    for (const m of code.matchAll(pattern)) out.add(m[1]);
  }
  return [...out];
}

// This repo's ESM convention writes `.js` for a `.ts`/`.tsx` source file, so
// extension-swapping and an index-file fallback both need trying.
function resolveRelativeSpecifier(
  fromFileAbs: string,
  specifier: string
): string | null {
  const raw = resolve(dirname(fromFileAbs), specifier);
  const extMatch = /\.(m?[jt]sx?)$/.exec(raw);
  const candidates =
    extMatch !== null
      ? [
          `${raw.slice(0, -extMatch[0].length)}.ts`,
          `${raw.slice(0, -extMatch[0].length)}.tsx`,
          raw,
        ]
      : [
          `${raw}.ts`,
          `${raw}.tsx`,
          join(raw, 'index.ts'),
          join(raw, 'index.tsx'),
        ];
  return candidates.find((c) => existsSync(c)) ?? null;
}

// Resolves a bare `@dispatch/pkg` or `@dispatch/pkg/subpath` specifier via
// that package's `exports` map. Any other bare specifier is third-party.
function resolveBareSpecifier(
  specifier: string,
  packages: Map<string, PackageInfo>
): string | null {
  const match = /^(@dispatch\/[^/]+)(\/.*)?$/.exec(specifier);
  if (match === null) return null;
  const pkg = packages.get(match[1]);
  if (pkg === undefined) return null;
  const subpath = match[2] === undefined ? '.' : `.${match[2]}`;
  const source = pkg.exports.get(subpath);
  return source === undefined ? null : join(pkg.dir, source);
}

// "mirrors", then a repo-relative path within 160 chars (spanning line
// wraps) — covers both "Mirrors X in path/to/file.ts" and "Mirrors path's X".
const MIRROR_WINDOW_RE =
  /[Mm]irrors[\s\S]{0,160}?((?:[\w-]+\/)+[\w.-]+\.tsx?)\b/g;

// Joins consecutive `//` lines into one block, so a claim wrapped across
// lines still matches, while code that merely mentions "mirrors" cannot.
function extractCommentBlocks(content: string): string[] {
  const blocks: string[] = [];
  let current: string[] = [];
  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (line.startsWith('//')) {
      current.push(line.slice(2).trim());
    } else if (current.length > 0) {
      blocks.push(current.join(' '));
      current = [];
    }
  }
  if (current.length > 0) blocks.push(current.join(' '));
  return blocks;
}

function extractMirrorTargets(content: string): string[] {
  const out: string[] = [];
  for (const block of extractCommentBlocks(content)) {
    for (const m of block.matchAll(MIRROR_WINDOW_RE)) out.push(m[1]);
  }
  return out;
}

function normalizeInputPath(file: string): string {
  return file.replace(/^\.\//, '').split(sep).join('/');
}

// Scans every workspace member's `src`/`test` tree once and returns a
// `DepMap` closed over the resulting reverse-import and mirror-claim graphs.
export function buildDepMap(rootDir: string): DepMap {
  const packages = discoverPackages(rootDir);
  const files: string[] = [];
  if (packages.size > 0) {
    for (const pkg of packages.values()) {
      for (const sub of MEMBER_SUBDIRS) {
        collectSourceFiles(join(pkg.dir, sub), files);
      }
    }
  } else {
    // No packages/apps workspace layout — a single-package Dispatch project
    // still gets relative-import edges from scanning the whole tree.
    collectSourceFiles(rootDir, files);
  }
  const fileSet = new Set(files.map((f) => toPosixRelative(rootDir, f)));

  const reverseImports = new Map<string, Set<string>>();
  const reverseMirrors = new Map<string, Set<string>>();

  const addEdge = (
    index: Map<string, Set<string>>,
    from: string,
    to: string
  ) => {
    let set = index.get(to);
    if (set === undefined) {
      set = new Set();
      index.set(to, set);
    }
    set.add(from);
  };

  for (const abs of files) {
    const rel = toPosixRelative(rootDir, abs);
    const content = readFileSync(abs, 'utf8');

    for (const specifier of extractSpecifiers(content)) {
      const targetAbs = specifier.startsWith('.')
        ? resolveRelativeSpecifier(abs, specifier)
        : resolveBareSpecifier(specifier, packages);
      if (targetAbs === null) continue;
      const targetRel = toPosixRelative(rootDir, targetAbs);
      if (targetRel !== rel && fileSet.has(targetRel)) {
        addEdge(reverseImports, rel, targetRel);
      }
    }

    for (const target of extractMirrorTargets(content)) {
      if (target !== rel && fileSet.has(target)) {
        addEdge(reverseMirrors, rel, target);
      }
    }
  }

  return {
    // BFS over the reverse-import index, sorted by hop distance then name —
    // a high-fanout file's direct importers must survive a later cap.
    dependents(file: string): string[] {
      const start = normalizeInputPath(file);
      const depth = new Map<string, number>([[start, 0]]);
      const queue = [start];
      while (queue.length > 0) {
        const current = queue.shift() as string;
        for (const importer of reverseImports.get(current) ?? []) {
          if (!depth.has(importer)) {
            depth.set(importer, (depth.get(current) as number) + 1);
            queue.push(importer);
          }
        }
      }
      depth.delete(start);
      return [...depth.entries()]
        .sort(([fa, da], [fb, db]) =>
          da !== db ? da - db : fa < fb ? -1 : fa > fb ? 1 : 0
        )
        .map(([f]) => f);
    },
    // Direct only: a mirror comment is a first-person claim, not something
    // to chase transitively.
    mirrors(file: string): string[] {
      const start = normalizeInputPath(file);
      return [...(reverseMirrors.get(start) ?? [])].sort();
    },
  };
}

// The top-level workspace roots, so a package added after boot is watched
// without re-deriving this list — not each member's own src/test.
export function depMapSourceDirs(rootDir: string): string[] {
  const roots = WORKSPACE_ROOTS.map((name) => join(rootDir, name)).filter(
    (dir) => existsSync(dir)
  );
  return roots.length > 0 ? roots : [rootDir];
}

// True when a watch-reported path falls inside a directory buildDepMap
// itself never scans, so the watcher doesn't invalidate on noise like it.
export function isSkippedPath(changedPath: string): boolean {
  return changedPath.split(/[/\\]/).some((segment) => SKIP_DIRS.has(segment));
}

export interface DepMapCacheOptions {
  mode?: CartoMode;
  onDegrade?: (degradation: CartoDegradation) => void;
}

// Lazily builds and memoizes a DepMap, so a burst of review dispatches shares
// one scan. Unions carto with the built-in scanner when the mode allows and a
// container is readable; every miss degrades to the scanner alone and is
// reported once.
export class DepMapCache {
  private cached: DepMap | null = null;
  // Both survive invalidate() deliberately. The watcher invalidates on every
  // debounced source change, so without these a missing binary would re-report
  // forever and a failed `carto init` would respawn a 4-9s index each tick.
  private reported = false;
  private initAttempted = false;

  constructor(
    private readonly rootDir: string,
    private readonly options: DepMapCacheOptions = {}
  ) {}

  private report(detail: string): void {
    if (this.reported) return;
    this.reported = true;
    this.options.onDegrade?.({ file: '', detail });
  }

  private build(): DepMap {
    const fallback = buildDepMap(this.rootDir);
    const mode = this.options.mode ?? 'on';
    if (mode === 'off') return fallback;

    const discovery = discoverCarto();
    if (!discovery.ok) {
      this.report(discovery.detail);
      return fallback;
    }
    let opened = openCartoReader(this.rootDir);
    // Mode `on` is a build policy: a project that upgraded into carto without
    // re-running `dispatch init` gets its container built here, once, on the
    // first review that needs it. `detect` never builds.
    if (
      !opened.ok &&
      opened.reason === 'no-container' &&
      mode === 'on' &&
      !this.initAttempted
    ) {
      this.initAttempted = true;
      const built = cartoInit(this.rootDir, discovery.binary);
      if (!built.ok) {
        this.report(built.detail);
        return fallback;
      }
      opened = openCartoReader(this.rootDir);
    }
    if (!opened.ok) {
      this.report(opened.detail);
      return fallback;
    }
    return createCartoDepMap(this.rootDir, opened.reader, fallback, (d) =>
      this.report(d.detail)
    );
  }

  get(): DepMap {
    this.cached ??= this.build();
    return this.cached;
  }

  invalidate(): void {
    this.cached = null;
  }
}

export interface SourceChangeHandlerOptions {
  rootDir: string;
  mode: CartoMode;
  cache: DepMapCache;
  // Both injectable so the handler's scheduling can be tested without
  // spawning a real binary.
  discover?: () => CartoDiscovery;
  sync?: (projectRoot: string, binary: CartoBinary) => Promise<CartoRunResult>;
}

// The daemon's watcher callback: always invalidates the cached map, and
// refreshes carto's container off the event loop, one sync at a time.
// Discovery is resolved once per daemon, and only when there is a container
// to sync — both are spawns the watcher must not pay per burst.
export function createSourceChangeHandler(
  options: SourceChangeHandlerOptions
): () => void {
  const discover = options.discover ?? discoverCarto;
  const sync = options.sync ?? cartoSyncAsync;
  let binary: CartoBinary | null | undefined;
  let inFlight = false;
  return () => {
    options.cache.invalidate();
    if (options.mode === 'off' || inFlight) return;
    if (!existsSync(join(options.rootDir, '.carto'))) return;
    if (binary === undefined) {
      const discovery = discover();
      binary = discovery.ok ? discovery.binary : null;
    }
    if (binary === null) return;
    inFlight = true;
    void sync(options.rootDir, binary)
      .then(() => {
        // The container just changed under the cached map, which was
        // invalidated before the sync started.
        options.cache.invalidate();
      })
      .catch(() => {
        // A rejecting sync must still release the guard, or every later
        // change event would be silently dropped for the daemon's life.
      })
      .finally(() => {
        inFlight = false;
      });
  };
}

// A path reachable via more than one route keeps only its closest hop, then
// the result sorts by (hops, name) ascending to match buildDepMap's ordering.
export function normalizeBlastRadius(raw: CartoBlastRadius): string[] {
  // path -> nearest hop distance seen for it, so a duplicate route can only
  // ever shrink the recorded distance, never add a second entry.
  const closest = new Map<string, number>();
  for (const file of raw.files) {
    let path: string | undefined;
    let hops: number | undefined;
    if (typeof file === 'string') {
      path = file;
      hops = raw.hops;
    } else if (typeof file === 'object' && file !== null) {
      const record = file as Record<string, unknown>;
      // Entries are { file, hop_distance }; `path`/`hops` are tolerated fallbacks.
      const rawPath = record.file ?? record.path;
      if (typeof rawPath !== 'string') continue;
      path = rawPath;
      const rawHops = record.hop_distance ?? record.hops;
      hops = typeof rawHops === 'number' ? rawHops : raw.hops;
    } else {
      continue;
    }
    const existing = closest.get(path);
    if (existing === undefined || hops < existing) closest.set(path, hops);
  }
  return [...closest.entries()]
    .sort(([pa, ha], [pb, hb]) =>
      ha !== hb ? ha - hb : pa < pb ? -1 : pa > pb ? 1 : 0
    )
    .map(([path]) => path);
}

/** Why a CartoDepMap stopped using carto, for the caller to surface once. */
export type CartoDegradation = { file: string; detail: string };

// Interleaves two closest-first lists one item at a time so a file only the
// second list found still lands near the front, instead of behind every
// entry of a long first list. review.ts's mergeRoundRobin does the same job,
// but depmap.ts is a shared, lower-level module (also consumed directly from
// index.ts) and importing a value from the orchestrator layer would invert
// that dependency, so this keeps its own copy.
function mergeRoundRobin(lists: string[][]): string[] {
  const cursors = lists.map(() => 0);
  const seen = new Set<string>();
  const merged: string[] = [];
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (let i = 0; i < lists.length; i++) {
      while (cursors[i] < lists[i].length && seen.has(lists[i][cursors[i]])) {
        cursors[i]++;
      }
      if (cursors[i] < lists[i].length) {
        const item = lists[i][cursors[i]];
        seen.add(item);
        merged.push(item);
        cursors[i]++;
        progressed = true;
      }
    }
  }
  return merged;
}

// dependents() unions carto's blast radius with the scanner's reverse-import
// graph: carto resolves specifiers naively and misses workspace `exports`
// edges the scanner catches, while the scanner only understands .ts/.tsx.
// Neither dominates, so a review must never lose the other's coverage. The
// two closest-first lists are round-robin merged, not concatenated, so a
// scanner-only dependent still survives review.ts's cap on a repo where carto
// alone returns far more results. mirrors() has no carto equivalent (no
// notion of hand-mirror comments), so it always comes from the scanner. A
// throw retires carto for this instance's life.
export function createCartoDepMap(
  rootDir: string,
  reader: CartoReader,
  fallback: DepMap,
  onDegrade?: (degradation: CartoDegradation) => void
): DepMap {
  let degraded = false;
  return {
    dependents(file: string): string[] {
      if (degraded) return fallback.dependents(file);
      let cartoDependents: string[];
      try {
        cartoDependents = normalizeBlastRadius(
          reader.blastRadius(normalizeInputPath(file))
        );
      } catch (err) {
        degraded = true;
        onDegrade?.({ file, detail: (err as Error).message });
        return fallback.dependents(file);
      }
      return mergeRoundRobin([cartoDependents, fallback.dependents(file)]);
    },
    mirrors(file: string): string[] {
      return fallback.mirrors(file);
    },
  };
}
