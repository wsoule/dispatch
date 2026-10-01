import { randomUUID } from 'node:crypto';
import {
  lstatSync,
  mkdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

import { DocsError } from './errors.js';

// Where a published doc may land, and writing it into a run's worktree without
// following a symlink into or out of it (spec "Publish to repo", D17, D29).

const REFUSED_PUBLISH_DIRS: readonly string[] = [
  '.git',
  '.dispatch',
  '.agents',
  '.claude',
  '.github',
];
const INSTRUCTION_FILES = new Set(['agents.md', 'claude.md']);
const MAX_PATH_BYTES = 1024;
// A task's writes are globs, so a path with a glob metacharacter would claim more than itself.
const GLOB_METACHARS = /[*?[\]{}()+@|!]/;

// Whether `text` holds a C0 control character or DEL.
function hasControl(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

const bad = (why: string): DocsError =>
  new DocsError('invalid', `path: ${why}`, 'path');

// The rules a path meets on its own, before any file system is consulted.
// Case-folded, since macOS and Windows checkouts do not tell `.GitHub` from `.github`.
function checkShape(path: string): void {
  if (typeof path !== 'string' || path === '') throw bad('required');
  if (Buffer.byteLength(path) > MAX_PATH_BYTES)
    throw bad(`longer than ${MAX_PATH_BYTES} bytes`);
  if (hasControl(path)) throw bad('control characters are not allowed');
  if (path.startsWith('/') || path.includes('\\') || isAbsolute(path))
    throw bad('must be a repo-relative POSIX path');
  const parts = path.split('/');
  if (parts.some((p) => p === '' || p === '.' || p === '..'))
    throw bad('no empty, . or .. segments');
  if (!path.endsWith('.md')) throw bad('must end in .md');
  if (GLOB_METACHARS.test(path))
    throw bad(
      'glob characters such as * ? [ ] { } ( ) + @ | ! are not allowed'
    );
  const folded = parts.map((p) => p.toLowerCase());
  if (REFUSED_PUBLISH_DIRS.includes(folded[0]))
    throw bad(`${parts[0]}/ is not a publish target`);
  if (folded.includes('.git')) throw bad('.git/ is not a publish target');
  if (INSTRUCTION_FILES.has(folded[folded.length - 1]))
    throw bad('agent-instruction files change through ordinary tasks');
}

// Every existing component of `rel` under `root` must be a real directory
// (the last a regular file) that resolves inside `root`; none may be a symlink.
function checkComponents(root: string, rel: string): void {
  const realRoot = realpathSync(root);
  const parts = rel.split('/');
  let at = root;
  for (const [i, part] of parts.entries()) {
    at = join(at, part);
    let st;
    try {
      st = lstatSync(at);
    } catch {
      return; // the rest does not exist yet
    }
    const shown = parts.slice(0, i + 1).join('/');
    if (st.isSymbolicLink()) throw bad(`${shown} is a symlink`);
    const last = i === parts.length - 1;
    if (last ? !st.isFile() : !st.isDirectory())
      throw bad(`${shown} is not a ${last ? 'file' : 'directory'}`);
    const inside = relative(realRoot, realpathSync(at));
    if (inside.startsWith('..') || isAbsolute(inside))
      throw bad('it leaves the checkout');
  }
}

/** `path` when a publish may write it under `rootDir`; a DocsError('invalid') otherwise. */
export function validatePublishPath(rootDir: string, path: string): string {
  checkShape(path);
  checkComponents(rootDir, path);
  return path;
}

// Creates each missing directory of `rel` one level at a time, so no
// recursive mkdir ever follows a symlink planted along the way.
function makeParents(root: string, rel: string): void {
  const parts = rel.split('/').slice(0, -1);
  let at = root;
  for (const part of parts) {
    at = join(at, part);
    try {
      mkdirSync(at);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
    }
    const st = lstatSync(at);
    if (st.isSymbolicLink() || !st.isDirectory())
      throw bad(`${relative(root, at)} is a symlink or not a directory`);
  }
}

/** Writes `body` at `relPath` inside `worktree` through an exclusive temp file
 *  and a rename, re-checking the path against the worktree first. */
export function seedFile(
  worktree: string,
  relPath: string,
  body: string
): void {
  validatePublishPath(worktree, relPath);
  makeParents(worktree, relPath);
  checkComponents(worktree, relPath);
  const target = join(worktree, relPath);
  const name = relPath.split('/').at(-1) ?? 'doc.md';
  const temp = join(target, '..', `.${name}.${randomUUID()}.dispatch-tmp`);
  // `wx` refuses an existing file or symlink at the temp name.
  writeFileSync(temp, body, { flag: 'wx', mode: 0o644 });
  try {
    checkComponents(worktree, relPath);
    renameSync(temp, target);
  } catch (err) {
    rmSync(temp, { force: true });
    throw err;
  }
}
