import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';

// `Response.json()` types as `Promise<unknown>` under this repo's strict,
// DOM-less tsconfig — same escape hatch as api.test.ts.
function json(res: Response): Promise<any> {
  return res.json();
}

const moduleDir = dirname(fileURLToPath(import.meta.url));
const webPackageDir = join(moduleDir, '..', '..', 'web');
const webDistDir = join(webPackageDir, 'dist');
const webIndexHtml = join(webDistDir, 'index.html');

// Runs `bun run build` in packages/web and resolves with its exit code,
// force-killing it if it runs past `timeoutMs`.
function runWebBuild(timeoutMs: number): Promise<number> {
  return new Promise((resolve) => {
    const proc = spawn('bun', ['run', 'build'], {
      cwd: webPackageDir,
      stdio: 'inherit',
    });
    const timer = setTimeout(() => {
      proc.kill();
      resolve(1);
    }, timeoutMs);
    proc.on('close', (code) => {
      clearTimeout(timer);
      resolve(code ?? 1);
    });
  });
}

// This test plugs Slice S3's built web UI into the static serving Slice S1
// already added to startServer. Root `bun run build` builds every package
// (web included) before `bun run test` runs, but scripts/ws.ts matches
// packages in directory order — "server" sorts before "web" — so a
// server-only test run (or a fresh checkout that only ran `bun run test`)
// can't assume packages/web/dist already exists. Building it here, once, up
// front makes this test self-sufficient either way; 120s covers a cold vite
// build plus dependency resolution.
let distAvailable = existsSync(webIndexHtml);
if (!distAvailable) {
  console.log(
    '[static.test] packages/web/dist not found — building @dispatch/web (up to 120s)...'
  );
  const code = await runWebBuild(120_000);
  distAvailable = code === 0 && existsSync(webIndexHtml);
  if (!distAvailable) {
    console.log(
      '[static.test] @dispatch/web build did not produce dist/index.html — skipping static serving tests.'
    );
  }
}

const maybeDescribe = distAvailable ? describe : describe.skip;

maybeDescribe('static file serving (webDistDir)', () => {
  let root: string;
  let handle: ServerHandle;
  let baseUrl: string;

  beforeEach(async () => {
    root = mkdtempSync(join(tmpdir(), 'dispatch-server-static-'));
    TaskStore.init(root);
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir,
      writeDaemonFile: false,
    });
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
  });

  it('serves the built SPA shell at /', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/html');
    const html = await res.text();
    expect(html).toContain('<div id="root">');
  });

  it('still serves JSON from /api/health alongside static files', async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    expect(res.status).toBe(200);
    const body = await json(res);
    expect(body.ok).toBe(true);
    expect(typeof body.rootDir).toBe('string');
  });
});
