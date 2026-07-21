#!/usr/bin/env bun
// Compiles `packages/server/src/bin.ts` (dispatchd, the per-project daemon)
// into a standalone `bun build --compile` executable, then smoke-boots the
// result against a freshly initialized tmp repo to confirm the compiled
// binary actually starts and serves — not just that it built. This is Phase
// 6 groundwork only: the desktop app's `ensure_dispatchd` (apps/desktop/
// src-tauri/src/sidecar.rs) still spawns dispatchd via `bun <bin.ts>` in dev;
// wiring it to consume this compiled binary from a packaged app bundle is a
// separate follow-up (see that file's own "Phase 6 TODO" comment).
//
// Usage: `bun run build:sidecar` from the repo root (see package.json).

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// `bun build --compile` (at least on Bun 1.3.14) leaves a stray
// `.<hash>-00000000.bun-build` staging file behind in its invocation cwd
// even on a successful build — gitignored (see .gitignore), but there is no
// reason to let them pile up in the repo root across repeated runs.
function cleanupBunBuildArtifacts(dir: string): void {
  for (const entry of readdirSync(dir)) {
    if (entry.endsWith('.bun-build')) rmSync(join(dir, entry), { force: true });
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(repoRoot, 'packages', 'server', 'src', 'bin.ts');
const outDir = join(repoRoot, 'dist-sidecar');
const outfile = join(outDir, 'dispatchd');

// Bytes -> "12.3 MB", for a report-friendly binary size instead of a raw
// byte count.
function formatSize(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

console.log(`building ${outfile} from ${entry}...`);
mkdirSync(outDir, { recursive: true });
// Target the current platform only (Phase 6 groundwork scope) — no
// --target/--compile-executable-path cross-compile flags.
const build = spawnSync(
  'bun',
  ['build', '--compile', entry, '--outfile', outfile],
  { cwd: repoRoot, stdio: 'inherit' }
);
cleanupBunBuildArtifacts(repoRoot);
if (build.status !== 0) {
  console.error('build-sidecar: bun build --compile failed');
  process.exit(build.status ?? 1);
}
if (!existsSync(outfile)) {
  console.error(`build-sidecar: expected output missing: ${outfile}`);
  process.exit(1);
}
const size = statSync(outfile).size;
console.log(`built ${outfile} (${formatSize(size)})`);

// --- Smoke boot -------------------------------------------------------
//
// A tmp project root with a minimal `.dispatch/` (same shape TaskStore.init
// writes in packages/core/src/store.ts) so the daemon has a real, empty
// tracker to serve rather than an uninitialized directory. A separate tmp
// DISPATCH_HOME keeps the daemon-file write (writeDaemonFile defaults to
// true — see packages/server/src/daemonfile.ts) out of the real home
// directory during this smoke test.
const projectRoot = mkdtempSync(join(tmpdir(), 'dispatch-sidecar-smoke-'));
const dispatchHome = mkdtempSync(join(tmpdir(), 'dispatch-sidecar-home-'));
mkdirSync(join(projectRoot, '.dispatch', 'tasks'), { recursive: true });
writeFileSync(
  join(projectRoot, '.dispatch', 'config.yml'),
  'statuses: [backlog, todo, in-progress, in-review, done, cancelled]\nautoCommit: false\n'
);

console.log(`smoke-booting ${outfile} against ${projectRoot}...`);

// Regex the compiled binary's own startup line
// (`dispatchd listening on http://127.0.0.1:<port>`, printed by bin.ts)
// straight off stdout, rather than polling the daemon file — no race with
// the daemon-file write, and it directly proves the binary itself ran (as
// opposed to some other process happening to hold that daemon file).
const LISTENING_RE = /dispatchd listening on http:\/\/127\.0\.0\.1:(\d+)/;
const SMOKE_TIMEOUT_MS = 10_000;

// Reads `stream` until `regex` matches the accumulated text or `timeoutMs`
// elapses (whichever first) — a single `reader.read()` call outstanding at
// a time, with the timeout enforced by cancelling the reader itself rather
// than racing a second, overlapping `read()` call against it.
async function readUntilMatch(
  stream: ReadableStream<Uint8Array>,
  regex: RegExp,
  timeoutMs: number
): Promise<{ output: string; match: RegExpExecArray | null }> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let output = '';
  const timer = setTimeout(() => {
    void reader.cancel();
  }, timeoutMs);
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      output += decoder.decode(value);
      const match = regex.exec(output);
      if (match) return { output, match };
    }
  } catch {
    // reader.cancel() rejects the in-flight read() on timeout — treated the
    // same as a plain "no match found before the deadline" below.
  } finally {
    clearTimeout(timer);
  }
  return { output, match: null };
}

async function smokeTest(): Promise<{ ok: boolean; output: string }> {
  const child = Bun.spawn({
    cmd: [outfile, '--root', projectRoot, '--port', '0'],
    env: { ...process.env, DISPATCH_HOME: dispatchHome },
    stdout: 'pipe',
    stderr: 'pipe',
  });

  const read = await readUntilMatch(
    child.stdout,
    LISTENING_RE,
    SMOKE_TIMEOUT_MS
  );
  let output = read.output;

  if (read.match === null) {
    child.kill();
    await child.exited;
    return { ok: false, output };
  }
  const port = Number(read.match[1]);

  // Confirm the process is actually serving, not just that it printed the
  // line — a quick real request against its own health endpoint.
  let healthOk = false;
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`);
    const body = (await res.json()) as { ok?: boolean };
    healthOk = res.ok && body.ok === true;
    output += `\n/api/health -> ${res.status} ${JSON.stringify(body)}`;
  } catch (err) {
    output += `\n/api/health request failed: ${(err as Error).message}`;
  }

  child.kill();
  await child.exited;
  return { ok: healthOk, output };
}

let result: { ok: boolean; output: string };
try {
  result = await smokeTest();
} finally {
  rmSync(projectRoot, { recursive: true, force: true });
  rmSync(dispatchHome, { recursive: true, force: true });
}

console.log(result.output.trim());
if (!result.ok) {
  console.error(
    'build-sidecar: smoke test failed — binary did not report healthy'
  );
  process.exit(1);
}
console.log('build-sidecar: smoke test passed');
