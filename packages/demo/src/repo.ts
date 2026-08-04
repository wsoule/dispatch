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
function assertSafeToDelete(root: string): void {
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
  git(root, 'commit', '-qm', 'initial: storefront');

  for (const fix of BRANCH_FIXES) {
    git(root, 'checkout', '-q', '-b', fix.branch, 'main');
    writeFileSync(join(root, fix.file), fix.contents);
    git(root, 'add', '-A');
    git(root, 'commit', '-qm', `fix: ${fix.task}`);
    git(root, 'checkout', '-q', 'main');
  }

  if (push) {
    git(root, 'remote', 'add', 'origin', DEMO.remote);
    git(root, 'push', '-q', '--force', '--all', 'origin');
  }
}
