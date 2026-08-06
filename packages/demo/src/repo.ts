import {
  cpSync,
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';

import { git } from './git.js';
import { DEMO } from './paths.js';

export interface BranchFix {
  task: string;
  branch: string;
  file: string;
  contents: string;
}

// Hand-kept mirror of packages/server/src/orchestrator/worktree.ts's
// DiffResult/DiffFile — see runs.ts's own "hand-kept mirrors" comment for why
// this package can't import @dispatch/server's types directly.
export interface DiffFile {
  path: string;
  status: string;
}

export interface DiffResult {
  patch: string;
  files: DiffFile[];
}

// Computes the same {patch, files} shape Orchestrator.diff() would produce
// from a live worktree (see WorktreeManager.diff() in
// packages/server/src/orchestrator/worktree.ts), but directly from the two
// real refs a BRANCH_FIXES entry creates — merge-base(main, fix.branch), then
// `git diff`/`git diff --name-status` from there to the fix branch's tip.
//
// No seeded demo run ever gets a real `git worktree add`, so without this,
// every review/verify run's diff pane 409s ("run has no worktree to diff")
// — confirmed against a live daemon while building this fixture. runs.ts
// writes this result to each such run's `<runId>.diff.json` snapshot (the
// same file Orchestrator.persistDiffSnapshot writes right before deleting a
// reviewed run's worktree), so `diff()`'s snapshot fallback has real content
// to serve for the runs the demo path's Review/Verify stops actually open.
// `git clone` only ever checks out the default branch locally; every OTHER
// branch (including a BRANCH_FIXES entry, and even `main` itself when the
// remote's default branch is something else) exists only as a
// remote-tracking ref (`origin/<branch>`) until something explicitly checks
// it out. That's true for DEMO.teammateRoot always, and would even be true
// for DEMO.root itself after a real `git clone` — buildRepo happens to
// create its branches locally directly (no clone involved), so `root` alone
// resolves there, but nothing calling resolveRef should assume which case
// it's in. Throws instead of guessing when neither form exists, so callers
// fail with an actionable message instead of a raw "Not a valid object
// name" surfacing from whatever git command consumes the (wrong) ref.
function resolveRef(root: string, branch: string): string {
  try {
    git(root, 'rev-parse', '--verify', '--quiet', branch);
    return branch;
  } catch {
    // fall through to the origin/<branch> fallback below
  }
  const remote = `origin/${branch}`;
  try {
    git(root, 'rev-parse', '--verify', '--quiet', remote);
    return remote;
  } catch {
    throw new Error(
      `cannot resolve ref "${branch}" in ${root}: neither a local branch nor "${remote}" exists`
    );
  }
}

export function computeFixDiff(root: string, taskId: string): DiffResult {
  const fix = BRANCH_FIXES.find((f) => f.task === taskId);
  if (fix === undefined) {
    throw new Error(`no BRANCH_FIXES entry for ${taskId}`);
  }
  const baseRef = resolveRef(root, 'main');
  const ref = resolveRef(root, fix.branch);
  const mergeBase = git(root, 'merge-base', baseRef, ref).trim();
  const patch = git(root, 'diff', mergeBase, ref);
  const nameStatus = git(root, 'diff', '--name-status', mergeBase, ref);
  const files: DiffFile[] = nameStatus
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => {
      const [status, ...rest] = line.split('\t');
      return { path: rest.join('\t'), status: status ?? '' };
    });
  return { patch, files };
}

// The in-review tasks: broken on main, fixed on their own branch, so the review
// surface has a real diff to render.
export const BRANCH_FIXES: BranchFix[] = [
  {
    task: 't-2e91aa',
    branch: 'dispatch/t-2e91aa-move-cart-state-to-the-session',
    file: 'src/cart/CartProvider.ts',
    contents: `import { query } from '../db/client.js';

export interface CartLine {
  sku: string;
  qty: number;
}

// Cart state lives in the session store, so it follows a signed-in user
// between devices — task t-2e91aa.
export async function loadCart(sessionId: string): Promise<CartLine[]> {
  const rows = await query('SELECT lines FROM sessions WHERE id = ?', [sessionId]);
  const raw = rows[0]?.lines;
  if (typeof raw !== 'string') return [];
  try {
    return JSON.parse(raw) as CartLine[];
  } catch {
    return [];
  }
}

export async function saveCart(sessionId: string, lines: CartLine[]): Promise<void> {
  await query('UPDATE sessions SET lines = ? WHERE id = ?', [JSON.stringify(lines), sessionId]);
}
`,
  },
  {
    task: 't-58cc03',
    branch: 'dispatch/t-58cc03-rank-exact-sku-matches-above',
    file: 'src/search/rank.ts',
    contents: `import { tokenize } from './tokenize.js';

export interface Product {
  sku: string;
  title: string;
}

export interface Hit {
  sku: string;
  score: number;
}

const EXACT_SKU_BOOST = 100;

// An exact SKU match outranks every fuzzy hit — task t-58cc03.
export function rank(query: string, products: Product[]): Hit[] {
  const terms = tokenize(query);
  const hits: Hit[] = [];
  for (const product of products) {
    const haystack = tokenize(\`\${product.sku} \${product.title}\`);
    const overlap = terms.filter((t) => haystack.includes(t)).length;
    const exact = product.sku.toLowerCase() === query.trim().toLowerCase();
    const score = overlap + (exact ? EXACT_SKU_BOOST : 0);
    if (score > 0) hits.push({ sku: product.sku, score });
  }
  return hits.sort((a, b) => b.score - a.score);
}
`,
  },
];

// Resolves symlinks in the longest existing ancestor of `p`, then re-appends
// whatever suffix doesn't exist yet. Plain `realpathSync` throws ENOENT on a
// path that hasn't been created, which `root` often hasn't when the guard
// below runs (buildRepo deletes-then-creates it). Walking up to an existing
// ancestor lets us resolve symlinks (e.g. macOS /var -> /private/var) without
// requiring the target itself to exist yet.
function realpathIfPossible(p: string): string {
  let current = resolve(p);
  const missingSuffix: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) break; // hit the filesystem root; nothing left to resolve
    missingSuffix.unshift(current.slice(parent.length + 1));
    current = parent;
  }
  const real = realpathSync(current);
  return missingSuffix.length > 0 ? join(real, ...missingSuffix) : real;
}

// `buildRepo` starts with a recursive delete of `root`. Only allow that when
// `root` resolves inside .agents/ignore/ or the OS temp dir (where the tests'
// mkdtempSync paths live) — anything else is refused before rmSync runs. Both
// sides are realpath-resolved so a caller passing an already-realpath'd temp
// path (or a TMPDIR that itself resolves through a symlink, e.g. macOS's
// /var -> /private/var) isn't wrongly rejected.
export function assertSafeToDelete(root: string): void {
  const resolved = realpathIfPossible(root);
  const allowedRoots = [
    realpathIfPossible(DEMO.ignore),
    realpathIfPossible(tmpdir()),
  ];
  const isSafe = allowedRoots.some(
    (allowed) => resolved === allowed || resolved.startsWith(allowed + sep)
  );
  if (!isSafe) {
    throw new Error(
      `refusing to delete "${resolved}": it is outside both ${DEMO.ignore} and the OS temp directory`
    );
  }
}

// Skips install artifacts so a `bun install` run inside storefront-src never
// gets copied into (and then committed into) the generated repo. Exported so
// tests can exercise the exact filter buildRepo's cpSync uses, without
// needing a real node_modules/bun.lock planted in the template.
export function skipInstallArtifacts(src: string): boolean {
  const base = basename(src);
  return base !== 'node_modules' && base !== 'bun.lock';
}

// Filenames that must never reach a commit in the demo's repo — it is pushed
// to a public GitHub remote, so anything matching here would be leaked the
// moment it's force-pushed and can never be un-leaked by a later push.
// Broader than a literal "credentials.json": also catches a stray `.env`,
// a `*.pem`/`*.key`, or an `id_rsa*` private key, since `buildRepo` copies
// the whole template with a filter that only excludes install artifacts
// (skipInstallArtifacts, above) — nothing else in the template is vetted.
const SUSPICIOUS_BASENAME = /credential|\.env$|\.pem$|^id_rsa|\.key$/i;

/** Narrows `stagedFiles` down to the ones whose basename looks like a credential. */
export function findSuspiciousStagedFiles(stagedFiles: string[]): string[] {
  return stagedFiles.filter((f) => SUSPICIOUS_BASENAME.test(basename(f)));
}

// Throws when anything currently staged (`git diff --cached`) in `root`
// looks like a credential. Call this right after every `git add -A` and
// before the commit/push that follows it — checking post-commit or only
// once at the very end would let a secret slip into history (and a public
// remote) before anything caught it.
export function assertNoCredentialsStaged(root: string): void {
  const staged = git(root, 'diff', '--cached', '--name-only')
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l !== '');
  const suspicious = findSuspiciousStagedFiles(staged);
  if (suspicious.length > 0) {
    throw new Error(
      `refusing to commit in ${root}: staged files that look like credentials: ${suspicious.join(', ')}`
    );
  }
}

/** Copies the template into `root`, commits main, then lays down one branch per in-review fix. */
export function buildRepo(opts: { root: string; push: boolean }): void {
  const { root, push } = opts;
  assertSafeToDelete(root);
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  cpSync(DEMO.template, root, {
    recursive: true,
    filter: skipInstallArtifacts,
  });

  git(root, 'init', '-q', '-b', 'main');
  git(root, 'add', '-A');
  assertNoCredentialsStaged(root);
  git(root, 'commit', '-qm', 'initial: storefront');

  for (const fix of BRANCH_FIXES) {
    git(root, 'checkout', '-q', '-b', fix.branch, 'main');
    writeFileSync(join(root, fix.file), fix.contents);
    git(root, 'add', '-A');
    assertNoCredentialsStaged(root);
    git(root, 'commit', '-qm', `fix: ${fix.task}`);
    git(root, 'checkout', '-q', 'main');
  }

  if (push) {
    git(root, 'remote', 'add', 'origin', DEMO.remote);
    git(root, 'push', '-q', '--force', '--all', 'origin');
  }
}
