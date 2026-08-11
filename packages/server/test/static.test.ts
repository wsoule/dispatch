import { TaskStore } from '@dispatch/core';
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ServerHandle } from '../src/index.js';
import { startServer } from '../src/index.js';
import { json } from './json.js';
import { useTestAuth } from './testAuth.js';

// A minimal built-SPA-shell fixture, standing in for a real `dist/` (e.g.
// the desktop bundle's) so this test exercises serveStatic without building
// anything.
function makeFixtureDist(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dispatch-web-dist-'));
  writeFileSync(
    join(dir, 'index.html'),
    '<html><head><title>dispatch</title></head><body><div id="root"></div></body></html>'
  );
  mkdirSync(join(dir, 'assets'), { recursive: true });
  writeFileSync(join(dir, 'assets', 'index.js'), 'console.log(1)\n');
  return dir;
}

describe('static file serving (webDistDir)', () => {
  let root: string;
  let fakeHome: string;
  let webDistDir: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    // startServer hydrates the merge queue, which writes run state under
    // DISPATCH_HOME — left unset it lands in the real home, one dir per test.
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-server-static-'));
    TaskStore.init(root);
    webDistDir = makeFixtureDist();
    handle = await startServer({
      rootDir: root,
      port: 0,
      webDistDir,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
    rmSync(webDistDir, { recursive: true, force: true });
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

describe('static file serving default (webDistDir unset)', () => {
  let root: string;
  let fakeHome: string;
  let handle: ServerHandle;
  let baseUrl: string;
  const originalDispatchHome = process.env.DISPATCH_HOME;

  beforeEach(async () => {
    fakeHome = mkdtempSync(join(tmpdir(), 'dispatch-home-'));
    process.env.DISPATCH_HOME = fakeHome;
    root = mkdtempSync(join(tmpdir(), 'dispatch-server-static-default-'));
    TaskStore.init(root);
    // No webDistDir passed — startServer must not resolve any implicit
    // sibling dist and must serve no UI at all.
    handle = await startServer({
      rootDir: root,
      port: 0,
      writeDaemonFile: false,
    });
    useTestAuth(handle);
    baseUrl = `http://127.0.0.1:${handle.port}`;
  });

  afterEach(async () => {
    await handle.stop();
    if (originalDispatchHome === undefined) delete process.env.DISPATCH_HOME;
    else process.env.DISPATCH_HOME = originalDispatchHome;
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true });
  });

  it('404s at / with no webDistDir configured', async () => {
    const res = await fetch(`${baseUrl}/`);
    expect(res.status).toBe(404);
  });
});
